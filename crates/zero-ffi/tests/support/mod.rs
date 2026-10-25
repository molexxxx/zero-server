//! What the integration tests share: safe wrappers over the C exports a test calls with
//! valid arguments, a loopback client, and polling helpers.

#![allow(dead_code, unsafe_code)]

use std::io::{self, Read, Write};
use std::mem::size_of;
use std::net::{SocketAddr, TcpStream};
use std::ptr;
use std::time::{Duration, Instant};

use zero_ffi::*;

/// The worker index no test claims, for ids that name an unclaimed worker.
pub const FOREIGN_WORKER: u8 = 127;

/// The message of the calling thread's last refused call, or an empty string.
pub fn last_error() -> String {
    take_string(zero_last_error_message()).unwrap_or_default()
}

/// Assert a call succeeded, showing the last error when it did not.
#[track_caller]
pub fn ok(status: ZeroStatus) {
    assert_eq!(status, ZeroStatus::Ok, "{}", last_error());
}

/// Copy an owned string out and free it; `None` for NULL.
pub fn take_string(string: *mut ZeroString) -> Option<String> {
    if string.is_null() {
        return None;
    }
    // SAFETY: `string` is a live string this library just returned.
    let data = unsafe { zero_string_data(string) };
    // SAFETY: as above.
    let len = unsafe { zero_string_len(string) };
    // SAFETY: the data holds `len` octets before its terminator while the string lives.
    let text = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec();
    // SAFETY: `string` is live and is not used again.
    unsafe { zero_string_free(string) };
    Some(String::from_utf8(text).expect("an owned string is UTF-8"))
}

/// Copy an owned buffer out and free it.
pub fn take_buffer(buffer: *mut ZeroBuffer) -> Vec<u8> {
    assert!(!buffer.is_null());
    // SAFETY: `buffer` is a live buffer this library just returned.
    let data = unsafe { zero_buffer_data(buffer) };
    // SAFETY: as above.
    let len = unsafe { zero_buffer_len(buffer) };
    // SAFETY: the data holds `len` octets while the buffer lives.
    let bytes = unsafe { std::slice::from_raw_parts(data, len) }.to_vec();
    // SAFETY: `buffer` is live and is not used again.
    unsafe { zero_buffer_free(buffer) };
    bytes
}

/// Copy a view out: `None` for an absent view.
///
/// The caller holds the view rule's permission for the slot the view points into.
pub fn view(bytes: ZeroBytes) -> Option<Vec<u8>> {
    if bytes.ptr.is_null() {
        assert_eq!(bytes.len, 0, "an absent view has no length");
        return None;
    }
    // SAFETY: a present view points to `len` octets that stay valid while the caller
    // holds its pin or its batch window.
    Some(unsafe { std::slice::from_raw_parts(bytes.ptr, bytes.len) }.to_vec())
}

/// A new app.
pub fn app_new() -> u64 {
    let mut app = 0;
    // SAFETY: `app` is a writable `uint64_t`.
    ok(unsafe { zero_app_new(&mut app) });
    app
}

/// Register a route and return its id.
pub fn route(app: u64, kind: u32, method: u8, pattern: &str, options: &str) -> u32 {
    let mut id = 0;
    // SAFETY: the ranges are the bytes of the two strings and `id` is writable.
    let status = unsafe {
        zero_app_route(
            app,
            kind,
            method,
            pattern.as_ptr(),
            pattern.len(),
            options.as_ptr(),
            options.len(),
            &mut id,
        )
    };
    ok(status);
    id
}

/// Build a server from an app.
pub fn server_new(app: u64, options: &str) -> u64 {
    let mut server = 0;
    // SAFETY: the range is the bytes of `options` and `server` is writable.
    ok(unsafe { zero_server_new(app, options.as_ptr(), options.len(), &mut server) });
    server
}

/// The worker indexes of a server.
pub fn workers(server: u64) -> Vec<u8> {
    let mut indexes = [0u8; 128];
    let mut count = 0usize;
    // SAFETY: `indexes` holds 128 writable octets and `count` is writable.
    ok(unsafe { zero_server_workers(server, indexes.as_mut_ptr(), indexes.len(), &mut count) });
    indexes[..count].to_vec()
}

/// Attach a pull target.
pub fn attach(server: u64, worker: u32) -> u64 {
    let mut target = 0;
    // SAFETY: `target` is a writable `uint64_t`.
    ok(unsafe { zero_target_attach(server, worker, &mut target) });
    target
}

/// The address a running server listens on.
pub fn address(server: u64) -> SocketAddr {
    let mut address = ptr::null_mut();
    // SAFETY: `address` is a writable pointer.
    ok(unsafe { zero_server_address(server, &mut address) });
    take_string(address)
        .expect("an address")
        .parse()
        .expect("a socket address")
}

/// Shut a server down, wait for it to stop, and free it.
pub fn stop(server: u64) {
    ok(zero_server_shutdown(server, ZERO_NONE));
    ok(zero_server_wait(server, 30_000));
    ok(zero_server_free(server));
}

/// A batch a poll took.
#[derive(Debug)]
pub struct Polled {
    pub batch: ZeroBatch,
    pub slots: Vec<u64>,
    pub routes: Vec<u32>,
    pub events: Vec<ZeroEvent>,
}

/// An empty event record.
pub const NO_EVENT: ZeroEvent = ZeroEvent {
    conn: 0,
    route: 0,
    kind: 0,
    opcode: 0,
    close_code: 0,
    data: ZeroBytes::ABSENT,
};

/// A batch descriptor with its size set, as a host prepares one.
pub fn batch_out() -> ZeroBatch {
    ZeroBatch {
        size: u32::try_from(size_of::<ZeroBatch>()).unwrap(),
        worker: 0,
        kind: 0,
        flags: 0,
        count: 0,
        reserved: 0,
        epoch: 0,
    }
}

/// Poll a target once.
pub fn poll(target: u64, timeout_ms: u64) -> Result<Polled, ZeroStatus> {
    let max = usize::try_from(ZERO_MAX_BATCH).unwrap();
    let mut batch = batch_out();
    let mut slots = vec![0u64; max];
    let mut routes = vec![0u32; max];
    let mut events = vec![NO_EVENT; max];
    // SAFETY: every array holds `max` writable entries, `ZeroEvent` ones of their own
    // size, and `batch` is a writable struct with its size set.
    let status = unsafe {
        zero_target_poll(
            target,
            timeout_ms,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            size_of::<ZeroEvent>(),
            max,
        )
    };
    if status != ZeroStatus::Ok {
        return Err(status);
    }
    let count = usize::try_from(batch.count).unwrap();
    if batch.kind == ZERO_BATCH_REQUESTS {
        slots.truncate(count);
        routes.truncate(count);
        events.clear();
    } else {
        slots.clear();
        routes.clear();
        events.truncate(count);
    }
    Ok(Polled {
        batch,
        slots,
        routes,
        events,
    })
}

/// Poll until a batch arrives, for up to twenty seconds.
#[track_caller]
pub fn poll_batch(target: u64) -> Polled {
    poll(target, 20_000).unwrap_or_else(|status| panic!("no batch: {status:?}: {}", last_error()))
}

/// Complete slots and acknowledge an epoch; the call's status and each id's status.
pub fn complete(worker: u8, ids: &[u64], epoch: u64) -> (ZeroStatus, Vec<ZeroStatus>) {
    let mut results = vec![ZeroStatus::Panic; ids.len()];
    // SAFETY: `ids` holds `len` readable ids and `results` as many writable statuses.
    let status = unsafe {
        zero_batch_complete(worker, ids.as_ptr(), ids.len(), epoch, results.as_mut_ptr())
    };
    (status, results)
}

/// Poll `done` every millisecond until it holds, for up to twenty seconds.
#[track_caller]
pub fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// One parsed response head and, when it has one, its body.
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

    pub fn headers_named(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
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
    pub fn connect(address: SocketAddr) -> Client {
        let stream = TcpStream::connect(address).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.set_nodelay(true).unwrap();
        Client { stream }
    }

    pub fn send(&mut self, request: &[u8]) {
        self.stream.write_all(request).expect("send");
    }

    /// Read a response head only.
    pub fn read_head(&mut self) -> io::Result<Reply> {
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
        let text = String::from_utf8(head).expect("a UTF-8 head");
        let mut lines = text.trim_end().split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .and_then(|code| code.parse().ok())
            .expect("a status line");
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(':').expect("a field line");
                (name.to_owned(), value.trim().to_owned())
            })
            .collect();
        Ok(Reply {
            status,
            headers,
            body: Vec::new(),
        })
    }

    /// Read one response: the head, then `Content-Length` octets of body.
    pub fn read(&mut self) -> io::Result<Reply> {
        let mut reply = self.read_head()?;
        let length: usize = reply
            .header("content-length")
            .map_or(0, |value| value.parse().expect("a length"));
        let mut body = vec![0u8; length];
        self.stream.read_exact(&mut body)?;
        reply.body = body;
        Ok(reply)
    }

    /// Read until the stream holds `wanted`, returning everything read.
    pub fn read_until(&mut self, wanted: &[u8]) -> io::Result<Vec<u8>> {
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        while !seen
            .windows(wanted.len().max(1))
            .any(|window| window == wanted)
        {
            let read = self.stream.read(&mut chunk)?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
            }
            seen.extend_from_slice(&chunk[..read]);
        }
        Ok(seen)
    }
}

/// A WebSocket opening handshake for `path`, with the RFC 6455 sample key.
pub fn upgrade_request(path: &str, protocols: Option<&str>) -> Vec<u8> {
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
    );
    if let Some(protocols) = protocols {
        request.push_str(&format!("Sec-WebSocket-Protocol: {protocols}\r\n"));
    }
    request.push_str("\r\n");
    request.into_bytes()
}
