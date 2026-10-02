//! The bytes-per-idle-connection probe: open
//! `connections` keep-alive connections to a server process, send one request on
//! each so that it has been through the lazy-lease path, leave them idle, and read
//! the server's resident set before and after from `/proc/<pid>/status`.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// What the probe measured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measurement {
    /// Connections that were open and idle when the second reading was taken.
    pub connections: usize,
    /// The server's resident set before the connections, in bytes.
    pub rss_before: u64,
    /// The server's resident set with the connections idle, in bytes.
    pub rss_after: u64,
}

impl Measurement {
    /// Resident bytes the server grew by per idle connection.
    #[must_use]
    pub fn bytes_per_connection(&self) -> u64 {
        if self.connections == 0 {
            return 0;
        }
        self.rss_after.saturating_sub(self.rss_before) / self.connections as u64
    }
}

/// The resident set of a process, from `/proc/<pid>/status` (`VmRSS`, in kB).
///
/// # Arguments
///
/// * `pid` - the process.
///
/// # Errors
///
/// When the file cannot be read or holds no `VmRSS` line.
pub fn resident_bytes(pid: u32) -> io::Result<u64> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.trim().split(' ').next())
        .and_then(|kb| kb.parse::<u64>().ok())
        .map(|kb| kb * 1024)
        .ok_or_else(|| io::Error::other("no VmRSS line"))
}

/// Open the connections and take the readings.
///
/// # Arguments
///
/// * `pid` - the server process.
/// * `addr` - where it listens.
/// * `path` - the request target each connection fetches once.
/// * `connections` - how many to open.
/// * `settle` - how long to wait before the second reading.
///
/// # Errors
///
/// A connect or read failure, or an unreadable process status.
pub fn measure(
    pid: u32,
    addr: SocketAddr,
    path: &str,
    connections: usize,
    settle: Duration,
) -> io::Result<Measurement> {
    let rss_before = resident_bytes(pid)?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: idle\r\n\r\n");
    let mut open = Vec::with_capacity(connections);
    let started = Instant::now();
    for index in 0..connections {
        let mut stream = TcpStream::connect(addr)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.write_all(request.as_bytes())?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        let length: usize = loop {
            if stream.read(&mut byte)? == 0 {
                return Err(io::Error::other(format!(
                    "connection {index} closed in the head"
                )));
            }
            head.push(byte[0]);
            if head.ends_with(b"\r\n\r\n") {
                let text = String::from_utf8_lossy(&head);
                break text
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
            }
        };
        let mut body = vec![0u8; length];
        stream.read_exact(&mut body)?;
        open.push(stream);
        if started.elapsed() > Duration::from_secs(120) {
            return Err(io::Error::other(
                "opening the connections took over two minutes",
            ));
        }
    }
    std::thread::sleep(settle);
    let rss_after = resident_bytes(pid)?;
    let measurement = Measurement {
        connections: open.len(),
        rss_before,
        rss_after,
    };
    drop(open);
    Ok(measurement)
}

#[cfg(test)]
mod tests {
    use super::{resident_bytes, Measurement};

    #[test]
    fn the_own_process_has_a_resident_set_and_the_division_is_per_connection() {
        let rss = resident_bytes(std::process::id()).unwrap_or(0);
        assert!(rss > 0, "this process is resident");
        let measurement = Measurement {
            connections: 1000,
            rss_before: 10_000_000,
            rss_after: 12_500_000,
        };
        assert_eq!(measurement.bytes_per_connection(), 2_500);
    }
}
