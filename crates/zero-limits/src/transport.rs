//! The transport limits: the TLS handshake budget, the HTTP/2 stream and frame
//! settings, and the QUIC and HTTP/3 stream, data and field-section settings.

use core::time::Duration;

/// The time allowed for a TLS handshake to complete.
pub const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The handshakes one core keeps in progress at once; the rest wait.
pub const TLS_MAX_HANDSHAKES_PER_CORE: usize = 1_024;

/// The configured TLS limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TlsLimits {
    /// See [`TLS_HANDSHAKE_TIMEOUT`].
    pub handshake_timeout: Duration,
    /// See [`TLS_MAX_HANDSHAKES_PER_CORE`].
    pub max_handshakes_per_core: usize,
}

impl TlsLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        handshake_timeout: TLS_HANDSHAKE_TIMEOUT,
        max_handshakes_per_core: TLS_MAX_HANDSHAKES_PER_CORE,
    };
}

impl Default for TlsLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The concurrent streams one HTTP/2 connection may open toward the server.
pub const H2_MAX_CONCURRENT_STREAMS: u32 = 100;
/// The largest HTTP/2 frame payload the server advertises, in octets.
pub const H2_MAX_FRAME_SIZE: u32 = 16_384;
/// The largest HTTP/2 field section the server advertises, in octets counted
/// with the per-field overhead the setting defines.
pub const H2_MAX_HEADER_LIST_SIZE: u32 = 32_768;
/// The HPACK dynamic table size the server advertises, in octets.
pub const H2_HEADER_TABLE_SIZE: u32 = 4_096;
/// The stream resets a peer may send inside one window before the connection
/// is closed.
pub const H2_RESETS_PER_WINDOW: u32 = 200;
/// The length of the reset window.
pub const H2_RESET_WINDOW: Duration = Duration::from_secs(10);

/// The configured HTTP/2 limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Http2Limits {
    /// See [`H2_MAX_CONCURRENT_STREAMS`].
    pub max_concurrent_streams: u32,
    /// See [`H2_MAX_FRAME_SIZE`].
    pub max_frame_size: u32,
    /// See [`H2_MAX_HEADER_LIST_SIZE`].
    pub max_header_list_size: u32,
    /// See [`H2_HEADER_TABLE_SIZE`].
    pub header_table_size: u32,
    /// See [`H2_RESETS_PER_WINDOW`].
    pub resets_per_window: u32,
    /// See [`H2_RESET_WINDOW`].
    pub reset_window: Duration,
}

impl Http2Limits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_concurrent_streams: H2_MAX_CONCURRENT_STREAMS,
        max_frame_size: H2_MAX_FRAME_SIZE,
        max_header_list_size: H2_MAX_HEADER_LIST_SIZE,
        header_table_size: H2_HEADER_TABLE_SIZE,
        resets_per_window: H2_RESETS_PER_WINDOW,
        reset_window: H2_RESET_WINDOW,
    };
}

impl Default for Http2Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The bidirectional streams a QUIC peer may open.
pub const H3_MAX_BIDI_STREAMS: u32 = 100;
/// The unidirectional streams a QUIC peer may open beyond the three HTTP/3
/// reserves for control and QPACK.
pub const H3_MAX_UNI_STREAMS: u32 = 3;
/// The flow-control credit of one QUIC connection, in octets.
pub const H3_CONNECTION_DATA: u64 = 1_048_576;
/// The flow-control credit of one QUIC stream, in octets.
pub const H3_STREAM_DATA: u64 = 262_144;
/// The time an idle QUIC connection is held open.
pub const H3_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest UDP payload the server is willing to receive, in octets.
pub const H3_RECEIVE_PAYLOAD: u16 = 1_350;
/// The largest HTTP/3 field section the server advertises, in octets.
pub const H3_MAX_FIELD_SECTION_SIZE: u64 = 32_768;
/// The QPACK dynamic table capacity the server advertises; zero keeps the
/// decoder static-only.
pub const QPACK_MAX_TABLE_CAPACITY: u64 = 0;
/// The streams the server lets a QPACK encoder block; zero blocks none.
pub const QPACK_BLOCKED_STREAMS: u64 = 0;
/// The longest string literal, in octets, the QPACK decoder accepts; every
/// other QPACK integer is decoded up to 2^62-1 (RFC 9204 Section 4.1.1).
pub const QPACK_INTEGER_CAP: u64 = 1_073_741_824;
/// The stream resets and stop-sending requests a peer may send inside one
/// window before the connection is closed with excessive load.
pub const H3_RESETS_PER_WINDOW: u32 = 200;
/// The length of the HTTP/3 reset window.
pub const H3_RESET_WINDOW: Duration = Duration::from_secs(10);

/// The configured QUIC and HTTP/3 limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Http3Limits {
    /// See [`H3_MAX_BIDI_STREAMS`].
    pub max_bidi_streams: u32,
    /// See [`H3_MAX_UNI_STREAMS`].
    pub max_uni_streams: u32,
    /// See [`H3_CONNECTION_DATA`].
    pub connection_data: u64,
    /// See [`H3_STREAM_DATA`].
    pub stream_data: u64,
    /// See [`H3_IDLE_TIMEOUT`].
    pub idle_timeout: Duration,
    /// See [`H3_RECEIVE_PAYLOAD`].
    pub receive_payload: u16,
    /// See [`H3_MAX_FIELD_SECTION_SIZE`].
    pub max_field_section_size: u64,
    /// See [`QPACK_MAX_TABLE_CAPACITY`].
    pub qpack_max_table_capacity: u64,
    /// See [`QPACK_BLOCKED_STREAMS`].
    pub qpack_blocked_streams: u64,
    /// See [`QPACK_INTEGER_CAP`].
    pub qpack_integer_cap: u64,
    /// See [`H3_RESETS_PER_WINDOW`].
    pub resets_per_window: u32,
    /// See [`H3_RESET_WINDOW`].
    pub reset_window: Duration,
}

impl Http3Limits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_bidi_streams: H3_MAX_BIDI_STREAMS,
        max_uni_streams: H3_MAX_UNI_STREAMS,
        connection_data: H3_CONNECTION_DATA,
        stream_data: H3_STREAM_DATA,
        idle_timeout: H3_IDLE_TIMEOUT,
        receive_payload: H3_RECEIVE_PAYLOAD,
        max_field_section_size: H3_MAX_FIELD_SECTION_SIZE,
        qpack_max_table_capacity: QPACK_MAX_TABLE_CAPACITY,
        qpack_blocked_streams: QPACK_BLOCKED_STREAMS,
        qpack_integer_cap: QPACK_INTEGER_CAP,
        resets_per_window: H3_RESETS_PER_WINDOW,
        reset_window: H3_RESET_WINDOW,
    };
}

impl Default for Http3Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}
