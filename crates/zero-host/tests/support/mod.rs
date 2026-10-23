//! What the end-to-end tests share: a loopback client, a test target that hands
//! batches to the test thread, and polling helpers.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use zero_host::{read_batch, App, BatchRef, Post, Server, ServerOptions, Target, MAX_BATCH};

/// Build and start a server for `app` from a server option document.
pub fn start(app: &App, options: &str) -> Server {
    let server = Server::new(app, ServerOptions::parse(options.as_bytes()).unwrap()).unwrap();
    server.start().unwrap();
    server
}

/// Detach every target, so leases end and bound threads are unbound, then stop the
/// server and wait for it.
pub fn stop(server: &Server) {
    for &worker in server.workers() {
        let _ = server.detach(worker);
    }
    server.shutdown();
    server.wait(Some(Duration::from_secs(20))).unwrap();
}

/// Poll `done` every millisecond until it holds, for up to ten seconds.
pub fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// One parsed response.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A loopback connection.
pub struct Client {
    pub stream: TcpStream,
}

impl Client {
    pub fn connect(server: &Server) -> Client {
        let stream = TcpStream::connect(server.address().unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        stream.set_nodelay(true).unwrap();
        Client { stream }
    }

    pub fn send(&mut self, request: &[u8]) {
        self.stream.write_all(request).unwrap();
    }

    pub fn send_get(&mut self, path: &str) {
        self.send(format!("GET {path} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes());
    }

    /// Read one response: the head, then `Content-Length` bytes of body.
    pub fn read(&mut self) -> io::Result<Reply> {
        self.read_reply(false)
    }

    /// Send a HEAD request and read its response, which carries no body.
    pub fn head(&mut self, path: &str) -> Reply {
        self.send(format!("HEAD {path} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes());
        self.read_reply(true).unwrap()
    }

    fn read_reply(&mut self, head_request: bool) -> io::Result<Reply> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if self.stream.read(&mut byte)? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "closed in the head",
                ));
            }
            head.push(byte[0]);
        }
        let text = String::from_utf8(head).unwrap();
        let mut lines = text.trim_end().split("\r\n");
        let status: u16 = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers: Vec<(String, String)> = lines
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_owned(), value.trim().to_owned())
            })
            .collect();
        let length: usize = if head_request || status == 204 || status == 304 || status < 200 {
            0
        } else {
            headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, value)| value.parse().unwrap())
        };
        let mut body = vec![0u8; length];
        self.stream.read_exact(&mut body)?;
        Ok(Reply {
            status,
            headers,
            body,
        })
    }

    pub fn get(&mut self, path: &str) -> Reply {
        self.send_get(path);
        self.read().unwrap()
    }

    /// Send a whole request as written and read its response.
    pub fn get_with(&mut self, request: &str) -> Reply {
        self.send(request.as_bytes());
        self.read().unwrap()
    }
}

/// One request on a new connection.
pub fn get(server: &Server, path: &str) -> Reply {
    Client::connect(server).get(path)
}

struct Held {
    batches: VecDeque<BatchRef>,
    capacity: usize,
    posts: usize,
    refused: usize,
    received: usize,
    before_return: Option<Arc<dyn Fn(BatchRef) + Send + Sync>>,
}

/// A target that holds the batches it takes for the test thread, refuses with
/// `Full` while it holds `capacity`, and can run a hook before a post returns.
pub struct TestTarget {
    held: Mutex<Held>,
    ready: Condvar,
}

impl Target for TestTarget {
    fn post(&self, batch: BatchRef) -> Post {
        let hook = {
            let mut held = self.held.lock().unwrap();
            held.posts += 1;
            if held.batches.len() >= held.capacity {
                held.refused += 1;
                return Post::Full;
            }
            held.batches.push_back(batch);
            held.received += 1;
            held.before_return.clone()
        };
        self.ready.notify_all();
        if let Some(hook) = hook {
            hook(batch);
        }
        Post::Taken
    }
}

impl TestTarget {
    pub fn new(capacity: usize) -> Arc<TestTarget> {
        Arc::new(TestTarget {
            held: Mutex::new(Held {
                batches: VecDeque::new(),
                capacity,
                posts: 0,
                refused: 0,
                received: 0,
                before_return: None,
            }),
            ready: Condvar::new(),
        })
    }

    /// Run `hook` on the worker thread after each taken batch is queued and before
    /// the post returns.
    pub fn before_return(&self, hook: Arc<dyn Fn(BatchRef) + Send + Sync>) {
        self.held.lock().unwrap().before_return = Some(hook);
    }

    /// Take the oldest batch held, waiting up to ten seconds for one.
    pub fn take(&self) -> BatchRef {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut held = self.held.lock().unwrap();
        loop {
            if let Some(batch) = held.batches.pop_front() {
                return batch;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no batch arrived");
            held = self.ready.wait_timeout(held, left).unwrap().0;
        }
    }

    /// Post attempts, refusals and batches taken so far.
    pub fn counts(&self) -> (usize, usize, usize) {
        let held = self.held.lock().unwrap();
        (held.posts, held.refused, held.received)
    }

    /// How many batches the target holds now.
    pub fn holding(&self) -> usize {
        self.held.lock().unwrap().batches.len()
    }
}

/// The slot ids of a request batch.
pub fn ids(batch: BatchRef) -> Vec<u64> {
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    let count = read_batch(batch, &mut slots, &mut routes).unwrap();
    slots.truncate(count);
    slots
}

/// The route ids of a request batch.
pub fn routes(batch: BatchRef) -> Vec<u32> {
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    let count = read_batch(batch, &mut slots, &mut routes).unwrap();
    routes.truncate(count);
    routes
}
