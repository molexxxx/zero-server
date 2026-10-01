import asyncio
import sys
import time

sys.path.insert(0, r"C:\Users\tonyw\Desktop\projects\zero-edge\bindings\python\packages\native\python")
from pamoja import _native  # noqa: E402

Transport = getattr(_native, "Transport", None) or getattr(_native, "PyTransport")


class Handlers:
    def __init__(self):
        self.calls = 0

    def connect(self):
        pass

    def send(self, topic, payload):
        self.calls += len(payload)

    def subscribe(self, topic):
        pass


class AsyncHandlers(Handlers):
    async def send(self, topic, payload):
        self.calls += len(payload)


async def run(label, handlers):
    transport = Transport.from_handlers(handlers)
    await transport.connect()
    payload = bytes(64)
    for _ in range(5000):
        await transport.send("t", payload)
    sequential = 50_000
    start = time.perf_counter_ns()
    for _ in range(sequential):
        await transport.send("t", payload)
    elapsed = time.perf_counter_ns() - start
    print(f"{label} sequential round trip (send 64 bytes, await): {elapsed / sequential:.0f} ns/call")
    for width in (16, 64, 256):
        rounds = 1000
        start = time.perf_counter_ns()
        for _ in range(rounds):
            await asyncio.gather(*(transport.send("t", payload) for _ in range(width)))
        elapsed = time.perf_counter_ns() - start
        total = rounds * width
        print(f"{label} concurrent x{width}: {elapsed / total:.0f} ns/call, {total / (elapsed / 1e9):,.0f} calls/s")


async def main():
    await run("sync handler", Handlers())
    await run("async handler", AsyncHandlers())

    handlers = Handlers()
    payload = bytes(64)

    async def py_send(topic, payload):
        handlers.send(topic, payload)

    sequential = 50_000
    start = time.perf_counter_ns()
    for _ in range(sequential):
        await py_send("t", payload)
    elapsed = time.perf_counter_ns() - start
    print(f"pure Python coroutine call + await: {elapsed / sequential:.0f} ns/call (sink {handlers.calls})")
    print(sys.version, "gil enabled:", sys._is_gil_enabled() if hasattr(sys, "_is_gil_enabled") else "gil build")


asyncio.run(main())
