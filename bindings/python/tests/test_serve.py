"""A pull target served from Python, the shape of a synchronous handler thread: a
``threading.Thread`` loops on ``zero_target_poll``, reads each request through
``zero_req_view``, answers it with ``zero_res_respond`` and acknowledges the batch, while
a client in the test thread asserts the responses; ``zero_target_detach`` ends the loop."""

import ctypes
import threading

import cabi
from cabi import Status


class Spinner:
    """A thread that runs nothing but Python bytecode, counting its turns until stopped."""

    def __init__(self) -> None:
        self._turns = 0
        self._changed = threading.Condition()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._spin, name="spinner", daemon=True)

    def _spin(self) -> None:
        while not self._stop.is_set():
            with self._changed:
                self._turns += 1
                self._changed.notify_all()

    def start(self) -> None:
        """Start counting."""
        self._thread.start()

    def stop(self) -> None:
        """Stop counting and wait for the thread to end."""
        self._stop.set()
        self._thread.join(cabi.WAIT_SECONDS)

    def turns(self) -> int:
        """How many turns the thread has counted."""
        with self._changed:
            return self._turns

    def passes(self, mark: int) -> bool:
        """Wait until the thread has counted past ``mark``; false when it did not within
        ``WAIT_SECONDS``."""
        with self._changed:
            return self._changed.wait_for(lambda: self._turns > mark, cabi.WAIT_SECONDS)


def hello(request: cabi.Request) -> cabi.Response:
    """Answer ``/hello`` with a greeting, and any other target 404."""
    return cabi.Response(
        status=200 if request.target == b"/hello" else 404,
        fields=[(b"Content-Type", b"text/plain")],
        body=b"hello",
    )


def test_a_pull_target_serves_while_the_interpreter_runs_other_threads(lib):
    """A ``CDLL`` call releases the global interpreter lock: "The Python global interpreter
    lock is released before calling any function exported by these libraries, and
    reacquired afterwards", and a ``PyDLL`` instance behaves like a ``CDLL`` one "except
    that the Python GIL is not released during the function call" (Python 3.11 ctypes,
    Loading shared libraries). So the serving thread blocks in ``zero_target_poll``
    without holding it: a thread of pure Python keeps counting through that poll, and
    this thread connects and sends the request that ends it."""
    spinner = Spinner()
    spinner.start()
    site = cabi.Site(lib, hello, ticks=spinner.turns)
    try:
        assert site.polling.wait(cabi.WAIT_SECONDS), "the serving thread never polled"
        mark = spinner.turns()
        assert spinner.passes(mark), "no Python thread ran while the serving thread polled"
        reply = cabi.exchange(site.address, b"GET /hello HTTP/1.1\r\nHost: t\r\n\r\n")
    finally:
        spinner.stop()
        last = site.close()
    assert reply.status == 200
    assert reply.body == b"hello"
    assert reply.field("content-type") == "text/plain"
    assert last == Status.CLOSED
    first = site.polls[0]
    assert first.status == Status.OK, "the first poll returned the request it waited for"
    assert first.ticks_after > first.ticks_before, "the spinner ran inside the first poll"
    assert [request.route for request in site.served] == [site.hello]


def test_detaching_the_target_ends_the_poll_loop_with_closed(lib):
    site = cabi.Site(lib, hello)
    assert site.polling.wait(cabi.WAIT_SECONDS), "the serving thread never polled"
    assert site.close() == Status.CLOSED
    assert [poll.status for poll in site.polls][-1:] == [Status.CLOSED]
    assert site.served == []


def test_a_request_no_route_matches_reaches_the_miss_route_with_the_core_status(lib):
    site = cabi.Site(lib, hello)
    try:
        reply = cabi.exchange(site.address, b"POST /elsewhere HTTP/1.1\r\nHost: t\r\n\r\n")
    finally:
        site.close()
    assert reply.status == 404
    [request] = site.served
    assert request.route == site.miss
    assert request.method == b"POST"
    assert request.miss_status == 404


def test_a_slot_id_reads_closed_once_its_response_was_sent(lib):
    site = cabi.Site(lib, hello)
    try:
        reply = cabi.exchange(site.address, b"GET /hello HTTP/1.1\r\nHost: t\r\n\r\n")
        assert reply.status == 200
        [request] = site.served
        route = ctypes.c_uint32()

        def retired() -> bool:
            return lib.zero_slot_route(request.slot, ctypes.byref(route)) == Status.CLOSED

        cabi.eventually("the answered slot to retire", retired)
    finally:
        site.close()
