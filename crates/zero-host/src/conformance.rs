//! The conformance entry: one stateless, total function that runs part of
//! `conformance/vectors.json` through the parsers and encoders the server uses, so
//! the Rust tests and the runner of every binding assert the same vectors against
//! the same code.
//!
//! [`case`] takes the name of a section and a JSON document in the shape that section
//! has in the vectors file: any of its members, and any of the cases of a list of
//! cases. A runner passes a whole section in one call, or one case at a time as
//! `{"cases":[case]}`, as `{"table":table,"cases":[case]}` for `router`, and as
//! `{"integers":{"cases":[case]}}` for a group of `qpack` or `h3Frames`. The result is
//! the same document with every outcome computed again from the inputs of its case,
//! written as canonical JSON: keys sorted, no whitespace between tokens. It holds the
//! members the input holds and no others, and a case comes back whole: its `name`,
//! its `section` and its inputs as read, and every outcome replaced, whatever the
//! input carried for it. So the result equals the input exactly when the core agrees
//! with the vectors, and a runner compares the two without knowing any section.
//!
//! As in the vectors file, octets are lowercase hexadecimal strings; decoded octets,
//! such as a field name or value, a path or the text of a string literal, are text
//! when they are UTF-8 and `{"hex": ...}` with their octets otherwise, so octets that
//! are not text come back as the parser returned them; and integers that can pass
//! 2^53 - 1, where JSON numbers stop being interoperable, are decimal strings. What
//! each section computes:
//!
//! - `http1Parser`: for each `request`, the `expect` that `zero-http1` gives it under
//!   the server's default limits: the `head`, the `reject` with its status, or
//!   `"partial"`.
//! - `responseSplitting`: for each `field` and `value`, whether a host may write the
//!   field line (`accepted`): a token name the driver does not write itself, and a
//!   field value.
//! - `router`: the `table` (`routes`, `mounts` and `trailingSlash`), which a document
//!   holding cases also holds, and for each `method` and `target` the `expect` the
//!   server gives the request line `<method> <target> HTTP/1.1` with a `Host` field:
//!   the request parser's rejection status, the core's own answer to an asterisk-form
//!   target (200 for `OPTIONS *`), or what `zero-router` gives the path of an
//!   origin-form or absolute-form target: the match, or the status, with `allow` for
//!   405 and for the automatic OPTIONS answer.
//! - `ws`: for each case, the response to its `request` under the route's
//!   `routeProtocols` and `routeOrigins`, and for the `frames` and `close` kinds, once
//!   that handshake is accepted, the `events`, `serverFrames`, `failed` close code and
//!   `finished` flag of the session `zero-ws` runs over `clientFrames`.
//! - `sse`: for each `call` (an event, a comment or a retry), the stream `bytes` that
//!   `zero-sse` writes, or `rejected` when it refuses the call.
//! - `qpack` and `h3Frames`: in each group, what `zero-qpack` and `zero-h3` make of
//!   the octets a case gives (the decoded `value`, `text`, `lines`, `representations`,
//!   `instructions` or `events`, and the error with its code), the octets their
//!   encoders write for the field lines or settings a case gives, and the verdicts of
//!   the stream, setting and identifier rules on the values a case gives.
//!
//! An unknown section, and `ws` and `sse` in a build without the `realtime` feature,
//! are refused as unsupported whatever the document. The entry keeps no state and
//! never panics, since a binding hands it bytes it has not checked.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-6>
//! @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-8.1>

use zero_core::Value;
use zero_h3::{
    reserved, varint, CapsuleDecoder, CapsuleStep, Datagram, Disposition, ErrorCode, Frame,
    FrameDecoder, FrameHeader, FrameLimits, GoawaySender, PeerControl, Reserved, Role, Scope,
    Settings, Step, StreamKind, StreamType, UniStreams,
};
use zero_http::{target_route, TargetRoute};
use zero_http1::{parse_request, BodyLength, Field, Status as Parsed, Version};
use zero_http_types::field::validate_field_value;
use zero_http_types::{Method, StatusCode};
use zero_json::{ErrorKind, WriteError, Writer};
use zero_limits::http1::{Http1Limits, HEADER_TABLE_ENTRIES};
use zero_limits::transport::QPACK_INTEGER_CAP;
use zero_limits::Http3Limits;
use zero_qpack::integer::{PrefixBits, MAX_VALUE};
use zero_qpack::table::STATIC_TABLE;
use zero_qpack::{
    huffman, integer, Decoder, DecoderInstruction, DecoderStreamReceiver, Encoder, EncoderHead,
    EncoderInstruction, EncoderStreamReceiver, FieldLine, HuffmanPolicy, Prefix, Representation,
    StringLiteral,
};
use zero_router::{Resolution, Router, TrailingSlash};

use crate::spec::writable_field_name;
use crate::{HostError, Status};

/// The sections of `conformance/vectors.json` the entry runs, named as the file
/// names them.
pub const SECTIONS: [&str; 7] = [
    Section::Http1Parser.name(),
    Section::ResponseSplitting.name(),
    Section::Router.name(),
    Section::Ws.name(),
    Section::Sse.name(),
    Section::Qpack.name(),
    Section::H3Frames.name(),
];

/// Runs part of a section of `conformance/vectors.json` through the parsers and
/// encoders the server uses.
///
/// # Arguments
///
/// * `section` - the name of the section, one of [`SECTIONS`].
/// * `input` - a JSON document in the section's shape: any of its members, and any
///   of the cases of a list of cases.
///
/// # Returns
///
/// The document with every outcome computed again, as canonical JSON with sorted
/// keys; it equals the input when the core agrees with the vectors.
///
/// # Errors
///
/// [`Status::Unsupported`] for a section outside [`SECTIONS`], and for `ws` and `sse`
/// in a build without the `realtime` feature, whatever the document;
/// [`Status::Limit`] for a document past the JSON size cap of one mebibyte or the
/// nesting cap; [`Status::Codec`] for a document that is not JSON or does not have
/// the section's shape, with the path of the member at fault.
pub fn case(section: &[u8], input: &[u8]) -> Result<String, HostError> {
    let Some(known) = Section::parse(section) else {
        let shown = section.get(..64).unwrap_or(section);
        return Err(HostError::unsupported(format!(
            "no conformance section is named {}",
            String::from_utf8_lossy(shown)
        )));
    };
    if !known.compiled() {
        return Err(compiled_out(known));
    }
    let name = known.name();
    let value = zero_json::parse(input).map_err(|error| {
        let status = match error.kind {
            ErrorKind::TooLarge | ErrorKind::TooDeep => Status::Limit,
            _ => Status::Codec,
        };
        HostError::new(status, format!("{name}: {error}"))
    })?;
    let result = run(known, &Object::new(&value, name.to_owned())?)?;
    let mut written = Vec::new();
    write(&result, &mut Writer::new(&mut written))
        .map_err(|error| HostError::codec(format!("{name}: the result: {error}")))?;
    String::from_utf8(written)
        .map_err(|_| HostError::codec(format!("{name}: the result is not UTF-8")))
}

/// A section of the vectors file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Section {
    Http1Parser,
    ResponseSplitting,
    Router,
    Ws,
    Sse,
    Qpack,
    H3Frames,
}

impl Section {
    const ALL: [Self; 7] = [
        Self::Http1Parser,
        Self::ResponseSplitting,
        Self::Router,
        Self::Ws,
        Self::Sse,
        Self::Qpack,
        Self::H3Frames,
    ];

    /// The name the vectors file gives the section.
    const fn name(self) -> &'static str {
        match self {
            Self::Http1Parser => "http1Parser",
            Self::ResponseSplitting => "responseSplitting",
            Self::Router => "router",
            Self::Ws => "ws",
            Self::Sse => "sse",
            Self::Qpack => "qpack",
            Self::H3Frames => "h3Frames",
        }
    }

    /// The section a name names.
    fn parse(name: &[u8]) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|section| section.name().as_bytes() == name)
    }

    /// Whether this build holds the capability the section runs: `ws` and `sse` need
    /// the `realtime` feature.
    const fn compiled(self) -> bool {
        !matches!(self, Self::Ws | Self::Sse) || cfg!(feature = "realtime")
    }
}

/// The refusal of a section whose capability this build leaves out.
fn compiled_out(section: Section) -> HostError {
    HostError::unsupported(format!(
        "the {} section needs the realtime feature, which this build leaves out",
        section.name()
    ))
}

/// Runs a section document.
fn run(section: Section, document: &Object<'_>) -> Result<Out, HostError> {
    match section {
        Section::Http1Parser => recompute(document, HTTP1_PARSER),
        Section::ResponseSplitting => recompute(document, RESPONSE_SPLITTING),
        Section::Router => router_document(document),
        #[cfg(feature = "realtime")]
        Section::Ws => recompute(document, realtime::WS),
        #[cfg(feature = "realtime")]
        Section::Sse => recompute(document, realtime::SSE),
        #[cfg(not(feature = "realtime"))]
        Section::Ws | Section::Sse => Err(compiled_out(section)),
        Section::Qpack => recompute(document, QPACK),
        Section::H3Frames => recompute(document, H3_FRAMES),
    }
}

/// The result, built before it is written: object members are written in key order.
enum Out {
    Null,
    Bool(bool),
    Uint(u64),
    Text(String),
    List(Vec<Out>),
    Map(Vec<(&'static str, Out)>),
}

/// Writes a result as canonical JSON.
fn write(value: &Out, writer: &mut Writer<'_>) -> Result<(), WriteError> {
    match value {
        Out::Null => {
            writer.null()?;
        }
        Out::Bool(flag) => {
            writer.bool(*flag)?;
        }
        Out::Uint(number) => {
            writer.uint(*number)?;
        }
        Out::Text(content) => {
            writer.string(content)?;
        }
        Out::List(items) => {
            writer.begin_array()?;
            for item in items {
                write(item, writer)?;
            }
            writer.end_array()?;
        }
        Out::Map(members) => {
            let mut sorted: Vec<&(&'static str, Out)> = members.iter().collect();
            sorted.sort_by_key(|member| member.0);
            writer.begin_object()?;
            for (key, member) in sorted {
                writer.key(key)?;
                write(member, writer)?;
            }
            writer.end_object()?;
        }
    }
    Ok(())
}

/// Text, copied.
fn text(content: &str) -> Out {
    Out::Text(content.to_owned())
}

/// Decoded octets: text when they are UTF-8, and otherwise `{"hex": ...}` with the
/// octets in lowercase hexadecimal, so octets that are not text, such as obs-text in
/// a field value, which a recipient treats as opaque data, come back as the parser
/// returned them.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
fn decoded(bytes: &[u8]) -> Out {
    match std::str::from_utf8(bytes) {
        Ok(content) => text(content),
        Err(_) => Out::Map(vec![("hex", octets(bytes))]),
    }
}

/// Octets as lowercase hexadecimal.
fn octets(bytes: &[u8]) -> Out {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(bytes.len().saturating_mul(2));
    for &byte in bytes {
        for nibble in [byte.wrapping_shr(4), byte & 0x0f] {
            hex.push(char::from(
                DIGITS.get(usize::from(nibble)).copied().unwrap_or(b'0'),
            ));
        }
    }
    Out::Text(hex)
}

/// An integer as a decimal string.
fn decimal(value: u64) -> Out {
    Out::Text(value.to_string())
}

/// The octets of lowercase hexadecimal text, or `None` for any other text.
fn parse_hex(hex: &str) -> Option<Vec<u8>> {
    let (pairs, rest) = hex.as_bytes().as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    pairs
        .iter()
        .map(|&[high, low]| Some(nibble(high)?.wrapping_shl(4) | nibble(low)?))
        .collect()
}

/// The value of a lowercase hexadecimal digit.
const fn nibble(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(digit.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    }
}

/// The value of a decimal string below 2^64 without leading zeros, or `None`.
fn parse_decimal(digits: &str) -> Option<u64> {
    let bytes = digits.as_bytes();
    if bytes.is_empty() || (bytes.len() > 1 && bytes.first() == Some(&b'0')) {
        return None;
    }
    bytes.iter().try_fold(0u64, |value, &digit| {
        if !digit.is_ascii_digit() {
            return None;
        }
        value
            .checked_mul(10)?
            .checked_add(u64::from(digit.wrapping_sub(b'0')))
    })
}

/// What a decimal string member must hold.
const DECIMAL: &str = "a decimal integer below 2^64 without leading zeros";

/// The refusal of a member that does not hold what its shape requires.
fn expected(path: String, what: &str) -> HostError {
    HostError::codec(format!("{path}: expected {what}"))
}

/// One object of the input document, with the path its refusals name.
struct Object<'a> {
    members: &'a [(String, Value)],
    path: String,
}

impl<'a> Object<'a> {
    /// The object a value holds.
    fn new(value: &'a Value, path: String) -> Result<Self, HostError> {
        match value {
            Value::Object(members) => Ok(Object { members, path }),
            _ => Err(expected(path, "an object")),
        }
    }

    /// The path of a member.
    fn at(&self, key: &str) -> String {
        format!("{}.{key}", self.path)
    }

    /// A member, when present.
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.members
            .iter()
            .find(|(name, _)| name.as_str() == key)
            .map(|(_, value)| value)
    }

    /// Refuses a member outside `keys`.
    fn only(&self, keys: &[&str]) -> Result<(), HostError> {
        match self
            .members
            .iter()
            .find(|(name, _)| !keys.contains(&name.as_str()))
        {
            Some((name, _)) => Err(HostError::codec(format!(
                "{}: not a member of this shape",
                self.at(name)
            ))),
            None => Ok(()),
        }
    }

    /// A member that must be present.
    fn required(&self, key: &str) -> Result<&'a Value, HostError> {
        self.get(key)
            .ok_or_else(|| HostError::codec(format!("{}: missing", self.at(key))))
    }

    /// A string member.
    fn string(&self, key: &str) -> Result<&'a str, HostError> {
        match self.required(key)? {
            Value::Str(content) => Ok(content),
            _ => Err(expected(self.at(key), "a string")),
        }
    }

    /// A string member that may be absent.
    fn optional_string(&self, key: &str) -> Result<Option<&'a str>, HostError> {
        match self.get(key) {
            None => Ok(None),
            Some(Value::Str(content)) => Ok(Some(content)),
            Some(_) => Err(expected(self.at(key), "a string")),
        }
    }

    /// A boolean member.
    fn boolean(&self, key: &str) -> Result<bool, HostError> {
        match self.required(key)? {
            Value::Bool(flag) => Ok(*flag),
            _ => Err(expected(self.at(key), "true or false")),
        }
    }

    /// A non-negative integer member.
    fn unsigned(&self, key: &str) -> Result<u64, HostError> {
        match self.required(key)? {
            Value::Int(number) => {
                u64::try_from(*number).map_err(|_| expected(self.at(key), "a non-negative integer"))
            }
            _ => Err(expected(self.at(key), "a non-negative integer")),
        }
    }

    /// A member holding octets as lowercase hexadecimal.
    fn hex(&self, key: &str) -> Result<Vec<u8>, HostError> {
        parse_hex(self.string(key)?)
            .ok_or_else(|| expected(self.at(key), "octets in lowercase hexadecimal"))
    }

    /// A member holding an integer as a decimal string.
    fn decimal(&self, key: &str) -> Result<u64, HostError> {
        parse_decimal(self.string(key)?).ok_or_else(|| expected(self.at(key), DECIMAL))
    }

    /// An array member.
    fn array(&self, key: &str) -> Result<&'a [Value], HostError> {
        match self.required(key)? {
            Value::Array(items) => Ok(items),
            _ => Err(expected(self.at(key), "an array")),
        }
    }

    /// An object member.
    fn object(&self, key: &str) -> Result<Object<'a>, HostError> {
        Object::new(self.required(key)?, self.at(key))
    }

    /// An array member of strings.
    #[cfg(feature = "realtime")]
    fn strings(&self, key: &str) -> Result<Vec<&'a str>, HostError> {
        let path = self.at(key);
        self.array(key)?
            .iter()
            .enumerate()
            .map(|(index, item)| match item {
                Value::Str(content) => Ok(content.as_str()),
                _ => Err(expected(format!("{path}[{index}]"), "a string")),
            })
            .collect()
    }

    /// A member holding null or an array of strings.
    #[cfg(feature = "realtime")]
    fn optional_strings(&self, key: &str) -> Result<Option<Vec<&'a str>>, HostError> {
        match self.required(key)? {
            Value::Null => Ok(None),
            _ => self.strings(key).map(Some),
        }
    }

    /// An array member of decimal strings.
    fn decimals(&self, key: &str) -> Result<Vec<u64>, HostError> {
        let path = self.at(key);
        self.array(key)?
            .iter()
            .enumerate()
            .map(|(index, item)| {
                match item {
                    Value::Str(content) => parse_decimal(content),
                    _ => None,
                }
                .ok_or_else(|| expected(format!("{path}[{index}]"), DECIMAL))
            })
            .collect()
    }
}

/// Computes one case of a list from its inputs.
type CaseFn = fn(&Object<'_>) -> Result<Out, HostError>;

/// Computes a member from the object that holds it and its key.
type MemberFn = fn(&Object<'_>, &str) -> Result<Out, HostError>;

/// What a member of a section or group holds, and how it is computed again.
#[derive(Clone, Copy)]
enum Member {
    /// A list of cases.
    Cases(CaseFn),
    /// A group of members.
    Group(&'static [(&'static str, Member)]),
    /// A value the function computes.
    Value(MemberFn),
    /// Text echoed as read.
    Text,
}

/// The members of a section or group the input holds, each computed again; a member
/// outside `members` is refused.
fn recompute(object: &Object<'_>, members: &[(&'static str, Member)]) -> Result<Out, HostError> {
    let keys: Vec<&str> = members.iter().map(|&(key, _)| key).collect();
    object.only(&keys)?;
    let mut out = Vec::new();
    for &(key, member) in members {
        if object.get(key).is_none() {
            continue;
        }
        let value = match member {
            Member::Cases(run) => each(object, key, run)?,
            Member::Group(inner) => recompute(&object.object(key)?, inner)?,
            Member::Value(run) => run(object, key)?,
            Member::Text => text(object.string(key)?),
        };
        out.push((key, value));
    }
    Ok(Out::Map(out))
}

/// A list of cases, each computed from its inputs.
fn each(owner: &Object<'_>, key: &str, run: CaseFn) -> Result<Out, HostError> {
    let path = owner.at(key);
    let list = owner.array(key)?;
    let mut out = Vec::with_capacity(list.len());
    for (index, item) in list.iter().enumerate() {
        out.push(run(&Object::new(item, format!("{path}[{index}]"))?)?);
    }
    Ok(Out::List(out))
}

/// The `name` and `section` of a case, echoed as read.
fn identity(case: &Object<'_>) -> Result<Vec<(&'static str, Out)>, HostError> {
    let mut members = Vec::new();
    for key in ["name", "section"] {
        if let Some(content) = case.optional_string(key)? {
            members.push((key, text(content)));
        }
    }
    Ok(members)
}

const HTTP1_PARSER: &[(&str, Member)] = &[("cases", Member::Cases(http1_parser_case))];

const RESPONSE_SPLITTING: &[(&str, Member)] = &[("cases", Member::Cases(splitting_case))];

const QPACK: &[(&str, Member)] = &[
    (
        "base",
        Member::Group(&[("cases", Member::Cases(base_case))]),
    ),
    (
        "decoderStream",
        Member::Group(&[("cases", Member::Cases(decoder_stream_case))]),
    ),
    (
        "encoderStream",
        Member::Group(&[("cases", Member::Cases(encoder_stream_case))]),
    ),
    (
        "encodings",
        Member::Group(&[("cases", Member::Cases(encoding_case))]),
    ),
    (
        "fieldSections",
        Member::Group(&[("cases", Member::Cases(field_section_case))]),
    ),
    (
        "huffman",
        Member::Group(&[("cases", Member::Cases(huffman_case))]),
    ),
    (
        "huffmanErrors",
        Member::Group(&[("cases", Member::Cases(huffman_error_case))]),
    ),
    (
        "integerErrors",
        Member::Group(&[("cases", Member::Cases(integer_error_case))]),
    ),
    (
        "integers",
        Member::Group(&[("cases", Member::Cases(integer_case))]),
    ),
    (
        "requiredInsertCount",
        Member::Group(&[("cases", Member::Cases(insert_count_case))]),
    ),
    (
        "staticTable",
        Member::Group(&[
            ("entries", Member::Value(static_entries)),
            ("section", Member::Text),
        ]),
    ),
];

const H3_FRAMES: &[(&str, Member)] = &[
    (
        "capsules",
        Member::Group(&[("cases", Member::Cases(capsule_case))]),
    ),
    (
        "datagrams",
        Member::Group(&[("cases", Member::Cases(datagram_case))]),
    ),
    (
        "errorCodes",
        Member::Group(&[
            ("onReceipt", Member::Cases(on_receipt_item)),
            ("registered", Member::Cases(registered_item)),
        ]),
    ),
    (
        "frames",
        Member::Group(&[("cases", Member::Cases(frame_case))]),
    ),
    (
        "goaway",
        Member::Group(&[
            ("cases", Member::Cases(goaway_case)),
            ("gracefulClient", Member::Value(graceful_client)),
            ("gracefulServer", Member::Value(graceful_server)),
        ]),
    ),
    (
        "reservedValues",
        Member::Group(&[
            ("first", Member::Value(first_reserved)),
            ("last", Member::Value(last_reserved)),
            ("notReserved", Member::Value(not_reserved)),
            ("section", Member::Text),
        ]),
    ),
    (
        "serverControlStream",
        Member::Group(&[
            ("encoded", Member::Value(control_preface)),
            ("section", Member::Text),
            ("settings", Member::Value(server_settings)),
            ("withReserved", Member::Value(preface_with_reserved)),
        ]),
    ),
    (
        "settings",
        Member::Group(&[("cases", Member::Cases(settings_case))]),
    ),
    (
        "streamTypes",
        Member::Group(&[("cases", Member::Cases(stream_type_case))]),
    ),
    (
        "uniStreams",
        Member::Group(&[
            ("cases", Member::Cases(uni_streams_case)),
            ("closed", Member::Cases(closed_item)),
        ]),
    ),
    (
        "varints",
        Member::Group(&[
            ("cases", Member::Cases(varint_case)),
            ("refused", Member::Value(refused_varints)),
        ]),
    ),
];

/// One `http1Parser` case: what the request head parser makes of the request.
fn http1_parser_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["expect", "name", "request", "section"])?;
    let request = case.hex("request")?;
    let mut members = identity(case)?;
    members.push(("expect", head_outcome(&request)));
    members.push(("request", octets(&request)));
    Ok(Out::Map(members))
}

/// The head, the rejection or `"partial"` the parser gives a request under the
/// server's default limits and field table.
fn head_outcome(request: &[u8]) -> Out {
    let mut table = [Field::EMPTY; HEADER_TABLE_ENTRIES];
    match parse_request(request, &mut table, &Http1Limits::DEFAULT) {
        Parsed::Complete(head) => {
            let fields = table
                .iter()
                .take(head.field_count)
                .map(|field| {
                    Out::List(vec![
                        decoded(field.name(request)),
                        decoded(field.value(request)),
                    ])
                })
                .collect();
            let body = match head.body {
                BodyLength::None => text("none"),
                BodyLength::Chunked => text("chunked"),
                BodyLength::Length(length) => Out::Map(vec![("length", Out::Uint(length))]),
            };
            let version = match head.version {
                Version::Http10 => "HTTP/1.0",
                Version::Http11 => "HTTP/1.1",
            };
            Out::Map(vec![(
                "head",
                Out::Map(vec![
                    ("body", body),
                    ("fields", Out::List(fields)),
                    ("keepAlive", Out::Bool(head.keep_alive)),
                    ("method", decoded(head.method_token.of(request))),
                    ("target", decoded(head.target.of(request))),
                    ("version", text(version)),
                ]),
            )])
        }
        Parsed::Partial => text("partial"),
        Parsed::Reject(reject) => Out::Map(vec![(
            "reject",
            Out::Map(vec![
                ("close", Out::Bool(reject.close)),
                ("status", Out::Uint(u64::from(reject.status.as_u16()))),
            ]),
        )]),
    }
}

/// One `responseSplitting` case: whether a host may write the field line.
fn splitting_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["accepted", "field", "name", "section", "value"])?;
    let field = case.string("field")?;
    let value = case.hex("value")?;
    let mut members = identity(case)?;
    members.push((
        "accepted",
        Out::Bool(host_field_accepted(field.as_bytes(), &value)),
    ));
    members.push(("field", text(field)));
    members.push(("value", octets(&value)));
    Ok(Out::Map(members))
}

/// Whether a host may write a field line: the name is an RFC 9110 token the driver
/// does not write itself ([`zero_http::DRIVER_FIELDS`], compared without regard to
/// case), and the value is a field value, which holds no CR, LF or NUL and no
/// leading or trailing whitespace.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.2>
fn host_field_accepted(name: &[u8], value: &[u8]) -> bool {
    writable_field_name(name) && validate_field_value(value).is_ok()
}

/// The `router` section: the table, and the cases resolved against it.
fn router_document(document: &Object<'_>) -> Result<Out, HostError> {
    document.only(&["cases", "table"])?;
    let table = match document.get("table") {
        Some(_) => Some(read_table(&document.object("table")?)?),
        None => None,
    };
    let mut members = Vec::new();
    if document.get("cases").is_some() {
        let Some((router, _)) = &table else {
            return Err(HostError::codec(format!(
                "{}: the cases need the table beside them",
                document.at("cases")
            )));
        };
        let path = document.at("cases");
        let list = document.array("cases")?;
        let mut cases = Vec::with_capacity(list.len());
        for (index, item) in list.iter().enumerate() {
            cases.push(route_case(
                &Object::new(item, format!("{path}[{index}]"))?,
                router,
            )?);
        }
        members.push(("cases", Out::List(cases)));
    }
    if let Some((_, echo)) = table {
        members.push(("table", echo));
    }
    Ok(Out::Map(members))
}

/// The router a table describes, and the table as read.
fn read_table(table: &Object<'_>) -> Result<(Router<u32>, Out), HostError> {
    table.only(&["mounts", "routes", "trailingSlash"])?;
    let rule = table.string("trailingSlash")?;
    let trailing = match rule {
        "ignore" => TrailingSlash::Ignore,
        "strict" => TrailingSlash::Strict,
        _ => {
            return Err(expected(
                table.at("trailingSlash"),
                "\"ignore\" or \"strict\"",
            ))
        }
    };
    let mut router = Router::new().with_trailing_slash(trailing);
    let routes = add_routes(&mut router, table)?;
    let path = table.at("mounts");
    let mut mounts = Vec::new();
    for (index, item) in table.array("mounts")?.iter().enumerate() {
        let mount = Object::new(item, format!("{path}[{index}]"))?;
        mount.only(&["prefix", "routes"])?;
        let prefix = mount.string("prefix")?;
        let mut child = Router::new().with_trailing_slash(trailing);
        let child_routes = add_routes(&mut child, &mount)?;
        router
            .mount(prefix, child)
            .map_err(|error| HostError::codec(format!("{}: {error}", mount.at("prefix"))))?;
        mounts.push(Out::Map(vec![
            ("prefix", text(prefix)),
            ("routes", child_routes),
        ]));
    }
    let echo = Out::Map(vec![
        ("mounts", Out::List(mounts)),
        ("routes", routes),
        ("trailingSlash", text(rule)),
    ]);
    Ok((router, echo))
}

/// Registers the routes an object lists, and returns them as read.
fn add_routes(router: &mut Router<u32>, owner: &Object<'_>) -> Result<Out, HostError> {
    let path = owner.at("routes");
    let mut echo = Vec::new();
    for (index, item) in owner.array("routes")?.iter().enumerate() {
        let route = Object::new(item, format!("{path}[{index}]"))?;
        route.only(&["id", "method", "pattern"])?;
        let token = route.string("method")?;
        let method = Method::parse(token.as_bytes())
            .ok_or_else(|| expected(route.at("method"), "a method the server implements"))?;
        let pattern = route.string("pattern")?;
        let id = u32::try_from(route.unsigned("id")?)
            .map_err(|_| expected(route.at("id"), "a route id below 2^32"))?;
        router
            .route(method, pattern, id)
            .map_err(|error| HostError::codec(format!("{}: {error}", route.at("pattern"))))?;
        echo.push(Out::Map(vec![
            ("id", Out::Uint(u64::from(id))),
            ("method", text(token)),
            ("pattern", text(pattern)),
        ]));
    }
    Ok(Out::List(echo))
}

/// One `router` case: what the server answers for the method token and the target.
fn route_case(case: &Object<'_>, router: &Router<u32>) -> Result<Out, HostError> {
    case.only(&["expect", "method", "name", "section", "target"])?;
    let method = case.string("method")?;
    let target = case.string("target")?;
    let expect = resolution(router, method.as_bytes(), target.as_bytes()).ok_or_else(|| {
        HostError::codec(format!(
            "{}: the request line of the method and the target does not end",
            case.at("target")
        ))
    })?;
    let mut members = identity(case)?;
    members.push(("expect", expect));
    members.push(("method", text(method)));
    members.push(("target", text(target)));
    Ok(Out::Map(members))
}

/// The request a router case stands for: the request line of its method token and
/// target, with the `Host` field an HTTP/1.1 request carries (RFC 9112 Section 3.2).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2>
fn request_line(method: &[u8], target: &[u8]) -> Vec<u8> {
    const REST: &[u8] = b" HTTP/1.1\r\nHost: www.example.org\r\n\r\n";
    let mut request = Vec::with_capacity(
        method
            .len()
            .saturating_add(target.len())
            .saturating_add(REST.len())
            .saturating_add(1),
    );
    request.extend_from_slice(method);
    request.push(b' ');
    request.extend_from_slice(target);
    request.extend_from_slice(REST);
    request
}

/// What the server answers for a method token and a target, step by step as the
/// driver and the core take the request: the request parser's rejection under the
/// default limits, the answer the core gives a target it does not route
/// ([`target_route`]: `OPTIONS *` and any other asterisk-form request), and
/// otherwise the router's match or status for the path, which is the whole
/// origin-form target or what follows the authority of an absolute-form one. `None`
/// when the request line does not end, which no method and target can bring about.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.7>
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2.2>
fn resolution(router: &Router<u32>, method: &[u8], target: &[u8]) -> Option<Out> {
    let status = |code: StatusCode| ("status", Out::Uint(u64::from(code.as_u16())));
    let request = request_line(method, target);
    let mut table = [Field::EMPTY; HEADER_TABLE_ENTRIES];
    let head = match parse_request(&request, &mut table, &Http1Limits::DEFAULT) {
        Parsed::Complete(head) => head,
        Parsed::Reject(reject) => return Some(Out::Map(vec![status(reject.status)])),
        Parsed::Partial => return None,
    };
    let path = match target_route(&head, &request) {
        TargetRoute::Path(path) => path,
        TargetRoute::Server(code) | TargetRoute::NotAPath(code) => {
            return Some(Out::Map(vec![status(code)]));
        }
    };
    let mut scratch = Vec::new();
    let Ok(resolved) = router.resolve_target(head.method_token.of(&request), path, &mut scratch)
    else {
        return Some(Out::Map(vec![status(StatusCode::BAD_REQUEST)]));
    };
    let allow = |allow: zero_router::Allow| {
        let mut list = Vec::new();
        allow.write(&mut list);
        ("allow", decoded(&list))
    };
    Some(match resolved.resolution {
        Resolution::Matched {
            descriptor,
            params,
            head: is_head,
        } => {
            let params = params
                .iter()
                .map(|(name, range)| {
                    Out::List(vec![
                        decoded(name),
                        decoded(resolved.path.get(range).unwrap_or(&[])),
                    ])
                })
                .collect();
            Out::Map(vec![(
                "matched",
                Out::Map(vec![
                    ("head", Out::Bool(is_head)),
                    ("id", Out::Uint(u64::from(descriptor))),
                    ("params", Out::List(params)),
                    ("path", decoded(resolved.path)),
                    ("query", resolved.query.map_or(Out::Null, decoded)),
                ]),
            )])
        }
        Resolution::NotFound => Out::Map(vec![status(StatusCode::NOT_FOUND)]),
        Resolution::MethodNotAllowed { allow: methods } => {
            Out::Map(vec![allow(methods), status(StatusCode::METHOD_NOT_ALLOWED)])
        }
        Resolution::Options { allow: methods } => {
            Out::Map(vec![allow(methods), status(StatusCode::OK)])
        }
        Resolution::NotImplemented => Out::Map(vec![status(StatusCode::NOT_IMPLEMENTED)]),
    })
}

/// The QPACK static table, entry by entry.
fn static_entries(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(Out::List(
        STATIC_TABLE
            .iter()
            .map(|entry| Out::List(vec![decoded(entry.name), decoded(entry.value)]))
            .collect(),
    ))
}

/// A prefix size from 1 to 8, as read and as the integer codec takes it.
fn read_prefix(case: &Object<'_>) -> Result<(u8, PrefixBits), HostError> {
    let read = case.unsigned("prefixBits")?;
    u8::try_from(read)
        .ok()
        .and_then(|bits| PrefixBits::new(bits).map(|prefix| (bits, prefix)))
        .ok_or_else(|| expected(case.at("prefixBits"), "a prefix size from 1 to 8"))
}

/// One `integers` case: the value the octets encode with the prefix, when they are
/// one whole integer, or null.
fn integer_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "name", "prefixBits", "section", "value"])?;
    let (bits, prefix) = read_prefix(case)?;
    let encoded = case.hex("encoded")?;
    let value = match integer::decode(&encoded, prefix, MAX_VALUE) {
        Ok(Some((value, used))) if used == encoded.len() => decimal(value),
        _ => Out::Null,
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("prefixBits", Out::Uint(u64::from(bits))));
    members.push(("value", value));
    Ok(Out::Map(members))
}

/// One `integerErrors` case: the name of the error the integer codec refuses the
/// octets with under the cap, or null.
fn integer_error_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["cap", "encoded", "error", "name", "prefixBits", "section"])?;
    let (bits, prefix) = read_prefix(case)?;
    let cap = case.decimal("cap")?;
    let encoded = case.hex("encoded")?;
    let error = match integer::decode(&encoded, prefix, cap) {
        Err(error) => text(error.name()),
        Ok(_) => Out::Null,
    };
    let mut members = identity(case)?;
    members.push(("cap", decimal(cap)));
    members.push(("encoded", octets(&encoded)));
    members.push(("error", error));
    members.push(("prefixBits", Out::Uint(u64::from(bits))));
    Ok(Out::Map(members))
}

/// One `huffman` case: the text the octets decode to, or null when they do not
/// decode.
fn huffman_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "name", "section", "text"])?;
    let encoded = case.hex("encoded")?;
    let mut plain = Vec::new();
    let decoded_text = match huffman::decode_to_vec(&encoded, &mut plain) {
        Ok(()) => decoded(&plain),
        Err(_) => Out::Null,
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("text", decoded_text));
    Ok(Out::Map(members))
}

/// One `huffmanErrors` case: the name of the error the octets fail to decode with,
/// or null.
fn huffman_error_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "error", "name", "section"])?;
    let encoded = case.hex("encoded")?;
    let mut plain = Vec::new();
    let error = match huffman::decode_to_vec(&encoded, &mut plain) {
        Err(error) => text(error.name()),
        Ok(()) => Out::Null,
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("error", error));
    Ok(Out::Map(members))
}

/// One `fieldSections` case: what the static-only decoder makes of the section, and
/// the representations it holds, null when it does not parse into representations.
fn field_section_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "expect", "name", "representations", "section"])?;
    let encoded = case.hex("encoded")?;
    let expect = decode_section(&encoded)?;
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("expect", expect));
    members.push(("representations", representations_of(&encoded)));
    Ok(Out::Map(members))
}

/// The field lines the static-only decoder of the default limits yields for a whole
/// section, or the error it stops at.
fn decode_section(section: &[u8]) -> Result<Out, HostError> {
    let decoder = Decoder::new(&Http3Limits::DEFAULT).map_err(|error| {
        HostError::codec(format!("the QPACK decoder of the default limits: {error}"))
    })?;
    let lines: Result<Vec<FieldLine<'_>>, zero_qpack::Error> =
        decoder.decode(section).and_then(Iterator::collect);
    Ok(match lines {
        Ok(lines) => Out::Map(vec![(
            "lines",
            Out::List(lines.iter().map(field_line).collect()),
        )]),
        Err(error) => qpack_error(&error),
    })
}

/// A decoded field line.
fn field_line(line: &FieldLine<'_>) -> Out {
    Out::Map(vec![
        ("name", decoded(&line.name)),
        ("neverIndexed", Out::Bool(line.never_indexed)),
        ("value", decoded(&line.value)),
    ])
}

/// A QPACK error: its code, the name of the code, whether it closes the connection,
/// and the rule it names.
fn qpack_error(error: &zero_qpack::Error) -> Out {
    Out::Map(vec![(
        "error",
        Out::Map(vec![
            ("code", Out::Uint(error.code())),
            ("connection", Out::Bool(error.is_connection_error())),
            ("kind", text(error.fault.name())),
            ("name", text(error.code_name())),
        ]),
    )])
}

/// The representations of a whole field section after its prefix, or null when it
/// does not parse into representations.
fn representations_of(section: &[u8]) -> Out {
    let Ok((_, used)) = Prefix::parse(section) else {
        return Out::Null;
    };
    let mut rest = section.get(used..).unwrap_or(&[]);
    let mut list = Vec::new();
    while !rest.is_empty() {
        let Ok((representation, used)) = Representation::parse(rest) else {
            return Out::Null;
        };
        let Some(next) = rest.get(used..).filter(|_| used > 0) else {
            return Out::Null;
        };
        list.push(representation_value(&representation));
        rest = next;
    }
    Out::List(list)
}

/// A field line representation, its strings as decoded text.
fn representation_value(representation: &Representation<'_>) -> Out {
    let (kind, value) = match *representation {
        Representation::Indexed {
            static_table,
            index,
        } => (
            "indexed",
            Out::Map(vec![
                ("index", decimal(index)),
                ("static", Out::Bool(static_table)),
            ]),
        ),
        Representation::IndexedPostBase { index } => ("indexedPostBase", decimal(index)),
        Representation::LiteralNameReference {
            never_indexed,
            static_table,
            index,
            value,
        } => (
            "literalNameReference",
            Out::Map(vec![
                ("huffman", Out::Bool(value.huffman)),
                ("index", decimal(index)),
                ("neverIndexed", Out::Bool(never_indexed)),
                ("static", Out::Bool(static_table)),
                ("value", literal_text(&value)),
            ]),
        ),
        Representation::LiteralPostBaseNameReference {
            never_indexed,
            index,
            value,
        } => (
            "literalPostBaseNameReference",
            Out::Map(vec![
                ("huffman", Out::Bool(value.huffman)),
                ("index", decimal(index)),
                ("neverIndexed", Out::Bool(never_indexed)),
                ("value", literal_text(&value)),
            ]),
        ),
        Representation::LiteralName {
            never_indexed,
            name,
            value,
        } => (
            "literalName",
            Out::Map(vec![
                ("name", literal_text(&name)),
                ("nameHuffman", Out::Bool(name.huffman)),
                ("neverIndexed", Out::Bool(never_indexed)),
                ("value", literal_text(&value)),
                ("valueHuffman", Out::Bool(value.huffman)),
            ]),
        ),
    };
    Out::Map(vec![(kind, value)])
}

/// The decoded text of a string literal, or null when its Huffman coding is invalid.
fn literal_text(literal: &StringLiteral<'_>) -> Out {
    literal.decode().map_or(Out::Null, |plain| decoded(&plain))
}

/// One `encodings` case: the section the static-only encoder writes for the lines
/// under the Huffman policy, and its representations.
fn encoding_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "encoded",
        "huffman",
        "lines",
        "name",
        "representations",
        "section",
    ])?;
    let policy_name = case.string("huffman")?;
    let policy = match policy_name {
        "never" => HuffmanPolicy::Never,
        "shorter" => HuffmanPolicy::Shorter,
        "always" => HuffmanPolicy::Always,
        _ => {
            return Err(expected(
                case.at("huffman"),
                "\"never\", \"shorter\" or \"always\"",
            ))
        }
    };
    let path = case.at("lines");
    let mut read = Vec::new();
    for (index, item) in case.array("lines")?.iter().enumerate() {
        let line = Object::new(item, format!("{path}[{index}]"))?;
        line.only(&["name", "neverIndexed", "value"])?;
        read.push((
            line.string("name")?,
            line.string("value")?,
            line.boolean("neverIndexed")?,
        ));
    }
    let lines: Vec<FieldLine<'_>> = read
        .iter()
        .map(|&(name, value, never_indexed)| {
            if never_indexed {
                FieldLine::sensitive(name.as_bytes(), value.as_bytes())
            } else {
                FieldLine::new(name.as_bytes(), value.as_bytes())
            }
        })
        .collect();
    let mut section = Vec::new();
    let (encoded, representations) = match Encoder::new(policy).encode(&lines, &mut section) {
        Some(()) => (octets(&section), representations_of(&section)),
        None => (Out::Null, Out::Null),
    };
    let echo = read
        .iter()
        .map(|&(name, value, never_indexed)| {
            Out::Map(vec![
                ("name", text(name)),
                ("neverIndexed", Out::Bool(never_indexed)),
                ("value", text(value)),
            ])
        })
        .collect();
    let mut members = identity(case)?;
    members.push(("encoded", encoded));
    members.push(("huffman", text(policy_name)));
    members.push(("lines", Out::List(echo)));
    members.push(("representations", representations));
    Ok(Out::Map(members))
}

/// One `encoderStream` case: the instructions the octets hold, the head of the first
/// when they end inside an instruction, and the verdict of a decoder whose maximum
/// table capacity is zero.
fn encoder_stream_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "atCapacityZero",
        "encoded",
        "headOnly",
        "instructions",
        "name",
        "section",
    ])?;
    let encoded = case.hex("encoded")?;
    let instructions = encoder_instructions(&encoded);
    let head_only = match (
        &instructions,
        EncoderHead::parse(&encoded, QPACK_INTEGER_CAP),
    ) {
        (None, Ok(Some((head, _)))) => encoder_head_value(&head),
        _ => Out::Null,
    };
    let verdict = stream_verdict(
        EncoderStreamReceiver::new(QPACK_INTEGER_CAP).feed(&encoded),
        encoded.len(),
    );
    let mut members = identity(case)?;
    members.push(("atCapacityZero", verdict));
    members.push(("encoded", octets(&encoded)));
    members.push(("headOnly", head_only));
    members.push(("instructions", instructions.map_or(Out::Null, Out::List)));
    Ok(Out::Map(members))
}

/// The encoder instructions of the octets, or `None` when they end inside one or an
/// integer in one is refused.
fn encoder_instructions(input: &[u8]) -> Option<Vec<Out>> {
    let mut rest = input;
    let mut list = Vec::new();
    while !rest.is_empty() {
        let Ok(Some((instruction, used))) = EncoderInstruction::parse(rest, QPACK_INTEGER_CAP)
        else {
            return None;
        };
        list.push(encoder_instruction_value(&instruction));
        rest = rest.get(used..).filter(|_| used > 0)?;
    }
    Some(list)
}

/// An encoder instruction, its strings as decoded text.
fn encoder_instruction_value(instruction: &EncoderInstruction<'_>) -> Out {
    let (kind, value) = match *instruction {
        EncoderInstruction::SetDynamicTableCapacity { capacity } => {
            ("setDynamicTableCapacity", decimal(capacity))
        }
        EncoderInstruction::InsertWithNameReference {
            static_table,
            index,
            value,
        } => (
            "insertWithNameReference",
            Out::Map(vec![
                ("huffman", Out::Bool(value.huffman)),
                ("index", decimal(index)),
                ("static", Out::Bool(static_table)),
                ("value", literal_text(&value)),
            ]),
        ),
        EncoderInstruction::InsertWithLiteralName { name, value } => (
            "insertWithLiteralName",
            Out::Map(vec![
                ("name", literal_text(&name)),
                ("nameHuffman", Out::Bool(name.huffman)),
                ("value", literal_text(&value)),
                ("valueHuffman", Out::Bool(value.huffman)),
            ]),
        ),
        EncoderInstruction::Duplicate { index } => ("duplicate", decimal(index)),
    };
    Out::Map(vec![(kind, value)])
}

/// The opcode and first integer of an encoder instruction.
fn encoder_head_value(head: &EncoderHead) -> Out {
    let (kind, value) = match *head {
        EncoderHead::SetDynamicTableCapacity { capacity } => {
            ("setDynamicTableCapacity", decimal(capacity))
        }
        EncoderHead::InsertWithNameReference {
            static_table,
            index,
        } => (
            "insertWithNameReference",
            Out::Map(vec![
                ("index", decimal(index)),
                ("static", Out::Bool(static_table)),
            ]),
        ),
        EncoderHead::InsertWithLiteralName { huffman, name_len } => (
            "insertWithLiteralName",
            Out::Map(vec![
                ("huffman", Out::Bool(huffman)),
                ("nameLength", decimal(name_len)),
            ]),
        ),
        EncoderHead::Duplicate { index } => ("duplicate", decimal(index)),
    };
    Out::Map(vec![(kind, value)])
}

/// The verdict of a stream receiver: `"accepted"` when it consumed every octet,
/// `"needMore"` when the octets end inside an instruction, or the error.
fn stream_verdict(fed: Result<usize, zero_qpack::Error>, len: usize) -> Out {
    match fed {
        Ok(consumed) if consumed == len => text("accepted"),
        Ok(_) => text("needMore"),
        Err(error) => qpack_error(&error),
    }
}

/// One `decoderStream` case: the instructions the octets hold, and the verdict of an
/// encoder that never references the dynamic table.
fn decoder_stream_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "atStaticEncoder",
        "encoded",
        "instructions",
        "name",
        "section",
    ])?;
    let encoded = case.hex("encoded")?;
    let instructions = decoder_instructions(&encoded);
    let mut receiver = DecoderStreamReceiver;
    let verdict = stream_verdict(receiver.feed(&encoded), encoded.len());
    let mut members = identity(case)?;
    members.push(("atStaticEncoder", verdict));
    members.push(("encoded", octets(&encoded)));
    members.push(("instructions", instructions.map_or(Out::Null, Out::List)));
    Ok(Out::Map(members))
}

/// The decoder instructions of the octets, or `None` when they end inside one or an
/// integer in one is refused.
fn decoder_instructions(input: &[u8]) -> Option<Vec<Out>> {
    let mut rest = input;
    let mut list = Vec::new();
    while !rest.is_empty() {
        let Ok(Some((instruction, used))) = DecoderInstruction::parse(rest) else {
            return None;
        };
        let (kind, value) = match instruction {
            DecoderInstruction::SectionAcknowledgment { stream_id } => {
                ("sectionAcknowledgment", stream_id)
            }
            DecoderInstruction::StreamCancellation { stream_id } => {
                ("streamCancellation", stream_id)
            }
            DecoderInstruction::InsertCountIncrement { increment } => {
                ("insertCountIncrement", increment)
            }
        };
        list.push(Out::Map(vec![(kind, decimal(value))]));
        rest = rest.get(used..).filter(|_| used > 0)?;
    }
    Some(list)
}

/// One `requiredInsertCount` case: the Required Insert Count the decoder
/// reconstructs, or the name of the error.
fn insert_count_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "encodedInsertCount",
        "expect",
        "maxEntries",
        "name",
        "section",
        "totalInserts",
    ])?;
    let encoded = case.decimal("encodedInsertCount")?;
    let max_entries = case.decimal("maxEntries")?;
    let total_inserts = case.decimal("totalInserts")?;
    let expect =
        match zero_qpack::prefix::required_insert_count(encoded, max_entries, total_inserts) {
            Ok(count) => decimal(count),
            Err(fault) => Out::Map(vec![("error", text(fault.name()))]),
        };
    let mut members = identity(case)?;
    members.push(("encodedInsertCount", decimal(encoded)));
    members.push(("expect", expect));
    members.push(("maxEntries", decimal(max_entries)));
    members.push(("totalInserts", decimal(total_inserts)));
    Ok(Out::Map(members))
}

/// One `base` case: the Base of the Required Insert Count, the Sign bit and the Delta
/// Base, or the name of the error.
fn base_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "deltaBase",
        "expect",
        "name",
        "requiredInsertCount",
        "section",
        "sign",
    ])?;
    let count = case.decimal("requiredInsertCount")?;
    let sign = case.boolean("sign")?;
    let delta = case.decimal("deltaBase")?;
    let expect = match zero_qpack::prefix::base(count, sign, delta) {
        Ok(base) => decimal(base),
        Err(fault) => Out::Map(vec![("error", text(fault.name()))]),
    };
    let mut members = identity(case)?;
    members.push(("deltaBase", decimal(delta)));
    members.push(("expect", expect));
    members.push(("requiredInsertCount", decimal(count)));
    members.push(("sign", Out::Bool(sign)));
    Ok(Out::Map(members))
}

/// An HTTP/3 error: its code, the name of the code, whether it closes the
/// connection, and the rule it names.
fn h3_error(error: &zero_h3::Error) -> Out {
    let code = error.code();
    Out::Map(vec![(
        "error",
        Out::Map(vec![
            ("code", Out::Uint(code.0)),
            ("connection", Out::Bool(error.scope() == Scope::Connection)),
            ("kind", text(error.name())),
            ("name", code.name().map_or(Out::Null, text)),
        ]),
    )])
}

/// Settings with all five keys, null when absent.
fn settings_value(settings: &Settings) -> Out {
    let number = |value: Option<u64>| value.map_or(Out::Null, decimal);
    let flag = |value: Option<bool>| value.map_or(Out::Null, Out::Bool);
    Out::Map(vec![
        (
            "enableConnectProtocol",
            flag(settings.enable_connect_protocol),
        ),
        ("h3Datagram", flag(settings.h3_datagram)),
        (
            "maxFieldSectionSize",
            number(settings.max_field_section_size),
        ),
        (
            "qpackBlockedStreams",
            number(settings.qpack_blocked_streams),
        ),
        (
            "qpackMaxTableCapacity",
            number(settings.qpack_max_table_capacity),
        ),
    ])
}

/// The local role a case names.
fn read_role<'a>(case: &Object<'a>) -> Result<(&'a str, Role), HostError> {
    let name = case.string("role")?;
    let role = match name {
        "client" => Role::Client,
        "server" => Role::Server,
        _ => return Err(expected(case.at("role"), "\"client\" or \"server\"")),
    };
    Ok((name, role))
}

/// One `varints` case: the value the octets encode and whether the encoding is the
/// shortest, when they are one whole integer, or null.
fn varint_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "name", "section", "shortest", "value"])?;
    let encoded = case.hex("encoded")?;
    let (value, shortest) = match varint::decode(&encoded) {
        Some((value, used)) if used == encoded.len() => (
            decimal(value),
            Out::Bool(varint::encoded_len(value) == Some(used)),
        ),
        _ => (Out::Null, Out::Null),
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("shortest", shortest));
    members.push(("value", value));
    Ok(Out::Map(members))
}

/// The values of a list that no variable-length integer encodes.
fn refused_varints(owner: &Object<'_>, key: &str) -> Result<Out, HostError> {
    Ok(Out::List(
        owner
            .decimals(key)?
            .into_iter()
            .filter(|&value| varint::encoded_len(value).is_none())
            .map(decimal)
            .collect(),
    ))
}

/// The first reserved values, one for each item of the list.
fn first_reserved(owner: &Object<'_>, key: &str) -> Result<Out, HostError> {
    let count = owner.array(key)?.len();
    Ok(Out::List(
        (0u64..)
            .take(count)
            .map(|n| reserved::reserved(n).map_or(Out::Null, decimal))
            .collect(),
    ))
}

/// The largest reserved value.
fn last_reserved(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(reserved::reserved(reserved::MAX_N).map_or(Out::Null, decimal))
}

/// The values of a list that are not reserved.
fn not_reserved(owner: &Object<'_>, key: &str) -> Result<Out, HostError> {
    Ok(Out::List(
        owner
            .decimals(key)?
            .into_iter()
            .filter(|&value| !reserved::is_reserved(value))
            .map(decimal)
            .collect(),
    ))
}

/// One `frames` case: the frames the decoder reads from one stream, the pieces of a
/// DATA frame joined, and how the input ends.
fn frame_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "encoded",
        "events",
        "fin",
        "limits",
        "name",
        "outcome",
        "role",
        "section",
        "stream",
        "tunnelAfterHeaders",
    ])?;
    let stream = case.string("stream")?;
    let kind = match stream {
        "control" => StreamKind::Control,
        "request" => StreamKind::Request,
        "push" => StreamKind::Push,
        _ => {
            return Err(expected(
                case.at("stream"),
                "\"control\", \"request\" or \"push\"",
            ))
        }
    };
    let (role_name, role) = read_role(case)?;
    let bounds = case.object("limits")?;
    bounds.only(&["fieldSection", "settings"])?;
    let limits = FrameLimits {
        field_section: bounds.decimal("fieldSection")?,
        settings: bounds.decimal("settings")?,
    };
    let tunnel = case.boolean("tunnelAfterHeaders")?;
    let encoded = case.hex("encoded")?;
    let fin = case.boolean("fin")?;
    let (events, outcome) = FrameRun::new(kind, role, limits, tunnel).run(&encoded, fin);
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("events", Out::List(events)));
    members.push(("fin", Out::Bool(fin)));
    members.push((
        "limits",
        Out::Map(vec![
            ("fieldSection", decimal(limits.field_section)),
            ("settings", decimal(limits.settings)),
        ]),
    ));
    members.push(("outcome", outcome));
    members.push(("role", text(role_name)));
    members.push(("stream", text(stream)));
    members.push(("tunnelAfterHeaders", Out::Bool(tunnel)));
    Ok(Out::Map(members))
}

/// One frame or DATA frame a stream carried.
enum FrameEvent {
    /// A frame other than DATA, or the header of a skipped or oversized one.
    Done(Out),
    /// The payload of a DATA frame, joined from its pieces.
    Data(Vec<u8>),
}

/// A frame decoder run over the whole input of one stream, with the GOAWAY,
/// MAX_PUSH_ID and CANCEL_PUSH rules on a control stream.
struct FrameRun {
    decoder: FrameDecoder,
    control: Option<PeerControl>,
    tunnel_after_headers: bool,
    events: Vec<FrameEvent>,
    open: Option<(bool, u64)>,
}

impl FrameRun {
    /// A run at the start of a stream.
    fn new(kind: StreamKind, role: Role, limits: FrameLimits, tunnel_after_headers: bool) -> Self {
        FrameRun {
            decoder: FrameDecoder::new(kind, role, limits),
            control: (kind == StreamKind::Control).then(|| PeerControl::new(role)),
            tunnel_after_headers,
            events: Vec::new(),
            open: None,
        }
    }

    /// The events of the input and how it ends: `"ok"`, `"needMore"` when it ends
    /// inside a frame and the stream goes on, or the error.
    fn run(mut self, input: &[u8], fin: bool) -> (Vec<Out>, Out) {
        let mut at = 0usize;
        let pumped = self.pump(input, &mut at);
        let rest = input.get(at..).unwrap_or(&[]);
        let outcome = match pumped {
            Err(error) => h3_error(&error),
            Ok(()) if fin => self
                .decoder
                .finish(rest)
                .map_or_else(|error| h3_error(&error), |()| text("ok")),
            Ok(()) if rest.is_empty() && self.open.is_none() => text("ok"),
            Ok(()) => text("needMore"),
        };
        let events = self
            .events
            .into_iter()
            .map(|event| match event {
                FrameEvent::Done(value) => value,
                FrameEvent::Data(data) => Out::Map(vec![("data", octets(&data))]),
            })
            .collect();
        (events, outcome)
    }

    /// Decodes until the decoder needs more octets. Every step consumes octets or is
    /// the one empty end piece of a payload of length zero, so the steps are bounded.
    fn pump(&mut self, input: &[u8], at: &mut usize) -> Result<(), zero_h3::Error> {
        for _ in 0..input.len().saturating_mul(2).saturating_add(2) {
            let rest = input.get(*at..).unwrap_or(&[]);
            let header = FrameHeader::parse(rest);
            let step = self.decoder.decode(rest)?;
            let (consumed, more) = self.apply(step, header)?;
            *at = at.saturating_add(consumed);
            if !more {
                break;
            }
        }
        Ok(())
    }

    /// Records one step, and returns the octets it consumed and whether to go on.
    fn apply(
        &mut self,
        step: Step<'_>,
        header: Option<FrameHeader>,
    ) -> Result<(usize, bool), zero_h3::Error> {
        Ok(match step {
            Step::NeedMore { consumed } => (consumed, false),
            Step::Frame { frame, consumed } => {
                if let Some(control) = self.control.as_mut() {
                    control.receive(&frame)?;
                }
                if self.tunnel_after_headers && matches!(frame, Frame::Headers { .. }) {
                    self.decoder.tunnel();
                }
                self.events.push(FrameEvent::Done(frame_value(&frame)));
                (consumed, true)
            }
            Step::Data {
                data,
                consumed,
                end,
            } => {
                if self.open.is_some() {
                    self.piece(data, end, true);
                } else {
                    self.open = Some((true, header.map_or(0, |header| header.len)));
                    self.events.push(FrameEvent::Data(Vec::new()));
                }
                (consumed, true)
            }
            Step::Skipped {
                frame_type,
                len,
                consumed,
            } => {
                self.open = Some((false, len));
                self.events
                    .push(FrameEvent::Done(skipped("skipped", frame_type.0, len)));
                (consumed, true)
            }
            Step::Oversized {
                frame_type,
                len,
                consumed,
            } => {
                self.open = Some((false, len));
                self.events
                    .push(FrameEvent::Done(skipped("oversized", frame_type.0, len)));
                (consumed, true)
            }
            Step::Discarded {
                data,
                consumed,
                end,
            } => {
                self.piece(data, end, false);
                (consumed, true)
            }
        })
    }

    /// Accounts for one piece of a streamed payload; a DATA piece joins its frame.
    fn piece(&mut self, data: &[u8], end: bool, is_data: bool) {
        let Some((open_data, remaining)) = self.open else {
            return;
        };
        let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
        self.open = (!end).then_some((open_data, remaining.saturating_sub(len)));
        if is_data {
            if let Some(FrameEvent::Data(buffer)) = self.events.last_mut() {
                buffer.extend_from_slice(data);
            }
        }
    }
}

/// The header of a frame or capsule whose payload is not kept.
fn skipped(kind: &'static str, frame_type: u64, len: u64) -> Out {
    Out::Map(vec![(
        kind,
        Out::Map(vec![
            ("length", decimal(len)),
            ("type", decimal(frame_type)),
        ]),
    )])
}

/// A whole frame other than DATA.
fn frame_value(frame: &Frame<'_>) -> Out {
    let (kind, value) = match *frame {
        Frame::Headers { field_section } => ("headers", octets(field_section)),
        Frame::CancelPush { push_id } => ("cancelPush", decimal(push_id)),
        Frame::Settings(settings) => ("settings", settings_value(&settings)),
        Frame::PushPromise {
            push_id,
            field_section,
        } => (
            "pushPromise",
            Out::Map(vec![
                ("fieldSection", octets(field_section)),
                ("pushId", decimal(push_id)),
            ]),
        ),
        Frame::Goaway { id } => ("goaway", decimal(id)),
        Frame::MaxPushId { push_id } => ("maxPushId", decimal(push_id)),
    };
    Out::Map(vec![(kind, value)])
}

/// One `settings` case: the settings a SETTINGS payload carries, or the error.
fn settings_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["expect", "name", "payload", "section"])?;
    let payload = case.hex("payload")?;
    let expect = match Settings::parse(&payload) {
        Ok(settings) => Out::Map(vec![("settings", settings_value(&settings))]),
        Err(error) => h3_error(&error),
    };
    let mut members = identity(case)?;
    members.push(("expect", expect));
    members.push(("payload", octets(&payload)));
    Ok(Out::Map(members))
}

/// The settings the server sends with the default limits.
fn server_settings(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(settings_value(&Settings::server(&Http3Limits::DEFAULT)))
}

/// The start of the server's control stream: the stream type and its SETTINGS frame.
fn control_preface(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(preface(None))
}

/// The start of the server's control stream with the reserved setting a member
/// gives.
fn preface_with_reserved(owner: &Object<'_>, key: &str) -> Result<Out, HostError> {
    let setting = owner.object(key)?;
    setting.only(&["encoded", "n", "value"])?;
    let n = setting.decimal("n")?;
    let value = setting.decimal("value")?;
    Ok(Out::Map(vec![
        ("encoded", preface(Some(Reserved { n, value }))),
        ("n", decimal(n)),
        ("value", decimal(value)),
    ]))
}

/// The control stream preface of the server's settings, or null when the reserved
/// setting cannot be encoded.
fn preface(reserved_setting: Option<Reserved>) -> Out {
    let mut out = Vec::new();
    match Settings::server(&Http3Limits::DEFAULT).encode_control_preface(reserved_setting, &mut out)
    {
        Some(()) => octets(&out),
        None => Out::Null,
    }
}

/// The name of a stream type in the vectors.
const fn stream_type_name(stream_type: StreamType) -> &'static str {
    match stream_type {
        StreamType::Control => "control",
        StreamType::Push => "push",
        StreamType::QpackEncoder => "qpackEncoder",
        StreamType::QpackDecoder => "qpackDecoder",
        StreamType::Reserved(_) => "reserved",
        StreamType::Unknown(_) => "unknown",
    }
}

/// One `streamTypes` case: the type a unidirectional stream starting with the octets
/// has, or `"needMore"` while its type is incomplete.
fn stream_type_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "name", "section", "type", "value"])?;
    let encoded = case.hex("encoded")?;
    let (kind, value) = match StreamType::parse(&encoded) {
        Some((stream_type, _)) => (
            text(stream_type_name(stream_type)),
            decimal(stream_type.value()),
        ),
        None => (text("needMore"), Out::Null),
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("type", kind));
    members.push(("value", value));
    Ok(Out::Map(members))
}

/// The name of what becomes of a unidirectional stream in the vectors.
const fn disposition_name(disposition: Disposition) -> &'static str {
    match disposition {
        Disposition::Control => "control",
        Disposition::Push => "push",
        Disposition::QpackEncoder => "qpackEncoder",
        Disposition::QpackDecoder => "qpackDecoder",
        Disposition::Discard => "discard",
    }
}

/// One `uniStreams` case: what becomes of each stream the peer opens, in order, up
/// to the first error.
fn uni_streams_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["expect", "name", "opened", "role", "section"])?;
    let (role_name, role) = read_role(case)?;
    let opened = case.decimals("opened")?;
    let mut streams = UniStreams::new(role);
    let mut expect = Vec::new();
    for &stream_type in &opened {
        match streams.open(StreamType::from_value(stream_type)) {
            Ok(disposition) => expect.push(text(disposition_name(disposition))),
            Err(error) => {
                expect.push(h3_error(&error));
                break;
            }
        }
    }
    let mut members = identity(case)?;
    members.push(("expect", Out::List(expect)));
    members.push((
        "opened",
        Out::List(opened.into_iter().map(decimal).collect()),
    ));
    members.push(("role", text(role_name)));
    Ok(Out::Map(members))
}

/// One `uniStreams` closure: whether a server may see a stream of the type close.
fn closed_item(item: &Object<'_>) -> Result<Out, HostError> {
    item.only(&["expect", "type"])?;
    let stream_type = item.decimal("type")?;
    let expect = UniStreams::new(Role::Server)
        .closed(StreamType::from_value(stream_type))
        .map_or_else(|error| h3_error(&error), |()| text("ok"));
    Ok(Out::Map(vec![
        ("expect", expect),
        ("type", decimal(stream_type)),
    ]))
}

/// One registered error code: the name the registry gives the value, or null.
fn registered_item(item: &Object<'_>) -> Result<Out, HostError> {
    item.only(&["name", "value"])?;
    let value = item.unsigned("value")?;
    Ok(Out::Map(vec![
        ("name", ErrorCode(value).name().map_or(Out::Null, text)),
        ("value", Out::Uint(value)),
    ]))
}

/// One received error code: the code it is treated as.
fn on_receipt_item(item: &Object<'_>) -> Result<Out, HostError> {
    item.only(&["treatedAs", "value"])?;
    let value = item.decimal("value")?;
    Ok(Out::Map(vec![
        ("treatedAs", Out::Uint(ErrorCode(value).on_receipt().0)),
        ("value", decimal(value)),
    ]))
}

/// One `goaway` case: the verdict on each GOAWAY identifier received in order, up to
/// the first error.
fn goaway_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["expect", "name", "received", "role", "section"])?;
    let (role_name, role) = read_role(case)?;
    let received = case.decimals("received")?;
    let mut control = PeerControl::new(role);
    let mut expect = Vec::new();
    for &id in &received {
        match control.receive(&Frame::Goaway { id }) {
            Ok(()) => expect.push(text("ok")),
            Err(error) => {
                expect.push(h3_error(&error));
                break;
            }
        }
    }
    let mut members = identity(case)?;
    members.push(("expect", Out::List(expect)));
    members.push((
        "received",
        Out::List(received.into_iter().map(decimal).collect()),
    ));
    members.push(("role", text(role_name)));
    Ok(Out::Map(members))
}

/// The first GOAWAY of a graceful server.
fn graceful_server(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(decimal(GoawaySender::GRACEFUL_SERVER))
}

/// The first GOAWAY of a graceful client.
fn graceful_client(_: &Object<'_>, _: &str) -> Result<Out, HostError> {
    Ok(decimal(GoawaySender::GRACEFUL_CLIENT))
}

/// One `capsules` case: the capsules the decoder reads from a request stream and how
/// the input ends.
fn capsule_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&[
        "encoded",
        "events",
        "fin",
        "maxDatagram",
        "name",
        "outcome",
        "section",
    ])?;
    let max_datagram = case.decimal("maxDatagram")?;
    let encoded = case.hex("encoded")?;
    let fin = case.boolean("fin")?;
    let (events, outcome) = capsules(max_datagram, &encoded, fin);
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("events", Out::List(events)));
    members.push(("fin", Out::Bool(fin)));
    members.push(("maxDatagram", decimal(max_datagram)));
    members.push(("outcome", outcome));
    Ok(Out::Map(members))
}

/// The capsules of the whole input of one stream, and how it ends: `"ok"`,
/// `"needMore"` when it ends inside a capsule and the stream goes on, or the error.
/// Every step consumes octets or is the one empty end piece of a value of length
/// zero, so the steps are bounded.
fn capsules(max_datagram: u64, input: &[u8], fin: bool) -> (Vec<Out>, Out) {
    let mut decoder = CapsuleDecoder::new(max_datagram);
    let mut events = Vec::new();
    let mut open: Option<u64> = None;
    let mut at = 0usize;
    for _ in 0..input.len().saturating_mul(2).saturating_add(2) {
        let rest = input.get(at..).unwrap_or(&[]);
        let (consumed, more) = match decoder.decode(rest) {
            CapsuleStep::NeedMore { consumed } => (consumed, false),
            CapsuleStep::Datagram { payload, consumed } => {
                events.push(Out::Map(vec![("datagram", octets(payload))]));
                (consumed, true)
            }
            CapsuleStep::Skipped {
                capsule_type,
                len,
                consumed,
            } => {
                open = Some(len);
                events.push(skipped("skipped", capsule_type, len));
                (consumed, true)
            }
            CapsuleStep::Value {
                data,
                consumed,
                end,
            } => {
                let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
                open = open
                    .filter(|_| !end)
                    .map(|remaining| remaining.saturating_sub(len));
                (consumed, true)
            }
        };
        at = at.saturating_add(consumed);
        if !more {
            break;
        }
    }
    let rest = input.get(at..).unwrap_or(&[]);
    let outcome = if fin {
        decoder
            .finish(rest)
            .map_or_else(|error| h3_error(&error), |()| text("ok"))
    } else if rest.is_empty() && open.is_none() {
        text("ok")
    } else {
        text("needMore")
    };
    (events, outcome)
}

/// One `datagrams` case: the Quarter Stream ID, the stream and the payload of an
/// HTTP/3 datagram, or the error.
fn datagram_case(case: &Object<'_>) -> Result<Out, HostError> {
    case.only(&["encoded", "expect", "name", "section"])?;
    let encoded = case.hex("encoded")?;
    let expect = match Datagram::parse(&encoded) {
        Ok(datagram) => Out::Map(vec![
            ("payload", octets(datagram.payload)),
            ("quarterStreamId", decimal(datagram.quarter_stream_id)),
            ("streamId", datagram.stream_id().map_or(Out::Null, decimal)),
        ]),
        Err(error) => h3_error(&error),
    };
    let mut members = identity(case)?;
    members.push(("encoded", octets(&encoded)));
    members.push(("expect", expect));
    Ok(Out::Map(members))
}

/// The sections the `realtime` feature brings: the WebSocket handshake and session,
/// and the event stream encoder.
#[cfg(feature = "realtime")]
mod realtime {
    use zero_http1::{parse_request, Field, Status as Parsed, Version};
    use zero_limits::http1::{Http1Limits, HEADER_TABLE_ENTRIES};
    use zero_limits::WebSocketLimits;
    use zero_server_crypto::Sha1;
    use zero_sse::Event as Message;
    use zero_ws::handshake::{negotiate, Config};
    use zero_ws::{Event, Session};

    use super::{decoded, expected, identity, octets, text, Member, Object, Out};
    use crate::HostError;

    pub(super) const WS: &[(&str, Member)] = &[("cases", Member::Cases(ws_case))];

    pub(super) const SSE: &[(&str, Member)] = &[("cases", Member::Cases(sse_case))];

    /// One `ws` case: the answer to the handshake, and for the `frames` and `close`
    /// kinds what the session makes of the client's frames once it is accepted.
    fn ws_case(case: &Object<'_>) -> Result<Out, HostError> {
        case.only(&[
            "clientFrames",
            "expect",
            "kind",
            "name",
            "request",
            "routeOrigins",
            "routeProtocols",
            "section",
        ])?;
        let kind = case.string("kind")?;
        let after_handshake = match kind {
            "handshake" => false,
            "frames" | "close" => true,
            _ => {
                return Err(expected(
                    case.at("kind"),
                    "\"handshake\", \"frames\" or \"close\"",
                ))
            }
        };
        let request = case.hex("request")?;
        let protocols = case.strings("routeProtocols")?;
        let origins = case.optional_strings("routeOrigins")?;
        let client = case.hex("clientFrames")?;
        let (answer, accepted) = handshake(&request, &protocols, origins.as_deref())?;
        let expect = if after_handshake && accepted {
            session(&client)
        } else {
            answer
        };
        let names = |list: &[&str]| Out::List(list.iter().map(|item| text(item)).collect());
        let mut members = identity(case)?;
        members.push(("clientFrames", octets(&client)));
        members.push(("expect", expect));
        members.push(("kind", text(kind)));
        members.push(("request", octets(&request)));
        members.push(("routeOrigins", origins.as_deref().map_or(Out::Null, names)));
        members.push(("routeProtocols", names(protocols.as_slice())));
        Ok(Out::Map(members))
    }

    /// The answer to an opening handshake under a route's subprotocols and Origin
    /// allow list, and whether it is accepted: the request parsed as the driver
    /// parses it, an HTTP/1.1 or later GET, checked by `zero-ws`, with the accept
    /// value hashed by the server's SHA-1.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
    fn handshake(
        request: &[u8],
        protocols: &[&str],
        origins: Option<&[&str]>,
    ) -> Result<(Out, bool), HostError> {
        let mut table = [Field::EMPTY; HEADER_TABLE_ENTRIES];
        let head = match parse_request(request, &mut table, &Http1Limits::DEFAULT) {
            Parsed::Complete(head) => head,
            Parsed::Partial => return Ok((text("partial"), false)),
            Parsed::Reject(reject) => {
                return Ok((answer(reject.status.as_u16(), Vec::new()), false));
            }
        };
        let protocols: Vec<&[u8]> = protocols.iter().map(|name| name.as_bytes()).collect();
        let origins: Option<Vec<&[u8]>> =
            origins.map(|list| list.iter().map(|origin| origin.as_bytes()).collect());
        let config = Config {
            protocols: &protocols,
            origins: origins.as_deref(),
        };
        let fields = table
            .iter()
            .take(head.field_count)
            .map(|field| (field.name(request), field.value(request)));
        match negotiate(
            head.method,
            head.version != Version::Http10,
            fields,
            &config,
        ) {
            Ok(accepted) => {
                let response = accepted.response_fields(&Sha1).map_err(|error| {
                    HostError::codec(format!("the Sec-WebSocket-Accept value: {error}"))
                })?;
                Ok((answer(101, pairs(response.iter())), true))
            }
            Err(refusal) => Ok((
                answer(
                    refusal.status.as_u16(),
                    pairs(refusal.fields.iter().copied()),
                ),
                false,
            )),
        }
    }

    /// A handshake answer: the status and the WebSocket fields it carries.
    fn answer(status: u16, fields: Vec<Out>) -> Out {
        Out::Map(vec![
            ("fields", Out::List(fields)),
            ("status", Out::Uint(u64::from(status))),
        ])
    }

    /// Response fields as name and value pairs of text.
    fn pairs<'v>(fields: impl Iterator<Item = (&'static [u8], &'v [u8])>) -> Vec<Out> {
        fields
            .map(|(name, value)| Out::List(vec![decoded(name), decoded(value)]))
            .collect()
    }

    /// What the session the server runs after an accepted handshake makes of the
    /// client's frames, fed in one buffer under the default limits: the events it
    /// reports, the frames it sends on its own, the close code it fails the
    /// connection with, and whether the connection closes once they are written.
    fn session(client: &[u8]) -> Out {
        let mut session = Session::new(WebSocketLimits::DEFAULT);
        let mut input = client.to_vec();
        let mut at = 0usize;
        let mut events = Vec::new();
        let mut failed = Out::Null;
        for _ in 0..=input.len() {
            let Some(rest) = input.get_mut(at..) else {
                break;
            };
            match session.feed(rest, 0) {
                Ok(step) => {
                    let consumed = step.consumed;
                    let event = step.event.map(event_value);
                    at = at.saturating_add(consumed);
                    match event {
                        Some(event) => events.push(event),
                        None if consumed == 0 => break,
                        None => {}
                    }
                }
                Err(code) => {
                    failed = Out::Uint(u64::from(code.0));
                    break;
                }
            }
        }
        Out::Map(vec![
            ("events", Out::List(events)),
            ("failed", failed),
            ("finished", Out::Bool(session.is_finished())),
            ("serverFrames", octets(session.output())),
        ])
    }

    /// One event a session reports: its type, its data and, for a close, its code.
    fn event_value(event: Event<'_>) -> Out {
        let (kind, data, code) = match event {
            Event::Text(message) => ("text", message.as_bytes(), None),
            Event::Binary(data) => ("binary", data, None),
            Event::Ping(data) => ("ping", data, None),
            Event::Pong(data) => ("pong", data, None),
            Event::Close(close) => ("close", close.reason.as_bytes(), Some(close.code.0)),
        };
        Out::Map(vec![
            (
                "code",
                code.map_or(Out::Null, |code| Out::Uint(u64::from(code))),
            ),
            ("data", octets(data)),
            ("type", text(kind)),
        ])
    }

    /// One `sse` case: the stream octets the call writes, or the refusal.
    fn sse_case(case: &Object<'_>) -> Result<Out, HostError> {
        case.only(&["call", "expect", "name", "section"])?;
        let call = case.object("call")?;
        let mut stream = Vec::new();
        let (echo, written) = if call.get("comment").is_some() {
            call.only(&["comment"])?;
            let comment = call.string("comment")?;
            (
                Out::Map(vec![("comment", text(comment))]),
                zero_sse::comment(comment, &mut stream),
            )
        } else if call.get("retry").is_some() {
            call.only(&["retry"])?;
            let milliseconds = u32::try_from(call.unsigned("retry")?)
                .map_err(|_| expected(call.at("retry"), "milliseconds below 2^32"))?;
            let message = Message {
                event: None,
                id: None,
                retry: Some(u64::from(milliseconds)),
                data: None,
            };
            (
                Out::Map(vec![("retry", Out::Uint(u64::from(milliseconds)))]),
                zero_sse::encode(&message, &mut stream),
            )
        } else {
            call.only(&["data", "event", "id"])?;
            let data = call.string("data")?;
            let event = call.optional_string("event")?;
            let id = call.optional_string("id")?;
            let mut echo = vec![("data", text(data))];
            if let Some(event) = event {
                echo.push(("event", text(event)));
            }
            if let Some(id) = id {
                echo.push(("id", text(id)));
            }
            let message = Message {
                event,
                id,
                retry: None,
                data: Some(data),
            };
            (Out::Map(echo), zero_sse::encode(&message, &mut stream))
        };
        let expect = match written {
            Ok(()) => Out::Map(vec![("bytes", octets(&stream))]),
            Err(_) => Out::Map(vec![("rejected", Out::Bool(true))]),
        };
        let mut members = identity(case)?;
        members.push(("call", echo));
        members.push(("expect", expect));
        Ok(Out::Map(members))
    }
}
