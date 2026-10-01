import sys
import time

sys.path.insert(0, r"C:\Users\tonyw\Desktop\projects\zero-edge\bindings\python\packages\native\python")
from pamoja import _native  # noqa: E402


def py_version():
    return "0.2.0"


def bench(label, fn, iterations):
    for _ in range(200_000):
        fn()
    start = time.perf_counter_ns()
    sink = 0
    for _ in range(iterations):
        sink += len(fn())
    elapsed = time.perf_counter_ns() - start
    print(f"{label}: {elapsed / iterations:.1f} ns/call (sink {sink})")


n = 3_000_000
bench("python function returning str", py_version, n)
bench("pyo3 version() returning String", _native.version, n)
samples = list(range(64))
encoded = _native.encode_delta_samples(samples)
bench("pyo3 encode_delta_samples(64 ints) -> bytes", lambda: _native.encode_delta_samples(samples), 500_000)
bench("pyo3 decode_delta_samples(bytes) -> list", lambda: _native.decode_delta_samples(encoded), 500_000)
print(sys.version, sys._is_gil_enabled() if hasattr(sys, "_is_gil_enabled") else "gil build")
