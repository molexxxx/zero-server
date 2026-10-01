//! The echo test of R.3 step 4: one worker per core, every core accepts and echoes,
//! and a connection that is idle holds no receive buffer, which the pool's lease count
//! shows from inside the core.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use zero_core::OwnedBuf;
use zero_io::rt::{serve, Acceptor, Config, Core};
use zero_io::seam::{Leased, Listener, Runtime, Shutdown, Stream};

/// Echo what arrives, then report how many buffers this core has out on lease.
async fn echo(core: Core, stream: zero_io::rt::TcpStream) {
    loop {
        let Some(read) = core.shutdown().until(stream.read_leased(&core.pool)).await else {
            return;
        };
        let mut buf = match read {
            Ok(Leased::Data(buf)) => buf,
            Ok(Leased::Eof | Leased::NoBudget) | Err(_) => return,
        };
        while !buf.is_empty() {
            let (written, back) = stream.write(buf).await;
            buf = back;
            match written {
                Ok(count) => {
                    if buf.consume(count).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    core.pool.release(buf);
                    return;
                }
            }
        }
        core.pool.release(buf);
        let report = format!("leased={}\n", core.pool.leased());
        let mut report = OwnedBuf::from_vec(report.into_bytes());
        while !report.is_empty() {
            let (written, back) = stream.write(report).await;
            report = back;
            match written {
                Ok(count) => {
                    if report.consume(count).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }
}

async fn per_core(core: Core, acceptor: Acceptor) -> io::Result<()> {
    while let Some(accepted) = core.shutdown().until(acceptor.accept()).await {
        let (stream, _) = accepted?;
        let worker = core.clone();
        core.spawn_local(echo(worker, stream));
    }
    Ok(())
}

fn config() -> Config {
    Config {
        drain: Duration::from_secs(2),
        listen: zero_io::rt::ListenConfig {
            handoff: std::env::var_os("ZERO_TEST_HANDOFF").is_some(),
            ..zero_io::rt::ListenConfig::default()
        },
        ..Config::default()
    }
}

/// Everything the connection answered with the lease reports taken out, and how many
/// reports there were.
fn read_echo(conn: &mut TcpStream, sent: usize) -> (Vec<u8>, usize) {
    let mut received = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut data = Vec::new();
    loop {
        let count = conn.read(&mut chunk).expect("the echo arrives in time");
        assert!(count > 0, "the connection closed early");
        received.extend_from_slice(&chunk[..count]);
        data.clear();
        let mut reports = 0;
        let mut rest = received.as_slice();
        while let Some(at) = rest.windows(7).position(|window| window == b"leased=") {
            data.extend_from_slice(&rest[..at]);
            let Some(end) = rest[at..].iter().position(|byte| *byte == b'\n') else {
                break;
            };
            assert_eq!(
                &rest[at..at + end],
                b"leased=0",
                "an idle core holds no buffer"
            );
            reports += 1;
            rest = &rest[at + end + 1..];
        }
        data.extend_from_slice(rest);
        if data.len() >= sent && reports > 0 && !received.ends_with(b"leased=") {
            let tail_complete = received.ends_with(b"\n");
            if tail_complete {
                return (data, reports);
            }
        }
    }
}

#[test]
fn every_core_echoes_and_an_idle_connection_holds_no_buffer() {
    let workers = serve("127.0.0.1:0".parse().unwrap(), config(), per_core).unwrap();
    let addr = workers.local_addr();
    let cores = workers.count();
    assert!(cores >= 1);

    let mut connections: Vec<TcpStream> = (0..cores * 3)
        .map(|_| {
            let conn = TcpStream::connect(addr).expect("a worker accepts");
            conn.set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            conn
        })
        .collect();
    for (index, conn) in connections.iter_mut().enumerate() {
        let line = format!("hello from connection {index}\n");
        conn.write_all(line.as_bytes()).unwrap();
        let (data, reports) = read_echo(conn, line.len());
        assert_eq!(data, line.as_bytes());
        assert!(reports >= 1);
    }

    let big = vec![b'x'; 20_000];
    let conn = connections.first_mut().expect("one connection");
    conn.write_all(&big).unwrap();
    let (data, reports) = read_echo(conn, big.len());
    assert_eq!(data, big, "a message longer than a block is echoed whole");
    assert!(reports >= 1);

    drop(connections);
    workers.stop().unwrap();
    assert!(
        TcpStream::connect(addr).is_err(),
        "the listeners are closed after stop"
    );
}

#[test]
fn stop_returns_promptly_with_idle_connections_open() {
    let workers = serve("127.0.0.1:0".parse().unwrap(), config(), per_core).unwrap();
    let addr = workers.local_addr();
    let idle: Vec<TcpStream> = (0..4).map(|_| TcpStream::connect(addr).unwrap()).collect();
    let started = std::time::Instant::now();
    workers.stop().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "stop took {:?}",
        started.elapsed()
    );
    drop(idle);
}

#[test]
fn a_fixed_thread_count_is_honored() {
    let config = Config {
        threads: 2,
        ..config()
    };
    let workers = serve("127.0.0.1:0".parse().unwrap(), config, per_core).unwrap();
    assert_eq!(workers.count(), 2);
    workers.stop().unwrap();
}
