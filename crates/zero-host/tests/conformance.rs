//! The conformance entry against `conformance/vectors.json`: every case of every
//! section comes back unchanged, one case at a time and a whole section at once;
//! every outcome of every case, given a wrong value of its shape, comes back
//! computed again, and every member of the file is known as an input or an outcome,
//! so an entry that echoed what it was given would fail; arbitrary input to each
//! section never panics and always ends in a well-formed result, which the entry
//! returns unchanged; and a section whose capability is compiled out is refused as
//! unsupported.

use std::panic;

use zero_core::Value;
use zero_host::conformance::{self, SECTIONS};
use zero_host::Status;

/// The committed vectors.
const VECTORS: &str = include_str!("../../../conformance/vectors.json");

/// Whether this build runs a section: `ws` and `sse` need the `realtime` feature.
fn compiled(name: &str) -> bool {
    !matches!(name, "ws" | "sse") || cfg!(feature = "realtime")
}

/// The sections of the vectors file, without its note and tolerance.
fn sections() -> Vec<(String, Value)> {
    let Ok(Value::Object(members)) = zero_json::parse(VECTORS.as_bytes()) else {
        panic!("the vectors file is a JSON object");
    };
    members
        .into_iter()
        .filter(|(name, _)| name != "note" && name != "tolerance")
        .collect()
}

/// The section of the vectors file a name names.
fn section(name: &str) -> Value {
    sections()
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, body)| body)
        .unwrap_or_else(|| panic!("the vectors file holds {name}"))
}

/// A value as JSON text.
fn json(value: &Value) -> String {
    let bytes = zero_json::to_vec(value).expect("a parsed document serializes");
    String::from_utf8(bytes).expect("JSON text is UTF-8")
}

/// Octets as lowercase hexadecimal.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The octets of lowercase hexadecimal text, or `None` for other text.
fn unhex(text: &str) -> Option<Vec<u8>> {
    let (pairs, rest) = text.as_bytes().as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    pairs
        .iter()
        .map(|&[high, low]| Some(digit(high)? << 4 | digit(low)?))
        .collect()
}

/// Whether two values are equal, object members compared in any order.
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .iter()
                        .any(|(other, item)| other == key && same(value, item))
                })
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same(a, b))
        }
        _ => left == right,
    }
}

/// The members of an object as single-member documents, a list of objects split into
/// one document per object, each with the label a failure names.
fn split(path: &str, object: &Value) -> Vec<(String, Value)> {
    let Value::Object(members) = object else {
        panic!("{path} is an object");
    };
    let mut out = Vec::new();
    for (key, value) in members {
        match value {
            Value::Array(items)
                if !items.is_empty()
                    && items.iter().all(|item| matches!(item, Value::Object(_))) =>
            {
                for (index, item) in items.iter().enumerate() {
                    let label = match item.get("name").and_then(Value::as_str) {
                        Some(name) => format!("{path}.{key}: {name}"),
                        None => format!("{path}.{key}[{index}]"),
                    };
                    let document =
                        Value::Object(vec![(key.clone(), Value::Array(vec![item.clone()]))]);
                    out.push((label, document));
                }
            }
            _ => out.push((
                format!("{path}.{key}"),
                Value::Object(vec![(key.clone(), value.clone())]),
            )),
        }
    }
    out
}

/// One document per case of a section and one per other member: a case alone in its
/// list, inside its group for `qpack` and `h3Frames`, and beside the table for
/// `router`.
fn units(name: &str, body: &Value) -> Vec<(String, Value)> {
    match name {
        "qpack" | "h3Frames" => {
            let Value::Object(groups) = body else {
                panic!("{name} is an object");
            };
            groups
                .iter()
                .flat_map(|(group, value)| {
                    split(&format!("{name}.{group}"), value)
                        .into_iter()
                        .map(|(label, unit)| (label, Value::Object(vec![(group.clone(), unit)])))
                })
                .collect()
        }
        "router" => {
            let table = body.get("table").cloned().expect("the router table");
            split(name, body)
                .into_iter()
                .map(|(label, unit)| match unit {
                    Value::Object(mut members) if members.iter().all(|(key, _)| key != "table") => {
                        members.push(("table".to_owned(), table.clone()));
                        (label, Value::Object(members))
                    }
                    other => (label, other),
                })
                .collect()
        }
        _ => split(name, body),
    }
}

/// Runs a document through the entry and asserts it comes back unchanged.
fn assert_unchanged(name: &str, label: &str, document: &Value) {
    let input = json(document);
    let result = conformance::case(name.as_bytes(), input.as_bytes())
        .unwrap_or_else(|error| panic!("{label}: {error}"));
    let parsed = zero_json::parse(result.as_bytes())
        .unwrap_or_else(|error| panic!("{label}: the result is not JSON: {error}"));
    assert!(
        same(&parsed, document),
        "{label}: the entry disagrees with the vector\n  vector: {input}\n  entry:  {result}"
    );
}

#[test]
fn every_case_of_every_section_comes_back_unchanged_through_the_entry() {
    let mut checked = 0usize;
    for (name, body) in sections() {
        if !compiled(&name) {
            continue;
        }
        for (label, document) in units(&name, &body) {
            assert_unchanged(&name, &label, &document);
            checked += 1;
        }
        assert_unchanged(&name, &name, &body);
    }
    assert!(checked > 250, "only {checked} cases were checked");
}

/// One list of cases in the vectors file: where it is, the members of a case the
/// entry reads, and the members it computes.
struct CaseList {
    section: &'static str,
    group: Option<&'static str>,
    key: &'static str,
    inputs: &'static [&'static str],
    outcomes: &'static [&'static str],
}

/// Every list of cases in the vectors file.
const CASE_LISTS: [CaseList; 26] = [
    CaseList {
        section: "http1Parser",
        group: None,
        key: "cases",
        inputs: &["name", "section", "request"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "responseSplitting",
        group: None,
        key: "cases",
        inputs: &["name", "section", "field", "value"],
        outcomes: &["accepted"],
    },
    CaseList {
        section: "router",
        group: None,
        key: "cases",
        inputs: &["name", "section", "method", "target"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "ws",
        group: None,
        key: "cases",
        inputs: &[
            "name",
            "section",
            "kind",
            "request",
            "routeProtocols",
            "routeOrigins",
            "clientFrames",
        ],
        outcomes: &["expect"],
    },
    CaseList {
        section: "sse",
        group: None,
        key: "cases",
        inputs: &["name", "section", "call"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "qpack",
        group: Some("integers"),
        key: "cases",
        inputs: &["name", "section", "encoded", "prefixBits"],
        outcomes: &["value"],
    },
    CaseList {
        section: "qpack",
        group: Some("integerErrors"),
        key: "cases",
        inputs: &["name", "section", "cap", "encoded", "prefixBits"],
        outcomes: &["error"],
    },
    CaseList {
        section: "qpack",
        group: Some("huffman"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["text"],
    },
    CaseList {
        section: "qpack",
        group: Some("huffmanErrors"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["error"],
    },
    CaseList {
        section: "qpack",
        group: Some("fieldSections"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["expect", "representations"],
    },
    CaseList {
        section: "qpack",
        group: Some("encodings"),
        key: "cases",
        inputs: &["name", "section", "huffman", "lines"],
        outcomes: &["encoded", "representations"],
    },
    CaseList {
        section: "qpack",
        group: Some("encoderStream"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["atCapacityZero", "headOnly", "instructions"],
    },
    CaseList {
        section: "qpack",
        group: Some("decoderStream"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["atStaticEncoder", "instructions"],
    },
    CaseList {
        section: "qpack",
        group: Some("requiredInsertCount"),
        key: "cases",
        inputs: &[
            "name",
            "section",
            "encodedInsertCount",
            "maxEntries",
            "totalInserts",
        ],
        outcomes: &["expect"],
    },
    CaseList {
        section: "qpack",
        group: Some("base"),
        key: "cases",
        inputs: &[
            "name",
            "section",
            "requiredInsertCount",
            "sign",
            "deltaBase",
        ],
        outcomes: &["expect"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("varints"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["value", "shortest"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("frames"),
        key: "cases",
        inputs: &[
            "name",
            "section",
            "encoded",
            "fin",
            "limits",
            "role",
            "stream",
            "tunnelAfterHeaders",
        ],
        outcomes: &["events", "outcome"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("settings"),
        key: "cases",
        inputs: &["name", "section", "payload"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("streamTypes"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["type", "value"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("uniStreams"),
        key: "cases",
        inputs: &["name", "section", "opened", "role"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("uniStreams"),
        key: "closed",
        inputs: &["type"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("errorCodes"),
        key: "registered",
        inputs: &["value"],
        outcomes: &["name"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("errorCodes"),
        key: "onReceipt",
        inputs: &["value"],
        outcomes: &["treatedAs"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("goaway"),
        key: "cases",
        inputs: &["name", "section", "received", "role"],
        outcomes: &["expect"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("capsules"),
        key: "cases",
        inputs: &["name", "section", "encoded", "fin", "maxDatagram"],
        outcomes: &["events", "outcome"],
    },
    CaseList {
        section: "h3Frames",
        group: Some("datagrams"),
        key: "cases",
        inputs: &["name", "section", "encoded"],
        outcomes: &["expect"],
    },
];

/// What a member of a group other than a list of cases holds.
#[derive(Clone, Copy, Debug)]
enum Held {
    /// The specification text the group cites, which the entry echoes.
    Citation,
    /// A value the entry computes without reading the member.
    Computed,
    /// An object whose named member is computed from its other members.
    Inner(&'static str),
    /// Values each claimed to hold a property, of which the entry keeps those that
    /// hold it; the given value does not.
    Claims(&'static str),
    /// The first values of a sequence, as many as the list holds.
    Leading,
}

/// Every member of a group other than a list of cases.
const GROUP_VALUES: [(&str, &str, &str, Held); 13] = [
    ("qpack", "staticTable", "entries", Held::Computed),
    ("qpack", "staticTable", "section", Held::Citation),
    ("h3Frames", "varints", "refused", Held::Claims("5")),
    ("h3Frames", "reservedValues", "first", Held::Leading),
    ("h3Frames", "reservedValues", "last", Held::Computed),
    (
        "h3Frames",
        "reservedValues",
        "notReserved",
        Held::Claims("33"),
    ),
    ("h3Frames", "reservedValues", "section", Held::Citation),
    ("h3Frames", "serverControlStream", "encoded", Held::Computed),
    ("h3Frames", "serverControlStream", "section", Held::Citation),
    (
        "h3Frames",
        "serverControlStream",
        "settings",
        Held::Computed,
    ),
    (
        "h3Frames",
        "serverControlStream",
        "withReserved",
        Held::Inner("encoded"),
    ),
    ("h3Frames", "goaway", "gracefulClient", Held::Computed),
    ("h3Frames", "goaway", "gracefulServer", Held::Computed),
];

/// A member of an object in the vectors file.
fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("the vectors file holds {key}"))
}

/// An object with one member replaced.
fn replaced(object: &Value, key: &str, item: &Value) -> Value {
    let Value::Object(members) = object else {
        panic!("{key} is a member of an object");
    };
    Value::Object(
        members
            .iter()
            .map(|(name, value)| {
                let kept = if name == key { item } else { value };
                (name.clone(), kept.clone())
            })
            .collect(),
    )
}

/// A document holding one member, as a runner passes a group or a list.
fn holding(key: &str, value: Value) -> Value {
    Value::Object(vec![(key.to_owned(), value)])
}

/// A document holding one case of a list, as a runner passes it.
fn alone(list: &CaseList, body: &Value, case: Value) -> Value {
    let cases = Value::Array(vec![case]);
    match list.group {
        Some(group) => holding(group, holding(list.key, cases)),
        None if list.section == "router" => Value::Object(vec![
            ("cases".to_owned(), cases),
            ("table".to_owned(), member(body, "table").clone()),
        ]),
        None => holding(list.key, cases),
    }
}

/// Text with its last character changed: a decimal or lowercase hexadecimal digit to
/// the next one, so the text keeps its form; any other character gains an `X` after
/// it, and empty text becomes `00`.
fn bumped(text: &str) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    let Some(last) = chars.last_mut() else {
        return "00".to_owned();
    };
    match *last {
        '0'..='8' | 'a'..='e' => {
            *last = char::from(u8::try_from(*last).expect("an ASCII digit") + 1);
        }
        '9' => *last = '0',
        'f' => *last = 'a',
        _ => chars.push('X'),
    }
    chars.into_iter().collect()
}

/// Values of the same shape as `value` and different from it, each with what
/// changed: a boolean flipped, an integer moved by one, the last character of text
/// changed, the last item of a list dropped or repeated (an item added to an empty
/// one), an object given another member, and each of these inside every item and
/// member.
fn wrong_values(value: &Value) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    match value {
        Value::Null => out.push(("null to text".to_owned(), Value::Str("ALTERED".to_owned()))),
        Value::Bool(flag) => out.push((format!("{flag} flipped"), Value::Bool(!flag))),
        Value::Int(number) => out.push((
            format!("{number} moved by one"),
            Value::Int(number.wrapping_add(1)),
        )),
        Value::Str(text) => out.push((format!("{text:?} changed"), Value::Str(bumped(text)))),
        Value::Array(items) => {
            match items.split_last() {
                None => out.push((
                    "an item added".to_owned(),
                    Value::Array(vec![Value::Str("ALTERED".to_owned())]),
                )),
                Some((last, rest)) => {
                    out.push((
                        "the last item dropped".to_owned(),
                        Value::Array(rest.to_vec()),
                    ));
                    let mut longer = items.clone();
                    longer.push(last.clone());
                    out.push(("the last item repeated".to_owned(), Value::Array(longer)));
                }
            }
            for (index, item) in items.iter().enumerate() {
                for (change, wrong) in wrong_values(item) {
                    let mut copy = items.clone();
                    copy[index] = wrong;
                    out.push((format!("[{index}] {change}"), Value::Array(copy)));
                }
            }
        }
        Value::Object(members) => {
            let mut extra = members.clone();
            extra.push(("altered".to_owned(), Value::Bool(true)));
            out.push(("a member added".to_owned(), Value::Object(extra)));
            for (index, (key, item)) in members.iter().enumerate() {
                for (change, wrong) in wrong_values(item) {
                    let mut copy = members.clone();
                    copy[index].1 = wrong;
                    out.push((format!(".{key} {change}"), Value::Object(copy)));
                }
            }
        }
        Value::Float(_) | Value::Bytes(_) => {}
    }
    out
}

/// Every wrong value of an outcome: the whole replaced by text and by null, and every
/// value of the same shape that differs from it.
fn wrong_outcomes(original: &Value) -> Vec<(String, Value)> {
    let mut out = vec![(
        "replaced by text".to_owned(),
        Value::Str("ALTERED".to_owned()),
    )];
    if !original.is_null() {
        out.push(("replaced by null".to_owned(), Value::Null));
    }
    out.extend(wrong_values(original));
    out
}

/// Runs a document carrying a wrong outcome through the entry and asserts that the
/// result is the vector, every outcome computed again from the inputs.
fn assert_corrected(name: &str, label: &str, vector: &Value, given: &Value) {
    let input = json(given);
    let result = conformance::case(name.as_bytes(), input.as_bytes())
        .unwrap_or_else(|error| panic!("{label}: {error}"));
    let parsed = zero_json::parse(result.as_bytes())
        .unwrap_or_else(|error| panic!("{label}: the result is not JSON: {error}"));
    assert!(
        same(&parsed, vector),
        "{label}: the entry did not compute the outcome again\n  given:  {input}\n  entry:  {result}\n  vector: {}",
        json(vector)
    );
}

#[test]
fn every_member_of_the_vectors_is_an_input_or_an_outcome_the_entry_computes() {
    let grouped = |name: &str, group: &str, key: &str| {
        CASE_LISTS
            .iter()
            .any(|list| list.section == name && list.group == Some(group) && list.key == key)
            || GROUP_VALUES.iter().any(|&(section, owner, value, _)| {
                section == name && owner == group && value == key
            })
    };
    for (name, body) in sections() {
        let Value::Object(members) = &body else {
            panic!("{name} is an object");
        };
        for (key, value) in members {
            match name.as_str() {
                "qpack" | "h3Frames" => {
                    let Value::Object(inner) = value else {
                        panic!("{name}.{key} is a group");
                    };
                    for (inner_key, _) in inner {
                        assert!(
                            grouped(&name, key, inner_key),
                            "{name}.{key}.{inner_key} is neither a list of cases nor a value the test knows"
                        );
                    }
                }
                _ => assert!(
                    (name == "router" && key == "table")
                        || CASE_LISTS.iter().any(|list| list.section == name
                            && list.group.is_none()
                            && list.key == key),
                    "{name}.{key} is not a list of cases the test knows"
                ),
            }
        }
    }
    for list in &CASE_LISTS {
        let body = section(list.section);
        let owner = list.group.map_or(&body, |group| member(&body, group));
        let cases = member(owner, list.key)
            .as_array()
            .unwrap_or_else(|| panic!("{}.{} is a list", list.section, list.key));
        assert!(
            !cases.is_empty(),
            "{}.{} holds cases",
            list.section,
            list.key
        );
        for case in cases {
            let Value::Object(members) = case else {
                panic!("a case of {}.{} is an object", list.section, list.key);
            };
            for (key, _) in members {
                assert!(
                    list.inputs.contains(&key.as_str()) || list.outcomes.contains(&key.as_str()),
                    "{}.{}: {key} is neither an input nor an outcome",
                    list.section,
                    list.key
                );
            }
            for outcome in list.outcomes {
                assert!(
                    case.get(outcome).is_some(),
                    "{}.{}: a case leaves out the outcome {outcome}",
                    list.section,
                    list.key
                );
            }
        }
    }
    for (name, group, key, _) in GROUP_VALUES {
        assert!(
            section(name)
                .get(group)
                .and_then(|owner| owner.get(key))
                .is_some(),
            "{name}.{group}.{key} is in the vectors file"
        );
    }
}

#[test]
fn every_outcome_comes_back_computed_from_the_inputs_whatever_the_input_carried_for_it() {
    let mut checked = 0usize;
    for list in &CASE_LISTS {
        if !compiled(list.section) {
            continue;
        }
        let body = section(list.section);
        let owner = list.group.map_or(&body, |group| member(&body, group));
        let cases = member(owner, list.key).as_array().unwrap_or(&[]);
        for (index, case) in cases.iter().enumerate() {
            let vector = alone(list, &body, case.clone());
            let named = case
                .get("name")
                .and_then(Value::as_str)
                .map_or_else(|| format!("[{index}]"), |name| format!(": {name}"));
            for outcome in list.outcomes {
                for (change, wrong) in wrong_outcomes(member(case, outcome)) {
                    let label = format!(
                        "{}.{}{}{named}: {outcome} {change}",
                        list.section,
                        list.group
                            .map(|group| format!("{group}."))
                            .unwrap_or_default(),
                        list.key
                    );
                    let given = alone(list, &body, replaced(case, outcome, &wrong));
                    assert_corrected(list.section, &label, &vector, &given);
                    checked += 1;
                }
            }
        }
    }
    for (name, group, key, held) in GROUP_VALUES {
        let original = member(member(&section(name), group), key).clone();
        let document = |value: Value| holding(group, holding(key, value));
        let vector = document(original.clone());
        let label = |change: &str| format!("{name}.{group}.{key}: {change}");
        let wrong: Vec<(String, Value)> = match held {
            Held::Citation => Vec::new(),
            Held::Computed => wrong_outcomes(&original),
            Held::Inner(outcome) => wrong_outcomes(member(&original, outcome))
                .into_iter()
                .map(|(change, value)| {
                    (
                        format!("{outcome} {change}"),
                        replaced(&original, outcome, &value),
                    )
                })
                .collect(),
            Held::Claims(outside) => {
                let items = original.as_array().unwrap_or(&[]);
                (0..=items.len())
                    .map(|at| {
                        let mut claims = items.to_vec();
                        claims.insert(at, Value::Str(outside.to_owned()));
                        (format!("{outside} claimed at {at}"), Value::Array(claims))
                    })
                    .collect()
            }
            Held::Leading => {
                let items = original.as_array().unwrap_or(&[]);
                (0..items.len())
                    .flat_map(|at| {
                        let mut changes = wrong_values(&items[at]);
                        changes.push(("replaced by null".to_owned(), Value::Null));
                        changes.into_iter().map(move |(change, value)| {
                            let mut first = items.to_vec();
                            first[at] = value;
                            (format!("[{at}] {change}"), Value::Array(first))
                        })
                    })
                    .collect()
            }
        };
        for (change, value) in wrong {
            assert_corrected(name, &label(&change), &vector, &document(value));
            checked += 1;
        }
    }
    assert!(
        checked > 3_000,
        "only {checked} wrong outcomes were checked"
    );
}

#[test]
fn the_vectors_file_holds_exactly_the_sections_the_entry_runs() {
    let mut names: Vec<String> = sections().into_iter().map(|(name, _)| name).collect();
    names.sort_unstable();
    let mut known: Vec<String> = SECTIONS.iter().map(|name| (*name).to_owned()).collect();
    known.sort_unstable();
    assert_eq!(names, known, "a runner refuses a section it does not know");
}

#[test]
fn an_unknown_section_is_unsupported_whatever_the_document() {
    let names: [&[u8]; 9] = [
        b"",
        b"note",
        b"tolerance",
        b"HTTP1PARSER",
        b"http1parser",
        b"qpack.integers",
        b"h3",
        b"ws ",
        &[0xff, 0xfe],
    ];
    for name in names {
        for input in [&b"{}"[..], b"not json", b"[]"] {
            let refused = conformance::case(name, input).map_err(|error| error.status());
            assert_eq!(
                refused,
                Err(Status::Unsupported),
                "{}",
                String::from_utf8_lossy(name)
            );
        }
    }
}

#[test]
fn a_section_whose_capability_is_compiled_out_is_unsupported() {
    for name in ["ws", "sse"] {
        let body = section(name);
        for (label, document) in units(name, &body) {
            let result = conformance::case(name.as_bytes(), json(&document).as_bytes());
            if cfg!(feature = "realtime") {
                assert!(result.is_ok(), "{label}: {result:?}");
            } else {
                assert_eq!(
                    result.map_err(|error| error.status()),
                    Err(Status::Unsupported),
                    "{label}"
                );
            }
        }
        for input in [&b"{}"[..], b"not json"] {
            let status = conformance::case(name.as_bytes(), input).map_err(|error| error.status());
            if cfg!(feature = "realtime") {
                assert_ne!(status, Err(Status::Unsupported), "{name}");
            } else {
                assert_eq!(status, Err(Status::Unsupported), "{name}");
            }
        }
    }
    for name in SECTIONS
        .iter()
        .filter(|name| !matches!(**name, "ws" | "sse"))
    {
        assert_eq!(
            conformance::case(name.as_bytes(), b"{}").as_deref(),
            Ok("{}"),
            "{name} runs in every build"
        );
    }
}

#[test]
fn a_document_outside_the_shape_of_its_section_is_refused_naming_the_member() {
    let mut refused = vec![
        ("http1Parser", "[]", "http1Parser"),
        ("http1Parser", r#"{"case":[]}"#, "http1Parser.case"),
        ("http1Parser", r#"{"cases":{}}"#, "http1Parser.cases"),
        ("http1Parser", r#"{"cases":[7]}"#, "http1Parser.cases[0]"),
        (
            "http1Parser",
            r#"{"cases":[{}]}"#,
            "http1Parser.cases[0].request",
        ),
        (
            "http1Parser",
            r#"{"cases":[{"request":"0"}]}"#,
            "http1Parser.cases[0].request",
        ),
        (
            "http1Parser",
            r#"{"cases":[{"request":"0A"}]}"#,
            "http1Parser.cases[0].request",
        ),
        (
            "http1Parser",
            r#"{"cases":[{"request":"zz"}]}"#,
            "http1Parser.cases[0].request",
        ),
        (
            "http1Parser",
            r#"{"cases":[{"request":"","extra":1}]}"#,
            "http1Parser.cases[0].extra",
        ),
        (
            "http1Parser",
            r#"{"cases":[{"request":"","name":7}]}"#,
            "http1Parser.cases[0].name",
        ),
        (
            "responseSplitting",
            r#"{"cases":[{"field":1,"value":""}]}"#,
            "responseSplitting.cases[0].field",
        ),
        ("router", r#"{"cases":[]}"#, "router.cases"),
        (
            "router",
            r#"{"table":{"routes":[{"method":"FETCH","pattern":"/","id":1}],"mounts":[],"trailingSlash":"ignore"}}"#,
            "router.table.routes[0].method",
        ),
        (
            "router",
            r#"{"table":{"routes":[{"method":"GET","pattern":"users","id":1}],"mounts":[],"trailingSlash":"ignore"}}"#,
            "router.table.routes[0].pattern",
        ),
        (
            "router",
            r#"{"table":{"routes":[{"method":"GET","pattern":"/","id":-1}],"mounts":[],"trailingSlash":"ignore"}}"#,
            "router.table.routes[0].id",
        ),
        (
            "router",
            r#"{"table":{"routes":[],"mounts":[],"trailingSlash":"maybe"}}"#,
            "router.table.trailingSlash",
        ),
        (
            "qpack",
            r#"{"integers":{"cases":[{"prefixBits":9,"encoded":"00"}]}}"#,
            "qpack.integers.cases[0].prefixBits",
        ),
        (
            "qpack",
            r#"{"base":{"cases":[{"requiredInsertCount":"01","sign":true,"deltaBase":"0"}]}}"#,
            "qpack.base.cases[0].requiredInsertCount",
        ),
        (
            "qpack",
            r#"{"base":{"cases":[{"requiredInsertCount":"18446744073709551616","sign":true,"deltaBase":"0"}]}}"#,
            "qpack.base.cases[0].requiredInsertCount",
        ),
        (
            "qpack",
            r#"{"encodings":{"cases":[{"huffman":"sometimes","lines":[]}]}}"#,
            "qpack.encodings.cases[0].huffman",
        ),
        ("qpack", r#"{"tables":{}}"#, "qpack.tables"),
        (
            "h3Frames",
            r#"{"varints":{"refused":[4]}}"#,
            "h3Frames.varints.refused[0]",
        ),
        (
            "h3Frames",
            r#"{"frames":{"cases":[{"stream":"bidi"}]}}"#,
            "h3Frames.frames.cases[0].stream",
        ),
        (
            "h3Frames",
            r#"{"goaway":{"cases":[{"role":"peer","received":[]}]}}"#,
            "h3Frames.goaway.cases[0].role",
        ),
    ];
    if cfg!(feature = "realtime") {
        refused.extend([
            (
                "ws",
                r#"{"cases":[{"kind":"ping","request":"","routeProtocols":[],"routeOrigins":null,"clientFrames":""}]}"#,
                "ws.cases[0].kind",
            ),
            (
                "ws",
                r#"{"cases":[{"kind":"handshake","request":"","routeProtocols":[1],"routeOrigins":null,"clientFrames":""}]}"#,
                "ws.cases[0].routeProtocols[0]",
            ),
            (
                "sse",
                r#"{"cases":[{"call":{"comment":"x","retry":1}}]}"#,
                "sse.cases[0].call.retry",
            ),
            (
                "sse",
                r#"{"cases":[{"call":{"retry":4294967296}}]}"#,
                "sse.cases[0].call.retry",
            ),
            (
                "sse",
                r#"{"cases":[{"call":{"data":"x","event":null}}]}"#,
                "sse.cases[0].call.event",
            ),
        ]);
    }
    for (name, input, path) in refused {
        let error = conformance::case(name.as_bytes(), input.as_bytes()).expect_err(input);
        assert_eq!(error.status(), Status::Codec, "{input}: {error}");
        assert!(
            error.message().starts_with(&format!("{path}:")),
            "{input}: {error}"
        );
    }
}

#[test]
fn a_document_past_the_json_size_or_nesting_cap_is_a_limit_and_malformed_json_a_codec_error() {
    let deep = format!("{{\"cases\":{}{}}}", "[".repeat(100), "]".repeat(100));
    let large = format!(
        "{{\"cases\":[{{\"request\":\"{}\"}}]}}",
        "00".repeat(600_000)
    );
    for (input, status) in [
        (deep.as_str(), Status::Limit),
        (large.as_str(), Status::Limit),
        (r#"{"cases":[}"#, Status::Codec),
        ("", Status::Codec),
    ] {
        let refused =
            conformance::case(b"http1Parser", input.as_bytes()).map_err(|error| error.status());
        assert_eq!(refused, Err(status), "{} octets", input.len());
    }
}

#[test]
fn the_result_is_canonical_json_with_inputs_echoed_and_outcomes_computed_again() {
    let input = br#"{ "cases" : [ { "value": "2f6e657874", "field": "Location", "name": "plain", "accepted": false } ] }"#;
    assert_eq!(
        conformance::case(b"responseSplitting", input).as_deref(),
        Ok(
            r#"{"cases":[{"accepted":true,"field":"Location","name":"plain","value":"2f6e657874"}]}"#
        )
    );
}

#[test]
fn the_result_holds_the_members_the_input_holds_and_no_others() {
    let cases: [(&[u8], &[u8], &str); 3] = [
        (
            b"h3Frames",
            br#"{"goaway":{"gracefulServer":"0"}}"#,
            r#"{"goaway":{"gracefulServer":"4611686018427387900"}}"#,
        ),
        (
            b"qpack",
            br#"{"staticTable":{"section":"RFC 9204 Appendix A"}}"#,
            r#"{"staticTable":{"section":"RFC 9204 Appendix A"}}"#,
        ),
        (
            b"h3Frames",
            br#"{"varints":{"cases":[{"encoded":"25"}]}}"#,
            r#"{"varints":{"cases":[{"encoded":"25","shortest":true,"value":"37"}]}}"#,
        ),
    ];
    for (name, input, result) in cases {
        assert_eq!(
            conformance::case(name, input).as_deref(),
            Ok(result),
            "{}",
            String::from_utf8_lossy(input)
        );
    }
}

#[test]
fn a_request_ending_inside_its_head_is_reported_partial() {
    assert_eq!(
        conformance::case(b"http1Parser", br#"{"cases":[{"request":"474554"}]}"#).as_deref(),
        Ok(r#"{"cases":[{"expect":"partial","request":"474554"}]}"#)
    );
}

#[test]
fn field_section_representations_are_computed_whatever_the_case_gives_for_them() {
    let lines = r#""expect":{"lines":[{"name":":method","neverIndexed":false,"value":"GET"}]}"#;
    let listed = format!(
        r#"{{"fieldSections":{{"cases":[{{"encoded":"0000d1",{lines},"representations":[{{"indexed":{{"index":"17","static":true}}}}]}}]}}}}"#
    );
    for given in ["[]", "null", r#""listed""#] {
        let input = format!(
            r#"{{"fieldSections":{{"cases":[{{"encoded":"0000d1","representations":{given}}}]}}}}"#
        );
        assert_eq!(
            conformance::case(b"qpack", input.as_bytes()).as_deref(),
            Ok(listed.as_str()),
            "{given}"
        );
    }
    let truncated =
        br#"{"fieldSections":{"cases":[{"encoded":"0000510b2f69","representations":[]}]}}"#;
    let result = conformance::case(b"qpack", truncated).expect("a truncated section runs");
    assert!(
        result.ends_with(r#""representations":null}]}}"#),
        "a section that ends inside a representation has none: {result}"
    );
}

#[test]
fn obs_text_octets_come_back_as_the_octets_the_parsers_return_rfc_9110_section_5_5() {
    let request = |last: u8| {
        let mut bytes = b"GET / HTTP/1.1\r\nHost: a\r\nX-Name: caf".to_vec();
        bytes.push(last);
        bytes.extend_from_slice(b"\r\n\r\n");
        format!(r#"{{"cases":[{{"request":"{}"}}]}}"#, hex(&bytes))
    };
    let latin = conformance::case(b"http1Parser", request(0xe9).as_bytes()).expect("a head");
    let other = conformance::case(b"http1Parser", request(0xea).as_bytes()).expect("a head");
    assert!(
        latin.contains(r#"["X-Name",{"hex":"636166e9"}]"#),
        "a field value that is not UTF-8 is written as its octets: {latin}"
    );
    assert_ne!(
        latin, other,
        "values that differ in one octet differ in the result"
    );
    let section = |octet: &str| {
        format!(r#"{{"fieldSections":{{"cases":[{{"encoded":"00005101{octet}"}}]}}}}"#)
    };
    let decoded = conformance::case(b"qpack", section("e9").as_bytes()).expect("a section");
    assert!(
        decoded.contains(r#""value":{"hex":"e9"}"#),
        "a decoded value that is not UTF-8 is written as its octets: {decoded}"
    );
    assert_ne!(
        decoded,
        conformance::case(b"qpack", section("ea").as_bytes()).expect("a section")
    );
    let utf8 = conformance::case(b"http1Parser", request(b'e').as_bytes()).expect("a head");
    assert!(
        utf8.contains(r#"["X-Name","cafe"]"#),
        "UTF-8 stays text: {utf8}"
    );
}

#[test]
fn router_cases_are_answered_as_the_server_answers_options_asterisk_and_the_absolute_form() {
    let table = member(&section("router"), "table").clone();
    let cases = [
        ("OPTIONS", "*", r#"{"status":200}"#),
        ("GET", "*", r#"{"status":400}"#),
        (
            "GET",
            "http://www.example.org/users",
            r#"{"matched":{"head":false,"id":2,"params":[],"path":"/users","query":null}}"#,
        ),
        (
            "GET",
            "http://www.example.org/users/42?x=1",
            r#"{"matched":{"head":false,"id":5,"params":[["id","42"]],"path":"/users/42","query":"x=1"}}"#,
        ),
        (
            "OPTIONS",
            "/users",
            r#"{"allow":"GET, HEAD, POST, OPTIONS","status":200}"#,
        ),
        ("PROPFIND", "/users", r#"{"status":501}"#),
    ];
    for (method, target, expect) in cases {
        let case = Value::Object(vec![
            ("method".to_owned(), Value::Str(method.to_owned())),
            ("target".to_owned(), Value::Str(target.to_owned())),
        ]);
        let document = Value::Object(vec![
            ("cases".to_owned(), Value::Array(vec![case])),
            ("table".to_owned(), table.clone()),
        ]);
        let result = conformance::case(b"router", json(&document).as_bytes())
            .unwrap_or_else(|error| panic!("{method} {target}: {error}"));
        let parsed = zero_json::parse(result.as_bytes()).expect("the result is JSON");
        let first = member(&parsed, "cases")
            .as_array()
            .and_then(<[Value]>::first)
            .expect("the case comes back");
        let answered = member(first, "expect");
        let wanted = zero_json::parse(expect.as_bytes()).expect("the expected outcome is JSON");
        assert!(
            same(answered, &wanted),
            "{method} {target}: the server answers {expect}, the entry {}",
            json(answered)
        );
    }
}

#[cfg(feature = "realtime")]
#[test]
fn client_frames_run_only_after_an_accepted_handshake_and_a_refused_one_answers_with_its_status() {
    let request = |version: &str| {
        hex(format!(
            "GET /chat {version}\r\nHost: server.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .as_bytes())
    };
    let hello = "818537fa213d7f9f4d5158";
    let document = |request: &str| {
        format!(
            r#"{{"cases":[{{"kind":"frames","request":"{request}","routeProtocols":[],"routeOrigins":null,"clientFrames":"{hello}"}}]}}"#
        )
    };
    let expect = |result: &str| {
        let Ok(Value::Object(members)) = zero_json::parse(result.as_bytes()) else {
            panic!("the result is a JSON object: {result}");
        };
        let cases = members
            .into_iter()
            .find(|(key, _)| key == "cases")
            .map(|(_, cases)| cases);
        match cases {
            Some(Value::Array(mut cases)) if cases.len() == 1 => cases
                .remove(0)
                .get("expect")
                .cloned()
                .expect("the case carries its outcome"),
            other => panic!("one case comes back: {other:?}"),
        }
    };
    let accepted = conformance::case(b"ws", document(&request("HTTP/1.1")).as_bytes())
        .expect("an accepted handshake");
    let session = zero_json::parse(
        br#"{"events":[{"code":null,"data":"48656c6c6f","type":"text"}],"failed":null,"finished":false,"serverFrames":""}"#,
    )
    .expect("the expected session");
    assert!(same(&expect(&accepted), &session), "{accepted}");
    let refused = conformance::case(b"ws", document(&request("HTTP/1.0")).as_bytes())
        .expect("a refused handshake");
    let refusal = zero_json::parse(br#"{"fields":[],"status":400}"#).expect("the refusal");
    assert!(same(&expect(&refused), &refusal), "{refused}");
}

/// The number of rounds a property test runs: the full count natively, a hundredth
/// under Miri, which interprets every instruction.
fn rounds(native: usize) -> usize {
    if cfg!(miri) {
        native.div_euclid(100).max(10)
    } else {
        native
    }
}

/// An xorshift64* generator; the same seed always yields the same inputs, so a
/// failing round can be rerun.
struct Rng(u64);

impl Rng {
    /// Seeds the generator; zero is replaced so the state never sticks.
    fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }

    /// The next 64 random bits.
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x.wrapping_shr(12);
        x ^= x.wrapping_shl(25);
        x ^= x.wrapping_shr(27);
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value below `bound`, or zero when `bound` is zero.
    fn below(&mut self, bound: usize) -> usize {
        let bound = u64::try_from(bound).unwrap_or(u64::MAX);
        usize::try_from(self.next_u64().checked_rem(bound).unwrap_or(0)).unwrap_or(0)
    }

    /// A random octet.
    fn byte(&mut self) -> u8 {
        u8::try_from(self.next_u64().wrapping_shr(56)).unwrap_or(0)
    }

    /// Random octets, at most `most` of them.
    fn bytes(&mut self, most: usize) -> Vec<u8> {
        let len = self.below(most + 1);
        (0..len).map(|_| self.byte()).collect()
    }

    /// One item of a list.
    fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[self.below(list.len())]
    }
}

/// The member names of the vectors file, so a change stays near the shape.
const KEYS: [&str; 85] = [
    "hex",
    "cases",
    "name",
    "section",
    "request",
    "expect",
    "field",
    "value",
    "accepted",
    "table",
    "routes",
    "mounts",
    "trailingSlash",
    "method",
    "pattern",
    "id",
    "target",
    "prefix",
    "kind",
    "routeProtocols",
    "routeOrigins",
    "clientFrames",
    "call",
    "event",
    "data",
    "comment",
    "retry",
    "encoded",
    "prefixBits",
    "cap",
    "error",
    "text",
    "representations",
    "lines",
    "huffman",
    "neverIndexed",
    "instructions",
    "headOnly",
    "atCapacityZero",
    "atStaticEncoder",
    "encodedInsertCount",
    "maxEntries",
    "totalInserts",
    "requiredInsertCount",
    "sign",
    "deltaBase",
    "entries",
    "shortest",
    "refused",
    "first",
    "last",
    "notReserved",
    "stream",
    "role",
    "limits",
    "fieldSection",
    "settings",
    "tunnelAfterHeaders",
    "fin",
    "events",
    "outcome",
    "payload",
    "withReserved",
    "n",
    "type",
    "opened",
    "closed",
    "registered",
    "onReceipt",
    "treatedAs",
    "received",
    "gracefulServer",
    "gracefulClient",
    "maxDatagram",
    "staticTable",
    "integers",
    "integerErrors",
    "huffmanErrors",
    "fieldSections",
    "encodings",
    "encoderStream",
    "decoderStream",
    "base",
    "varints",
    "uniStreams",
];

/// The enumerated words of the vectors file.
const WORDS: [&str; 24] = [
    "handshake",
    "frames",
    "close",
    "control",
    "request",
    "push",
    "client",
    "server",
    "never",
    "shorter",
    "always",
    "ignore",
    "strict",
    "GET",
    "HEAD",
    "PATCH",
    "OPTIONS",
    "/",
    "/users",
    "/users/:id",
    "/static/*path",
    "/*",
    "chat",
    "Location",
];

/// Integers the vectors and their limits turn on.
const NUMBERS: [i64; 18] = [
    0,
    1,
    2,
    5,
    7,
    8,
    9,
    101,
    125,
    255,
    256,
    404,
    65_535,
    4_294_967_295,
    4_294_967_296,
    i64::MAX,
    -1,
    i64::MIN,
];

/// Decimal strings the vectors and their limits turn on.
const DECIMALS: [&str; 14] = [
    "0",
    "1",
    "2",
    "3",
    "63",
    "64",
    "1073741824",
    "2147483648",
    "1152921504606846975",
    "4611686018427387900",
    "4611686018427387903",
    "4611686018427387904",
    "18446744073709551615",
    "18446744073709551616",
];

/// Characters text in the vectors holds or must refuse.
const CHARACTERS: [char; 20] = [
    'a',
    'Z',
    '0',
    ' ',
    '\t',
    '\r',
    '\n',
    '\0',
    ':',
    '/',
    '%',
    '?',
    '*',
    ',',
    '"',
    '\\',
    '\u{e9}',
    '\u{3ba}',
    '\u{1f600}',
    '\u{fffd}',
];

/// Random text.
fn text(rng: &mut Rng) -> String {
    let len = rng.below(24);
    (0..len)
        .map(|_| CHARACTERS[rng.below(CHARACTERS.len())])
        .collect()
}

/// A random decimal string.
fn decimal(rng: &mut Rng) -> String {
    if rng.below(3) == 0 {
        rng.next_u64().to_string()
    } else {
        rng.pick(&DECIMALS).to_owned()
    }
}

/// A member name: one of the vectors file's, now and then another.
fn key(rng: &mut Rng) -> String {
    if rng.below(8) == 0 {
        text(rng)
    } else {
        rng.pick(&KEYS).to_owned()
    }
}

/// A random value of a kind the vectors hold.
fn arbitrary(rng: &mut Rng, depth: usize) -> Value {
    match rng.below(if depth > 2 { 7 } else { 9 }) {
        0 => Value::Null,
        1 => Value::Bool(rng.below(2) == 0),
        2 => Value::Int(if rng.below(3) == 0 {
            i64::from_ne_bytes(rng.next_u64().to_ne_bytes())
        } else {
            NUMBERS[rng.below(NUMBERS.len())]
        }),
        3 => Value::Str(hex(&rng.bytes(48))),
        4 => Value::Str(decimal(rng)),
        5 => Value::Str(text(rng)),
        6 => Value::Str(rng.pick(&WORDS).to_owned()),
        7 => Value::Array(
            (0..rng.below(4))
                .map(|_| arbitrary(rng, depth + 1))
                .collect(),
        ),
        _ => Value::Object(
            (0..rng.below(4))
                .map(|_| (key(rng), arbitrary(rng, depth + 1)))
                .collect(),
        ),
    }
}

/// Other text for a string: the octets of hexadecimal text flipped, set, cut, added
/// to or removed from; otherwise other octets, a decimal, a word or random text.
fn mutate_text(content: &str, rng: &mut Rng) -> String {
    if let Some(mut bytes) = unhex(content).filter(|_| rng.below(5) != 0) {
        match rng.below(6) {
            0 if !bytes.is_empty() => {
                let at = rng.below(bytes.len());
                bytes[at] ^= 1u8 << rng.below(8);
            }
            1 if !bytes.is_empty() => {
                let at = rng.below(bytes.len());
                bytes[at] = rng.byte();
            }
            2 => {
                let at = rng.below(bytes.len() + 1);
                let added = rng.bytes(16);
                bytes.splice(at..at, added);
            }
            3 if !bytes.is_empty() => {
                let start = rng.below(bytes.len());
                let end = (start + 1 + rng.below(8)).min(bytes.len());
                bytes.drain(start..end);
            }
            4 => bytes.truncate(rng.below(bytes.len() + 1)),
            _ => bytes.extend(rng.bytes(32)),
        }
        return hex(&bytes);
    }
    match rng.below(5) {
        0 => hex(&rng.bytes(64)),
        1 => decimal(rng),
        2 => rng.pick(&WORDS).to_owned(),
        3 => String::new(),
        _ => text(rng),
    }
}

/// Changes one place of a document.
fn mutate(value: &mut Value, rng: &mut Rng) {
    let replace = match value {
        Value::Object(members) => {
            if !members.is_empty() && rng.below(6) != 0 {
                let at = rng.below(members.len());
                if let Some((_, member)) = members.get_mut(at) {
                    mutate(member, rng);
                }
                false
            } else {
                match rng.below(3) {
                    0 if !members.is_empty() => {
                        let at = rng.below(members.len());
                        members.remove(at);
                        false
                    }
                    1 => {
                        members.push((key(rng), arbitrary(rng, 0)));
                        false
                    }
                    _ => true,
                }
            }
        }
        Value::Array(items) => {
            if items.is_empty() || rng.below(5) == 0 {
                items.push(arbitrary(rng, 0));
            } else {
                let at = rng.below(items.len());
                match rng.below(4) {
                    0 => {
                        let copy = items[at].clone();
                        items.insert(at, copy);
                    }
                    1 => {
                        items.remove(at);
                    }
                    _ => mutate(&mut items[at], rng),
                }
            }
            false
        }
        Value::Str(content) => {
            *content = mutate_text(content, rng);
            false
        }
        Value::Bool(flag) => {
            *flag = !*flag;
            rng.below(4) == 0
        }
        _ => true,
    };
    if replace {
        *value = arbitrary(rng, 0);
    }
}

/// Runs one input through the entry: it does not panic; a result is a JSON object
/// holding the members the input holds, and the entry returns it unchanged; a
/// refusal has one of the statuses the entry documents. Returns whether the entry
/// returned a result.
fn assert_well_formed(name: &str, input: &[u8], seed: u64, round: usize) -> bool {
    let outcome = panic::catch_unwind(|| conformance::case(name.as_bytes(), input));
    let Ok(result) = outcome else {
        panic!(
            "{name}: the entry panicked on round {round} of seed {seed:#x}: {}",
            String::from_utf8_lossy(input)
        );
    };
    match result {
        Ok(text) => {
            assert!(compiled(name), "{name} runs in this build");
            let Ok(Value::Object(members)) = zero_json::parse(text.as_bytes()) else {
                panic!("{name}: round {round} of seed {seed:#x}: not a JSON object: {text}");
            };
            if let Ok(Value::Object(given)) = zero_json::parse(input) {
                let mut held: Vec<&str> = members.iter().map(|(key, _)| key.as_str()).collect();
                let mut asked: Vec<&str> = given.iter().map(|(key, _)| key.as_str()).collect();
                held.sort_unstable();
                asked.sort_unstable();
                assert_eq!(held, asked, "{name}: round {round} of seed {seed:#x}");
            }
            assert_eq!(
                conformance::case(name.as_bytes(), text.as_bytes()).as_deref(),
                Ok(text.as_str()),
                "{name}: round {round} of seed {seed:#x}: a result comes back unchanged"
            );
            true
        }
        Err(error) => {
            let documented = if compiled(name) {
                matches!(error.status(), Status::Codec | Status::Limit)
            } else {
                error.status() == Status::Unsupported
            };
            assert!(
                documented,
                "{name}: round {round} of seed {seed:#x}: {error}"
            );
            assert!(!error.message().is_empty(), "{name}: a refusal says why");
            false
        }
    }
}

/// Feeds a section arbitrary octets, then its own cases changed at random places,
/// enough of which keep the section's shape to reach the parsers.
fn fuzz(name: &str, seed: u64) {
    let mut rng = Rng::new(seed);
    let body = section(name);
    let units = units(name, &body);
    for round in 0..rounds(400) {
        let input = rng.bytes(200);
        assert_well_formed(name, &input, seed, round);
    }
    let changed = rounds(3_000);
    let mut reached = 0usize;
    for round in 0..changed {
        let (_, unit) = &units[rng.below(units.len())];
        let mut document = unit.clone();
        for _ in 0..=rng.below(3) {
            mutate(&mut document, &mut rng);
        }
        let mut input = json(&document).into_bytes();
        if rng.below(20) == 0 {
            let at = rng.below(input.len() + 1);
            input.insert(at, rng.byte());
        }
        if assert_well_formed(name, &input, seed, round) {
            reached += 1;
        }
    }
    if compiled(name) {
        assert!(
            reached * 10 >= changed,
            "{name}: only {reached} of {changed} changed cases reached the parsers"
        );
    } else {
        assert_eq!(reached, 0, "{name} is refused in this build");
    }
}

#[test]
fn arbitrary_http1_parser_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("http1Parser", 0x6874_7470_312e_3131);
}

#[test]
fn arbitrary_response_splitting_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("responseSplitting", 0x0d0a_5365_742d_436f);
}

#[test]
fn arbitrary_router_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("router", 0x2f75_7365_7273_2f3a);
}

#[test]
fn arbitrary_ws_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("ws", 0x37fa_213d_7f9f_4d51);
}

#[test]
fn arbitrary_sse_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("sse", 0x6461_7461_3a20_0a0a);
}

#[test]
fn arbitrary_qpack_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("qpack", 0x0000_510b_2f69_6e64);
}

#[test]
fn arbitrary_h3_frames_input_never_panics_and_ends_in_a_well_formed_result() {
    fuzz("h3Frames", 0xc219_7c5e_ff14_e88c);
}
