//! The generated header: it declares only C-compatible types and only the curated API,
//! and its constants equal the values they mirror.

#![cfg(not(miri))]
#![allow(unsafe_code)]

mod support;

use std::collections::BTreeSet;

use zero_ffi::*;
use zero_http_types::{HeaderName, Method};

/// The committed header.
fn header() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/include/zero.h"))
        .expect("the header")
}

/// The header as a C17 compiler reads it: comments removed, preprocessor lines and the
/// C++ linkage block dropped.
fn code(header: &str) -> String {
    let mut out = String::new();
    let mut in_block = false;
    for line in header.lines() {
        let mut rest = line;
        let mut kept = String::new();
        loop {
            if in_block {
                match rest.find("*/") {
                    Some(end) => {
                        rest = &rest[end + 2..];
                        in_block = false;
                    }
                    None => break,
                }
            } else if let Some(start) = rest.find("/*") {
                let before = &rest[..start];
                kept.push_str(before.split("//").next().unwrap_or(""));
                if before.contains("//") {
                    break;
                }
                rest = &rest[start + 2..];
                in_block = true;
            } else {
                kept.push_str(rest.split("//").next().unwrap_or(""));
                break;
            }
        }
        let trimmed = kept.trim();
        if trimmed.starts_with('#') || trimmed == "extern \"C\" {" || trimmed == "}" {
            continue;
        }
        out.push_str(&kept);
        out.push('\n');
    }
    out
}

/// Split the code into its top-level declarations, each ending at a `;` outside braces.
fn declarations(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in code.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        current.push(c);
        if c == ';' && depth == 0 {
            let squashed = current.split_whitespace().collect::<Vec<_>>().join(" ");
            if !squashed.is_empty() && squashed != ";" {
                out.push(squashed);
            }
            current.clear();
        }
    }
    out
}

/// The types a C prototype or field may use at the bottom of its pointers.
const C_TYPES: [&str; 9] = [
    "void",
    "char",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "int32_t",
    "uintptr_t",
    "const",
];

/// Every identifier of a type, a parameter list or a field list, without the names a
/// declaration gives its parameters and fields.
fn type_words(declaration: &str) -> Vec<String> {
    declaration
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_generated_header_declares_only_c_compatible_types() {
    let text = header();
    let declarations = declarations(&code(&text));
    let mut types = BTreeSet::new();
    let mut prototypes = Vec::new();
    let mut bodies = Vec::new();
    for declaration in &declarations {
        if let Some(rest) = declaration.strip_prefix("typedef struct ") {
            if let Some((tag, name)) = rest.trim_end_matches(';').split_once(' ') {
                if tag == name.trim() {
                    types.insert(name.trim().to_owned());
                    continue;
                }
            }
        }
        if declaration.starts_with("typedef struct {") || declaration.starts_with("typedef enum {")
        {
            let name = declaration
                .rsplit('}')
                .next()
                .unwrap()
                .trim_end_matches(';')
                .trim()
                .to_owned();
            types.insert(name);
            bodies.push(declaration.clone());
            continue;
        }
        if declaration.starts_with("typedef ") {
            let name = declaration
                .split("(*")
                .nth(1)
                .and_then(|rest| rest.split(')').next())
                .expect("a function pointer typedef")
                .to_owned();
            types.insert(name);
            bodies.push(declaration.clone());
            continue;
        }
        prototypes.push(declaration.clone());
    }
    assert!(
        types.contains("ZeroStatus")
            && types.contains("ZeroString")
            && types.contains("ZeroPluginRegisterFn")
    );
    assert!(prototypes.len() >= 80, "{} prototypes", prototypes.len());

    let mut foreign = Vec::new();
    for prototype in &prototypes {
        let open = prototype.find('(').expect("a parameter list");
        let before = &prototype[..open];
        let name = before
            .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .next()
            .unwrap();
        assert!(
            name.starts_with("zero_"),
            "{prototype}: the export {name} is not in the zero_ namespace"
        );
        let returns = &before[..before.len() - name.len()];
        let params = &prototype[open..];
        let mut words = type_words(returns);
        for parameter in params
            .trim_start_matches('(')
            .trim_end_matches(';')
            .trim_end_matches(')')
            .split(',')
        {
            let mut parameter_words = type_words(parameter);
            if parameter_words.len() > 1 {
                parameter_words.pop();
            }
            words.extend(parameter_words);
        }
        for word in words {
            if !(C_TYPES.contains(&word.as_str()) || types.contains(&word)) {
                foreign.push(format!("{name}: {word}"));
            }
        }
        if returns.contains("char") || params.contains("char") {
            assert!(
                prototype.contains("const char *"),
                "{prototype}: char only as UTF-8 text"
            );
        }
    }
    for body in &bodies {
        let inside = body
            .split_once('{')
            .map_or(body.as_str(), |(_, inside)| inside);
        let inside = inside.rsplit_once('}').map_or(inside, |(inside, _)| inside);
        let fields = if body.starts_with("typedef enum") {
            Vec::new()
        } else if body.starts_with("typedef struct") {
            inside.split(';').map(str::to_owned).collect()
        } else {
            vec![body.trim_start_matches("typedef ").to_owned()]
        };
        for field in fields {
            let field = field.trim();
            if field.is_empty() {
                continue;
            }
            let mut words = Vec::new();
            if let Some((ret, rest)) = field.split_once("(*") {
                words.extend(type_words(ret));
                let params = rest.split_once(")(").map_or("", |(_, params)| params);
                for parameter in params
                    .trim_end_matches(';')
                    .trim_end_matches(')')
                    .split(',')
                {
                    let mut parameter_words = type_words(parameter);
                    if parameter_words.len() > 1 {
                        parameter_words.pop();
                    }
                    words.extend(parameter_words);
                }
            } else {
                let without_array = field.split('[').next().unwrap_or(field);
                words = type_words(without_array);
                words.pop();
            }
            for word in words {
                if !(C_TYPES.contains(&word.as_str()) || types.contains(&word)) {
                    foreign.push(format!("{body}: {word}"));
                }
            }
        }
    }
    assert!(
        foreign.is_empty(),
        "types that are not C or declared here: {foreign:#?}"
    );
    for name in &types {
        assert!(
            name.starts_with("Zero"),
            "{name} is not in the Zero namespace"
        );
    }
    for forbidden in ["bool", "size_t", "Option", "Box", "Vec", "String", "&", "<"] {
        assert!(
            !code(&text).contains(&format!(" {forbidden} ")),
            "the header names {forbidden}"
        );
    }
    let defined = format!("#define ZERO_ABI_VERSION {}", zero_abi_version());
    assert!(text.contains(&defined), "{defined}");
}

/// The value of a `#define` of the header.
fn defined(header: &str, name: &str) -> String {
    let prefix = format!("#define {name} ");
    header
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("no #define {name}"))
        .trim()
        .to_owned()
}

#[test]
fn every_constant_equals_the_value_it_mirrors() {
    let text = header();
    assert_eq!(
        usize::try_from(ZERO_HEADER_COUNT).unwrap(),
        HeaderName::ALL.len()
    );
    for name in HeaderName::ALL {
        let constant = format!(
            "ZERO_HEADER_{}",
            name.as_str().to_ascii_uppercase().replace('-', "_")
        );
        assert_eq!(
            defined(&text, &constant),
            name.id().to_string(),
            "{constant}"
        );
    }
    for method in Method::ALL {
        let constant = format!("ZERO_METHOD_{}", method.as_str());
        assert_eq!(
            defined(&text, &constant),
            method.id().to_string(),
            "{constant}"
        );
    }
    assert!(
        Method::from_id(ZERO_METHOD_ANY).is_none() && Method::from_id(ZERO_METHOD_OTHER).is_none()
    );
    assert_eq!(ZERO_METHOD_OTHER, zero_http::exchange::METHOD_OTHER);
    assert_eq!(ZERO_HEADER_NONE, zero_http::exchange::HEADER_NONE);
    assert_eq!(ZERO_ID_MAX, zero_core::slot::MAX_ENCODED);
    assert_eq!(
        usize::try_from(ZERO_MAX_BATCH).unwrap(),
        zero_limits::services::MAX_BATCH_SIZE
    );
    assert_eq!(
        usize::try_from(ZERO_MAX_BATCH).unwrap(),
        zero_host::MAX_BATCH
    );
    assert_eq!(ZERO_BATCH_REQUESTS, zero_host::BATCH_REQUESTS);
    assert_eq!(ZERO_BATCH_EVENTS, zero_host::BATCH_EVENTS);
    for (constant, mirrored) in [
        (ZERO_EVENT_WS_OPEN, zero_host::realtime::EVENT_WS_OPEN),
        (ZERO_EVENT_WS_MESSAGE, zero_host::realtime::EVENT_WS_MESSAGE),
        (ZERO_EVENT_WS_PONG, zero_host::realtime::EVENT_WS_PONG),
        (ZERO_EVENT_WS_CLOSE, zero_host::realtime::EVENT_WS_CLOSE),
        (ZERO_EVENT_WS_DRAINED, zero_host::realtime::EVENT_WS_DRAINED),
        (ZERO_EVENT_SSE_CLOSED, zero_host::realtime::EVENT_SSE_CLOSED),
        (
            ZERO_EVENT_SSE_DRAINED,
            zero_host::realtime::EVENT_SSE_DRAINED,
        ),
        (ZERO_OPCODE_TEXT, zero_host::realtime::OPCODE_TEXT),
        (ZERO_OPCODE_BINARY, zero_host::realtime::OPCODE_BINARY),
    ] {
        assert_eq!(constant, mirrored);
    }
    for (constant, mirrored) in [
        (ZERO_VIEW_SECURE, zero_http::exchange::VIEW_SECURE),
        (ZERO_VIEW_UPGRADE, zero_http::exchange::VIEW_UPGRADE),
        (ZERO_VIEW_KEEP_ALIVE, zero_http::exchange::VIEW_KEEP_ALIVE),
        (
            ZERO_VIEW_EXPECT_CONTINUE,
            zero_http::exchange::VIEW_EXPECT_CONTINUE,
        ),
        (ZERO_VIEW_HEAD_AS_GET, zero_http::exchange::VIEW_HEAD_AS_GET),
        (ZERO_VIEW_QUERY, zero_http::exchange::VIEW_QUERY),
    ] {
        assert_eq!(constant, mirrored);
    }
    use zero_host::{PolicyKind, RouteKind};
    for (code, kind) in [
        (ZERO_ROUTE_HOST, RouteKind::Host),
        (ZERO_ROUTE_STATIC, RouteKind::Static),
        (ZERO_ROUTE_REDIRECT, RouteKind::Redirect),
        (ZERO_ROUTE_FIXED, RouteKind::Fixed),
        (ZERO_ROUTE_WEBSOCKET, RouteKind::WebSocket),
        (ZERO_ROUTE_HEALTH, RouteKind::Health),
    ] {
        assert_eq!(RouteKind::from_code(code), Some(kind));
    }
    for (code, kind) in [
        (ZERO_POLICY_CORS, PolicyKind::Cors),
        (ZERO_POLICY_SECURITY_HEADERS, PolicyKind::SecurityHeaders),
        (ZERO_POLICY_REQUEST_ID, PolicyKind::RequestId),
        (ZERO_POLICY_TRUST_PROXY, PolicyKind::TrustProxy),
        (ZERO_POLICY_BODY_LIMIT, PolicyKind::BodyLimit),
    ] {
        assert_eq!(PolicyKind::from_code(code), Some(kind));
    }
    assert_eq!(
        (ZERO_NONE, ZERO_ALL_WORKERS, ZERO_EPOCH_NONE),
        (u64::MAX, u32::MAX, 0)
    );
    assert_eq!(ZERO_PLUGIN_ABI_VERSION, 1);
    assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
}

#[test]
fn a_route_captures_at_most_zero_max_params_parameters() {
    let pattern = |count: u32| {
        (0..count)
            .map(|index| format!("/:p{index}"))
            .collect::<String>()
    };
    let app = support::app_new();
    let mut id = 0u32;
    let accepted = pattern(ZERO_MAX_PARAMS);
    // SAFETY: the pattern range is the bytes of a string and `id` is writable.
    let status = unsafe {
        zero_app_route(
            app,
            ZERO_ROUTE_HOST,
            ZERO_METHOD_GET,
            accepted.as_ptr(),
            accepted.len(),
            std::ptr::null(),
            0,
            &mut id,
        )
    };
    assert_eq!(status, ZeroStatus::Ok, "{}", support::last_error());
    let refused = format!("/x{}", pattern(ZERO_MAX_PARAMS + 1));
    // SAFETY: the pattern range is the bytes of a string and `id` is writable.
    let status = unsafe {
        zero_app_route(
            app,
            ZERO_ROUTE_HOST,
            ZERO_METHOD_GET,
            refused.as_ptr(),
            refused.len(),
            std::ptr::null(),
            0,
            &mut id,
        )
    };
    assert_eq!(status, ZeroStatus::InvalidArgument);
    support::ok(zero_app_free(app));
}
