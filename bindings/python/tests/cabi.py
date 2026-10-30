"""The C ABI of ``libzero_ffi`` declared for ctypes from ``include/zero.h``, and what the
tests over it share: loading the library, reading owned strings and buffers, a one-thread
server whose pull target a Python thread serves, and a loopback client.

The library is the one ``cargo build -p zero-ffi --release`` writes. ``ZERO_FFI_LIBRARY``
names its path; without it the tests look in the ``release`` directory of
``CARGO_TARGET_DIR``, or of ``target`` at the repository root.

Nothing here is a ``CFUNCTYPE``: the library never calls a host function pointer, and a
ctypes callback entered on a thread Python did not create runs on "a new dummy Python
thread on every invocation" (Python 3.11 ctypes, Callback functions).
"""

from __future__ import annotations

import ctypes
import enum
import json
import os
import pathlib
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

#: The repository root, which holds ``conformance/vectors.json``.
ROOT = pathlib.Path(__file__).resolve().parents[3]

#: The environment variable that names the shared library's path.
LIBRARY_VARIABLE = "ZERO_FFI_LIBRARY"

ABI_VERSION = 1
ID_MAX = (1 << 53) - 1
NONE = (1 << 64) - 1
EPOCH_NONE = 0
MAX_BATCH = 256
HEADER_COUNT = 49
METHOD_GET = 0
ROUTE_HOST = 0
BATCH_REQUESTS = 1
VIEW_KEEP_ALIVE = 4

#: How long a poll, a wait or a socket read blocks, in milliseconds: far beyond any
#: loopback round trip, so reaching it means a call did not return when it should have.
WAIT_MS = 30_000
WAIT_SECONDS = WAIT_MS / 1000


class Status(enum.IntEnum):
    """``ZeroStatus``: what a call ended with."""

    OK = 0
    PROTOCOL = 1
    IO = 2
    CODEC = 3
    CLOSED = 4
    AUTH = 5
    UNSUPPORTED = 6
    TIMEOUT = 7
    LIMIT = 8
    INVALID_ARGUMENT = 9
    PANIC = 10


class Bytes(ctypes.Structure):
    """``ZeroBytes``: a read-only byte range; ``{NULL, 0}`` means absent."""

    _fields_ = [("ptr", ctypes.c_void_p), ("len", ctypes.c_size_t)]


class Span(ctypes.Structure):
    """``ZeroSpan``: a range of the request head as offset and length."""

    _fields_ = [("start", ctypes.c_uint32), ("len", ctypes.c_uint32)]


class Field(ctypes.Structure):
    """``ZeroField``: one field line of the request head, as spans into the head."""

    _fields_ = [("name", Span), ("value", Span), ("id", ctypes.c_uint32)]


class RequestView(ctypes.Structure):
    """``ZeroRequestView``: the request of a leased slot in one read."""

    _fields_ = [
        ("size", ctypes.c_uint32),
        ("method", ctypes.c_uint8),
        ("version", ctypes.c_uint8),
        ("flags", ctypes.c_uint16),
        ("route", ctypes.c_uint32),
        ("miss_status", ctypes.c_uint16),
        ("allow", ctypes.c_uint16),
        ("head", ctypes.c_void_p),
        ("head_len", ctypes.c_uint32),
        ("field_count", ctypes.c_uint32),
        ("method_token", Span),
        ("target", Span),
        ("path", Span),
        ("query", Span),
        ("authority", Span),
        ("fields", ctypes.c_void_p),
        ("route_path", ctypes.c_void_p),
        ("route_path_len", ctypes.c_uint32),
        ("param_count", ctypes.c_uint32),
        ("body", ctypes.c_void_p),
        ("body_len", ctypes.c_uint64),
        ("field_size", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
    ]


class HeaderPair(ctypes.Structure):
    """``ZeroHeaderPair``: one field line a host writes."""

    _fields_ = [("name", Bytes), ("value", Bytes)]


class ResponseSpec(ctypes.Structure):
    """``ZeroResponseSpec``: a whole response in one call."""

    _fields_ = [
        ("size", ctypes.c_uint32),
        ("status", ctypes.c_uint16),
        ("reserved", ctypes.c_uint16),
        ("field_size", ctypes.c_uint32),
        ("reserved2", ctypes.c_uint32),
        ("fields", ctypes.c_void_p),
        ("field_count", ctypes.c_size_t),
        ("body", Bytes),
    ]


class Batch(ctypes.Structure):
    """``ZeroBatch``: one batch a target took."""

    _fields_ = [
        ("size", ctypes.c_uint32),
        ("worker", ctypes.c_uint8),
        ("kind", ctypes.c_uint8),
        ("flags", ctypes.c_uint16),
        ("count", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("epoch", ctypes.c_uint64),
    ]


class Event(ctypes.Structure):
    """``ZeroEvent``: one WebSocket or server-sent event of an event batch."""

    _fields_ = [
        ("conn", ctypes.c_uint64),
        ("route", ctypes.c_uint32),
        ("kind", ctypes.c_uint8),
        ("opcode", ctypes.c_uint8),
        ("close_code", ctypes.c_uint16),
        ("data", Bytes),
    ]


_U8 = ctypes.c_uint8
_U16 = ctypes.c_uint16
_U32 = ctypes.c_uint32
_U64 = ctypes.c_uint64
_SIZE = ctypes.c_size_t
_RANGE = ctypes.c_char_p
_HANDLE = ctypes.c_void_p
_STATUS = ctypes.c_int
_OUT = ctypes.POINTER

#: The prototype of every export the tests call, as (return type, argument types).
PROTOTYPES: dict[str, tuple[object, tuple[object, ...]]] = {
    "zero_version": (ctypes.c_char_p, ()),
    "zero_abi_version": (_U32, ()),
    "zero_last_error_message": (_HANDLE, ()),
    "zero_string_data": (ctypes.c_void_p, (_HANDLE,)),
    "zero_string_len": (_SIZE, (_HANDLE,)),
    "zero_string_free": (None, (_HANDLE,)),
    "zero_buffer_data": (ctypes.c_void_p, (_HANDLE,)),
    "zero_buffer_len": (_SIZE, (_HANDLE,)),
    "zero_buffer_free": (None, (_HANDLE,)),
    "zero_header_name": (_STATUS, (_U32, _OUT(Bytes))),
    "zero_header_id": (_STATUS, (_RANGE, _SIZE, _OUT(_U32))),
    "zero_field_validate": (_STATUS, (_RANGE, _SIZE, _RANGE, _SIZE)),
    "zero_conformance_case": (_STATUS, (_RANGE, _SIZE, _RANGE, _SIZE, _OUT(_HANDLE))),
    "zero_app_new": (_STATUS, (_OUT(_U64),)),
    "zero_app_free": (_STATUS, (_U64,)),
    "zero_app_route": (
        _STATUS,
        (_U64, _U32, _U8, _RANGE, _SIZE, _RANGE, _SIZE, _OUT(_U32)),
    ),
    "zero_app_miss": (_STATUS, (_U64, _OUT(_U32))),
    "zero_server_new": (_STATUS, (_U64, _RANGE, _SIZE, _OUT(_U64))),
    "zero_server_start": (_STATUS, (_U64,)),
    "zero_server_address": (_STATUS, (_U64, _OUT(_HANDLE))),
    "zero_server_workers": (_STATUS, (_U64, _OUT(_U8), _SIZE, _OUT(_SIZE))),
    "zero_server_shutdown": (_STATUS, (_U64, _U64)),
    "zero_server_wait": (_STATUS, (_U64, _U64)),
    "zero_server_free": (_STATUS, (_U64,)),
    "zero_target_attach": (_STATUS, (_U64, _U32, _OUT(_U64))),
    "zero_target_poll": (
        _STATUS,
        (_U64, _U64, _OUT(Batch), _OUT(_U64), _OUT(_U32), _OUT(Event), _SIZE, _SIZE),
    ),
    "zero_target_detach": (_STATUS, (_U64,)),
    "zero_batch_complete": (_STATUS, (_U8, _OUT(_U64), _SIZE, _U64, _OUT(_STATUS))),
    "zero_slot_route": (_STATUS, (_U64, _OUT(_U32))),
    "zero_req_method": (_STATUS, (_U64, _OUT(_U8))),
    "zero_req_view": (_STATUS, (_U64, _OUT(RequestView))),
    "zero_res_respond": (_STATUS, (_U64, _OUT(ResponseSpec))),
}


def library_name() -> str:
    """The file name of the shared library on this platform."""
    if sys.platform == "win32":
        return "zero_ffi.dll"
    if sys.platform == "darwin":
        return "libzero_ffi.dylib"
    return "libzero_ffi.so"


def library_path() -> pathlib.Path:
    """The path of the shared library the tests load."""
    configured = os.environ.get(LIBRARY_VARIABLE)
    if configured:
        return pathlib.Path(configured)
    target = os.environ.get("CARGO_TARGET_DIR")
    base = pathlib.Path(target) if target else ROOT / "target"
    return base / "release" / library_name()


def load() -> ctypes.CDLL:
    """Load the shared library with ``ctypes.CDLL`` and declare every prototype the tests
    call.

    Raises:
        FileNotFoundError: the library is not where ``library_path`` looks.
    """
    path = library_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"{path} does not exist: run `cargo build -p zero-ffi --release`, "
            f"or set {LIBRARY_VARIABLE} to the library's path"
        )
    library = ctypes.CDLL(str(path))
    for name, (restype, argtypes) in PROTOTYPES.items():
        function = getattr(library, name)
        function.restype = restype
        function.argtypes = argtypes
    return library


class Refused(AssertionError):
    """A call a test expected to succeed returned another status."""


def take_string(lib: ctypes.CDLL, handle: int | None) -> str | None:
    """Copy an owned string out and free it; ``None`` for NULL."""
    if not handle:
        return None
    try:
        data = lib.zero_string_data(handle)
        length = lib.zero_string_len(handle)
        return ctypes.string_at(data, length).decode("utf-8")
    finally:
        lib.zero_string_free(handle)


def take_buffer(lib: ctypes.CDLL, handle: int | None) -> bytes:
    """Copy an owned buffer out and free it."""
    if not handle:
        raise Refused("the call returned no buffer")
    try:
        data = lib.zero_buffer_data(handle)
        length = lib.zero_buffer_len(handle)
        return ctypes.string_at(data, length) if length else b""
    finally:
        lib.zero_buffer_free(handle)


def last_error(lib: ctypes.CDLL) -> str | None:
    """The message of the calling thread's last refused call, or ``None``."""
    return take_string(lib, lib.zero_last_error_message())


def ok(lib: ctypes.CDLL, status: int) -> None:
    """Raise ``Refused`` with the last error unless ``status`` is ``Ok``."""
    if status != Status.OK:
        raise Refused(f"{Status(status).name}: {last_error(lib)}")


def view_bytes(view: Bytes) -> bytes | None:
    """Copy a view out; ``None`` when it is absent."""
    if not view.ptr:
        return None
    return ctypes.string_at(view.ptr, view.len) if view.len else b""


def conformance_case(lib: ctypes.CDLL, section: str, document: bytes) -> tuple[Status, bytes | None]:
    """Run one section document through ``zero_conformance_case``: the status, and the
    result when the call succeeded."""
    name = section.encode("utf-8")
    result = ctypes.c_void_p()
    status = Status(
        lib.zero_conformance_case(name, len(name), document, len(document), ctypes.byref(result))
    )
    if status != Status.OK:
        return status, None
    return status, take_buffer(lib, result.value)


def octets(value: bytes) -> str | dict[str, str]:
    """Decoded octets as the vectors write them: a string when they are UTF-8, and
    ``{"hex": ...}`` otherwise."""
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return {"hex": value.hex()}


@dataclass
class Request:
    """A leased request, copied out of its slot inside the batch that delivered it."""

    slot: int
    route: int
    method: bytes
    target: bytes
    version: int
    keep_alive: bool
    miss_status: int
    fields: list[tuple[bytes, bytes]]
    body: bytes


@dataclass
class Response:
    """What a handler answers a request with."""

    status: int = 200
    fields: list[tuple[bytes, bytes]] = field(default_factory=list)
    body: bytes = b""


@dataclass
class Poll:
    """One ``zero_target_poll`` call of the serving thread: its status, and the ticks of
    the clock the site was given, read just before the call and just after it."""

    status: Status
    ticks_before: int
    ticks_after: int


def _borrowed(data: bytes, keep: list[object]) -> Bytes:
    """A byte range over a copy of ``data`` that ``keep`` holds alive for the call."""
    if not data:
        return Bytes(None, 0)
    buffer = ctypes.create_string_buffer(data, len(data))
    keep.append(buffer)
    return Bytes(ctypes.addressof(buffer), len(data))


def read_request(lib: ctypes.CDLL, slot: int, route: int) -> Request:
    """Read a leased slot's request through ``zero_req_view`` and copy it out."""
    view = RequestView()
    view.size = ctypes.sizeof(RequestView)
    ok(lib, lib.zero_req_view(slot, ctypes.byref(view)))
    head = ctypes.string_at(view.head, view.head_len) if view.head_len else b""

    def span(part: Span) -> bytes:
        return head[part.start : part.start + part.len]

    fields = []
    for index in range(view.field_count):
        line = Field.from_address(view.fields + index * view.field_size)
        fields.append((span(line.name), span(line.value)))
    body = ctypes.string_at(view.body, view.body_len) if view.body_len else b""
    return Request(
        slot=slot,
        route=route,
        method=span(view.method_token),
        target=span(view.target),
        version=view.version,
        keep_alive=bool(view.flags & VIEW_KEEP_ALIVE),
        miss_status=view.miss_status,
        fields=fields,
        body=body,
    )


def respond(lib: ctypes.CDLL, slot: int, response: Response) -> None:
    """Answer a slot with ``zero_res_respond``, which writes and seals in one call."""
    keep: list[object] = []
    pairs = (HeaderPair * max(len(response.fields), 1))()
    for index, (name, value) in enumerate(response.fields):
        pairs[index].name = _borrowed(name, keep)
        pairs[index].value = _borrowed(value, keep)
    spec = ResponseSpec()
    spec.size = ctypes.sizeof(ResponseSpec)
    spec.status = response.status
    spec.field_size = ctypes.sizeof(HeaderPair)
    spec.fields = ctypes.addressof(pairs)
    spec.field_count = len(response.fields)
    spec.body = _borrowed(response.body, keep)
    ok(lib, lib.zero_res_respond(slot, ctypes.byref(spec)))


class Site:
    """A one-thread server with a host route ``GET /hello`` and the miss route, whose pull
    target a ``threading.Thread`` serves: it loops on ``zero_target_poll``, copies each
    request out of its slot, answers it through the handler and ``zero_res_respond``, and
    hands the batch back with ``zero_batch_complete``, acknowledging its epoch, until a
    poll returns anything but ``Ok`` or ``Timeout``.

    Args:
        lib: the loaded library.
        handler: answers each request; an exception is recorded and answered 500.
        ticks: a clock the serving thread reads before and after each poll.
    """

    def __init__(
        self,
        lib: ctypes.CDLL,
        handler: Callable[[Request], Response],
        ticks: Callable[[], int] = lambda: 0,
    ) -> None:
        self.lib = lib
        self.handler = handler
        self.ticks = ticks
        self.polls: list[Poll] = []
        self.served: list[Request] = []
        self.failures: list[BaseException] = []
        self.polling = threading.Event()

        app = ctypes.c_uint64()
        ok(lib, lib.zero_app_new(ctypes.byref(app)))
        self.app = app.value
        pattern = b"/hello"
        route = ctypes.c_uint32()
        ok(
            lib,
            lib.zero_app_route(
                self.app, ROUTE_HOST, METHOD_GET, pattern, len(pattern), b"", 0, ctypes.byref(route)
            ),
        )
        self.hello = route.value
        ok(lib, lib.zero_app_miss(self.app, ctypes.byref(route)))
        self.miss = route.value

        options = b'{"threads":1}'
        server = ctypes.c_uint64()
        ok(lib, lib.zero_server_new(self.app, options, len(options), ctypes.byref(server)))
        self.server = server.value
        workers = (ctypes.c_uint8 * 128)()
        count = ctypes.c_size_t()
        ok(lib, lib.zero_server_workers(self.server, workers, len(workers), ctypes.byref(count)))
        if count.value != 1:
            raise Refused(f"a one-thread server claimed {count.value} worker indexes")
        self.worker = workers[0]
        target = ctypes.c_uint64()
        ok(lib, lib.zero_target_attach(self.server, self.worker, ctypes.byref(target)))
        self.target = target.value
        ok(lib, lib.zero_server_start(self.server))
        address = ctypes.c_void_p()
        ok(lib, lib.zero_server_address(self.server, ctypes.byref(address)))
        text = take_string(lib, address.value) or ""
        host, _, port = text.rpartition(":")
        self.address = (host.strip("[]"), int(port))

        self.thread = threading.Thread(target=self._serve, name="zero-target", daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        lib = self.lib
        batch = Batch()
        slots = (ctypes.c_uint64 * MAX_BATCH)()
        routes = (ctypes.c_uint32 * MAX_BATCH)()
        events = (Event * MAX_BATCH)()
        try:
            while True:
                batch.size = ctypes.sizeof(Batch)
                before = self.ticks()
                self.polling.set()
                status = Status(
                    lib.zero_target_poll(
                        self.target,
                        WAIT_MS,
                        ctypes.byref(batch),
                        slots,
                        routes,
                        events,
                        ctypes.sizeof(Event),
                        MAX_BATCH,
                    )
                )
                self.polls.append(Poll(status, before, self.ticks()))
                if status == Status.TIMEOUT:
                    continue
                if status != Status.OK:
                    return
                answered = batch.count if batch.kind == BATCH_REQUESTS else 0
                for index in range(answered):
                    self._answer(slots[index], routes[index])
                results = (ctypes.c_int * max(answered, 1))()
                ok(
                    lib,
                    lib.zero_batch_complete(batch.worker, slots, answered, batch.epoch, results),
                )
                for result in results[:answered]:
                    ok(lib, result)
        except BaseException as error:
            self.failures.append(error)

    def _answer(self, slot: int, route: int) -> None:
        request = read_request(self.lib, slot, route)
        self.served.append(request)
        try:
            response = self.handler(request)
        except Exception as error:
            self.failures.append(error)
            response = Response(status=500)
        respond(self.lib, slot, response)

    def close(self) -> Status:
        """Detach the target, which ends the serving thread's poll with ``Closed``, then
        stop and free the server and its app.

        Returns:
            The status the serving thread's last poll returned.

        Raises:
            Refused: the serving thread is still running after the detach.
            BaseException: the first failure the serving thread recorded.
        """
        lib = self.lib
        ok(lib, lib.zero_target_detach(self.target))
        self.thread.join(WAIT_SECONDS)
        running = self.thread.is_alive()
        ok(lib, lib.zero_server_shutdown(self.server, NONE))
        ok(lib, lib.zero_server_wait(self.server, WAIT_MS))
        ok(lib, lib.zero_server_free(self.server))
        ok(lib, lib.zero_app_free(self.app))
        if running:
            raise Refused("the serving thread did not end after the detach")
        if self.failures:
            raise self.failures[0]
        return self.polls[-1].status


def eventually(what: str, done: Callable[[], bool]) -> None:
    """Poll ``done`` every millisecond until it holds, for up to ``WAIT_SECONDS``."""
    deadline = time.monotonic() + WAIT_SECONDS
    while not done():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.001)


@dataclass
class Reply:
    """One response read off a connection, and whether the server closed the connection
    after it."""

    status: int
    fields: list[tuple[str, str]]
    body: bytes
    closed: bool

    def field(self, name: str) -> str | None:
        """The value of the first field line named ``name``, compared without case."""
        for key, value in self.fields:
            if key.lower() == name.lower():
                return value
        return None


class _Reader:
    """Buffered reads off a socket."""

    def __init__(self, connection: socket.socket) -> None:
        self.connection = connection
        self.buffer = b""

    def _fill(self) -> bool:
        try:
            chunk = self.connection.recv(65536)
        except ConnectionResetError:
            return False
        self.buffer += chunk
        return bool(chunk)

    def until(self, marker: bytes) -> bytes:
        while marker not in self.buffer:
            if not self._fill():
                raise EOFError(f"the connection closed before {marker!r}")
        head, _, self.buffer = self.buffer.partition(marker)
        return head

    def exactly(self, length: int) -> bytes:
        while len(self.buffer) < length:
            if not self._fill():
                raise EOFError("the connection closed inside the body")
        data, self.buffer = self.buffer[:length], self.buffer[length:]
        return data

    def rest(self) -> bytes:
        while self._fill():
            pass
        data, self.buffer = self.buffer, b""
        return data


def exchange(address: tuple[str, int], request: bytes, expect_close: bool = False) -> Reply:
    """Send ``request`` on a new connection and read one response. With ``expect_close``,
    also read on to learn whether the server closes the connection after the response.
    """
    with socket.create_connection(address, timeout=WAIT_SECONDS) as connection:
        connection.sendall(request)
        reader = _Reader(connection)
        lines = reader.until(b"\r\n\r\n").decode("latin-1").split("\r\n")
        status = int(lines[0].split(" ")[1])
        fields = []
        for line in lines[1:]:
            name, _, value = line.partition(":")
            fields.append((name, value.strip(" \t")))
        reply = Reply(status=status, fields=fields, body=b"", closed=False)
        if reply.field("transfer-encoding") is not None:
            raise AssertionError(f"a response with Transfer-Encoding: {reply.fields}")
        length = reply.field("content-length")
        if length is not None:
            reply.body = reader.exactly(int(length))
            if expect_close:
                reply.closed = reader.rest() == b""
        else:
            reply.body = reader.rest()
            reply.closed = True
        return reply


def echo(request: Request) -> Response:
    """Answer with the request as the vectors write a parsed head: method, target,
    version, keep-alive and field lines, with the body in hex."""
    document = {
        "method": octets(request.method),
        "target": octets(request.target),
        "version": f"HTTP/{request.version // 10}.{request.version % 10}",
        "keepAlive": request.keep_alive,
        "fields": [[octets(name), octets(value)] for name, value in request.fields],
        "body": request.body.hex(),
    }
    return Response(
        status=200,
        fields=[(b"Content-Type", b"application/json")],
        body=json.dumps(document).encode("utf-8"),
    )
