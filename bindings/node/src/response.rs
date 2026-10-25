//! Response writers: one native call writes a whole response, an error, or an
//! action the core runs once the response is back.
//!
//! Field names and values cross as latin1, one octet per character, the encoding
//! Node writes header strings in; a character above U+00FF is refused rather than
//! truncated, so no string can turn into a CR, an LF or a NUL on the wire. Every line
//! is then checked with the rule the core's response writers apply: a token name the
//! driver does not write itself, a field value without CR, LF, NUL or surrounding
//! whitespace (RFC 9110 Sections 5.1 and 5.5).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>

use std::borrow::Cow;

use napi::bindgen_prelude::{BufferSlice, Either};
use napi_derive::napi;
use zero_host::access::{self, FieldMode};
use zero_host::Status;

use crate::guard::{node_guard, Code, Fail};
use crate::ids;

/// One field line as octets.
pub(crate) type Line<'a> = (Cow<'a, [u8]>, Cow<'a, [u8]>);

/// The latin1 octets of a string: one octet per character, `None` when a character
/// is above U+00FF.
pub(crate) fn latin1(text: &str) -> Option<Cow<'_, [u8]>> {
    if text.is_ascii() {
        return Some(Cow::Borrowed(text.as_bytes()));
    }
    text.chars()
        .map(|character| u8::try_from(u32::from(character)).ok())
        .collect::<Option<Vec<u8>>>()
        .map(Cow::Owned)
}

/// Whether a host may write a field line: the name is a token (RFC 9110 Section 5.1)
/// the driver does not write itself, and the value is a field value without
/// surrounding whitespace (Section 5.5). It is the check of the core's response
/// writers, `access::field_check`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
pub(crate) fn field_allowed(name: &[u8], value: &[u8]) -> bool {
    access::field_check(name, value).is_ok()
}

/// The field lines of a flat `[name, value, ...]` array, as latin1 octets.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for an odd number of strings or a character above U+00FF.
pub(crate) fn lines(fields: &[String]) -> Result<Vec<Line<'_>>, Fail> {
    if !fields.len().is_multiple_of(2) {
        return Err(Fail::invalid(
            "the fields are name and value pairs, so their number is even",
        ));
    }
    let (pairs, _) = fields.as_chunks::<2>();
    let mut lines = Vec::with_capacity(pairs.len());
    for [name, value] in pairs {
        let name = latin1(name)
            .ok_or_else(|| Fail::invalid("a field name holds a character above U+00FF"))?;
        let value = latin1(value)
            .ok_or_else(|| Fail::invalid("a field value holds a character above U+00FF"))?;
        lines.push((name, value));
    }
    Ok(lines)
}

/// The field lines of a flat array, each checked with the core's rule, for a write
/// that takes more than one call.
///
/// # Errors
///
/// As [`lines`], and `ZERO_INVALID_ARGUMENT` naming the first refused line.
pub(crate) fn checked_lines(fields: &[String]) -> Result<Vec<Line<'_>>, Fail> {
    let lines = lines(fields)?;
    for (index, (name, value)) in lines.iter().enumerate() {
        if !field_allowed(name, value) {
            return Err(Fail::invalid(format!(
                "field line {index} is refused: a token name the driver does not write, and a value without CR, LF, NUL or surrounding whitespace"
            )));
        }
    }
    Ok(lines)
}

/// The lines as the name and value slices the core's writers take.
pub(crate) fn pairs<'a>(
    lines: &'a [Line<'a>],
) -> impl Iterator<Item = (&'a [u8], &'a [u8])> + Clone + 'a {
    lines
        .iter()
        .map(|(name, value)| (name.as_ref(), value.as_ref()))
}

/// Write a status when one is given and append the lines, before an action.
fn head(id: u64, status: u16, lines: &[Line<'_>]) -> Result<(), Fail> {
    if status != 0 {
        access::status(id, status)?;
    }
    for (name, value) in lines {
        access::header(id, name, value, FieldMode::Append)?;
    }
    Ok(())
}

/// Check one field line with the rule the core's response writers apply, as the
/// facade does when a header is set, before the response is written.
///
/// # Arguments
///
/// * `name` - the field name.
/// * `value` - the field value.
///
/// # Returns
///
/// 0 when a host may write the line, 9 (`InvalidArgument`) when it may not,
/// including a character above U+00FF.
#[napi(catch_unwind)]
pub fn field_validate(name: String, value: String) -> napi::Result<i32, Code> {
    node_guard(|| {
        let allowed = match (latin1(&name), latin1(&value)) {
            (Some(name), Some(value)) => field_allowed(&name, &value),
            _ => false,
        };
        Ok(if allowed {
            Status::Ok.code()
        } else {
            Status::InvalidArgument.code()
        })
    })
}

/// Write the status, the field lines and the body in one call and seal the
/// response. Every line is checked before any is written, so a refused call leaves
/// the response as it was; the lines are appended in order, each a line of its own,
/// so every `Set-Cookie` leaves as its own field line.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `status` - 200 to 599, or 0 to keep the status set before (200 when none was).
/// * `fields` - `[name, value, ...]`, latin1.
/// * `body` - the body: a `Buffer`, copied once; a string, written as UTF-8; or
///   `null` for none.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a status outside the range, a refused field line or a
/// character above U+00FF, `ZERO_LIMIT` for a body above the server's response
/// limit, and `ZERO_CLOSED` for a slot that is no longer leased or a sealed
/// response.
#[napi(
    catch_unwind,
    ts_args_type = "slot: number, status: number, fields: string[], body: Buffer | string | null"
)]
pub fn res_respond(
    slot: f64,
    status: f64,
    fields: Vec<String>,
    body: Option<Either<BufferSlice<'_>, String>>,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let status = ids::u16_of(status, "the status")?;
        let lines = lines(&fields)?;
        let bytes: &[u8] = match &body {
            Some(Either::A(buffer)) => buffer,
            Some(Either::B(text)) => text.as_bytes(),
            None => &[],
        };
        access::respond(id, status, pairs(&lines), bytes)?;
        Ok(Status::Ok.code())
    })
}

/// Answer with an error in the server's error shape and seal: the response written
/// so far is replaced by the status, the shape's `Content-Type` and the error body,
/// written in Rust. A status outside 400 to 599 is answered 500, malformed details
/// are dropped, and a message or details past the response limit are left out, so
/// only a refusal of the call itself fails it.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `status` - the status, 400 to 599.
/// * `code` - the error code: 1 to 64 characters of `A` to `Z`, `0` to `9` and `_`.
/// * `message` - the message, or `null` for the reason phrase.
/// * `details` - one JSON value with the details, or `null`.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a code outside its alphabet or length, and
/// `ZERO_CLOSED` for a slot that is no longer leased or a sealed response.
#[napi(
    catch_unwind,
    ts_args_type = "slot: number, status: number, code: string, message: string | null, details: string | null"
)]
pub fn res_error(
    slot: f64,
    status: f64,
    code: String,
    message: Option<String>,
    details: Option<String>,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let status = ids::whole_in(status, u64::from(u16::MAX))
            .and_then(|status| u16::try_from(status).ok())
            .unwrap_or(500);
        access::error(
            id,
            status,
            code.as_bytes(),
            message.as_deref().map(str::as_bytes),
            details.as_deref().map(str::as_bytes),
        )?;
        Ok(Status::Ok.code())
    })
}

/// Serve a file as the response once the request completes: the status and field
/// lines written now stay on the file response, and the core applies its file
/// policy (the path under the root, the method, ranges, validators) when it sends.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `status` - a status to set first, or 0.
/// * `fields` - `[name, value, ...]`, latin1.
/// * `root` - the root directory.
/// * `path` - the file's path under the root, percent-encoded as a request path is.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a refused field line, a status outside the range or an
/// empty root, `ZERO_UNSUPPORTED` when files are left out of the build, and
/// `ZERO_CLOSED` for a slot that is no longer leased or a sealed response.
#[napi(
    catch_unwind,
    ts_args_type = "slot: number, status: number, fields: string[], root: string, path: string"
)]
pub fn res_file(
    slot: f64,
    status: f64,
    fields: Vec<String>,
    root: String,
    path: String,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let status = ids::u16_of(status, "the status")?;
        let lines = checked_lines(&fields)?;
        head(id, status, &lines)?;
        access::file(id, root.as_bytes(), path.as_bytes())?;
        Ok(Status::Ok.code())
    })
}

/// Answer with a server-sent event stream once the request completes; the status
/// and field lines written now go into the stream's head. The connection id is valid
/// at once, and events sent before the head is written wait in its outbox.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `status` - a status to set first, or 0 for 200.
/// * `fields` - `[name, value, ...]`, latin1.
/// * `keepAliveMs` - the interval of the keep-alive comment; 0 writes none.
///
/// # Returns
///
/// The connection id.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a refused field line or a HEAD request,
/// `ZERO_UNSUPPORTED` when realtime is left out of the build, and `ZERO_CLOSED` for a
/// slot that is no longer leased or a sealed response.
#[napi(
    catch_unwind,
    ts_args_type = "slot: number, status: number, fields: string[], keepAliveMs: number"
)]
pub fn res_sse_open(
    slot: f64,
    status: f64,
    fields: Vec<String>,
    keep_alive_ms: f64,
) -> napi::Result<f64, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let status = ids::u16_of(status, "the status")?;
        let keep_alive = ids::u32_of(keep_alive_ms, "the keep-alive interval")?;
        let lines = checked_lines(&fields)?;
        head(id, status, &lines)?;
        let conn = access::sse_open(id, keep_alive)?;
        Ok(ids::number(conn))
    })
}

/// Accept a WebSocket route's upgrade request once it completes: the core writes the
/// `101` and serves the connection. A host that declines answers the request with an
/// error status instead.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `protocol` - a subprotocol the client offered and the route allows, or `null`
///   for none.
///
/// # Returns
///
/// The connection id.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a request that is not a WebSocket route's upgrade or a
/// subprotocol not offered or not allowed, `ZERO_UNSUPPORTED` when realtime is left
/// out of the build, and `ZERO_CLOSED` for a slot that is no longer leased or a
/// sealed response.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
#[napi(catch_unwind, ts_args_type = "slot: number, protocol: string | null")]
pub fn res_ws_accept(slot: f64, protocol: Option<String>) -> napi::Result<f64, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let protocol = protocol.as_deref().map_or(&[][..], str::as_bytes);
        let conn = access::ws_accept(id, protocol)?;
        Ok(ids::number(conn))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_text(text: &str) -> String {
        text.chars()
            .map(|character| match character {
                '"' => "\\\"".to_owned(),
                '\\' => "\\\\".to_owned(),
                control if u32::from(control) < 0x20 => format!("\\u{:04x}", u32::from(control)),
                other => other.to_string(),
            })
            .collect()
    }

    fn conformance_accepts(name: &str, value: &[u8]) -> bool {
        let hex: String = value.iter().map(|byte| format!("{byte:02x}")).collect();
        let name_json = json_text(name);
        let input = format!(
            r#"{{"cases":[{{"name":"probe","field":"{name_json}","value":"{hex}","accepted":false}}]}}"#
        );
        let result = zero_host::conformance::case(b"responseSplitting", input.as_bytes())
            .expect("the conformance entry runs the case");
        result.contains(r#""accepted":true"#)
    }

    #[test]
    fn the_field_rule_matches_the_core_response_writers_rule_over_every_value_octet() {
        for byte in 0..=u8::MAX {
            for value in [vec![byte], vec![b'a', byte, b'b']] {
                assert_eq!(
                    field_allowed(b"x-probe", &value),
                    conformance_accepts("x-probe", &value),
                    "value {value:?}"
                );
            }
        }
    }

    #[test]
    fn the_field_rule_refuses_the_names_the_driver_writes_and_non_tokens() {
        for name in [
            "Content-Length",
            "connection",
            "TRANSFER-ENCODING",
            "Date",
            "",
            "a b",
            "a:b",
            "x\r\ny",
        ] {
            assert!(!field_allowed(name.as_bytes(), b"1"), "{name:?}");
            assert!(!conformance_accepts(name, b"1"), "{name:?}");
        }
        for name in [
            "Set-Cookie",
            "x-request-id",
            "Cache-Control",
            "!#$%&'*+-.^_`|~",
        ] {
            assert!(field_allowed(name.as_bytes(), b"1"), "{name:?}");
            assert!(conformance_accepts(name, b"1"), "{name:?}");
        }
    }

    #[test]
    fn a_character_above_u00ff_is_refused_instead_of_truncated() {
        assert_eq!(latin1("plain").as_deref(), Some(&b"plain"[..]));
        assert_eq!(latin1("caf\u{e9}").as_deref(), Some(&b"caf\xe9"[..]));
        assert_eq!(latin1("\u{10a}"), None, "U+010A would truncate to LF");
        assert_eq!(latin1("\u{10d}"), None, "U+010D would truncate to CR");
        assert_eq!(latin1("\u{100}"), None, "U+0100 would truncate to NUL");
    }

    #[test]
    fn the_fields_are_name_and_value_pairs() {
        let fields = vec!["a".to_owned(), "1".to_owned(), "b".to_owned()];
        assert!(lines(&fields).is_err());
        let fields = vec!["a".to_owned(), "1".to_owned()];
        assert_eq!(lines(&fields).ok().map(|lines| lines.len()), Some(1));
    }
}
