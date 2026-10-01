//! The limit table that bounds every zero-server parser and connection.
//!
//! Every limit is a `const` default in the module of its protocol, and
//! [`Limits`] carries one configured set through the runtime so a parser never
//! reads a number from anywhere else. The defaults are starting values: the
//! request-line recommendation of RFC 9112, the header and timeout defaults
//! the widely deployed servers publish, and the values the earlier Node SDK
//! already chose (1 MiB bodies, 4 MiB gRPC messages, 64 KiB session
//! descriptions, 4,096-byte session cookies).
//!
//! The primary items are:
//!
//! - [`Limits`] - the configured set, with [`Limits::check`] for the relations
//!   the parsers rely on.
//! - [`http1`], [`transport`] and [`services`] - the defaults by protocol.
//! - [`InvalidLimit`] - a relation [`Limits::check`] found violated.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! ```
//! use zero_limits::Limits;
//!
//! let mut limits = Limits::default();
//! assert_eq!(limits.http1.max_request_line, 8_192);
//! assert!(limits.check().is_ok());
//!
//! limits.http1.max_pipelined = 64;
//! assert!(limits.check().is_err());
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod http1;
pub mod services;
pub mod transport;

use core::fmt;

pub use http1::Http1Limits;
pub use services::{BodyLimits, GrpcLimits, MemoryLimits, WebRtcLimits, WebSocketLimits};
pub use transport::{Http2Limits, Http3Limits, TlsLimits};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The configured limits of one server.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    /// The HTTP/1.1 head, body, chunk and timeout limits.
    pub http1: Http1Limits,
    /// The per-core memory and dispatch budgets.
    pub memory: MemoryLimits,
    /// The TLS handshake budget.
    pub tls: TlsLimits,
    /// The HTTP/2 settings.
    pub http2: Http2Limits,
    /// The QUIC and HTTP/3 settings.
    pub http3: Http3Limits,
    /// The WebSocket message budget.
    pub websocket: WebSocketLimits,
    /// The gRPC and protobuf limits.
    pub grpc: GrpcLimits,
    /// The WebRTC signaling limits.
    pub webrtc: WebRtcLimits,
    /// The body-parser and session limits.
    pub body: BodyLimits,
}

impl Limits {
    /// The defaults of every module.
    pub const DEFAULT: Self = Self {
        http1: Http1Limits::DEFAULT,
        memory: MemoryLimits::DEFAULT,
        tls: TlsLimits::DEFAULT,
        http2: Http2Limits::DEFAULT,
        http3: Http3Limits::DEFAULT,
        websocket: WebSocketLimits::DEFAULT,
        grpc: GrpcLimits::DEFAULT,
        webrtc: WebRtcLimits::DEFAULT,
        body: BodyLimits::DEFAULT,
    };

    /// Checks the relations between limits that the parsers and the dispatcher
    /// rely on.
    ///
    /// # Errors
    ///
    /// Returns the first [`InvalidLimit`] found: a pipelining depth over the
    /// codec's cap, a request line or header field longer than the head, a
    /// chunk-size digit cap a `u64` cannot hold, a zero header count, header
    /// table, batch size, in-flight batch count or varint length.
    pub const fn check(&self) -> Result<(), InvalidLimit> {
        let http1 = &self.http1;
        if http1.max_pipelined > http1::PIPELINE_CODEC_CAP {
            return Err(InvalidLimit {
                name: "http1.max_pipelined",
                reason: "exceeds the codec's pipelining cap",
            });
        }
        if http1.max_request_line > http1.max_head_bytes {
            return Err(InvalidLimit {
                name: "http1.max_request_line",
                reason: "exceeds http1.max_head_bytes",
            });
        }
        if http1.max_header_field > http1.max_head_bytes {
            return Err(InvalidLimit {
                name: "http1.max_header_field",
                reason: "exceeds http1.max_head_bytes",
            });
        }
        if http1.max_chunk_size_digits > http1::MAX_CHUNK_SIZE_DIGITS {
            return Err(InvalidLimit {
                name: "http1.max_chunk_size_digits",
                reason: "exceeds the sixteen hexadecimal digits of a u64",
            });
        }
        if http1.max_header_count == 0 {
            return Err(InvalidLimit {
                name: "http1.max_header_count",
                reason: "is zero",
            });
        }
        if http1.header_table_entries == 0 {
            return Err(InvalidLimit {
                name: "http1.header_table_entries",
                reason: "is zero",
            });
        }
        if self.memory.max_batch_size == 0 {
            return Err(InvalidLimit {
                name: "memory.max_batch_size",
                reason: "is zero",
            });
        }
        if self.memory.max_batches_in_flight == 0 {
            return Err(InvalidLimit {
                name: "memory.max_batches_in_flight",
                reason: "is zero",
            });
        }
        if self.grpc.max_varint_bytes == 0 || self.grpc.max_varint_bytes > 10 {
            return Err(InvalidLimit {
                name: "grpc.max_varint_bytes",
                reason: "is not between one and the ten bytes of a u64",
            });
        }
        Ok(())
    }
}

/// A limit that violates a relation the code relies on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidLimit {
    /// The field, as `module.field`.
    pub name: &'static str,
    /// What is wrong with it.
    pub reason: &'static str,
}

impl fmt::Display for InvalidLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "limit {} {}", self.name, self.reason)
    }
}

#[cfg(feature = "std")]
impl std::error::Error for InvalidLimit {}

#[cfg(test)]
mod tests {
    use core::time::Duration;

    use super::{http1, services, transport, InvalidLimit, Limits};

    #[test]
    fn the_defaults_are_the_design_values() {
        let limits = Limits::DEFAULT;
        assert_eq!(limits, Limits::default());
        assert_eq!(limits.http1.max_request_line, 8_192);
        assert_eq!(limits.http1.max_header_field, 8_192);
        assert_eq!(limits.http1.max_header_count, 100);
        assert_eq!(limits.http1.header_table_entries, 64);
        assert_eq!(limits.http1.max_head_bytes, 32 * 1_024);
        assert_eq!(limits.http1.max_body, 1_024 * 1_024);
        assert_eq!(limits.http1.max_requests_per_connection, 1_000);
        assert_eq!(limits.http1.max_pipelined, 8);
        assert_eq!(http1::PIPELINE_CODEC_CAP, 32);
        assert_eq!(limits.http1.max_chunk_size_digits, 16);
        assert_eq!(limits.http1.max_chunk_extension, 256);
        assert_eq!(limits.http1.max_trailer_bytes, 4 * 1_024);
        assert_eq!(limits.http1.receive_block, 8 * 1_024);
        assert_eq!(limits.http1.header_read_timeout, Duration::from_secs(30));
        assert_eq!(limits.http1.idle_keep_alive, Duration::from_secs(60));
        assert_eq!(limits.http1.body_read_idle, Duration::from_secs(60));
        assert_eq!(limits.http1.send_idle, Duration::from_secs(60));
        assert_eq!(limits.http1.request_total, Duration::from_secs(300));
        assert_eq!(limits.memory.lease_timeout, limits.http1.request_total);
        assert_eq!(limits.memory.request_memory_per_core, 256 * 1_024 * 1_024);
        assert_eq!(limits.memory.max_queued_batches_per_core, 16);
        assert_eq!(limits.memory.max_batch_size, 256);
        assert_eq!(limits.memory.max_batches_in_flight, 4);
        assert_eq!(limits.tls.handshake_timeout, Duration::from_secs(10));
        assert_eq!(limits.tls.max_handshakes_per_core, 1_024);
        assert_eq!(limits.http2.max_concurrent_streams, 100);
        assert_eq!(limits.http2.max_frame_size, 16_384);
        assert_eq!(limits.http2.max_header_list_size, 32_768);
        assert_eq!(limits.http2.header_table_size, 4_096);
        assert_eq!(limits.http2.resets_per_window, 200);
        assert_eq!(limits.http2.reset_window, Duration::from_secs(10));
        assert_eq!(limits.http3.max_bidi_streams, 100);
        assert_eq!(limits.http3.max_uni_streams, 3);
        assert_eq!(limits.http3.connection_data, 1_024 * 1_024);
        assert_eq!(limits.http3.stream_data, 256 * 1_024);
        assert_eq!(limits.http3.idle_timeout, Duration::from_secs(30));
        assert_eq!(limits.http3.receive_payload, 1_350);
        assert_eq!(limits.http3.max_field_section_size, 32_768);
        assert_eq!(limits.http3.qpack_max_table_capacity, 0);
        assert_eq!(limits.http3.qpack_blocked_streams, 0);
        assert_eq!(limits.http3.qpack_integer_cap, 1u64 << 30);
        assert_eq!(limits.websocket.max_message, 16 * 1_024 * 1_024);
        assert_eq!(limits.grpc.max_message, 4 * 1_024 * 1_024);
        assert_eq!(limits.grpc.max_frame, 16 * 1_024 * 1_024);
        assert_eq!(limits.grpc.max_metadata, 8_192);
        assert_eq!(limits.grpc.max_metadata_key, 256);
        assert_eq!(limits.grpc.max_varint_bytes, 10);
        assert_eq!(limits.grpc.max_recursion_depth, 64);
        assert_eq!(limits.webrtc.sdp_max_bytes, 64 * 1_024);
        assert_eq!(limits.webrtc.sdp_max_candidates, 30);
        assert_eq!(limits.webrtc.signaling_max_protocol_errors, 5);
        assert_eq!(limits.webrtc.turn_max_lifetime, Duration::from_secs(3_600));
        assert_eq!(limits.body.session_max_cookie, 4_096);
        assert_eq!(limits.body.multipart_max_field, 1_024 * 1_024);
        assert_eq!(services::MAX_CONNECTIONS, 1 << 20);
        assert_eq!(transport::H2_MAX_FRAME_SIZE, 1 << 14);
    }

    #[test]
    fn the_defaults_pass_the_check() {
        assert_eq!(Limits::DEFAULT.check(), Ok(()));
    }

    type Mutation = fn(&mut Limits);

    #[test]
    fn each_relation_is_checked() {
        let cases: [(Mutation, &str); 9] = [
            (|l| l.http1.max_pipelined = 33, "http1.max_pipelined"),
            (
                |l| l.http1.max_request_line = 40_000,
                "http1.max_request_line",
            ),
            (
                |l| l.http1.max_header_field = 40_000,
                "http1.max_header_field",
            ),
            (
                |l| l.http1.max_chunk_size_digits = 17,
                "http1.max_chunk_size_digits",
            ),
            (|l| l.http1.max_header_count = 0, "http1.max_header_count"),
            (
                |l| l.http1.header_table_entries = 0,
                "http1.header_table_entries",
            ),
            (|l| l.memory.max_batch_size = 0, "memory.max_batch_size"),
            (
                |l| l.memory.max_batches_in_flight = 0,
                "memory.max_batches_in_flight",
            ),
            (|l| l.grpc.max_varint_bytes = 11, "grpc.max_varint_bytes"),
        ];
        for (mutate, name) in cases {
            let mut limits = Limits::DEFAULT;
            mutate(&mut limits);
            assert_eq!(limits.check().map_err(|error| error.name), Err(name));
        }
        let mut limits = Limits::DEFAULT;
        limits.grpc.max_varint_bytes = 0;
        assert!(limits.check().is_err());
    }

    #[test]
    fn invalid_limits_display_the_field_and_reason() {
        let error = InvalidLimit {
            name: "http1.max_pipelined",
            reason: "exceeds the codec's pipelining cap",
        };
        assert_eq!(
            alloc::format!("{error}"),
            "limit http1.max_pipelined exceeds the codec's pipelining cap"
        );
    }
}
