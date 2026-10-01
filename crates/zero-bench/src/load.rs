//! The pipelined HTTP/1.1 load generator: `connections` connections spread over
//! `threads` runtimes, each writing `pipeline` requests at once and reading the
//! responses back, for `duration`. Every response is parsed (status line, fields,
//! `Content-Length` body), so a response that is not `200` or does not parse is an
//! error, which is what the acceptance rules count.

use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// What a run is.
#[derive(Clone, Debug)]
pub struct Plan {
    /// The server.
    pub addr: SocketAddr,
    /// The request target.
    pub path: String,
    /// The `Host` value.
    pub host: String,
    /// How many connections in all.
    pub connections: usize,
    /// How many runtimes, each on its own thread.
    pub threads: usize,
    /// Requests written per batch on each connection.
    pub pipeline: usize,
    /// How long to run after the warm-up.
    pub duration: Duration,
    /// How long to run before counting.
    pub warmup: Duration,
}

/// What a run measured.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// Responses with status 200 that parsed, during the measured window.
    pub requests: u64,
    /// Responses with another status, responses that did not parse, and
    /// connections that failed, during the measured window.
    pub errors: u64,
    /// Bytes read during the measured window.
    pub bytes: u64,
    /// The measured window.
    pub elapsed: Duration,
    /// Batch round trips in microseconds, sorted, sampled from every connection.
    pub latencies_us: Vec<u64>,
}

impl Report {
    /// Requests per second over the measured window.
    #[must_use]
    pub fn rate(&self) -> f64 {
        let seconds = self.elapsed.as_secs_f64();
        if seconds <= 0.0 {
            return 0.0;
        }
        self.requests as f64 / seconds
    }

    /// The latency at a percentile, in microseconds.
    ///
    /// # Arguments
    ///
    /// * `percentile` - 0 to 100.
    #[must_use]
    pub fn latency_us(&self, percentile: f64) -> Option<u64> {
        if self.latencies_us.is_empty() {
            return None;
        }
        // The nearest-rank percentile: the smallest sample with at least this share
        // of the samples at or below it.
        let rank = ((percentile / 100.0) * self.latencies_us.len() as f64).ceil() as usize;
        let index = rank.saturating_sub(1).min(self.latencies_us.len() - 1);
        self.latencies_us.get(index).copied()
    }
}

struct Counters {
    measuring: AtomicBool,
    stop: AtomicBool,
    requests: AtomicU64,
    errors: AtomicU64,
    bytes: AtomicU64,
}

/// Run the plan.
///
/// # Arguments
///
/// * `plan` - what to do.
///
/// # Returns
///
/// The report over the measured window.
///
/// # Errors
///
/// When a runtime or thread cannot be started.
pub fn run(plan: &Plan) -> io::Result<Report> {
    let counters = Arc::new(Counters {
        measuring: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        requests: AtomicU64::new(0),
        errors: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
    });
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: zero-bench\r\nAccept: */*\r\n\r\n",
        plan.path, plan.host
    );
    let batch: Arc<[u8]> = request.repeat(plan.pipeline.max(1)).into_bytes().into();
    let threads = plan.threads.max(1);
    let per_thread = plan.connections.max(1).div_ceil(threads);
    let mut handles = Vec::with_capacity(threads);
    for thread_index in 0..threads {
        let count = per_thread.min(plan.connections.saturating_sub(thread_index * per_thread));
        if count == 0 {
            break;
        }
        let counters = Arc::clone(&counters);
        let batch = Arc::clone(&batch);
        let addr = plan.addr;
        let pipeline = plan.pipeline.max(1);
        let handle = thread::Builder::new()
            .name(format!("zero-load-{thread_index}"))
            .spawn(move || -> io::Result<Vec<u64>> {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_io()
                    .enable_time()
                    .build()?;
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, async move {
                    let mut tasks = Vec::with_capacity(count);
                    for _ in 0..count {
                        let counters = Arc::clone(&counters);
                        let batch = Arc::clone(&batch);
                        tasks.push(tokio::task::spawn_local(connection(
                            addr, batch, pipeline, counters,
                        )));
                    }
                    let mut latencies = Vec::new();
                    for task in tasks {
                        if let Ok(samples) = task.await {
                            latencies.extend(samples);
                        }
                    }
                    Ok(latencies)
                })
            })?;
        handles.push(handle);
    }
    thread::sleep(plan.warmup);
    counters.measuring.store(true, Ordering::SeqCst);
    let started = Instant::now();
    thread::sleep(plan.duration);
    let elapsed = started.elapsed();
    counters.measuring.store(false, Ordering::SeqCst);
    counters.stop.store(true, Ordering::SeqCst);
    let mut latencies = Vec::new();
    for handle in handles {
        match handle.join() {
            Ok(Ok(samples)) => latencies.extend(samples),
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(io::Error::other("a load thread panicked")),
        }
    }
    latencies.sort_unstable();
    Ok(Report {
        requests: counters.requests.load(Ordering::SeqCst),
        errors: counters.errors.load(Ordering::SeqCst),
        bytes: counters.bytes.load(Ordering::SeqCst),
        elapsed,
        latencies_us: latencies,
    })
}

/// One connection: batches until told to stop; reconnects after a failure, which
/// counts as an error when measuring.
async fn connection(
    addr: SocketAddr,
    batch: Arc<[u8]>,
    pipeline: usize,
    counters: Arc<Counters>,
) -> Vec<u64> {
    let mut latencies = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    while !counters.stop.load(Ordering::Relaxed) {
        let Ok(mut stream) = TcpStream::connect(addr).await else {
            if counters.measuring.load(Ordering::Relaxed) {
                counters.errors.fetch_add(1, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        };
        let _ = stream.set_nodelay(true);
        let mut parser = Parser::default();
        while !counters.stop.load(Ordering::Relaxed) {
            let started = Instant::now();
            if stream.write_all(&batch).await.is_err() {
                break;
            }
            let mut outstanding = pipeline;
            let mut failed = false;
            while outstanding > 0 {
                let count = match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => {
                        failed = true;
                        break;
                    }
                    Ok(count) => count,
                };
                let measuring = counters.measuring.load(Ordering::Relaxed);
                if measuring {
                    counters.bytes.fetch_add(count as u64, Ordering::Relaxed);
                }
                for outcome in parser.feed(&buffer[..count]) {
                    outstanding = outstanding.saturating_sub(1);
                    if measuring {
                        match outcome {
                            Outcome::Ok => counters.requests.fetch_add(1, Ordering::Relaxed),
                            Outcome::Bad => counters.errors.fetch_add(1, Ordering::Relaxed),
                        };
                    }
                }
            }
            if failed {
                if counters.measuring.load(Ordering::Relaxed) {
                    counters
                        .errors
                        .fetch_add(outstanding as u64, Ordering::Relaxed);
                }
                break;
            }
            if counters.measuring.load(Ordering::Relaxed) && latencies.len() < 100_000 {
                latencies.push(started.elapsed().as_micros() as u64);
            }
        }
    }
    latencies
}

/// How one response went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    Bad,
}

/// A response parser over a byte stream: head until the empty line, then
/// `Content-Length` body bytes.
#[derive(Debug, Default)]
struct Parser {
    head: Vec<u8>,
    body_left: usize,
    status_ok: bool,
}

impl Parser {
    /// Feed bytes; yields one outcome per completed response.
    fn feed(&mut self, mut input: &[u8]) -> Vec<Outcome> {
        let mut outcomes = Vec::new();
        while !input.is_empty() {
            if self.body_left > 0 {
                let take = self.body_left.min(input.len());
                self.body_left -= take;
                input = &input[take..];
                if self.body_left == 0 {
                    outcomes.push(if self.status_ok {
                        Outcome::Ok
                    } else {
                        Outcome::Bad
                    });
                }
                continue;
            }
            self.head.extend_from_slice(input);
            input = &[];
            while let Some(end) = find_head_end(&self.head) {
                let rest = self.head.split_off(end + 4);
                let head = std::mem::take(&mut self.head);
                self.head = rest;
                match parse_head(&head) {
                    Some((status, length)) => {
                        self.status_ok = status == 200;
                        self.body_left = length;
                        if length == 0 {
                            outcomes.push(if self.status_ok {
                                Outcome::Ok
                            } else {
                                Outcome::Bad
                            });
                        } else {
                            // The body may already be in `self.head`; move it through
                            // the body path.
                            let pending = std::mem::take(&mut self.head);
                            outcomes.extend(self.feed(&pending));
                            break;
                        }
                    }
                    None => {
                        outcomes.push(Outcome::Bad);
                    }
                }
            }
        }
        outcomes
    }
}

fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// The status code and the `Content-Length` of a head.
fn parse_head(head: &[u8]) -> Option<(u16, usize)> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let status: u16 = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let mut length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok()?;
            }
        }
    }
    Some((status, length))
}

#[cfg(test)]
mod tests {
    use super::{Outcome, Parser, Report};

    #[test]
    fn the_response_parser_counts_complete_responses_across_reads() {
        let mut parser = Parser::default();
        let one = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
        assert_eq!(parser.feed(one), [Outcome::Ok]);
        let two = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloHTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Len";
        assert_eq!(parser.feed(two), [Outcome::Ok, Outcome::Bad]);
        assert_eq!(parser.feed(b"gth: 2\r\n\r\nh"), []);
        assert_eq!(parser.feed(b"i"), [Outcome::Ok]);
        assert_eq!(parser.feed(b"garbage\r\n\r\n"), [Outcome::Bad]);
    }

    #[test]
    fn the_report_computes_rates_and_percentiles() {
        let report = Report {
            requests: 1000,
            elapsed: std::time::Duration::from_secs(2),
            latencies_us: (1..=100).collect(),
            ..Report::default()
        };
        assert!((report.rate() - 500.0).abs() < 1e-9);
        assert_eq!(report.latency_us(50.0), Some(50));
        assert_eq!(report.latency_us(99.0), Some(99));
        assert_eq!(report.latency_us(100.0), Some(100));
        assert_eq!(Report::default().latency_us(50.0), None);
    }
}
