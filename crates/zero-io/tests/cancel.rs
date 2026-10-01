//! The seam's cancellation contract on both backends: a connection driver drops a
//! read or a write whenever another event wins the turn, so a dropped read must lose
//! no bytes and a dropped write, retried with the same bytes, must neither lose nor
//! repeat any.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::future::{poll_fn, Future};
use std::io::{self, IoSlice, Read, Write};
use std::net::TcpStream;
use std::pin::{pin, Pin};
use std::task::{Context, Poll};
use std::time::Duration;

use zero_io::rt::{serve, Acceptor, Config, Core};
use zero_io::seam::{Leased, Listener, Runtime, Shutdown, Stream};

const UPLOAD: usize = 400_000;
const DOWNLOAD: usize = 4_000_000;

fn pattern(at: usize) -> u8 {
    (at % 251) as u8
}

/// A future that is pending once, waking itself, and then ready: it wins every
/// other turn against anything that is not ready at once.
struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            return Poll::Ready(());
        }
        self.0 = true;
        cx.waker().wake_by_ref();
        Poll::Pending
    }
}

/// Poll `work` and then a yield each turn; `None` when the yield won and `work` was
/// dropped.
async fn race<F: Future>(work: F) -> Option<F::Output> {
    let mut work = pin!(work);
    let mut other = pin!(YieldOnce(false));
    poll_fn(|cx| {
        if let Poll::Ready(value) = work.as_mut().poll(cx) {
            return Poll::Ready(Some(value));
        }
        if other.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

async fn exchange(core: Core, stream: zero_io::rt::TcpStream) {
    let mut received = 0usize;
    let mut intact = true;
    while received < UPLOAD {
        let Some(read) = race(stream.read_leased(&core.pool)).await else {
            continue;
        };
        let Ok(Leased::Data(buf)) = read else {
            return;
        };
        for &byte in buf.filled() {
            intact &= byte == pattern(received);
            received += 1;
        }
        core.pool.release(buf);
    }
    let mut data: Vec<u8> = (0..DOWNLOAD).map(pattern).collect();
    if !intact {
        data = b"the upload arrived damaged".to_vec();
    }
    let mut sent = 0usize;
    while sent < data.len() {
        let rest = &data[sent..];
        let Some(written) = race(stream.writev(&[IoSlice::new(rest)])).await else {
            continue;
        };
        match written {
            Ok(count) if count > 0 && count <= rest.len() => sent += count,
            _ => return,
        }
    }
    let _ = stream.close_write().await;
}

async fn per_core(core: Core, acceptor: Acceptor) -> io::Result<()> {
    while let Some(accepted) = core.shutdown().until(acceptor.accept()).await {
        let (stream, _) = accepted?;
        core.spawn_local(exchange(core.clone(), stream));
    }
    Ok(())
}

#[test]
fn reads_and_writes_dropped_mid_flight_lose_and_repeat_no_bytes() {
    let config = Config {
        threads: 1,
        drain: Duration::from_secs(2),
        ..Config::default()
    };
    let workers = serve("127.0.0.1:0".parse().unwrap(), config, per_core).unwrap();
    let mut conn = TcpStream::connect(workers.local_addr()).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let upload: Vec<u8> = (0..UPLOAD).map(pattern).collect();
    for chunk in upload.chunks(1_000) {
        conn.write_all(chunk).unwrap();
    }
    let mut download = Vec::with_capacity(DOWNLOAD);
    conn.read_to_end(&mut download).unwrap();
    assert_eq!(
        download.len(),
        DOWNLOAD,
        "{:?}",
        String::from_utf8_lossy(&download[..download.len().min(64)])
    );
    let first_wrong = download
        .iter()
        .enumerate()
        .position(|(at, &byte)| byte != pattern(at));
    assert_eq!(first_wrong, None, "every byte once, in order");
    workers.stop().unwrap();
}
