//! The types of the C ABI, and the modules that export its functions.
//!
//! Every struct is `#[repr(C)]` with explicit reserved fields, so no padding byte is
//! ever left uninitialized when a struct is copied out, and no field is a `bool` or an
//! enum, so any bit pattern a host writes is a valid value.

pub(crate) mod app;
pub(crate) mod layout;
pub(crate) mod library;
pub(crate) mod names;
pub(crate) mod plugin;
pub(crate) mod realtime;
pub(crate) mod req;
pub(crate) mod res;
pub(crate) mod server;
pub(crate) mod slot;
pub(crate) mod target;

use std::mem::{offset_of, size_of};
use std::ptr;

use crate::ptr::{Prefixed, Zeroed};

/// What a call ended with. The library only ever returns a status, and never reads
/// one from the host.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ZeroStatus {
    /// The call succeeded.
    Ok = 0,
    /// A protocol rule refused the input.
    Protocol = 1,
    /// The operating system refused: a bind failure, TLS material that cannot be read.
    Io = 2,
    /// An option document is malformed; the last error names the key or the position.
    Codec = 3,
    /// The id is stale or unknown, the slot is not in a state the call accepts, the
    /// response is sealed, the connection is gone, the target is detached or the server
    /// is stopped.
    Closed = 4,
    /// An authentication rule refused the input.
    Auth = 5,
    /// The capability is compiled out, the call needs a feature that has not shipped, or
    /// the conformance section is unknown.
    Unsupported = 6,
    /// A poll or a wait timed out, or a poll was woken.
    Timeout = 7,
    /// A bound is reached: the pins of a thread, the readers of a slot, the response
    /// limit, an outbox limit, the free worker indexes, a target already attached, a
    /// server still running at its free, or an array too short for its count.
    Limit = 8,
    /// An argument is out of its range or its set, a pointer is NULL or misaligned, a
    /// size is below its version 1 size, or the call is made from a thread that may not
    /// make it.
    InvalidArgument = 9,
    /// A panic was caught inside the export, or a panic poisoned the state the call
    /// needs.
    Panic = 10,
}

impl ZeroStatus {
    /// The status of a zero-host refusal, which uses the same numbers.
    pub(crate) const fn from_host(status: zero_host::Status) -> Self {
        match status {
            zero_host::Status::Ok => ZeroStatus::Ok,
            zero_host::Status::Protocol => ZeroStatus::Protocol,
            zero_host::Status::Io => ZeroStatus::Io,
            zero_host::Status::Codec => ZeroStatus::Codec,
            zero_host::Status::Closed => ZeroStatus::Closed,
            zero_host::Status::Auth => ZeroStatus::Auth,
            zero_host::Status::Unsupported => ZeroStatus::Unsupported,
            zero_host::Status::Timeout => ZeroStatus::Timeout,
            zero_host::Status::Limit => ZeroStatus::Limit,
            zero_host::Status::InvalidArgument => ZeroStatus::InvalidArgument,
            zero_host::Status::Panic => ZeroStatus::Panic,
        }
    }
}

/// A read-only byte range: a view into a slot, or a range of static text. `{NULL, 0}`
/// means absent, and a present empty value has a non-null pointer.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroBytes {
    /// The first byte, or NULL when absent.
    pub ptr: *const u8,
    /// The number of bytes.
    pub len: usize,
}

impl ZeroBytes {
    /// The absent value.
    pub const ABSENT: ZeroBytes = ZeroBytes {
        ptr: ptr::null(),
        len: 0,
    };

    /// The range of `bytes`, present even when it is empty.
    pub(crate) const fn of(bytes: &[u8]) -> ZeroBytes {
        ZeroBytes {
            ptr: bytes.as_ptr(),
            len: bytes.len(),
        }
    }

    /// The range of `bytes`, or the absent value.
    pub(crate) fn of_option(bytes: Option<&[u8]>) -> ZeroBytes {
        bytes.map_or(ZeroBytes::ABSENT, ZeroBytes::of)
    }
}

impl Zeroed for ZeroBytes {
    const ZERO: Self = ZeroBytes::ABSENT;
}

/// A byte range of the request head as offset and length.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ZeroSpan {
    /// The offset of the first byte from the start of the head.
    pub start: u32,
    /// The number of bytes.
    pub len: u32,
}

impl ZeroSpan {
    /// The span of a zero-http host span.
    pub(crate) const fn of(span: zero_http::HostSpan) -> ZeroSpan {
        ZeroSpan {
            start: span.start,
            len: span.len,
        }
    }
}

/// One field line of the request head, as spans into the head.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroField {
    /// The field name as received.
    pub name: ZeroSpan,
    /// The field value without its surrounding whitespace.
    pub value: ZeroSpan,
    /// The interned name's id, a `ZERO_HEADER_*` value, or `ZERO_HEADER_NONE`.
    pub id: u32,
}

impl ZeroField {
    /// The version 1 size, the stride `ZeroRequestView.field_size` reports.
    pub(crate) const V1_SIZE: usize = offset_of!(ZeroField, id) + size_of::<u32>();
}

/// The request of a leased slot in one read: values, and views into the slot that the
/// view rule governs.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroRequestView {
    /// The size of this struct as the host built it; the library stores the octets it
    /// wrote.
    pub size: u32,
    /// The method: a `ZERO_METHOD_*` value, or `ZERO_METHOD_OTHER` for a token outside
    /// the method table.
    pub method: u8,
    /// The protocol version: 10 for HTTP/1.0, 11 for HTTP/1.1.
    pub version: u8,
    /// The `ZERO_VIEW_*` flags.
    pub flags: u16,
    /// The route id the request matched.
    pub route: u32,
    /// The status the core would have answered, for a request on the miss route; 0 for
    /// a matched route.
    pub miss_status: u16,
    /// The methods the path allows, bit `i` for method id `i`, for the miss route.
    pub allow: u16,
    /// The head as received; every span indexes it.
    pub head: *const u8,
    /// The length of the head in octets.
    pub head_len: u32,
    /// The number of entries of `fields`.
    pub field_count: u32,
    /// The method token.
    pub method_token: ZeroSpan,
    /// The request target.
    pub target: ZeroSpan,
    /// The path of the target, without the query.
    pub path: ZeroSpan,
    /// The query without its `?`; meaningful when `ZERO_VIEW_QUERY` is set.
    pub query: ZeroSpan,
    /// The authority; `{0, 0}` when the request has none.
    pub authority: ZeroSpan,
    /// The field table, `field_count` entries `field_size` octets apart.
    pub fields: *const ZeroField,
    /// The normalized path the route matched.
    pub route_path: *const u8,
    /// The length of the route path in octets.
    pub route_path_len: u32,
    /// The number of route parameters.
    pub param_count: u32,
    /// The buffered body.
    pub body: *const u8,
    /// The length of the body in octets.
    pub body_len: u64,
    /// The size of one `ZeroField` as the library wrote the table: the stride of
    /// `fields`.
    pub field_size: u32,
    /// Zero.
    pub reserved: u32,
}

impl Prefixed for ZeroRequestView {
    const V1_SIZE: usize = offset_of!(ZeroRequestView, reserved) + size_of::<u32>();

    fn with_size(self, size: u32) -> Self {
        ZeroRequestView { size, ..self }
    }
}

/// The addresses of a request's connection.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroPeer {
    /// The size of this struct as the host built it; the library stores the octets it
    /// wrote.
    pub size: u32,
    /// The peer's address family: 4, 6, or 0 when the address is unknown.
    pub family: u8,
    /// 1 when the connection is secure, 0 otherwise.
    pub secure: u8,
    /// The transport: 1 for TCP, 2 for TLS over TCP.
    pub transport: u8,
    /// The negotiated application protocol; 0 at this version.
    pub alpn: u8,
    /// The peer's port.
    pub port: u16,
    /// The client's port after the trust-proxy rule.
    pub client_port: u16,
    /// The client's address family after the trust-proxy rule: 4, 6 or 0.
    pub client_family: u8,
    /// Zero.
    pub reserved: [u8; 7],
    /// The peer's address: four octets then zeros for IPv4, sixteen for IPv6.
    pub address: [u8; 16],
    /// The client's address after the trust-proxy rule, laid out as `address`; the peer
    /// without a rule.
    pub client_address: [u8; 16],
}

impl Prefixed for ZeroPeer {
    const V1_SIZE: usize = offset_of!(ZeroPeer, client_address) + 16;

    fn with_size(self, size: u32) -> Self {
        ZeroPeer { size, ..self }
    }
}

/// One field line a host writes: a name and a value.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroHeaderPair {
    /// The field name, a token.
    pub name: ZeroBytes,
    /// The field value.
    pub value: ZeroBytes,
}

impl ZeroHeaderPair {
    /// The version 1 size, the least `ZeroResponseSpec.field_size` the library accepts.
    pub(crate) const V1_SIZE: usize = offset_of!(ZeroHeaderPair, value) + size_of::<ZeroBytes>();
}

impl Zeroed for ZeroHeaderPair {
    const ZERO: Self = ZeroHeaderPair {
        name: ZeroBytes::ABSENT,
        value: ZeroBytes::ABSENT,
    };
}

/// A whole response in one call: the status, field lines and the body.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroResponseSpec {
    /// The size of this struct as the host built it.
    pub size: u32,
    /// The status, 200 to 599, or 0 to keep the one set before (200 by default).
    pub status: u16,
    /// Zero.
    pub reserved: u16,
    /// The size of one `ZeroHeaderPair` as the host built the array: its stride.
    pub field_size: u32,
    /// Zero.
    pub reserved2: u32,
    /// The field lines, appended in order; `Set-Cookie` may repeat.
    pub fields: *const ZeroHeaderPair,
    /// The number of field lines.
    pub field_count: usize,
    /// The body; copied, and it replaces any body written before.
    pub body: ZeroBytes,
}

impl Prefixed for ZeroResponseSpec {
    const V1_SIZE: usize = offset_of!(ZeroResponseSpec, body) + size_of::<ZeroBytes>();

    fn with_size(self, size: u32) -> Self {
        ZeroResponseSpec { size, ..self }
    }
}

impl Zeroed for ZeroResponseSpec {
    const ZERO: Self = ZeroResponseSpec {
        size: 0,
        status: 0,
        reserved: 0,
        field_size: 0,
        reserved2: 0,
        fields: ptr::null(),
        field_count: 0,
        body: ZeroBytes::ABSENT,
    };
}

/// One batch a target took.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroBatch {
    /// The size of this struct as the host built it; the library stores the octets it
    /// wrote.
    pub size: u32,
    /// The worker index whose slots or connections the batch names.
    pub worker: u8,
    /// `ZERO_BATCH_REQUESTS` or `ZERO_BATCH_EVENTS`.
    pub kind: u8,
    /// Zero at this version.
    pub flags: u16,
    /// How many requests or events the batch carries.
    pub count: u32,
    /// Zero.
    pub reserved: u32,
    /// The epoch `zero_batch_complete` acknowledges the batch with.
    pub epoch: u64,
}

impl Prefixed for ZeroBatch {
    const V1_SIZE: usize = offset_of!(ZeroBatch, epoch) + size_of::<u64>();

    fn with_size(self, size: u32) -> Self {
        ZeroBatch { size, ..self }
    }
}

/// One WebSocket or server-sent event occurrence of an event batch.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZeroEvent {
    /// The connection id.
    pub conn: u64,
    /// The route the connection was accepted on.
    pub route: u32,
    /// A `ZERO_EVENT_*` value.
    pub kind: u8,
    /// The message opcode, `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`, for a message.
    pub opcode: u8,
    /// The close code, for a WebSocket close.
    pub close_code: u16,
    /// The message, the pong's data or the close reason, in the target's delivery
    /// storage; absent for the other kinds.
    pub data: ZeroBytes,
}

impl ZeroEvent {
    /// The version 1 size, the least `event_size` `zero_target_poll` accepts.
    pub(crate) const V1_SIZE: usize = offset_of!(ZeroEvent, data) + size_of::<ZeroBytes>();
}

/// A server's statistics, summed over its worker indexes. The counts start at zero for
/// each server; `pinned`, `quarantined_peak`, `in_flight`, `leased` and `retained` are
/// current values.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ZeroStats {
    /// The size of this struct as the host built it; the library stores the octets it
    /// wrote.
    pub size: u32,
    /// Zero.
    pub reserved: u32,
    /// Requests posted to a target in batches it took.
    pub dispatched: u64,
    /// Batches the targets took.
    pub batches: u64,
    /// Batches acknowledged.
    pub acks: u64,
    /// Slots that waited for a lock or a pin before the worker took them back.
    pub late_readers: u64,
    /// Posts a target answered full.
    pub queue_full: u64,
    /// Host requests answered 503 before a slot was claimed.
    pub refused_503: u64,
    /// Leases closed because their target was lost.
    pub closed_leases: u64,
    /// Panics of the host dispatch.
    pub panics: u64,
    /// Pins host threads hold now.
    pub pinned: u64,
    /// The longest a quarantine of retired slots has been.
    pub quarantined_peak: u64,
    /// Batches posted and not acknowledged.
    pub in_flight: u64,
    /// Slots leased to a host whose lease has not ended.
    pub leased: u64,
    /// Acknowledgments refused while their completions were applied.
    pub refused_acks: u64,
    /// Batches a target gave up on.
    pub abandoned_batches: u64,
    /// Octets of exchanges held outside the connection records.
    pub retained: u64,
}

impl ZeroStats {
    /// The statistics of a zero-host server.
    pub(crate) const fn of(stats: zero_host::Stats) -> ZeroStats {
        ZeroStats {
            size: 0,
            reserved: 0,
            dispatched: stats.dispatched,
            batches: stats.batches,
            acks: stats.acks,
            late_readers: stats.late_readers,
            queue_full: stats.queue_full,
            refused_503: stats.refused_503,
            closed_leases: stats.closed_leases,
            panics: stats.panics,
            pinned: stats.pinned,
            quarantined_peak: stats.quarantined_peak,
            in_flight: stats.in_flight,
            leased: stats.leased,
            refused_acks: stats.refused_acks,
            abandoned_batches: stats.abandoned_batches,
            retained: stats.retained,
        }
    }
}

impl Prefixed for ZeroStats {
    const V1_SIZE: usize = offset_of!(ZeroStats, retained) + size_of::<u64>();

    fn with_size(self, size: u32) -> Self {
        ZeroStats { size, ..self }
    }
}
