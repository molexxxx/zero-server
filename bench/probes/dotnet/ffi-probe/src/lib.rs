//! Probe C ABI: reverse P/Invoke cost from the calling thread and from a native thread.

use std::time::Instant;

pub type Callback = unsafe extern "C" fn(u32) -> u32;

/// Calls `cb` n times on the calling thread; returns ns per call.
#[no_mangle]
pub unsafe extern "C" fn probe_call_n(cb: Callback, n: u32) -> f64
{
    let start = Instant::now();
    let mut sink = 0u32;
    for i in 0..n
    {
        sink = sink.wrapping_add(cb(i));
    }
    std::hint::black_box(sink);
    start.elapsed().as_nanos() as f64 / n as f64
}

/// Spawns a native thread that has never run managed code and calls `cb` n times there.
#[no_mangle]
pub unsafe extern "C" fn probe_call_n_thread(cb: Callback, n: u32) -> f64
{
    let cb = cb as usize;
    std::thread::spawn(move || {
        let cb: Callback = std::mem::transmute(cb);
        let start = Instant::now();
        let mut sink = 0u32;
        for i in 0..n
        {
            sink = sink.wrapping_add(cb(i));
        }
        std::hint::black_box(sink);
        start.elapsed().as_nanos() as f64 / n as f64
    })
    .join()
    .unwrap_or(-1.0)
}

/// A request view: pointer plus length pairs that .NET reads as ReadOnlySpan<byte>.
#[repr(C)]
pub struct ProbeView
{
    pub method: u8,
    pub path_ptr: *const u8,
    pub path_len: usize,
}

static PATH: &[u8] = b"/api/users/12345/profile";

/// Fills a caller-owned view struct; nothing is allocated.
#[no_mangle]
pub unsafe extern "C" fn probe_fill_view(out: *mut ProbeView)
{
    (*out).method = 1;
    (*out).path_ptr = PATH.as_ptr();
    (*out).path_len = PATH.len();
}
