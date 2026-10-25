//! The calls that need no server.

use std::ffi::CStr;
use std::ptr;

use zero_ffi::*;

use super::{Cases, Entry, Kind, Live};
use crate::support::{take_buffer, take_string};

/// `Ok` when `holds`, a refusal otherwise, so a value check reads as a case.
pub fn held(holds: bool) -> ZeroStatus {
    if holds {
        ZeroStatus::Ok
    } else {
        ZeroStatus::Protocol
    }
}

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_version",
            cases: version,
            placeholder: crate::placeholder_call!(zero_version()),
        },
        Entry {
            name: "zero_abi_version",
            cases: abi_version,
            placeholder: crate::placeholder_call!(zero_abi_version()),
        },
        Entry {
            name: "zero_last_error_message",
            cases: last_error_message,
            placeholder: crate::placeholder_call!(zero_last_error_message()),
        },
        Entry {
            name: "zero_string_data",
            cases: strings,
            placeholder: crate::placeholder_call!(unsafe zero_string_data(a)),
        },
        Entry {
            name: "zero_string_len",
            cases: strings,
            placeholder: crate::placeholder_call!(unsafe zero_string_len(a)),
        },
        Entry {
            name: "zero_string_free",
            cases: strings,
            placeholder: crate::placeholder_call!(unsafe zero_string_free(a)),
        },
        Entry {
            name: "zero_buffer_data",
            cases: buffers,
            placeholder: crate::placeholder_call!(unsafe zero_buffer_data(a)),
        },
        Entry {
            name: "zero_buffer_len",
            cases: buffers,
            placeholder: crate::placeholder_call!(unsafe zero_buffer_len(a)),
        },
        Entry {
            name: "zero_buffer_free",
            cases: buffers,
            placeholder: crate::placeholder_call!(unsafe zero_buffer_free(a)),
        },
        Entry {
            name: "zero_header_name",
            cases: header_name,
            placeholder: crate::placeholder_call!(unsafe zero_header_name(a, b)),
        },
        Entry {
            name: "zero_header_id",
            cases: header_id,
            placeholder: crate::placeholder_call!(unsafe zero_header_id(a, b, c)),
        },
        Entry {
            name: "zero_field_validate",
            cases: field_validate,
            placeholder: crate::placeholder_call!(unsafe zero_field_validate(a, b, c, d)),
        },
        Entry {
            name: "zero_conformance_case",
            cases: conformance_case,
            placeholder: crate::placeholder_call!(unsafe zero_conformance_case(a, b, c, d, e)),
        },
    ]
}

fn version(_: &Live, cases: &mut Cases) {
    let pointer = zero_version();
    let matches = !pointer.is_null() && {
        // SAFETY: the version is a static NUL-terminated string.
        let text = unsafe { CStr::from_ptr(pointer) };
        text.to_str() == Ok(env!("CARGO_PKG_VERSION"))
    };
    cases.case(
        Kind::Valid,
        "the crate version",
        ZeroStatus::Ok,
        held(matches),
    );
}

fn abi_version(_: &Live, cases: &mut Cases) {
    cases.case(
        Kind::Valid,
        "ZERO_ABI_VERSION",
        ZeroStatus::Ok,
        held(zero_abi_version() == ZERO_ABI_VERSION),
    );
}

fn last_error_message(_: &Live, cases: &mut Cases) {
    let name = b"bad name";
    // SAFETY: the ranges are `name` and an empty value.
    let refused = unsafe { zero_field_validate(name.as_ptr(), name.len(), ptr::null(), 0) };
    cases.case(
        Kind::Other,
        "a refusal",
        ZeroStatus::InvalidArgument,
        refused,
    );
    let message = take_string(zero_last_error_message());
    cases.case(
        Kind::Handle,
        "the message names the refusal",
        ZeroStatus::Ok,
        held(message.is_some_and(|text| text.contains("token"))),
    );
    let again = take_string(zero_last_error_message());
    cases.case(
        Kind::Handle,
        "reading the message keeps it",
        ZeroStatus::Ok,
        held(again.is_some_and(|text| text.contains("token"))),
    );
}

fn strings(_: &Live, cases: &mut Cases) {
    // SAFETY: NULL is no string.
    let data = unsafe { zero_string_data(ptr::null()) };
    cases.case(
        Kind::Handle,
        "data of NULL",
        ZeroStatus::Ok,
        held(data.is_null()),
    );
    // SAFETY: NULL is no string.
    let len = unsafe { zero_string_len(ptr::null()) };
    cases.case(
        Kind::Handle,
        "length of NULL",
        ZeroStatus::Ok,
        held(len == 0),
    );
    // SAFETY: NULL is no string, and its free does nothing.
    unsafe { zero_string_free(ptr::null_mut()) };
    let name = b"\x01";
    // SAFETY: the ranges are `name` and an empty value.
    let _ = unsafe { zero_field_validate(name.as_ptr(), name.len(), ptr::null(), 0) };
    let string = zero_last_error_message();
    // SAFETY: `string` is a live string this library returned.
    let data = unsafe { zero_string_data(string) };
    // SAFETY: the data is NUL-terminated text while the string lives.
    let text = unsafe { CStr::from_ptr(data) }.to_bytes().len();
    // SAFETY: as above.
    let len = unsafe { zero_string_len(string) };
    cases.case(
        Kind::Handle,
        "a live string is terminated at its length",
        ZeroStatus::Ok,
        held(text == len && len > 0),
    );
    // SAFETY: `string` is live and is freed once.
    unsafe { zero_string_free(string) };
}

fn buffers(live: &Live, cases: &mut Cases) {
    // SAFETY: NULL is no buffer.
    let data = unsafe { zero_buffer_data(ptr::null()) };
    cases.case(
        Kind::Handle,
        "data of NULL",
        ZeroStatus::Ok,
        held(data.is_null()),
    );
    // SAFETY: NULL is no buffer.
    let len = unsafe { zero_buffer_len(ptr::null()) };
    cases.case(
        Kind::Handle,
        "length of NULL",
        ZeroStatus::Ok,
        held(len == 0),
    );
    // SAFETY: NULL is no buffer, and its free does nothing.
    unsafe { zero_buffer_free(ptr::null_mut()) };
    let mut table = ptr::null_mut();
    // SAFETY: `table` is a writable pointer.
    let status = unsafe { zero_app_table(live.app, &mut table) };
    cases.case(Kind::Valid, "an owned table", ZeroStatus::Ok, status);
    let bytes = take_buffer(table);
    cases.case(
        Kind::Handle,
        "a live buffer holds its bytes",
        ZeroStatus::Ok,
        held(String::from_utf8_lossy(&bytes).contains("/t/:p")),
    );
}

fn header_name(_: &Live, cases: &mut Cases) {
    let call = |id: u32, out: *mut ZeroBytes| {
        // SAFETY: every `out` a case passes is NULL, misaligned or a writable `ZeroBytes`,
        // and the library refuses the first two before any access.
        unsafe { zero_header_name(id, out) }
    };
    let mut name = ZeroBytes::ABSENT;
    cases.case(
        Kind::Set,
        "id 49",
        ZeroStatus::InvalidArgument,
        call(49, &mut name),
    );
    cases.case(
        Kind::Set,
        "ZERO_HEADER_NONE",
        ZeroStatus::InvalidArgument,
        call(ZERO_HEADER_NONE, &mut name),
    );
    cases.output("name_out", |out| call(0, out));
    cases.case(
        Kind::Valid,
        "id 0",
        ZeroStatus::Ok,
        call(ZERO_HEADER_ACCEPT, &mut name),
    );
    // SAFETY: the name is static text of the library.
    let text = unsafe { std::slice::from_raw_parts(name.ptr, name.len) };
    cases.case(
        Kind::Valid,
        "the spelling of id 0",
        ZeroStatus::Ok,
        held(text == b"Accept"),
    );
}

fn header_id(_: &Live, cases: &mut Cases) {
    let call = |name: *const u8, len: usize, out: *mut u32| {
        // SAFETY: every range a case passes is NULL or readable, and every `out` NULL,
        // misaligned or writable; the library refuses the first ones before any access.
        unsafe { zero_header_id(name, len, out) }
    };
    let mut id = 0u32;
    cases.null_range("name", |name, len| call(name, len, &mut id));
    let known = b"content-type";
    cases.output("id_out", |out| call(known.as_ptr(), known.len(), out));
    let status = call(known.as_ptr(), known.len(), &mut id);
    cases.case(Kind::Valid, "a known name", ZeroStatus::Ok, status);
    cases.case(
        Kind::Valid,
        "its id",
        ZeroStatus::Ok,
        held(id == ZERO_HEADER_CONTENT_TYPE),
    );
    let unknown = b"x-unknown";
    let status = call(unknown.as_ptr(), unknown.len(), &mut id);
    cases.case(Kind::Valid, "an unknown name", ZeroStatus::Ok, status);
    cases.case(
        Kind::Valid,
        "ZERO_HEADER_NONE",
        ZeroStatus::Ok,
        held(id == ZERO_HEADER_NONE),
    );
}

fn field_validate(_: &Live, cases: &mut Cases) {
    let call = |name: &[u8], value: &[u8]| {
        // SAFETY: both ranges are the bytes of slices.
        unsafe { zero_field_validate(name.as_ptr(), name.len(), value.as_ptr(), value.len()) }
    };
    let raw = |name: *const u8, name_len: usize, value: *const u8, value_len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable.
        unsafe { zero_field_validate(name, name_len, value, value_len) }
    };
    let value = b"v";
    cases.null_range("name", |name, len| raw(name, len, value.as_ptr(), 1));
    cases.null_range("value", |value, len| raw(b"x-a".as_ptr(), 3, value, len));
    for (byte, what) in [(b'\r', "CR"), (b'\n', "LF"), (0u8, "NUL")] {
        let value = [b'a', byte, b'b'];
        cases.case(
            Kind::Field,
            format!("a value holding {what}"),
            ZeroStatus::InvalidArgument,
            call(b"x-a", &value),
        );
    }
    cases.case(
        Kind::Other,
        "a name with a space",
        ZeroStatus::InvalidArgument,
        call(b"x a", b"v"),
    );
    cases.case(
        Kind::Other,
        "Content-Length",
        ZeroStatus::InvalidArgument,
        call(b"Content-Length", b"1"),
    );
    cases.case(
        Kind::Other,
        "a leading space",
        ZeroStatus::InvalidArgument,
        call(b"x-a", b" v"),
    );
    cases.case(
        Kind::Valid,
        "a field line",
        ZeroStatus::Ok,
        call(b"x-a", b"v w"),
    );
}

fn conformance_case(_: &Live, cases: &mut Cases) {
    let call = |section: &[u8], input: &[u8], out: *mut *mut ZeroBuffer| {
        // SAFETY: both ranges are the bytes of slices, and every `out` a case passes is
        // NULL, misaligned or writable; the library refuses the first two before any access.
        unsafe {
            zero_conformance_case(
                section.as_ptr(),
                section.len(),
                input.as_ptr(),
                input.len(),
                out,
            )
        }
    };
    let raw = |section: *const u8, section_len: usize, input: *const u8, input_len: usize| {
        let mut result = ptr::null_mut();
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable, and `result` is writable.
        unsafe { zero_conformance_case(section, section_len, input, input_len, &mut result) }
    };
    let section = b"responseSplitting";
    let input = br#"{"cases":[{"name":"plain","field":"x-a","value":"6869","accepted":true}]}"#;
    cases.null_range("section", |section, len| {
        raw(section, len, input.as_ptr(), input.len())
    });
    cases.null_range("input", |input, len| {
        raw(section.as_ptr(), section.len(), input, len)
    });
    cases.output("result_out", |out| call(section, input, out));
    let mut result = ptr::null_mut();
    cases.case(
        Kind::Other,
        "an unknown section",
        ZeroStatus::Unsupported,
        call(b"nothing", input, &mut result),
    );
    cases.case(
        Kind::Other,
        "a document that is not JSON",
        ZeroStatus::Codec,
        call(section, b"{", &mut result),
    );
    let status = call(section, input, &mut result);
    cases.case(
        Kind::Valid,
        "a responseSplitting case",
        ZeroStatus::Ok,
        status,
    );
    let text = if status == ZeroStatus::Ok {
        String::from_utf8(take_buffer(result)).unwrap_or_default()
    } else {
        String::new()
    };
    cases.case(
        Kind::Valid,
        "the case comes back accepted",
        ZeroStatus::Ok,
        held(text.contains(r#""accepted":true"#)),
    );
}
