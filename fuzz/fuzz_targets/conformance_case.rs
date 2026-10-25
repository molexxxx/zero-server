//! The conformance entry on arbitrary bytes: the first byte picks a section, the
//! rest is the document. The entry never panics, a refusal carries one of the
//! statuses it documents, and a result is a JSON object that comes back unchanged
//! when it is fed back, unless it is past the JSON size cap, where it is a limit.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_host::conformance::{self, SECTIONS};
use zero_host::Status;
use zero_json::parse::DEFAULT_SIZE;

fuzz_target!(|data: &[u8]| {
    let Some((&pick, document)) = data.split_first() else {
        return;
    };
    let name = SECTIONS[usize::from(pick) % SECTIONS.len()];
    match conformance::case(name.as_bytes(), document) {
        Ok(result) => {
            assert!(result.starts_with('{'), "{name}: a result is an object");
            let again = conformance::case(name.as_bytes(), result.as_bytes());
            if result.len() > DEFAULT_SIZE {
                assert_eq!(
                    again.map_err(|error| error.status()).map(|_| ()),
                    Err(Status::Limit),
                    "{name}: a result past the size cap"
                );
            } else {
                assert_eq!(
                    again.as_deref(),
                    Ok(result.as_str()),
                    "{name}: a result comes back unchanged"
                );
            }
        }
        Err(error) => assert!(
            matches!(error.status(), Status::Codec | Status::Limit),
            "{name}: {error}"
        ),
    }
});
