//! The two entries answer the json and plaintext tests as the Round 23 rules
//! require, and the load generator drives them with zero errors.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use zero_bench::entries::{config, start_platform, start_realistic};
use zero_bench::load;

fn fetch(addr: std::net::SocketAddr, path: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let mut conn = TcpStream::connect(addr).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    conn.write_all(format!("GET {path} HTTP/1.1\r\nHost: server\r\n\r\n").as_bytes())
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(conn.read(&mut byte).unwrap(), 1);
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
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| value.parse().unwrap());
    let mut body = vec![0u8; length];
    conn.read_exact(&mut body).unwrap();
    (status, headers, body)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn check_entry(addr: std::net::SocketAddr) {
    let (status, headers, body) = fetch(addr, "/json");
    assert_eq!(status, 200);
    assert_eq!(body, br#"{"message":"Hello, World!"}"#);
    assert_eq!(header(&headers, "content-type"), Some("application/json"));
    assert_eq!(header(&headers, "content-length"), Some("27"));
    assert_eq!(header(&headers, "server"), Some("zero"));
    assert!(header(&headers, "date").is_some_and(|date| date.ends_with(" GMT")));
    let (status, headers, body) = fetch(addr, "/plaintext");
    assert_eq!(status, 200);
    assert_eq!(body, b"Hello, World!");
    assert_eq!(header(&headers, "content-type"), Some("text/plain"));
    assert_eq!(header(&headers, "content-length"), Some("13"));
    assert_eq!(header(&headers, "server"), Some("zero"));
    let (status, _, _) = fetch(addr, "/nothing");
    assert_eq!(status, 404);
}

#[test]
fn the_realistic_entry_answers_json_and_plaintext_through_the_router() {
    let workers = start_realistic("127.0.0.1:0".parse().unwrap(), config(2, false)).unwrap();
    check_entry(workers.local_addr());
    let report = load::run(&load::Plan {
        addr: workers.local_addr(),
        host: "localhost".to_owned(),
        path: "/plaintext".to_owned(),
        connections: 16,
        threads: 2,
        pipeline: 16,
        duration: Duration::from_millis(500),
        warmup: Duration::from_millis(100),
    })
    .unwrap();
    assert_eq!(report.errors, 0, "{report:?}");
    assert!(report.requests > 1000, "{report:?}");
    assert!(report.latency_us(50.0).is_some());
    workers.stop().unwrap();
}

#[test]
fn the_platform_entry_answers_json_and_plaintext_on_the_raw_handler() {
    let workers = start_platform("127.0.0.1:0".parse().unwrap(), config(2, true)).unwrap();
    check_entry(workers.local_addr());
    let report = load::run(&load::Plan {
        addr: workers.local_addr(),
        host: "localhost".to_owned(),
        path: "/json".to_owned(),
        connections: 8,
        threads: 1,
        pipeline: 1,
        duration: Duration::from_millis(300),
        warmup: Duration::from_millis(100),
    })
    .unwrap();
    assert_eq!(report.errors, 0, "{report:?}");
    assert!(report.requests > 100, "{report:?}");
    workers.stop().unwrap();
}
