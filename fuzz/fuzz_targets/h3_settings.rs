//! The HTTP/3 SETTINGS payload on arbitrary bytes: parsing never panics, and
//! an accepted payload re-encodes, with and without a reserved setting, to a
//! frame whose payload parses to the same settings.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_h3::{FrameHeader, FrameType, Reserved, Settings};

/// Encodes `settings` and parses the payload of the frame back.
fn round_trip(settings: Settings, reserved: Option<Reserved>) {
    let mut frame = Vec::new();
    settings.encode(reserved, &mut frame).unwrap();
    let header = FrameHeader::parse(&frame).unwrap();
    assert_eq!(header.frame_type, FrameType::SETTINGS);
    assert_eq!(
        u64::try_from(frame.len() - header.header_len).unwrap(),
        header.len
    );
    assert_eq!(Settings::parse(&frame[header.header_len..]), Ok(settings));
}

fuzz_target!(|data: &[u8]| {
    let Ok(settings) = Settings::parse(data) else {
        return;
    };
    round_trip(settings, None);
    let n = u64::try_from(data.len()).unwrap();
    round_trip(settings, Some(Reserved { n, value: n }));
});
