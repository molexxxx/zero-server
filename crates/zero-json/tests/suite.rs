//! The JSON parsing test suite (nst/JSONTestSuite, `test_parsing`): every `y_`
//! text parses, every `n_` text is refused, and every `i_` text is one or the
//! other without a panic. The corpus sits in `suite/parsing.json`, embedded at
//! compile time so the test makes no file-system call, and read with the parser
//! under test; the two inputs over two kibibytes are built here.

use zero_core::Value;
use zero_json::{parse, ErrorKind};

fn unhex(text: &str) -> Option<Vec<u8>> {
    text.as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

fn text<'a>(case: &'a Value, member: &str) -> Option<&'a str> {
    case.get(member).and_then(Value::as_str)
}

#[test]
fn every_case_of_the_parsing_suite_is_accepted_or_refused_as_its_name_says() {
    let corpus: &[u8] = include_bytes!("suite/parsing.json");
    assert!(!corpus.is_empty(), "the corpus is embedded");
    let document = parse(corpus).ok();
    let cases = document
        .as_ref()
        .and_then(|document| document.get("cases"))
        .and_then(Value::as_array)
        .unwrap_or(&[]);
    assert!(cases.len() > 300, "{} cases", cases.len());
    let mut accepted = 0;
    let mut refused = 0;
    for case in cases {
        let name = text(case, "name").unwrap_or("?");
        let expect = text(case, "expect").unwrap_or("?");
        let input = text(case, "hex").and_then(unhex);
        assert!(input.is_some(), "{name}: the case holds hex");
        let outcome = parse(input.as_deref().unwrap_or(&[]));
        match expect {
            "y" => assert!(outcome.is_ok(), "{name} must parse: {outcome:?}"),
            "n" => assert!(outcome.is_err(), "{name} must be refused: {outcome:?}"),
            _ => {}
        }
        if outcome.is_ok() {
            accepted += 1;
        } else {
            refused += 1;
        }
    }
    assert!(
        accepted >= 95 && refused >= 188,
        "{accepted} accepted, {refused} refused"
    );
}

#[test]
fn the_two_large_nesting_cases_are_refused_without_exhausting_the_stack() {
    let arrays = "[".repeat(100_000);
    assert_eq!(
        parse(arrays.as_bytes()).map_err(|error| error.kind),
        Err(ErrorKind::TooDeep)
    );
    let open = "[{\"\":".repeat(50_000);
    assert_eq!(
        parse(open.as_bytes()).map_err(|error| error.kind),
        Err(ErrorKind::TooDeep)
    );
}
