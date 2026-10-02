//! The SETTINGS frame payload: parsing a peer's settings and writing the
//! server's.
//!
//! A payload is zero or more identifier and value pairs, both
//! variable-length integers (RFC 9114 Section 7.2.4). On receipt:
//!
//! - an identifier this codec does not understand is ignored, the reserved
//!   0x1f * N + 0x21 identifiers and 0x00 among them (Sections 7.2.4 and
//!   7.2.4.1);
//! - 0x02 to 0x05, defined by HTTP/2 with no HTTP/3 counterpart, are
//!   H3_SETTINGS_ERROR (Section 7.2.4.1 and Appendix A.3);
//! - an identifier that occurs twice is H3_SETTINGS_ERROR, the MAY of Section
//!   7.2.4 taken;
//! - SETTINGS_H3_DATAGRAM and SETTINGS_ENABLE_CONNECT_PROTOCOL other than 0
//!   or 1 are H3_SETTINGS_ERROR (RFC 9297 Section 2.1.1; RFC 8441 Section 3
//!   through RFC 9220 Section 3);
//! - a payload that ends inside a pair is H3_FRAME_ERROR (Section 7.1).
//!
//! An omitted setting takes its default: zero for the two QPACK settings
//! (RFC 9204 Section 5), unlimited for the field section size (RFC 9114
//! Section 7.2.4.1), and off for Extended CONNECT and HTTP/3 datagrams.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4.1>

use alloc::vec::Vec;

use crate::error::Error;
use crate::frame::{FrameHeader, FrameType};
use crate::{reserved, varint};

/// SETTINGS_QPACK_MAX_TABLE_CAPACITY, the QPACK dynamic table capacity
/// (RFC 9204 Section 5).
pub const SETTINGS_QPACK_MAX_TABLE_CAPACITY: u64 = 0x01;
/// SETTINGS_MAX_FIELD_SECTION_SIZE, the largest field section a peer accepts
/// (RFC 9114 Section 7.2.4.1).
pub const SETTINGS_MAX_FIELD_SECTION_SIZE: u64 = 0x06;
/// SETTINGS_QPACK_BLOCKED_STREAMS, the streams a QPACK encoder may block
/// (RFC 9204 Section 5).
pub const SETTINGS_QPACK_BLOCKED_STREAMS: u64 = 0x07;
/// SETTINGS_ENABLE_CONNECT_PROTOCOL, Extended CONNECT (RFC 9220 Section 3).
pub const SETTINGS_ENABLE_CONNECT_PROTOCOL: u64 = 0x08;
/// SETTINGS_H3_DATAGRAM, HTTP/3 datagrams (RFC 9297 Section 2.1.1).
pub const SETTINGS_H3_DATAGRAM: u64 = 0x33;

/// The identifiers HTTP/2 defined with no HTTP/3 counterpart, whose receipt
/// RFC 9114 Section 7.2.4.1 makes H3_SETTINGS_ERROR: 0x02 to 0x05, the four
/// Appendix A.3 calls an error. 0x00 is not among them, because HTTP/2 never
/// defined it (see [`Settings::parse`]).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#appendix-A.3>
pub const RESERVED_HTTP2: [u64; 4] = [0x02, 0x03, 0x04, 0x05];

/// A reserved setting to send: identifier 0x1f * N + 0x21 and any value.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reserved {
    /// The index of the identifier, at most [`reserved::MAX_N`]; a caller
    /// draws it at random so peers cannot come to rely on one value.
    pub n: u64,
    /// The value, chosen freely.
    pub value: u64,
}

/// The settings a SETTINGS frame carried; `None` means absent, so the
/// default applies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Settings {
    /// SETTINGS_QPACK_MAX_TABLE_CAPACITY (0x01).
    pub qpack_max_table_capacity: Option<u64>,
    /// SETTINGS_MAX_FIELD_SECTION_SIZE (0x06).
    pub max_field_section_size: Option<u64>,
    /// SETTINGS_QPACK_BLOCKED_STREAMS (0x07).
    pub qpack_blocked_streams: Option<u64>,
    /// SETTINGS_ENABLE_CONNECT_PROTOCOL (0x08).
    pub enable_connect_protocol: Option<bool>,
    /// SETTINGS_H3_DATAGRAM (0x33).
    pub h3_datagram: Option<bool>,
}

/// The PayloadTruncated error of a SETTINGS frame.
const TRUNCATED: Error = Error::PayloadTruncated {
    frame_type: FrameType::SETTINGS.0,
};

impl Settings {
    /// No settings: every value at its default.
    pub const EMPTY: Self = Self {
        qpack_max_table_capacity: None,
        max_field_section_size: None,
        qpack_blocked_streams: None,
        enable_connect_protocol: None,
        h3_datagram: None,
    };

    /// The settings a server sends: the QPACK dynamic table capacity, the
    /// field section size and the QPACK blocked streams from `limits`, all
    /// three sent explicitly so the values are pinned on the wire, and
    /// neither Extended CONNECT nor HTTP/3 datagrams.
    ///
    /// # Arguments
    ///
    /// * `limits` - the configured HTTP/3 limits; with the defaults the
    ///   values are 0, 32,768 and 0.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.2.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-5>
    #[must_use]
    pub const fn server(limits: &zero_limits::Http3Limits) -> Self {
        Self {
            qpack_max_table_capacity: Some(limits.qpack_max_table_capacity),
            max_field_section_size: Some(limits.max_field_section_size),
            qpack_blocked_streams: Some(limits.qpack_blocked_streams),
            enable_connect_protocol: None,
            h3_datagram: None,
        }
    }

    /// Parses a SETTINGS payload.
    ///
    /// Identifier 0x00 is ignored. RFC 9114 Section 7.2.4 says "An
    /// implementation MUST ignore any parameter with an identifier it does
    /// not understand.", and Section 7.2.4.1 limits the error to "Setting
    /// identifiers that were defined in [HTTP/2] where there is no
    /// corresponding HTTP/3 setting". HTTP/2 defined 0x01 to 0x06 (RFC 9113
    /// Section 6.5.2) and never 0x00, and Appendix A.3 calls exactly 0x02,
    /// 0x03, 0x04 and 0x05 an error; Table 3 lists 0x00 as Reserved, matching
    /// the HTTP/2 registry's own reservation. Erratum 8999, which reads 0x00
    /// as an error, is reported and not verified. If it is verified, 0x00
    /// joins [`RESERVED_HTTP2`].
    ///
    /// # Arguments
    ///
    /// * `payload` - the frame payload, without the frame header.
    ///
    /// # Errors
    ///
    /// [`Error::ReservedSetting`] for 0x02 to 0x05, [`Error::DuplicateSetting`]
    /// for an identifier that occurs twice, [`Error::SettingValue`] for 0x08
    /// or 0x33 other than 0 or 1, and [`Error::PayloadTruncated`] when the
    /// payload ends inside a pair.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-2.1.1>
    pub fn parse(payload: &[u8]) -> Result<Self, Error> {
        let mut settings = Self::EMPTY;
        let mut seen: Vec<u64> = Vec::new();
        let mut rest = payload;
        while !rest.is_empty() {
            let (id, id_len) = varint::decode(rest).ok_or(TRUNCATED)?;
            rest = rest.get(id_len..).unwrap_or(&[]);
            let (value, value_len) = varint::decode(rest).ok_or(TRUNCATED)?;
            rest = rest.get(value_len..).unwrap_or(&[]);
            if RESERVED_HTTP2.contains(&id) {
                return Err(Error::ReservedSetting { id });
            }
            seen.push(id);
            match id {
                SETTINGS_QPACK_MAX_TABLE_CAPACITY => {
                    settings.qpack_max_table_capacity = Some(value)
                }
                SETTINGS_MAX_FIELD_SECTION_SIZE => settings.max_field_section_size = Some(value),
                SETTINGS_QPACK_BLOCKED_STREAMS => settings.qpack_blocked_streams = Some(value),
                SETTINGS_ENABLE_CONNECT_PROTOCOL => {
                    settings.enable_connect_protocol = Some(flag(id, value)?);
                }
                SETTINGS_H3_DATAGRAM => settings.h3_datagram = Some(flag(id, value)?),
                _ => {}
            }
        }
        seen.sort_unstable();
        if let Some(id) = seen.windows(2).find_map(|pair| match pair {
            [first, second] if first == second => Some(*first),
            _ => None,
        }) {
            return Err(Error::DuplicateSetting { id });
        }
        Ok(settings)
    }

    /// Appends a whole SETTINGS frame: the present settings in ascending
    /// identifier order, then the reserved setting when one is given, every
    /// integer in the shortest encoding.
    ///
    /// # Arguments
    ///
    /// * `reserved` - the reserved setting to include; "Endpoints SHOULD
    ///   include at least one such setting in their SETTINGS frame." (RFC
    ///   9114 Section 7.2.4.1).
    /// * `out` - the buffer the frame is appended to.
    ///
    /// # Returns
    ///
    /// `None` when a value exceeds 2^62-1 or `reserved.n` exceeds
    /// [`reserved::MAX_N`], in which case `out` is unchanged.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4>
    pub fn encode(&self, reserved: Option<Reserved>, out: &mut Vec<u8>) -> Option<()> {
        let pairs = [
            (
                SETTINGS_QPACK_MAX_TABLE_CAPACITY,
                self.qpack_max_table_capacity,
            ),
            (SETTINGS_MAX_FIELD_SECTION_SIZE, self.max_field_section_size),
            (SETTINGS_QPACK_BLOCKED_STREAMS, self.qpack_blocked_streams),
            (
                SETTINGS_ENABLE_CONNECT_PROTOCOL,
                self.enable_connect_protocol.map(u64::from),
            ),
            (SETTINGS_H3_DATAGRAM, self.h3_datagram.map(u64::from)),
        ];
        let mut payload = Vec::with_capacity(96);
        for (id, value) in pairs {
            if let Some(value) = value {
                varint::push(id, &mut payload)?;
                varint::push(value, &mut payload)?;
            }
        }
        if let Some(Reserved { n, value }) = reserved {
            varint::push(reserved::reserved(n)?, &mut payload)?;
            varint::push(value, &mut payload)?;
        }
        let len = u64::try_from(payload.len()).ok()?;
        FrameHeader::encode(FrameType::SETTINGS, len, out)?;
        out.extend_from_slice(&payload);
        Some(())
    }

    /// Appends the start of a control stream: stream type 0x00, then the
    /// SETTINGS frame [`Self::encode`] writes, which must be the first frame
    /// on the stream (RFC 9114 Section 6.2.1).
    ///
    /// # Arguments
    ///
    /// * `reserved` - the reserved setting to include, as for [`Self::encode`].
    /// * `out` - the buffer the preface is appended to.
    ///
    /// # Returns
    ///
    /// As for [`Self::encode`]; `out` is unchanged on `None`.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2.1>
    pub fn encode_control_preface(
        &self,
        reserved: Option<Reserved>,
        out: &mut Vec<u8>,
    ) -> Option<()> {
        let start = out.len();
        varint::push(crate::stream::StreamType::Control.value(), out)?;
        if self.encode(reserved, out).is_none() {
            out.truncate(start);
            return None;
        }
        Some(())
    }

    /// The effective SETTINGS_QPACK_MAX_TABLE_CAPACITY: the received value,
    /// else the default, zero (RFC 9204 Section 5).
    #[must_use]
    pub const fn qpack_max_table_capacity_or_default(&self) -> u64 {
        match self.qpack_max_table_capacity {
            Some(value) => value,
            None => 0,
        }
    }

    /// The effective SETTINGS_MAX_FIELD_SECTION_SIZE: the received value,
    /// else `None`, the default "unlimited" (RFC 9114 Section 7.2.4.1).
    #[must_use]
    pub const fn max_field_section_size_or_default(&self) -> Option<u64> {
        self.max_field_section_size
    }

    /// The effective SETTINGS_QPACK_BLOCKED_STREAMS: the received value, else
    /// the default, zero (RFC 9204 Section 5).
    #[must_use]
    pub const fn qpack_blocked_streams_or_default(&self) -> u64 {
        match self.qpack_blocked_streams {
            Some(value) => value,
            None => 0,
        }
    }

    /// The effective SETTINGS_ENABLE_CONNECT_PROTOCOL: the received value,
    /// else `false`.
    #[must_use]
    pub const fn enable_connect_protocol_or_default(&self) -> bool {
        matches!(self.enable_connect_protocol, Some(true))
    }

    /// The effective SETTINGS_H3_DATAGRAM: the received value, else `false`.
    #[must_use]
    pub const fn h3_datagram_or_default(&self) -> bool {
        matches!(self.h3_datagram, Some(true))
    }
}

/// Reads a setting whose value MUST be 0 or 1.
const fn flag(id: u64, value: u64) -> Result<bool, Error> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(Error::SettingValue { id, value }),
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        Reserved, Settings, RESERVED_HTTP2, SETTINGS_ENABLE_CONNECT_PROTOCOL, SETTINGS_H3_DATAGRAM,
        SETTINGS_MAX_FIELD_SECTION_SIZE, SETTINGS_QPACK_BLOCKED_STREAMS,
        SETTINGS_QPACK_MAX_TABLE_CAPACITY,
    };
    use crate::error::{Error, ErrorCode};
    use crate::frame::FrameHeader;
    use crate::xorshift::{iterations, unhex, Rng};
    use crate::{reserved, varint};
    use zero_limits::Http3Limits;

    /// Encodes `settings` and returns the payload without the frame header.
    fn payload_of(settings: &Settings, reserved: Option<Reserved>) -> Vec<u8> {
        let mut frame = Vec::new();
        assert_eq!(settings.encode(reserved, &mut frame), Some(()));
        let header_len = FrameHeader::parse(&frame).map_or(0, |header| header.header_len);
        frame.get(header_len..).unwrap_or(&[]).to_vec()
    }

    /// The identifiers of a well-formed payload, in order.
    fn identifiers(payload: &[u8]) -> Vec<u64> {
        let mut ids = Vec::new();
        let mut rest = payload;
        while let Some((id, id_len)) = varint::decode(rest) {
            ids.push(id);
            let after_id = rest.get(id_len..).unwrap_or(&[]);
            let value_len = varint::decode(after_id).map_or(after_id.len(), |(_, len)| len);
            rest = after_id.get(value_len..).unwrap_or(&[]);
        }
        ids
    }

    /// RFC 9114 Section 7.2.4: "An implementation MUST ignore any parameter
    /// with an identifier it does not understand."
    #[test]
    fn settings_with_unknown_or_reserved_identifiers_are_ignored() {
        for payload in [
            "0000",
            "2100",
            "80004d4400",
            "00002100",
            "0000210080004d44000a05",
            "0a05",
        ] {
            assert_eq!(
                Settings::parse(&unhex(payload)),
                Ok(Settings::EMPTY),
                "{payload}"
            );
        }
        assert_eq!(
            Settings::parse(&unhex("21000600")),
            Ok(Settings {
                max_field_section_size: Some(0),
                ..Settings::EMPTY
            })
        );
        let mut rng = Rng::new(0x5EED_0006);
        for _ in 0..iterations(2_000) {
            let id = reserved::reserved(rng.below(reserved::MAX_N)).unwrap_or(0x21);
            let mut payload = Vec::new();
            assert_eq!(varint::push(id, &mut payload), Some(()));
            assert_eq!(varint::push(rng.varint(), &mut payload), Some(()));
            assert_eq!(Settings::parse(&payload), Ok(Settings::EMPTY), "{id}");
        }
    }

    /// RFC 9114 Section 7.2.4.1: "Setting identifiers that were defined in
    /// [HTTP/2] where there is no corresponding HTTP/3 setting have also been
    /// reserved (Section 11.2.2). These reserved settings MUST NOT be sent,
    /// and their receipt MUST be treated as a connection error of type
    /// H3_SETTINGS_ERROR."
    #[test]
    fn the_reserved_http_2_setting_identifiers_are_h3_settings_error() {
        assert_eq!(RESERVED_HTTP2, [0x02, 0x03, 0x04, 0x05]);
        for id in RESERVED_HTTP2 {
            for value in [0u64, 1, 16_384] {
                let mut payload = unhex("0100");
                assert_eq!(varint::push(id, &mut payload), Some(()));
                assert_eq!(varint::push(value, &mut payload), Some(()));
                let error = Settings::parse(&payload);
                assert_eq!(error, Err(Error::ReservedSetting { id }), "{id}");
                assert_eq!(
                    error.map_err(|error| error.code()),
                    Err(ErrorCode::H3_SETTINGS_ERROR)
                );
            }
        }
        assert_eq!(
            Settings::parse(&unhex("400200")),
            Err(Error::ReservedSetting { id: 2 })
        );
        let grease = Some(Reserved { n: 0, value: 0 });
        let ours = payload_of(&Settings::server(&Http3Limits::DEFAULT), grease);
        let sent = identifiers(&ours);
        assert_eq!(sent, [0x01, 0x06, 0x07, 0x21]);
        assert!(sent
            .iter()
            .all(|id| !RESERVED_HTTP2.contains(id) && *id != 0));
    }

    /// RFC 9114 Section 7.2.4: "The same setting identifier MUST NOT occur
    /// more than once in the SETTINGS frame. A receiver MAY treat the presence
    /// of duplicate setting identifiers as a connection error of type
    /// H3_SETTINGS_ERROR."
    #[test]
    fn a_duplicate_setting_identifier_is_h3_settings_error() {
        let cases: [(&str, u64); 6] = [
            ("06000600", 0x06),
            ("06000601", 0x06),
            ("0600400600", 0x06),
            ("0a000a01", 0x0A),
            ("21002100", 0x21),
            ("000007000001", 0x00),
        ];
        for (payload, id) in cases {
            let error = Settings::parse(&unhex(payload));
            assert_eq!(error, Err(Error::DuplicateSetting { id }), "{payload}");
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_SETTINGS_ERROR)
            );
        }
    }

    /// RFC 9114 Section 4.2.2: "If an implementation wishes to advise its peer
    /// of this limit, it can be conveyed as a number of bytes in the
    /// SETTINGS_MAX_FIELD_SECTION_SIZE parameter."
    /// RFC 9114 Section 6.2.1: "Each side MUST initiate a single control stream
    /// at the beginning of the connection and send its SETTINGS frame as the
    /// first frame on this stream."
    /// RFC 9114 Section 7.2.4.1: "SETTINGS_MAX_FIELD_SECTION_SIZE (0x06): The
    /// default value is unlimited. See Section 4.2.2 for usage."
    /// RFC 9204 Section 5: "SETTINGS_QPACK_MAX_TABLE_CAPACITY (0x01): The
    /// default value is zero." and "SETTINGS_QPACK_BLOCKED_STREAMS (0x07): The
    /// default value is zero."
    #[test]
    fn the_server_settings_frame_sends_max_field_section_size_32768_and_qpack_zeros() {
        let settings = Settings::server(&Http3Limits::DEFAULT);
        assert_eq!(
            settings,
            Settings {
                qpack_max_table_capacity: Some(0),
                max_field_section_size: Some(32_768),
                qpack_blocked_streams: Some(0),
                enable_connect_protocol: None,
                h3_datagram: None,
            }
        );
        let mut frame = Vec::new();
        assert_eq!(settings.encode(None, &mut frame), Some(()));
        assert_eq!(frame, unhex("0409010006800080000700"));
        let mut preface = Vec::new();
        assert_eq!(
            settings.encode_control_preface(None, &mut preface),
            Some(())
        );
        assert_eq!(preface, unhex("000409010006800080000700"));
        assert_eq!(Settings::parse(&unhex("010006800080000700")), Ok(settings));
        assert_eq!(settings.qpack_max_table_capacity_or_default(), 0);
        assert_eq!(settings.qpack_blocked_streams_or_default(), 0);
        assert_eq!(settings.max_field_section_size_or_default(), Some(32_768));
    }

    /// RFC 9204 Section 5: "SETTINGS_QPACK_MAX_TABLE_CAPACITY (0x01): The
    /// default value is zero." and "SETTINGS_QPACK_BLOCKED_STREAMS (0x07): The
    /// default value is zero."
    /// RFC 9114 Section 7.2.4.1: "SETTINGS_MAX_FIELD_SECTION_SIZE (0x06): The
    /// default value is unlimited."
    #[test]
    fn omitted_settings_take_their_defaults_qpack_zero_and_field_section_unlimited() {
        let empty = Settings::parse(&[]);
        assert_eq!(empty, Ok(Settings::EMPTY));
        assert_eq!(Settings::default(), Settings::EMPTY);
        let defaults = Settings::EMPTY;
        assert_eq!(defaults.qpack_max_table_capacity_or_default(), 0);
        assert_eq!(defaults.qpack_blocked_streams_or_default(), 0);
        assert_eq!(defaults.max_field_section_size_or_default(), None);
        assert!(!defaults.enable_connect_protocol_or_default());
        assert!(!defaults.h3_datagram_or_default());
        let only_size = Settings::parse(&unhex("064400"));
        assert_eq!(
            only_size.map(|settings| (
                settings.qpack_max_table_capacity_or_default(),
                settings.max_field_section_size_or_default(),
                settings.qpack_blocked_streams_or_default()
            )),
            Ok((0, Some(1_024), 0))
        );
        let qpack = Settings::parse(&unhex("014000073f"));
        assert_eq!(
            qpack.map(|settings| (
                settings.qpack_max_table_capacity_or_default(),
                settings.max_field_section_size_or_default(),
                settings.qpack_blocked_streams_or_default()
            )),
            Ok((0, None, 0x3F))
        );
    }

    /// RFC 9114 Section 7.2.4.1: "Endpoints SHOULD include at least one such
    /// setting in their SETTINGS frame."
    #[test]
    fn the_settings_frame_includes_one_reserved_setting_identifier() {
        let settings = Settings::server(&Http3Limits::DEFAULT);
        let mut frame = Vec::new();
        let first = Reserved { n: 0, value: 0 };
        assert_eq!(settings.encode(Some(first), &mut frame), Some(()));
        assert_eq!(frame, unhex("040b0100068000800007002100"));
        let mut preface = Vec::new();
        assert_eq!(
            settings.encode_control_preface(Some(first), &mut preface),
            Some(())
        );
        assert_eq!(preface, unhex("00040b0100068000800007002100"));
        let payload = payload_of(&settings, Some(Reserved { n: 5, value: 7 }));
        assert_eq!(payload, unhex("01000680008000070040bc07"));
        assert_eq!(Settings::parse(&payload), Ok(settings));
        let mut rng = Rng::new(0x5EED_0007);
        for _ in 0..iterations(1_000) {
            let grease = Reserved {
                n: rng.below(reserved::MAX_N),
                value: rng.varint(),
            };
            let payload = payload_of(&Settings::EMPTY, Some(grease));
            let id = varint::decode(&payload).map(|(id, _)| id);
            assert_eq!(id, reserved::reserved(grease.n));
            assert!(id.is_some_and(reserved::is_reserved));
            assert_eq!(Settings::parse(&payload), Ok(Settings::EMPTY));
        }
        let mut out = alloc::vec![1u8];
        let too_far = Reserved {
            n: reserved::MAX_N.saturating_add(1),
            value: 0,
        };
        assert_eq!(settings.encode(Some(too_far), &mut out), None);
        assert_eq!(
            settings.encode_control_preface(Some(too_far), &mut out),
            None
        );
        assert_eq!(out, [1u8]);
    }

    /// RFC 9297 Section 2.1.1: "If the SETTINGS_H3_DATAGRAM setting is
    /// received with a value that is neither 0 nor 1, the receiver MUST
    /// terminate the connection with error H3_SETTINGS_ERROR."
    #[test]
    fn settings_h3_datagram_other_than_0_or_1_is_h3_settings_error() {
        assert_eq!(SETTINGS_H3_DATAGRAM, 0x33);
        assert_eq!(
            Settings::parse(&unhex("3300")).map(|settings| settings.h3_datagram),
            Ok(Some(false))
        );
        assert_eq!(
            Settings::parse(&unhex("3301")).map(|settings| settings.h3_datagram_or_default()),
            Ok(true)
        );
        for (payload, value) in [("3302", 2u64), ("333f", 0x3F), ("33bfffffff", 0x3FFF_FFFF)] {
            let error = Settings::parse(&unhex(payload));
            assert_eq!(
                error,
                Err(Error::SettingValue { id: 0x33, value }),
                "{payload}"
            );
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_SETTINGS_ERROR)
            );
        }
    }

    /// RFC 8441 Section 3: "The value of the parameter MUST be 0 or 1."
    /// RFC 9220 Section 3: "The semantics of the pseudo-header fields and
    /// setting are identical to those in HTTP/2 as defined in [RFC8441]."
    #[test]
    fn settings_enable_connect_protocol_other_than_0_or_1_is_h3_settings_error() {
        assert_eq!(SETTINGS_ENABLE_CONNECT_PROTOCOL, 0x08);
        assert_eq!(
            Settings::parse(&unhex("0801"))
                .map(|settings| settings.enable_connect_protocol_or_default()),
            Ok(true)
        );
        assert_eq!(
            Settings::parse(&unhex("0800")).map(|settings| settings.enable_connect_protocol),
            Ok(Some(false))
        );
        let error = Settings::parse(&unhex("0802"));
        assert_eq!(error, Err(Error::SettingValue { id: 0x08, value: 2 }));
        assert_eq!(
            error.map_err(|error| error.code()),
            Err(ErrorCode::H3_SETTINGS_ERROR)
        );
    }

    /// RFC 9114 Section 7.1: "A frame payload that contains additional bytes
    /// after the identified fields or a frame payload that terminates before
    /// the end of the identified fields MUST be treated as a connection error
    /// of type H3_FRAME_ERROR.", and Section 7.2.4: "Each parameter consists
    /// of a setting identifier and a value".
    #[test]
    fn a_settings_payload_ending_inside_a_pair_is_h3_frame_error() {
        for payload in ["06", "0640", "4006", "060080", "010006c0000000"] {
            let error = Settings::parse(&unhex(payload));
            assert_eq!(
                error,
                Err(Error::PayloadTruncated { frame_type: 0x04 }),
                "{payload}"
            );
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_FRAME_ERROR)
            );
        }
    }

    /// RFC 9114 Section 7.2.4: setting identifiers and values are "both
    /// encoded as QUIC variable-length integers", which RFC 9000 Section 16
    /// bounds at 2^62-1, so no larger value is written.
    #[test]
    fn settings_encoders_refuse_values_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let too_large = varint::MAX.saturating_add(1);
        let settings = Settings {
            max_field_section_size: Some(too_large),
            ..Settings::EMPTY
        };
        let mut out = alloc::vec![3u8];
        assert_eq!(settings.encode(None, &mut out), None);
        assert_eq!(settings.encode_control_preface(None, &mut out), None);
        let grease = Reserved {
            n: 0,
            value: too_large,
        };
        assert_eq!(Settings::EMPTY.encode(Some(grease), &mut out), None);
        assert_eq!(out, [3u8]);
    }

    /// RFC 9114 Section 7.2.4: "The payload of a SETTINGS frame consists of
    /// zero or more parameters.", and Section 7.2.4.1: "Endpoints MUST NOT
    /// consider such settings to have any meaning upon receipt."; any subset
    /// of the known settings, with or without a reserved one, round trips.
    #[test]
    fn random_settings_round_trip_through_encode_and_parse() {
        let mut rng = Rng::new(0x5EED_0008);
        for _ in 0..iterations(5_000) {
            let settings = Settings {
                qpack_max_table_capacity: (rng.below(2) == 0).then_some(rng.varint()),
                max_field_section_size: (rng.below(2) == 0).then_some(rng.varint()),
                qpack_blocked_streams: (rng.below(2) == 0).then_some(rng.varint()),
                enable_connect_protocol: (rng.below(2) == 0).then_some(rng.below(2) == 0),
                h3_datagram: (rng.below(2) == 0).then_some(rng.below(2) == 0),
            };
            let grease = (rng.below(2) == 0).then_some(Reserved {
                n: rng.below(reserved::MAX_N),
                value: rng.varint(),
            });
            let payload = payload_of(&settings, grease);
            assert_eq!(Settings::parse(&payload), Ok(settings), "{payload:?}");
        }
    }

    /// RFC 9114 Section 7.2.4: arbitrary octets read as a SETTINGS payload
    /// never panic the parser, and whatever parses is written back to the
    /// same settings.
    #[test]
    fn arbitrary_settings_payloads_parse_without_panicking() {
        let mut rng = Rng::new(0x5EED_0009);
        let ids = [
            0u64,
            SETTINGS_QPACK_MAX_TABLE_CAPACITY,
            2,
            5,
            SETTINGS_MAX_FIELD_SECTION_SIZE,
            SETTINGS_QPACK_BLOCKED_STREAMS,
            SETTINGS_ENABLE_CONNECT_PROTOCOL,
            SETTINGS_H3_DATAGRAM,
            0x21,
        ];
        for _ in 0..iterations(20_000) {
            let mut payload = rng.bytes(24);
            if rng.below(2) == 0 {
                let id = ids.get(rng.index(ids.len())).copied().unwrap_or(0);
                let mut pair = Vec::new();
                let _ = varint::push(id, &mut pair);
                let _ = varint::push(rng.below(3), &mut pair);
                pair.extend_from_slice(&payload);
                payload = pair;
            }
            if let Ok(settings) = Settings::parse(&payload) {
                let again = payload_of(&settings, None);
                assert_eq!(Settings::parse(&again), Ok(settings));
            }
        }
    }
}
