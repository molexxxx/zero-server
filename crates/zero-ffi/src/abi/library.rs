//! The calls that need no server: the version, the last error, the owned strings and
//! buffers, the interned field names, the field rules and the conformance entry.

use std::ffi::c_char;
use std::mem::size_of;
use std::ptr;

use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::HeaderName;

use crate::abi::names::{ZERO_ABI_VERSION, ZERO_HEADER_NONE};
use crate::abi::{ZeroBytes, ZeroStatus};
use crate::guard::{guard, guard_value, Fail};
use crate::handles::{self, ZeroBuffer, ZeroString};
use crate::{last_error, ptr as host};

/// The crate version as a NUL-terminated string.
const VERSION_C: &str = concat!(env!("CARGO_PKG_VERSION"), "\0");

const UNKNOWN_HEADER: Fail = Fail::invalid("the header id is not below ZERO_HEADER_COUNT");
const FIELD_NAME: Fail = Fail::invalid("the field name is not a token");
const FIELD_VALUE: Fail =
    Fail::invalid("the field value holds a control character or starts or ends with whitespace");
const FIELD_RESERVED: Fail = Fail::invalid(
    "the driver writes Content-Length, Connection, Transfer-Encoding and Date itself",
);

/// Returns the version of the zero-server core.
///
/// # Returns
///
/// A NUL-terminated UTF-8 string owned by the library and valid for the life of the
/// process, or NULL if the call panicked. The caller must not free it.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_version() -> *const c_char {
    guard_value(ptr::null(), || VERSION_C.as_ptr().cast())
}

/// Returns the version of the C ABI this library implements.
///
/// # Returns
///
/// `ZERO_ABI_VERSION`, or 0 if the call panicked.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_abi_version() -> u32 {
    guard_value(0, || ZERO_ABI_VERSION)
}

/// Returns the message of the calling thread's most recent refused call.
///
/// # Returns
///
/// A new owned string the caller releases with `zero_string_free`, or NULL when the
/// thread has no message or the call panicked. Reading the message does not clear it.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_last_error_message() -> *mut ZeroString {
    guard_value(ptr::null_mut(), || {
        last_error::with_message(|message| message.map_or(ptr::null_mut(), ZeroString::into_raw))
    })
}

/// Returns the text of an owned string.
///
/// # Arguments
///
/// * `string` - the string, or NULL.
///
/// # Returns
///
/// The NUL-terminated UTF-8 text, valid until the string is freed; NULL for NULL.
///
/// # Safety
///
/// `string` must be NULL or a string this library returned and that has not been freed.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_string_data(string: *const ZeroString) -> *const c_char {
    guard_value(ptr::null(), || {
        // SAFETY: owned handles: `string` is NULL or a live string of this library.
        let string = unsafe { handles::peek(string) };
        string.map_or(ptr::null(), ZeroString::data)
    })
}

/// Returns the length of an owned string's text.
///
/// # Arguments
///
/// * `string` - the string, or NULL.
///
/// # Returns
///
/// The length in octets, without the terminator; 0 for NULL.
///
/// # Safety
///
/// As `zero_string_data`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_string_len(string: *const ZeroString) -> usize {
    guard_value(0, || {
        // SAFETY: owned handles: `string` is NULL or a live string of this library.
        let string = unsafe { handles::peek(string) };
        string.map_or(0, ZeroString::text_len)
    })
}

/// Releases an owned string.
///
/// # Arguments
///
/// * `string` - the string; NULL does nothing.
///
/// # Safety
///
/// `string` must be NULL or a string this library returned and that has not been freed;
/// it must not be used again.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_string_free(string: *mut ZeroString) {
    guard_value((), || {
        // SAFETY: owned handles: `string` is NULL or a live string of this library, freed
        // once.
        unsafe { handles::reclaim(string) }
    });
}

/// Returns the bytes of an owned buffer.
///
/// # Arguments
///
/// * `buffer` - the buffer, or NULL.
///
/// # Returns
///
/// The first byte, valid until the buffer is freed and not NULL for an empty buffer;
/// NULL for NULL.
///
/// # Safety
///
/// `buffer` must be NULL or a buffer this library returned and that has not been freed.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_buffer_data(buffer: *const ZeroBuffer) -> *const u8 {
    guard_value(ptr::null(), || {
        // SAFETY: owned handles: `buffer` is NULL or a live buffer of this library.
        let buffer = unsafe { handles::peek(buffer) };
        buffer.map_or(ptr::null(), ZeroBuffer::data)
    })
}

/// Returns the length of an owned buffer.
///
/// # Arguments
///
/// * `buffer` - the buffer, or NULL.
///
/// # Returns
///
/// The length in octets; 0 for NULL.
///
/// # Safety
///
/// As `zero_buffer_data`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_buffer_len(buffer: *const ZeroBuffer) -> usize {
    guard_value(0, || {
        // SAFETY: owned handles: `buffer` is NULL or a live buffer of this library.
        let buffer = unsafe { handles::peek(buffer) };
        buffer.map_or(0, ZeroBuffer::byte_len)
    })
}

/// Releases an owned buffer.
///
/// # Arguments
///
/// * `buffer` - the buffer; NULL does nothing.
///
/// # Safety
///
/// `buffer` must be NULL or a buffer this library returned and that has not been freed;
/// it must not be used again.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_buffer_free(buffer: *mut ZeroBuffer) {
    guard_value((), || {
        // SAFETY: owned handles: `buffer` is NULL or a live buffer of this library, freed
        // once.
        unsafe { handles::reclaim(buffer) }
    });
}

/// Writes the registered spelling of an interned field name.
///
/// # Arguments
///
/// * `id` - a `ZERO_HEADER_*` value.
/// * `name_out` - receives the name, static text valid for the life of the process.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT` or a NULL or misaligned
/// `name_out`.
///
/// # Safety
///
/// `name_out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_header_name(id: u32, name_out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(name_out)?;
        let name = u8::try_from(id)
            .ok()
            .and_then(HeaderName::from_id)
            .ok_or(UNKNOWN_HEADER)?;
        let name = ZeroBytes::of(name.canonical().as_bytes());
        // SAFETY: outputs: `name_out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(name_out, size_of::<ZeroBytes>(), &[name]) }
    })
}

/// Writes the interned id of a field name, compared without regard to case.
///
/// # Arguments
///
/// * `name` - the field name.
/// * `len` - its length in octets.
/// * `id_out` - receives a `ZERO_HEADER_*` value, or `ZERO_HEADER_NONE` for a name the
///   table does not hold.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an input range or an output the rules refuse.
///
/// # Safety
///
/// `name` must be a readable range of `len` octets, and `id_out` NULL or a writable
/// `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_header_id(
    name: *const u8,
    len: usize,
    id_out: *mut u32,
) -> ZeroStatus {
    guard(|| {
        host::check_out(id_out)?;
        // SAFETY: input ranges: `name` is `len` readable octets for the call.
        let name = unsafe { host::read_bytes(name, len) }?;
        let id = HeaderName::parse(name).map_or(ZERO_HEADER_NONE, |name| u32::from(name.id()));
        // SAFETY: outputs: `id_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(id_out, size_of::<u32>(), &[id]) }
    })
}

/// The rules every field line a host writes passes: the name is a token the driver does
/// not write itself, and the value is a field value, which holds no CR, LF, NUL or other
/// control character and no surrounding whitespace.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
pub(crate) fn field_rules(name: &[u8], value: &[u8]) -> Result<(), Fail> {
    validate_field_name(name).map_err(|_| FIELD_NAME)?;
    if HeaderName::parse(name).is_some_and(|name| {
        matches!(
            name,
            HeaderName::ContentLength
                | HeaderName::Connection
                | HeaderName::TransferEncoding
                | HeaderName::Date
        )
    }) {
        return Err(FIELD_RESERVED);
    }
    validate_field_value(value).map_err(|_| FIELD_VALUE)
}

/// Checks a field line against the rules `zero_res_header` applies, without a slot.
///
/// The name must be a token (RFC 9110 Section 5.1) other than `Content-Length`,
/// `Connection`, `Transfer-Encoding` and `Date`, which the driver writes itself. The value
/// must be a field value without surrounding whitespace: "Field values containing CR,
/// LF, or NUL characters are invalid and dangerous" (RFC 9110 Section 5.5), so the
/// library refuses them rather than send them.
///
/// # Arguments
///
/// * `name` - the field name.
/// * `name_len` - its length in octets.
/// * `value` - the field value.
/// * `value_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok` when a host may write the line, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a line the rules refuse or an input range they refuse.
///
/// # Safety
///
/// `name` and `value` must be readable ranges of their lengths.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_field_validate(
    name: *const u8,
    name_len: usize,
    value: *const u8,
    value_len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `name` is `name_len` readable octets for the call.
        let name = unsafe { host::read_bytes(name, name_len) }?;
        // SAFETY: input ranges: `value` is `value_len` readable octets for the call.
        let value = unsafe { host::read_bytes(value, value_len) }?;
        field_rules(name, value)
    })
}

/// Recomputes one section of the shared conformance vectors: the section's name and a
/// JSON document in its shape go in, and the same document comes out with every outcome
/// computed again by the parsers and encoders the server uses, as canonical JSON. The
/// entry keeps no state and never panics on arbitrary bytes.
///
/// # Arguments
///
/// * `section` - the section's name: `http1Parser`, `responseSplitting`, `router`, `ws`,
///   `sse`, `qpack` or `h3Frames`.
/// * `section_len` - its length in octets.
/// * `input` - the UTF-8 JSON document.
/// * `input_len` - its length in octets.
/// * `result_out` - receives the result, an owned buffer the caller releases with
///   `zero_buffer_free`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Unsupported` for an unknown section, and for `ws` and `sse` without the `realtime`
/// capability; `Codec` for a document that is not JSON or not in the section's shape;
/// `Limit` for a document past the JSON size or nesting cap; `InvalidArgument` for an
/// argument the rules refuse.
///
/// # Safety
///
/// `section` and `input` must be readable ranges of their lengths, and `result_out` NULL
/// or a writable `ZeroBuffer *`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_conformance_case(
    section: *const u8,
    section_len: usize,
    input: *const u8,
    input_len: usize,
    result_out: *mut *mut ZeroBuffer,
) -> ZeroStatus {
    guard(|| {
        host::check_out(result_out)?;
        // SAFETY: input ranges: `section` is `section_len` readable octets for the call.
        let section = unsafe { host::read_bytes(section, section_len) }?;
        // SAFETY: input ranges: `input` is `input_len` readable octets for the call.
        let input = unsafe { host::read_bytes(input, input_len) }?;
        let result = zero_host::conformance::case(section, input)?;
        let buffer = ZeroBuffer::into_raw(result.into_bytes());
        // SAFETY: outputs: `result_out` was checked and points to a writable pointer.
        unsafe { host::write_elements(result_out, size_of::<*mut ZeroBuffer>(), &[buffer]) }
    })
}
