//! The limits of the services above the transports: the per-core memory and
//! batch budgets, WebSocket messages, gRPC and protobuf, WebRTC signaling, and
//! the body parsers and session cookies.

use core::time::Duration;

/// The connections one process accepts at once; the per-core slots and the
/// memory budget bound it further.
pub const MAX_CONNECTIONS: usize = 1_048_576;
/// The request memory one core may commit (leased receive buffers, buffered
/// bodies and leased response buffers) before it pauses accepting, in octets.
pub const REQUEST_MEMORY_PER_CORE: u64 = 268_435_456;
/// The requests dispatched to a host target in one batch.
pub const MAX_BATCH_SIZE: usize = 256;
/// The batches kept in flight toward one target before the worker stops
/// reading from the connections that feed it.
pub const MAX_BATCHES_IN_FLIGHT: usize = 4;
/// The batches one core queues past the in-flight bound before new host
/// requests are answered 503 with a retry hint.
pub const MAX_QUEUED_BATCHES_PER_CORE: usize = 16;
/// The time a host may hold a leased slot before it is closed; the same as the
/// HTTP/1.1 request total.
pub const LEASE_TIMEOUT: Duration = Duration::from_secs(300);

/// The configured memory and dispatch budgets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryLimits {
    /// See [`MAX_CONNECTIONS`].
    pub max_connections: usize,
    /// See [`REQUEST_MEMORY_PER_CORE`].
    pub request_memory_per_core: u64,
    /// See [`MAX_BATCH_SIZE`].
    pub max_batch_size: usize,
    /// See [`MAX_BATCHES_IN_FLIGHT`].
    pub max_batches_in_flight: usize,
    /// See [`MAX_QUEUED_BATCHES_PER_CORE`].
    pub max_queued_batches_per_core: usize,
    /// See [`LEASE_TIMEOUT`].
    pub lease_timeout: Duration,
}

impl MemoryLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_connections: MAX_CONNECTIONS,
        request_memory_per_core: REQUEST_MEMORY_PER_CORE,
        max_batch_size: MAX_BATCH_SIZE,
        max_batches_in_flight: MAX_BATCHES_IN_FLIGHT,
        max_queued_batches_per_core: MAX_QUEUED_BATCHES_PER_CORE,
        lease_timeout: LEASE_TIMEOUT,
    };
}

impl Default for MemoryLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The largest WebSocket message, reassembled from its fragments, in octets.
pub const WS_MAX_MESSAGE: u64 = 16_777_216;
/// The most fragments one WebSocket message may span.
pub const WS_MAX_FRAGMENTS: u32 = 1_024;
/// The control frames (ping, pong, close) accepted per second on one
/// connection before it is closed.
pub const WS_MAX_CONTROL_FRAMES_PER_SECOND: u32 = 64;

/// The configured WebSocket limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebSocketLimits {
    /// See [`WS_MAX_MESSAGE`].
    pub max_message: u64,
    /// See [`WS_MAX_FRAGMENTS`].
    pub max_fragments: u32,
    /// See [`WS_MAX_CONTROL_FRAMES_PER_SECOND`].
    pub max_control_frames_per_second: u32,
}

impl WebSocketLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_message: WS_MAX_MESSAGE,
        max_fragments: WS_MAX_FRAGMENTS,
        max_control_frames_per_second: WS_MAX_CONTROL_FRAMES_PER_SECOND,
    };
}

impl Default for WebSocketLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The largest gRPC message, in octets.
pub const GRPC_MAX_MESSAGE: u64 = 4_194_304;
/// The largest length-prefixed gRPC frame, in octets.
pub const GRPC_MAX_FRAME: u64 = 16_777_216;
/// The largest gRPC metadata section, in octets.
pub const GRPC_MAX_METADATA: usize = 8_192;
/// The longest gRPC metadata key, in octets.
pub const GRPC_MAX_METADATA_KEY: usize = 256;
/// The most bytes in one protobuf varint; ten is every `u64`.
pub const PROTO_MAX_VARINT_BYTES: usize = 10;
/// The deepest message nesting the protobuf decoder follows.
pub const PROTO_MAX_RECURSION_DEPTH: usize = 64;

/// The configured gRPC and protobuf limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrpcLimits {
    /// See [`GRPC_MAX_MESSAGE`].
    pub max_message: u64,
    /// See [`GRPC_MAX_FRAME`].
    pub max_frame: u64,
    /// See [`GRPC_MAX_METADATA`].
    pub max_metadata: usize,
    /// See [`GRPC_MAX_METADATA_KEY`].
    pub max_metadata_key: usize,
    /// See [`PROTO_MAX_VARINT_BYTES`].
    pub max_varint_bytes: usize,
    /// See [`PROTO_MAX_RECURSION_DEPTH`].
    pub max_recursion_depth: usize,
}

impl GrpcLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        max_message: GRPC_MAX_MESSAGE,
        max_frame: GRPC_MAX_FRAME,
        max_metadata: GRPC_MAX_METADATA,
        max_metadata_key: GRPC_MAX_METADATA_KEY,
        max_varint_bytes: PROTO_MAX_VARINT_BYTES,
        max_recursion_depth: PROTO_MAX_RECURSION_DEPTH,
    };
}

impl Default for GrpcLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The largest session description accepted, in octets.
pub const SDP_MAX_BYTES: usize = 65_536;
/// The most ICE candidates accepted in one session description.
pub const SDP_MAX_CANDIDATES: usize = 30;
/// The protocol errors a signaling peer may commit before it is disconnected.
pub const SIGNALING_MAX_PROTOCOL_ERRORS: u32 = 5;
/// The longest TURN allocation lifetime granted.
pub const TURN_MAX_LIFETIME: Duration = Duration::from_secs(3_600);

/// The configured WebRTC limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebRtcLimits {
    /// See [`SDP_MAX_BYTES`].
    pub sdp_max_bytes: usize,
    /// See [`SDP_MAX_CANDIDATES`].
    pub sdp_max_candidates: usize,
    /// See [`SIGNALING_MAX_PROTOCOL_ERRORS`].
    pub signaling_max_protocol_errors: u32,
    /// See [`TURN_MAX_LIFETIME`].
    pub turn_max_lifetime: Duration,
}

impl WebRtcLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        sdp_max_bytes: SDP_MAX_BYTES,
        sdp_max_candidates: SDP_MAX_CANDIDATES,
        signaling_max_protocol_errors: SIGNALING_MAX_PROTOCOL_ERRORS,
        turn_max_lifetime: TURN_MAX_LIFETIME,
    };
}

impl Default for WebRtcLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The longest session cookie, in octets.
pub const SESSION_MAX_COOKIE: usize = 4_096;
/// The largest multipart field, in octets.
pub const MULTIPART_MAX_FIELD: u64 = 1_048_576;

/// The configured body-parser and session limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyLimits {
    /// See [`SESSION_MAX_COOKIE`].
    pub session_max_cookie: usize,
    /// See [`MULTIPART_MAX_FIELD`].
    pub multipart_max_field: u64,
}

impl BodyLimits {
    /// The defaults of this module.
    pub const DEFAULT: Self = Self {
        session_max_cookie: SESSION_MAX_COOKIE,
        multipart_max_field: MULTIPART_MAX_FIELD,
    };
}

impl Default for BodyLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}
