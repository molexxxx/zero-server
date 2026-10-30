"""The C ABI loaded with ``ctypes.CDLL`` from the shared library ``cargo build -p zero-ffi
--release`` writes, beside the PyO3 module over the same core: the versions it reports,
the calling thread's last error, the owned handles, the layout of the declarations, and
the refusals of NULL, misaligned, over-wide and stale arguments."""

import ctypes
import threading

import pytest

import cabi
from cabi import Status
from zero_server import _native


def test_the_library_reports_the_core_version_the_module_reports(lib):
    version = lib.zero_version()
    assert isinstance(version, bytes)
    assert version != b""
    assert version.decode("utf-8") == _native.version()


def test_the_library_implements_version_1_of_the_c_abi(lib):
    assert lib.zero_abi_version() == cabi.ABI_VERSION == 1


def test_a_refused_call_leaves_a_message_that_reading_and_success_keep(lib):
    name = cabi.Bytes()
    assert lib.zero_header_name(cabi.HEADER_COUNT, ctypes.byref(name)) == Status.INVALID_ARGUMENT
    message = cabi.last_error(lib)
    assert message
    assert cabi.last_error(lib) == message, "reading the message does not clear it"
    assert lib.zero_header_name(0, ctypes.byref(name)) == Status.OK
    assert cabi.view_bytes(name).lower() == b"accept"
    assert cabi.last_error(lib) == message, "a success leaves the message unchanged"


def test_the_last_error_belongs_to_the_thread_whose_call_was_refused(lib):
    name = cabi.Bytes()
    assert lib.zero_header_name(cabi.HEADER_COUNT, ctypes.byref(name)) == Status.INVALID_ARGUMENT
    assert cabi.last_error(lib)
    seen = []
    thread = threading.Thread(target=lambda: seen.append(cabi.last_error(lib)))
    thread.start()
    thread.join(cabi.WAIT_SECONDS)
    assert seen == [None]


def test_reading_or_freeing_a_null_owned_handle_does_nothing(lib):
    lib.zero_string_free(None)
    lib.zero_buffer_free(None)
    assert lib.zero_string_data(None) is None
    assert lib.zero_string_len(None) == 0
    assert lib.zero_buffer_data(None) is None
    assert lib.zero_buffer_len(None) == 0


@pytest.mark.skipif(
    ctypes.sizeof(ctypes.c_void_p) != 8, reason="the header's numbers are those of 64-bit targets"
)
def test_the_ctypes_declarations_have_the_layout_the_library_compiles_with():
    sizes = {
        cabi.Bytes: 16,
        cabi.Span: 8,
        cabi.Field: 20,
        cabi.RequestView: 120,
        cabi.HeaderPair: 32,
        cabi.ResponseSpec: 48,
        cabi.Batch: 24,
        cabi.Event: 32,
    }
    for struct, size in sizes.items():
        assert ctypes.sizeof(struct) == size, struct.__name__
    assert cabi.RequestView.head.offset == 16
    assert cabi.RequestView.method_token.offset == 32
    assert cabi.RequestView.fields.offset == 72
    assert cabi.RequestView.body_len.offset == 104
    assert cabi.RequestView.field_size.offset == 112
    assert cabi.ResponseSpec.fields.offset == 16
    assert cabi.ResponseSpec.body.offset == 32
    assert cabi.Batch.epoch.offset == 16
    assert cabi.Event.data.offset == 16


def test_null_and_misaligned_outputs_are_refused_and_nothing_is_written(lib):
    storage = (ctypes.c_uint64 * 2)()
    misaligned = ctypes.addressof(storage) + 1
    as_u64 = ctypes.cast(misaligned, ctypes.POINTER(ctypes.c_uint64))
    as_u32 = ctypes.cast(misaligned, ctypes.POINTER(ctypes.c_uint32))
    assert lib.zero_app_new(None) == Status.INVALID_ARGUMENT
    assert lib.zero_app_new(as_u64) == Status.INVALID_ARGUMENT
    assert lib.zero_slot_route(cabi.ID_MAX, None) == Status.INVALID_ARGUMENT
    assert lib.zero_slot_route(cabi.ID_MAX, as_u32) == Status.INVALID_ARGUMENT
    assert lib.zero_header_name(0, None) == Status.INVALID_ARGUMENT
    assert bytes(storage) == bytes(16)


def test_a_null_input_range_with_a_length_is_refused(lib):
    header = ctypes.c_uint32(7)
    assert lib.zero_header_id(None, 4, ctypes.byref(header)) == Status.INVALID_ARGUMENT
    assert header.value == 7
    assert lib.zero_field_validate(None, 1, b"v", 1) == Status.INVALID_ARGUMENT
    assert lib.zero_field_validate(b"X-A", 3, b"v", 1) == Status.OK


def _slot_route(lib, slot):
    out = ctypes.c_uint32(7)
    status = lib.zero_slot_route(slot, ctypes.byref(out))
    return status, out.value


def _req_method(lib, slot):
    out = ctypes.c_uint8(7)
    status = lib.zero_req_method(slot, ctypes.byref(out))
    return status, out.value


@pytest.mark.parametrize("accessor", [_slot_route, _req_method], ids=["slot_route", "req_method"])
def test_a_slot_accessor_refuses_a_wide_id_and_reads_an_unknown_one_as_closed(lib, accessor):
    for wide in (cabi.ID_MAX + 1, cabi.NONE):
        assert accessor(lib, wide) == (Status.INVALID_ARGUMENT, 7)
    assert accessor(lib, cabi.ID_MAX) == (Status.CLOSED, 7)


def test_the_id_of_a_freed_app_is_stale_and_every_call_on_it_reads_closed(lib):
    app = ctypes.c_uint64()
    cabi.ok(lib, lib.zero_app_new(ctypes.byref(app)))
    cabi.ok(lib, lib.zero_app_free(app.value))
    route = ctypes.c_uint32(7)
    status = lib.zero_app_route(
        app.value, cabi.ROUTE_HOST, cabi.METHOD_GET, b"/x", 2, b"", 0, ctypes.byref(route)
    )
    assert status == Status.CLOSED
    assert route.value == 7
    assert lib.zero_app_free(app.value) == Status.CLOSED
    assert lib.zero_app_free(cabi.ID_MAX + 1) == Status.INVALID_ARGUMENT


def test_unknown_server_and_target_ids_read_closed_and_wide_ones_are_refused(lib):
    assert lib.zero_server_start(cabi.ID_MAX) == Status.CLOSED
    assert lib.zero_server_free(cabi.ID_MAX) == Status.CLOSED
    assert lib.zero_target_detach(cabi.ID_MAX) == Status.CLOSED
    assert lib.zero_server_start(cabi.ID_MAX + 1) == Status.INVALID_ARGUMENT
    assert lib.zero_target_detach(cabi.ID_MAX + 1) == Status.INVALID_ARGUMENT
