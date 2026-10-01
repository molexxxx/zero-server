//! Probe addon: isolates the napi-rs costs that decide the handler model.

use std::sync::Arc;
use std::time::Instant;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;

/// Synchronous call with no arguments and a primitive return.
#[napi]
pub fn noop() -> u32
{
    1
}

/// Async fn: JS -> tokio worker -> Promise resolved on the main thread.
#[napi]
pub async fn noop_async() -> u32
{
    1
}

/// Borrowed view of a Buffer, no copy.
#[napi]
pub fn sum_slice(buf: BufferSlice) -> u32
{
    buf.iter().map(|b| *b as u32).sum()
}

/// Owned Buffer argument (napi_ref taken, bytes not copied).
#[napi]
pub fn sum_owned(buf: Buffer) -> u32
{
    buf.iter().map(|b| *b as u32).sum()
}

/// String argument: UTF-8 copied into a Rust String.
#[napi]
pub fn take_string(s: String) -> u32
{
    s.len() as u32
}

/// A request-like native object handed to JS as an opaque handle.
pub struct Req
{
    method: u8,
    path: String,
    headers: Vec<(String, String)>,
}

#[napi]
pub fn make_req() -> External<Req>
{
    External::new(Req {
        method: 1,
        path: "/json".to_owned(),
        headers: vec![
            ("host".to_owned(), "localhost".to_owned()),
            ("accept".to_owned(), "*/*".to_owned()),
            ("user-agent".to_owned(), "wrk".to_owned()),
        ],
    })
}

#[napi]
pub fn req_method(req: &External<Req>) -> u32
{
    req.method as u32
}

#[napi]
pub fn req_path(req: &External<Req>) -> String
{
    req.path.clone()
}

#[napi]
pub fn req_header(req: &External<Req>, name: String) -> Option<String>
{
    req.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone())
}

/// A Rust-owned response buffer handed to JS without a copy (external buffer).
#[napi]
pub fn make_body(size: u32) -> Buffer
{
    Buffer::from(vec![b'x'; size as usize])
}

type Callback = Arc<ThreadsafeFunction<u32, u32, u32, Status, false>>;

/// One tokio worker calls JS n times in sequence and waits for each return value.
#[napi]
pub async fn tsfn_sequential(cb: Callback, n: u32) -> Result<f64>
{
    let start = Instant::now();
    let mut sink = 0u32;
    for i in 0..n
    {
        sink = sink.wrapping_add(cb.call_async_catch(i).await?);
    }
    let ns = start.elapsed().as_nanos() as f64 / n as f64;
    if sink == u32::MAX
    {
        return Err(Error::from_reason("unreachable"));
    }
    Ok(ns)
}

/// `width` tokio tasks each call JS n/width times; measures pipelined throughput.
#[napi]
pub async fn tsfn_concurrent(cb: Callback, n: u32, width: u32) -> Result<f64>
{
    let per = n / width;
    let start = Instant::now();
    let mut handles = Vec::with_capacity(width as usize);
    for _ in 0..width
    {
        let cb = Arc::clone(&cb);
        handles.push(tokio::spawn(async move {
            let mut sink = 0u32;
            for i in 0..per
            {
                sink = sink.wrapping_add(cb.call_async_catch(i).await.unwrap_or(0));
            }
            sink
        }));
    }
    for handle in handles
    {
        handle.await.map_err(|e| Error::from_reason(e.to_string()))?;
    }
    Ok(start.elapsed().as_nanos() as f64 / (per * width) as f64)
}

/// Batched: one ThreadsafeFunction call carries `batch` items; JS returns one number.
/// Measures per-item cost when the crossing is amortized.
#[napi]
pub async fn tsfn_batched(cb: Arc<ThreadsafeFunction<Vec<u32>, u32, Vec<u32>, Status, false>>, n: u32, batch: u32) -> Result<f64>
{
    let rounds = n / batch;
    let start = Instant::now();
    for r in 0..rounds
    {
        let items: Vec<u32> = (0..batch).map(|i| r * batch + i).collect();
        cb.call_async_catch(items).await?;
    }
    Ok(start.elapsed().as_nanos() as f64 / (rounds * batch) as f64)
}

/// Batched with several batches in flight: `inflight` tokio tasks each issue batched
/// ThreadsafeFunction calls of `batch` items; measures per-item cost at small batch sizes
/// when the crossing is overlapped rather than serialized.
#[napi]
pub async fn tsfn_batched_inflight(cb: Arc<ThreadsafeFunction<Vec<u32>, u32, Vec<u32>, Status, false>>, n: u32, batch: u32, inflight: u32) -> Result<f64>
{
    let rounds = n / batch / inflight;
    let start = Instant::now();
    let mut handles = Vec::with_capacity(inflight as usize);
    for t in 0..inflight
    {
        let cb = Arc::clone(&cb);
        handles.push(tokio::spawn(async move {
            let mut sink = 0u32;
            for r in 0..rounds
            {
                let base = (t * rounds + r) * batch;
                let items: Vec<u32> = (0..batch).map(|i| base + i).collect();
                sink = sink.wrapping_add(cb.call_async_catch(items).await.unwrap_or(0));
            }
            sink
        }));
    }
    for handle in handles
    {
        handle.await.map_err(|e| Error::from_reason(e.to_string()))?;
    }
    Ok(start.elapsed().as_nanos() as f64 / (rounds * batch * inflight) as f64)
}

/// Fire-and-forget: NonBlocking calls with no return value, then one awaited call to flush.
#[napi]
pub async fn tsfn_fire_and_forget(cb: Callback, n: u32) -> Result<f64>
{
    let start = Instant::now();
    for i in 0..n
    {
        cb.call(i, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
    }
    cb.call_async_catch(n).await?;
    Ok(start.elapsed().as_nanos() as f64 / (n + 1) as f64)
}
