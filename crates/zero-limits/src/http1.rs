//! The HTTP/1.1 connection limits: head, body, chunk and trailer sizes, the
//! timeouts, and the per-connection request and pipelining budgets.

use core::time::Duration;

/// The longest request line accepted, in octets; a longer target is answered
/// 414 and a longer method 501.
pub const MAX_REQUEST_LINE: usize = 8_192;
/// The longest single header field (name, colon and value), in octets.
pub const MAX_HEADER_FIELD: usize = 8_192;
/// The most header fields in one head.
pub const MAX_HEADER_COUNT: usize = 100;
/// The entries in the caller-owned header table the parser fills by default.
pub const HEADER_TABLE_ENTRIES: usize = 64;
/// The longest head (request line and every field), in octets.
pub const MAX_HEAD_BYTES: usize = 32_768;
/// The longest body accepted without a route opting in, in octets.
pub const MAX_BODY: u64 = 1_048_576;
/// The requests served on one connection before it is closed, so the
/// per-connection allocations are recycled.
pub const MAX_REQUESTS_PER_CONNECTION: u32 = 1_000;
/// The pipelined requests held in flight on one connection by default.
pub const MAX_PIPELINED: usize = 8;
/// The most pipelined requests the codec can hold, whatever the configuration.
pub const PIPELINE_CODEC_CAP: usize = 32;
/// The most hexadecimal digits in a chunk size; sixteen is every `u64`.
pub const MAX_CHUNK_SIZE_DIGITS: usize = 16;
/// The longest chunk extension (everything after the size), in octets.
pub const MAX_CHUNK_EXTENSION: usize = 256;
/// The longest trailer section, in octets.
pub const MAX_TRAILER_BYTES: usize = 4_096;
/// The size of one receive buffer block, leased when a connection is readable.
pub const RECEIVE_BLOCK: usize = 8_192;
/// The time allowed from the first byte of a head to its end.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The time an idle keep-alive connection is held open.
pub const IDLE_KEEP_ALIVE: Duration = Duration::from_secs(60);
/// The time allowed between two reads of a body.
pub const BODY_READ_IDLE: Duration = Duration::from_secs(60);
/// The time allowed for one request from first byte to final write.
pub const REQUEST_TOTAL: Duration = Duration::from_secs(300);

/// The configured HTTP/1.1 limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Http1Limits {
    /// See [`MAX_REQUEST_LINE`].
    pub max_request_line: usize,
    /// See [`MAX_HEADER_FIELD`].
    pub max_header_field: usize,
    /// See [`MAX_HEADER_COUNT`].
    pub max_header_count: usize,
    /// See [`HEADER_TABLE_ENTRIES`].
    pub header_table_entries: usize,
    /// See [`MAX_HEAD_BYTES`].
    pub max_head_bytes: usize,
    /// See [`MAX_BODY`].
    pub max_body: u64,
    /// See [`MAX_REQUESTS_PER_CONNECTION`].
    pub max_requests_per_connection: u32,
    /// See [`MAX_PIPELINED`].
    pub max_pipelined: usize,
    /// See [`MAX_CHUNK_SIZE_DIGITS`].
    pub max_chunk_size_digits: usize,
    /// See [`MAX_CHUNK_EXTENSION`].
    pub max_chunk_extension: usize,
    /// See [`MAX_TRAILER_BYTES`].
    pub max_trailer_bytes: usize,
    /// See [`RECEIVE_BLOCK`].
    pub receive_block: usize,
    /// See [`HEADER_READ_TIMEOUT`].
    pub header_read_timeout: Duration,
    /// See [`IDLE_KEEP_ALIVE`].
    pub idle_keep_alive: Duration,
    /// See [`BODY_READ_IDLE`].
    pub body_read_idle: Duration,
    /// See [`REQUEST_TOTAL`].
    pub request_total: Duration,
}

impl Http1Limits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_request_line: MAX_REQUEST_LINE,
        max_header_field: MAX_HEADER_FIELD,
        max_header_count: MAX_HEADER_COUNT,
        header_table_entries: HEADER_TABLE_ENTRIES,
        max_head_bytes: MAX_HEAD_BYTES,
        max_body: MAX_BODY,
        max_requests_per_connection: MAX_REQUESTS_PER_CONNECTION,
        max_pipelined: MAX_PIPELINED,
        max_chunk_size_digits: MAX_CHUNK_SIZE_DIGITS,
        max_chunk_extension: MAX_CHUNK_EXTENSION,
        max_trailer_bytes: MAX_TRAILER_BYTES,
        receive_block: RECEIVE_BLOCK,
        header_read_timeout: HEADER_READ_TIMEOUT,
        idle_keep_alive: IDLE_KEEP_ALIVE,
        body_read_idle: BODY_READ_IDLE,
        request_total: REQUEST_TOTAL,
    };
}

impl Default for Http1Limits {
    fn default() -> Self {
        Self::DEFAULT
    }
}
