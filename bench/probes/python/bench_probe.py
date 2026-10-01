import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "pyo3-probe"))
import pyo3_probe as probe  # noqa: E402


def bench(label, fn, iterations):
    for _ in range(200_000):
        fn()
    start = time.perf_counter_ns()
    sink = 0
    for _ in range(iterations):
        sink += fn()
    elapsed = time.perf_counter_ns() - start
    print(f"{label}: {elapsed / iterations:.1f} ns/call (sink {sink})")


n = 3_000_000
data = bytes([1]) * 256
req = probe.make_req()
bench("noop() sync", probe.noop, n)
bench("sum_bytes(bytes 256) borrowed &[u8]", lambda: probe.sum_bytes(data), n)
bench("take_str('/api/users/12345/profile')", lambda: probe.take_str("/api/users/12345/profile"), n)
bench("req.method getter", lambda: req.method, n)
bench("req.path getter -> str", lambda: len(req.path), n)
bench("req.header('user-agent') -> str", lambda: len(req.header("user-agent")), n)
bench("make_req() pyclass alloc", lambda: (probe.make_req(), 1)[1], 1_000_000)
bench("make_body(1024) bytes", lambda: len(probe.make_body(1024)), 1_000_000)


def handler(x):
    return x + 1


def batch_handler(items):
    s = 0
    for x in items:
        s += x
    return s


probe.call_back_attached(handler, 20_000)
ns = probe.call_back_attached(handler, 2_000_000)
print(f"Rust -> Python callback, attached on calling thread: {ns:.0f} ns/call, {1e9 / ns:,.0f} calls/s")
ns = probe.call_back_thread_attach_once(handler, 2_000_000)
print(f"Rust -> Python callback from a foreign thread, attach once: {ns:.0f} ns/call, {1e9 / ns:,.0f} calls/s")
ns = probe.call_back_thread_attach_each(handler, 500_000)
print(f"Rust -> Python callback from a foreign thread, attach per call: {ns:.0f} ns/call, {1e9 / ns:,.0f} calls/s")
for batch in (16, 64, 256):
    ns = probe.call_back_batched(batch_handler, 2_000_000, batch)
    print(f"Rust -> Python batched x{batch} items per call: {ns:.0f} ns/item, {1e9 / ns:,.0f} items/s")
print(sys.version, "gil enabled:", sys._is_gil_enabled() if hasattr(sys, "_is_gil_enabled") else "gil build")
