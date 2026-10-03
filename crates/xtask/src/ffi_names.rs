//! The named constants of the C ABI. `cargo xtask ffi-names --write | --check` renders
//! `crates/zero-ffi/src/abi/names.rs`: the fixed constants of the ABI, one
//! `ZERO_METHOD_<TOKEN>` per variant of zero-http-types' `Method`, and one
//! `ZERO_HEADER_<NAME>` per entry of its interned header-name table with
//! `ZERO_HEADER_COUNT` before them. cbindgen copies each `pub const` of that file into
//! `include/zero.h` as a `#define`, but it expands no macro and reads no dependency
//! (`parse_deps = false`), so every value is written out as a literal, and this generator
//! keeps the literals equal to the tables they mirror.
//!
//! The values are spelled the way cbindgen 0.29.4 translates them, which its source shows
//! and its user guide does not: `u64::MAX` and `u32::MAX` become `UINT64_MAX` and
//! `UINT32_MAX` (`usize::MAX` is dropped), and a `u64` suffix becomes `ull`.
//!
//! @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/src/bindgen/ir/constant.rs>
//! @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/docs.md#cbindgentoml>
//! (`parse_deps` and `style`)

use std::collections::BTreeSet;
use std::fs;
use std::process::ExitCode;

use syn::parse::ParseStream;
use syn::{Expr, ExprLit, Fields, Ident, Item, Lit, LitInt, LitStr, Token};

/// The generated constants file, relative to the repository root.
pub(crate) const NAMES: &str = "crates/zero-ffi/src/abi/names.rs";

/// The interned header-name table, relative to the repository root.
const HEADER_TABLE: &str = "crates/zero-http-types/src/header.rs";

/// The method table, relative to the repository root.
const METHOD_TABLE: &str = "crates/zero-http-types/src/method.rs";

/// The method value that registers a route for every method.
const METHOD_ANY: u8 = 254;

/// The widest documentation line, without its `/// `, so every line stays inside rustfmt's
/// width.
const DOC_WIDTH: usize = 92;

/// A constant whose value the ABI fixes, not a table of another crate. Its documentation
/// is prose whose paragraphs are separated by a blank line; it is wrapped when rendered.
struct Fixed {
    name: &'static str,
    ty: &'static str,
    value: &'static str,
    doc: &'static str,
}

/// The fixed constants written before the header and method tables.
const LEADING: &[Fixed] = &[
    Fixed {
        name: "ZERO_ABI_VERSION",
        ty: "u32",
        value: "1",
        doc: "The version of the C ABI, which `zero_abi_version` returns.",
    },
    Fixed {
        name: "ZERO_PLUGIN_ABI_VERSION",
        ty: "u32",
        value: "1",
        doc: "The version of the plugin ABI, which a plugin's `ZeroPluginAbiVersionFn` \
              returns.",
    },
    Fixed {
        name: "ZERO_ID_MAX",
        ty: "u64",
        value: "9_007_199_254_740_991u64",
        doc: "The largest id, 2^53 - 1, so every id is exact as a JavaScript number. An id \
              above it is refused with `ZeroStatus_InvalidArgument`.",
    },
    Fixed {
        name: "ZERO_NONE",
        ty: "u64",
        value: "u64::MAX",
        doc: "No id, where an argument allows the id to be absent.",
    },
    Fixed {
        name: "ZERO_EPOCH_NONE",
        ty: "u64",
        value: "0",
        doc: "The epoch of a completion that acknowledges no batch.",
    },
    Fixed {
        name: "ZERO_ALL_WORKERS",
        ty: "u32",
        value: "u32::MAX",
        doc: "The worker index of a target that serves every worker of a server from one \
              queue.",
    },
    Fixed {
        name: "ZERO_MAX_BATCH",
        ty: "u32",
        value: "256",
        doc: "The most entries one batch carries; the capacity `zero_target_poll` takes is at \
              least this.",
    },
    Fixed {
        name: "ZERO_MAX_PARAMS",
        ty: "u32",
        value: "16",
        doc: "The most parameters one route captures.",
    },
    Fixed {
        name: "ZERO_HEADER_NONE",
        ty: "u32",
        value: "u32::MAX",
        doc: "The id of a field name outside the interned table.",
    },
];

/// The fixed constants written after the header and method tables.
const TRAILING: &[Fixed] = &[
    Fixed {
        name: "ZERO_METHOD_ANY",
        ty: "u8",
        value: "254",
        doc: "Registers a route for every method; never the method of a request.",
    },
    Fixed {
        name: "ZERO_METHOD_OTHER",
        ty: "u8",
        value: "255",
        doc: "The method of a request whose token is outside the method table; \
              `zero_req_method_token` reads the token.",
    },
    Fixed {
        name: "ZERO_HEADER_SET",
        ty: "u32",
        value: "0",
        doc: "`zero_res_header` mode: replace every field line of the name.",
    },
    Fixed {
        name: "ZERO_HEADER_APPEND",
        ty: "u32",
        value: "1",
        doc: "`zero_res_header` mode: add one more field line, so each `Set-Cookie` is its own \
              line.",
    },
    Fixed {
        name: "ZERO_BATCH_REQUESTS",
        ty: "u8",
        value: "1",
        doc: "`ZeroBatch.kind`: the batch carries leased request slots.",
    },
    Fixed {
        name: "ZERO_BATCH_EVENTS",
        ty: "u8",
        value: "2",
        doc: "`ZeroBatch.kind`: the batch carries WebSocket and server-sent events.",
    },
    Fixed {
        name: "ZERO_EVENT_WS_OPEN",
        ty: "u8",
        value: "1",
        doc: "`ZeroEvent.kind`: a WebSocket connection opened.",
    },
    Fixed {
        name: "ZERO_EVENT_WS_MESSAGE",
        ty: "u8",
        value: "2",
        doc: "`ZeroEvent.kind`: a WebSocket message arrived; `opcode` says text or binary.",
    },
    Fixed {
        name: "ZERO_EVENT_WS_PONG",
        ty: "u8",
        value: "3",
        doc: "`ZeroEvent.kind`: a WebSocket Pong frame arrived.",
    },
    Fixed {
        name: "ZERO_EVENT_WS_CLOSE",
        ty: "u8",
        value: "4",
        doc: "`ZeroEvent.kind`: a WebSocket connection closed; `close_code` and `data` hold the \
              code and the reason.",
    },
    Fixed {
        name: "ZERO_EVENT_WS_DRAINED",
        ty: "u8",
        value: "5",
        doc: "`ZeroEvent.kind`: a WebSocket connection's outbox drained below its high-water \
              mark.",
    },
    Fixed {
        name: "ZERO_EVENT_SSE_CLOSED",
        ty: "u8",
        value: "6",
        doc: "`ZeroEvent.kind`: a server-sent events stream closed.",
    },
    Fixed {
        name: "ZERO_EVENT_SSE_DRAINED",
        ty: "u8",
        value: "7",
        doc: "`ZeroEvent.kind`: a server-sent events stream's outbox drained below its \
              high-water mark.",
    },
    Fixed {
        name: "ZERO_OPCODE_TEXT",
        ty: "u8",
        value: "1",
        doc: "A text message: WebSocket opcode %x1.\n\n\
              @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>",
    },
    Fixed {
        name: "ZERO_OPCODE_BINARY",
        ty: "u8",
        value: "2",
        doc: "A binary message: WebSocket opcode %x2.\n\n\
              @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>",
    },
    Fixed {
        name: "ZERO_VIEW_SECURE",
        ty: "u16",
        value: "1",
        doc: "`ZeroRequestView.flags`: the request arrived over TLS.",
    },
    Fixed {
        name: "ZERO_VIEW_UPGRADE",
        ty: "u16",
        value: "2",
        doc: "`ZeroRequestView.flags`: the request asks for a protocol upgrade.",
    },
    Fixed {
        name: "ZERO_VIEW_KEEP_ALIVE",
        ty: "u16",
        value: "4",
        doc: "`ZeroRequestView.flags`: the connection stays open after the response.",
    },
    Fixed {
        name: "ZERO_VIEW_EXPECT_CONTINUE",
        ty: "u16",
        value: "8",
        doc: "`ZeroRequestView.flags`: the request carries `Expect: 100-continue`.",
    },
    Fixed {
        name: "ZERO_VIEW_HEAD_AS_GET",
        ty: "u16",
        value: "16",
        doc: "`ZeroRequestView.flags`: a HEAD request matched a GET route.",
    },
    Fixed {
        name: "ZERO_VIEW_QUERY",
        ty: "u16",
        value: "32",
        doc: "`ZeroRequestView.flags`: the target has a query, possibly empty.",
    },
    Fixed {
        name: "ZERO_ROUTE_HOST",
        ty: "u32",
        value: "0",
        doc: "`zero_app_route` kind: a route the host answers.",
    },
    Fixed {
        name: "ZERO_ROUTE_STATIC",
        ty: "u32",
        value: "1",
        doc: "`zero_app_route` kind: files served from a directory.",
    },
    Fixed {
        name: "ZERO_ROUTE_REDIRECT",
        ty: "u32",
        value: "2",
        doc: "`zero_app_route` kind: a redirect the core answers.",
    },
    Fixed {
        name: "ZERO_ROUTE_FIXED",
        ty: "u32",
        value: "3",
        doc: "`zero_app_route` kind: a fixed response the core answers.",
    },
    Fixed {
        name: "ZERO_ROUTE_WEBSOCKET",
        ty: "u32",
        value: "4",
        doc: "`zero_app_route` kind: a WebSocket endpoint.",
    },
    Fixed {
        name: "ZERO_ROUTE_HEALTH",
        ty: "u32",
        value: "5",
        doc: "`zero_app_route` kind: a health check the core answers.",
    },
    Fixed {
        name: "ZERO_POLICY_CORS",
        ty: "u32",
        value: "0",
        doc: "`zero_app_policy` kind: cross-origin resource sharing.",
    },
    Fixed {
        name: "ZERO_POLICY_SECURITY_HEADERS",
        ty: "u32",
        value: "1",
        doc: "`zero_app_policy` kind: security fields added to every response.",
    },
    Fixed {
        name: "ZERO_POLICY_REQUEST_ID",
        ty: "u32",
        value: "2",
        doc: "`zero_app_policy` kind: an id for every request.",
    },
    Fixed {
        name: "ZERO_POLICY_TRUST_PROXY",
        ty: "u32",
        value: "3",
        doc: "`zero_app_policy` kind: the proxies whose forwarding fields are trusted.",
    },
    Fixed {
        name: "ZERO_POLICY_BODY_LIMIT",
        ty: "u32",
        value: "4",
        doc: "`zero_app_policy` kind: the largest request body.",
    },
];

/// One constant of the generated file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Constant {
    /// The C name, `ZERO_` and SCREAMING_SNAKE_CASE.
    pub(crate) name: String,
    /// The Rust type.
    pub(crate) ty: String,
    /// The value as a Rust literal or path cbindgen translates: a plain integer, a literal
    /// with a `u64` suffix (written with `ull`), or `u32::MAX` or `u64::MAX` (written as
    /// `UINT32_MAX` or `UINT64_MAX`).
    ///
    /// @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/src/bindgen/ir/constant.rs>
    pub(crate) value: String,
    /// The documentation, one entry per line; an empty entry separates two paragraphs.
    pub(crate) doc: Vec<String>,
}

/// One entry of the interned header-name table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeaderName {
    /// The id.
    pub(crate) id: u32,
    /// The lowercase spelling.
    pub(crate) lower: String,
    /// The spelling the registry records.
    pub(crate) canonical: String,
    /// The specification that defines it.
    pub(crate) source: String,
}

/// One variant of the method table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MethodName {
    /// The variant name.
    pub(crate) variant: String,
    /// The id.
    pub(crate) id: u8,
    /// The variant's documentation, paragraphs separated by a blank line.
    pub(crate) doc: String,
}

/// Run `cargo xtask ffi-names --write | --check`.
///
/// # Arguments
///
/// * `args` - `--write` renders the constants file from the zero-http-types tables;
///   `--check` verifies the committed file matches.
///
/// # Returns
///
/// Success when the file was written, or when the check found it in sync.
pub(crate) fn run(args: &[String]) -> ExitCode {
    let Some(check) = crate::ffi_mirror::mode(args, "ffi-names") else {
        return ExitCode::FAILURE;
    };
    let root = crate::docs::repo_root();
    let read = |relative: &str| {
        fs::read_to_string(root.join(relative)).map_err(|err| format!("reading {relative}: {err}"))
    };
    let rendered = read(HEADER_TABLE).and_then(|headers| {
        let methods = read(METHOD_TABLE)?;
        let constants = constants(&header_names(&headers)?, &method_names(&methods)?)?;
        Ok(render(&constants))
    });
    match rendered {
        Ok(text) if crate::ffi_mirror::sync(&root, NAMES, &text, "ffi-names", check) => {
            ExitCode::SUCCESS
        }
        Ok(_) => ExitCode::FAILURE,
        Err(message) => {
            eprintln!("xtask ffi-names: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Read the interned header-name table from the source of zero-http-types' `header.rs`:
/// the body of its `header_names!` invocation, one `Variant = id, "lower", "Canonical",
/// "source";` entry per name.
///
/// # Arguments
///
/// * `text` - the source file.
///
/// # Returns
///
/// The entries in table order.
///
/// # Errors
///
/// The file does not parse, holds no `header_names!` invocation, or an entry does not
/// have that shape.
pub(crate) fn header_names(text: &str) -> Result<Vec<HeaderName>, String> {
    let file = syn::parse_file(text).map_err(|err| format!("parsing {HEADER_TABLE}: {err}"))?;
    let invocation = file
        .items
        .iter()
        .find_map(|item| match item {
            Item::Macro(item) if item.mac.path.is_ident("header_names") => Some(&item.mac),
            _ => None,
        })
        .ok_or_else(|| format!("{HEADER_TABLE} has no `header_names!` table"))?;
    invocation
        .parse_body_with(|input: ParseStream<'_>| -> syn::Result<Vec<HeaderName>> {
            let mut out = Vec::new();
            while !input.is_empty() {
                input.parse::<Ident>()?;
                input.parse::<Token![=]>()?;
                let id: LitInt = input.parse()?;
                input.parse::<Token![,]>()?;
                let lower: LitStr = input.parse()?;
                input.parse::<Token![,]>()?;
                let canonical: LitStr = input.parse()?;
                input.parse::<Token![,]>()?;
                let source: LitStr = input.parse()?;
                input.parse::<Token![;]>()?;
                out.push(HeaderName {
                    id: id.base10_parse()?,
                    lower: lower.value(),
                    canonical: canonical.value(),
                    source: source.value(),
                });
            }
            Ok(out)
        })
        .map_err(|err| format!("reading the `header_names!` table of {HEADER_TABLE}: {err}"))
}

/// Read the method table from the source of zero-http-types' `method.rs`: the variants of
/// `enum Method`, each with an explicit integer discriminant.
///
/// # Arguments
///
/// * `text` - the source file.
///
/// # Returns
///
/// The variants in declaration order.
///
/// # Errors
///
/// The file does not parse, declares no `Method` enum, or a variant carries data or no
/// integer discriminant.
pub(crate) fn method_names(text: &str) -> Result<Vec<MethodName>, String> {
    let file = syn::parse_file(text).map_err(|err| format!("parsing {METHOD_TABLE}: {err}"))?;
    let method = file
        .items
        .iter()
        .find_map(|item| match item {
            Item::Enum(item) if item.ident == "Method" => Some(item),
            _ => None,
        })
        .ok_or_else(|| format!("{METHOD_TABLE} declares no `enum Method`"))?;
    let mut out = Vec::new();
    for variant in &method.variants {
        let name = variant.ident.to_string();
        if !matches!(variant.fields, Fields::Unit) {
            return Err(format!("Method::{name} carries data"));
        }
        let id = match &variant.discriminant {
            Some((
                _,
                Expr::Lit(ExprLit {
                    lit: Lit::Int(id), ..
                }),
            )) => id
                .base10_parse::<u8>()
                .map_err(|err| format!("Method::{name}: {err}"))?,
            _ => return Err(format!("Method::{name} has no integer discriminant")),
        };
        out.push(MethodName {
            variant: name,
            id,
            doc: crate::docs::doc_of(&variant.attrs),
        });
    }
    Ok(out)
}

/// Break a paragraph into lines of at most `width` columns at word boundaries; a word
/// longer than `width` stays whole on its own line.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.len() + 1 + word.len() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// The lines of a documentation comment for prose whose paragraphs are separated by a
/// blank line: each paragraph wrapped at [`DOC_WIDTH`], an empty line between two.
fn doc_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut paragraph = String::new();
    for line in text.lines().chain(std::iter::once("")) {
        if !line.trim().is_empty() {
            paragraph.push(' ');
            paragraph.push_str(line);
            continue;
        }
        if paragraph.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(String::new());
        }
        out.extend(wrap(&paragraph, DOC_WIDTH));
        paragraph.clear();
    }
    out
}

/// A Rust variant name in SCREAMING_SNAKE_CASE: `Get` becomes `GET`.
fn screaming(name: &str) -> String {
    let mut out = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if c.is_ascii_uppercase() && previous_lower {
            out.push('_');
        }
        previous_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        out.push(c.to_ascii_uppercase());
    }
    out
}

/// Every constant of the generated file, in the order it is written.
///
/// # Arguments
///
/// * `headers` - the interned header-name table.
/// * `methods` - the method table.
///
/// # Returns
///
/// The fixed leading constants, `ZERO_HEADER_COUNT`, one constant per header name, one
/// per method, then the fixed trailing constants.
///
/// # Errors
///
/// The header ids are not dense from 0 in table order, a method id collides with another
/// or with the registration-only values, a header name has a character a C identifier
/// cannot hold, or two constants share a name.
pub(crate) fn constants(
    headers: &[HeaderName],
    methods: &[MethodName],
) -> Result<Vec<Constant>, String> {
    let fixed = |item: &Fixed| Constant {
        name: item.name.to_owned(),
        ty: item.ty.to_owned(),
        value: item.value.to_owned(),
        doc: doc_lines(item.doc),
    };
    let mut out: Vec<Constant> = LEADING.iter().map(fixed).collect();
    out.push(Constant {
        name: "ZERO_HEADER_COUNT".to_owned(),
        ty: "u32".to_owned(),
        value: headers.len().to_string(),
        doc: doc_lines(
            "The number of interned field names; the `ZERO_HEADER_*` ids of the names run \
             from 0 below it.",
        ),
    });
    for (index, header) in headers.iter().enumerate() {
        if usize::try_from(header.id).ok() != Some(index) {
            return Err(format!(
                "the header-name table is not dense from 0: `{}` has id {} at position {index}",
                header.lower, header.id
            ));
        }
        let mut name = String::from("ZERO_HEADER_");
        for c in header.lower.chars() {
            match c {
                'a'..='z' | '0'..='9' => name.push(c.to_ascii_uppercase()),
                '-' => name.push('_'),
                _ => {
                    return Err(format!(
                        "the header name `{}` has a character a C identifier cannot hold",
                        header.lower
                    ))
                }
            }
        }
        out.push(Constant {
            name,
            ty: "u32".to_owned(),
            value: header.id.to_string(),
            doc: doc_lines(&format!("`{}` ({}).", header.canonical, header.source)),
        });
    }
    let mut ids = BTreeSet::new();
    for method in methods {
        if method.id >= METHOD_ANY || !ids.insert(method.id) {
            return Err(format!(
                "Method::{} has id {}, which another method or a registration-only value holds",
                method.variant, method.id
            ));
        }
        let token = screaming(&method.variant);
        out.push(Constant {
            name: format!("ZERO_METHOD_{token}"),
            ty: "u8".to_owned(),
            value: method.id.to_string(),
            doc: doc_lines(&format!("The `{token}` method. {}", method.doc)),
        });
    }
    out.extend(TRAILING.iter().map(fixed));
    let mut names = BTreeSet::new();
    for constant in &out {
        if !names.insert(constant.name.as_str()) {
            return Err(format!("two constants are named {}", constant.name));
        }
    }
    Ok(out)
}

/// Render the constants file.
///
/// # Arguments
///
/// * `constants` - the constants, in order.
///
/// # Returns
///
/// The text of `names.rs`, formatted as rustfmt formats it.
pub(crate) fn render(constants: &[Constant]) -> String {
    let mut out = String::from(
        "//! The named constants of the C ABI, which cbindgen copies into `include/zero.h`.\n\
         //!\n\
         //! Generated by `cargo xtask ffi-names --write` from the method and header-name \
         tables of\n\
         //! zero-http-types. Do not edit by hand.\n",
    );
    for constant in constants {
        out.push('\n');
        for line in &constant.doc {
            if line.is_empty() {
                out.push_str("///\n");
            } else {
                out.push_str("/// ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push_str(&format!(
            "pub const {}: {} = {};\n",
            constant.name, constant.ty, constant.value
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_HEADER_TABLE: &str = r#"
macro_rules! header_names {
    ($($variant:ident = $id:literal, $lower:literal, $canonical:literal, $source:literal;)*) => {};
}

header_names! {
    Accept = 0, "accept", "Accept", "RFC 9110 Section 12.5.1";
    ContentLength = 1, "content-length", "Content-Length", "RFC 9110 Section 8.6";
    WwwAuthenticate = 2, "www-authenticate", "WWW-Authenticate", "RFC 9110 Section 11.6.1";
}
"#;

    const SAMPLE_METHOD_TABLE: &str = r#"
pub enum Method {
    /// Transfer a current representation of the target resource.
    Get = 0,
    /// Same as GET, but do not transfer the
    /// response content.
    Head = 1,
    /// Apply a set of changes described in the request content to the target
    /// resource (RFC 5789 Section 2).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc5789.html#section-2>
    Patch = 8,
}
"#;

    fn sample() -> Vec<Constant> {
        constants(
            &header_names(SAMPLE_HEADER_TABLE).unwrap(),
            &method_names(SAMPLE_METHOD_TABLE).unwrap(),
        )
        .unwrap()
    }

    fn value_of<'a>(constants: &'a [Constant], name: &str) -> (&'a str, &'a str) {
        let constant = constants
            .iter()
            .find(|constant| constant.name == name)
            .unwrap_or_else(|| panic!("{name} is not generated"));
        (constant.ty.as_str(), constant.value.as_str())
    }

    #[test]
    fn the_tables_read_from_the_source_of_zero_http_types() {
        let headers = header_names(SAMPLE_HEADER_TABLE).unwrap();
        assert_eq!(headers.len(), 3);
        assert_eq!(
            headers[2],
            HeaderName {
                id: 2,
                lower: "www-authenticate".to_owned(),
                canonical: "WWW-Authenticate".to_owned(),
                source: "RFC 9110 Section 11.6.1".to_owned(),
            }
        );
        let methods = method_names(SAMPLE_METHOD_TABLE).unwrap();
        assert_eq!(methods.len(), 3);
        assert_eq!(methods[1].variant, "Head");
        assert_eq!(
            doc_lines(&methods[1].doc),
            ["Same as GET, but do not transfer the response content."]
        );
        assert_eq!(methods[2].id, 8);
        let bare = method_names("pub enum Method { Get = 0 }").unwrap();
        assert!(bare[0].doc.is_empty());
    }

    #[test]
    fn every_constant_of_the_abi_is_generated_with_its_value_and_type() {
        let constants = sample();
        for (name, ty, value) in [
            ("ZERO_ABI_VERSION", "u32", "1"),
            ("ZERO_PLUGIN_ABI_VERSION", "u32", "1"),
            ("ZERO_ID_MAX", "u64", "9_007_199_254_740_991u64"),
            ("ZERO_NONE", "u64", "u64::MAX"),
            ("ZERO_EPOCH_NONE", "u64", "0"),
            ("ZERO_ALL_WORKERS", "u32", "u32::MAX"),
            ("ZERO_MAX_BATCH", "u32", "256"),
            ("ZERO_MAX_PARAMS", "u32", "16"),
            ("ZERO_HEADER_NONE", "u32", "u32::MAX"),
            ("ZERO_HEADER_COUNT", "u32", "3"),
            ("ZERO_HEADER_ACCEPT", "u32", "0"),
            ("ZERO_HEADER_CONTENT_LENGTH", "u32", "1"),
            ("ZERO_HEADER_WWW_AUTHENTICATE", "u32", "2"),
            ("ZERO_METHOD_GET", "u8", "0"),
            ("ZERO_METHOD_HEAD", "u8", "1"),
            ("ZERO_METHOD_PATCH", "u8", "8"),
            ("ZERO_METHOD_ANY", "u8", "254"),
            ("ZERO_METHOD_OTHER", "u8", "255"),
            ("ZERO_HEADER_SET", "u32", "0"),
            ("ZERO_HEADER_APPEND", "u32", "1"),
            ("ZERO_BATCH_REQUESTS", "u8", "1"),
            ("ZERO_BATCH_EVENTS", "u8", "2"),
            ("ZERO_EVENT_WS_OPEN", "u8", "1"),
            ("ZERO_EVENT_WS_MESSAGE", "u8", "2"),
            ("ZERO_EVENT_WS_PONG", "u8", "3"),
            ("ZERO_EVENT_WS_CLOSE", "u8", "4"),
            ("ZERO_EVENT_WS_DRAINED", "u8", "5"),
            ("ZERO_EVENT_SSE_CLOSED", "u8", "6"),
            ("ZERO_EVENT_SSE_DRAINED", "u8", "7"),
            ("ZERO_OPCODE_TEXT", "u8", "1"),
            ("ZERO_OPCODE_BINARY", "u8", "2"),
            ("ZERO_VIEW_SECURE", "u16", "1"),
            ("ZERO_VIEW_UPGRADE", "u16", "2"),
            ("ZERO_VIEW_KEEP_ALIVE", "u16", "4"),
            ("ZERO_VIEW_EXPECT_CONTINUE", "u16", "8"),
            ("ZERO_VIEW_HEAD_AS_GET", "u16", "16"),
            ("ZERO_VIEW_QUERY", "u16", "32"),
            ("ZERO_ROUTE_HOST", "u32", "0"),
            ("ZERO_ROUTE_STATIC", "u32", "1"),
            ("ZERO_ROUTE_REDIRECT", "u32", "2"),
            ("ZERO_ROUTE_FIXED", "u32", "3"),
            ("ZERO_ROUTE_WEBSOCKET", "u32", "4"),
            ("ZERO_ROUTE_HEALTH", "u32", "5"),
            ("ZERO_POLICY_CORS", "u32", "0"),
            ("ZERO_POLICY_SECURITY_HEADERS", "u32", "1"),
            ("ZERO_POLICY_REQUEST_ID", "u32", "2"),
            ("ZERO_POLICY_TRUST_PROXY", "u32", "3"),
            ("ZERO_POLICY_BODY_LIMIT", "u32", "4"),
        ] {
            assert_eq!(value_of(&constants, name), (ty, value), "{name}");
        }
        assert_eq!(constants.len(), 48);
    }

    #[test]
    fn the_rendered_file_is_documented_rust_with_one_public_constant_per_entry() {
        let constants = sample();
        let text = render(&constants);
        let file = syn::parse_file(&text).unwrap();
        assert_eq!(file.items.len(), constants.len());
        for item in &file.items {
            let Item::Const(item) = item else {
                panic!("not a constant: {item:?}");
            };
            assert!(matches!(item.vis, syn::Visibility::Public(_)));
            assert!(
                !crate::docs::doc_of(&item.attrs).is_empty(),
                "{}",
                item.ident
            );
        }
        for expected in [
            "\n/// `WWW-Authenticate` (RFC 9110 Section 11.6.1).\n\
             pub const ZERO_HEADER_WWW_AUTHENTICATE: u32 = 2;\n",
            "\n/// The `GET` method. Transfer a current representation of the target resource.\n\
             pub const ZERO_METHOD_GET: u8 = 0;\n",
            "\n/// The `PATCH` method. Apply a set of changes described in the request content to \
             the target\n\
             /// resource (RFC 5789 Section 2).\n\
             ///\n\
             /// @see <https://www.rfc-editor.org/rfc/rfc5789.html#section-2>\n\
             pub const ZERO_METHOD_PATCH: u8 = 8;\n",
            "\n/// A text message: WebSocket opcode %x1.\n\
             ///\n\
             /// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>\n\
             pub const ZERO_OPCODE_TEXT: u8 = 1;\n",
            "\n/// The largest id, 2^53 - 1, so every id is exact as a JavaScript number. An id \
             above it is\n\
             /// refused with `ZeroStatus_InvalidArgument`.\n\
             pub const ZERO_ID_MAX: u64 = 9_007_199_254_740_991u64;\n",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        assert!(text.starts_with("//! The named constants of the C ABI"));
        assert!(text.ends_with("pub const ZERO_POLICY_BODY_LIMIT: u32 = 4;\n"));
        assert!(!text.contains("\n\n\n"));
        assert!(text.lines().all(|line| line.len() <= 100), "{text}");
    }

    #[test]
    fn a_gap_in_the_header_ids_is_refused() {
        let mut headers = header_names(SAMPLE_HEADER_TABLE).unwrap();
        headers.remove(1);
        let err = constants(&headers, &[]).unwrap_err();
        assert!(err.contains("not dense"), "{err}");
    }

    #[test]
    fn a_header_name_that_collides_with_a_fixed_constant_is_refused() {
        let mut headers = header_names(SAMPLE_HEADER_TABLE).unwrap();
        headers.push(HeaderName {
            id: 3,
            lower: "set".to_owned(),
            canonical: "Set".to_owned(),
            source: "nowhere".to_owned(),
        });
        let err = constants(&headers, &[]).unwrap_err();
        assert_eq!(err, "two constants are named ZERO_HEADER_SET");
    }

    #[test]
    fn a_header_name_a_c_identifier_cannot_spell_is_refused() {
        let headers = [HeaderName {
            id: 0,
            lower: "x.y".to_owned(),
            canonical: "X.Y".to_owned(),
            source: "nowhere".to_owned(),
        }];
        let err = constants(&headers, &[]).unwrap_err();
        assert!(err.contains("a C identifier cannot hold"), "{err}");
    }

    #[test]
    fn a_method_id_held_by_another_method_or_by_any_is_refused() {
        let get = MethodName {
            variant: "Get".to_owned(),
            id: 0,
            doc: String::new(),
        };
        let twin = MethodName {
            variant: "Fetch".to_owned(),
            ..get.clone()
        };
        assert!(constants(&[], &[get.clone(), twin]).is_err());
        let any = MethodName {
            variant: "Every".to_owned(),
            id: 254,
            doc: String::new(),
        };
        assert!(constants(&[], &[get, any]).is_err());
    }

    #[test]
    fn a_method_without_a_discriminant_or_with_data_is_refused() {
        assert!(method_names("pub enum Method { Get }").is_err());
        assert!(method_names("pub enum Method { Get(u8) = 0 }").is_err());
        assert!(method_names("pub enum Verb { Get = 0 }").is_err());
        assert!(header_names("fn f() {}").is_err());
        assert!(header_names("header_names! { Accept = 0, \"accept\"; }").is_err());
    }

    #[test]
    fn every_value_is_a_form_cbindgen_translates() {
        let root = crate::docs::repo_root();
        let headers = header_names(&fs::read_to_string(root.join(HEADER_TABLE)).unwrap()).unwrap();
        let methods = method_names(&fs::read_to_string(root.join(METHOD_TABLE)).unwrap()).unwrap();
        for constant in constants(&headers, &methods).unwrap() {
            let value = constant.value.as_str();
            let digits = value.strip_suffix("u64").unwrap_or(value);
            let literal =
                !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit() || c == '_');
            assert!(
                literal || matches!(value, "u32::MAX" | "u64::MAX"),
                "{}: {value}",
                constant.name
            );
        }
    }

    #[test]
    fn screaming_case_splits_at_each_word() {
        assert_eq!(screaming("Get"), "GET");
        assert_eq!(screaming("MkCol"), "MK_COL");
        assert_eq!(screaming("Patch"), "PATCH");
    }

    #[test]
    fn documentation_wraps_at_word_boundaries_and_keeps_its_paragraphs() {
        assert_eq!(wrap("one two three four", 9), ["one two", "three", "four"]);
        assert_eq!(wrap("unbreakable-word", 4), ["unbreakable-word"]);
        assert!(wrap("", 10).is_empty());
        assert_eq!(
            doc_lines("First\nline.\n\n\n  \nSecond."),
            ["First line.", "", "Second."]
        );
        assert!(doc_lines("\n\n").is_empty());
    }

    #[test]
    fn the_tables_of_zero_http_types_generate_one_constant_per_entry() {
        let root = crate::docs::repo_root();
        let headers = header_names(&fs::read_to_string(root.join(HEADER_TABLE)).unwrap()).unwrap();
        let methods = method_names(&fs::read_to_string(root.join(METHOD_TABLE)).unwrap()).unwrap();
        let constants = constants(&headers, &methods).unwrap();
        assert_eq!(
            value_of(&constants, "ZERO_HEADER_COUNT").1,
            headers.len().to_string()
        );
        assert_eq!(value_of(&constants, "ZERO_HEADER_ACCEPT"), ("u32", "0"));
        assert_eq!(value_of(&constants, "ZERO_METHOD_GET"), ("u8", "0"));
        assert_eq!(value_of(&constants, "ZERO_METHOD_TRACE"), ("u8", "7"));
        assert_eq!(
            constants.len(),
            LEADING.len() + 1 + headers.len() + methods.len() + TRAILING.len()
        );
        let text = render(&constants);
        assert!(text.lines().all(|line| line.len() <= 100), "{text}");
    }
}
