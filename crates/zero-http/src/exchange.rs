//! The exchange: the part of a request a host on another thread reads, the
//! response it writes back, and the view of the request published without a lock.
//!
//! [`Call::export`](crate::Call::export) moves what a host may read out of the
//! request record into an [`Exchange`] by buffer swaps (the head, the body, the
//! trailers, the route path) and publishes a [`PublishedView`] over it with release
//! stores. The host writes the response side through [`Exchange::response`], which
//! applies the same field rules as a handler's response, and
//! [`Call::import`](crate::Call::import) moves the response back into the record,
//! which the driver serializes as it does any other. The request side is written
//! only at export and stays frozen until the exchange is reset, so the view stays
//! valid while another thread writes the response.
//!
//! An exchange counts the octets it holds on its owner's memory budget
//! ([`Exchange::counted`]): export moves the request body's charge off the core's
//! buffered bodies onto the exchange, [`Exchange::count`] adds the response octets
//! a host wrote, import takes the response charge off with the response and
//! returns it, and [`Exchange::release`] takes off whatever is left and returns
//! that, so the owner subtracts exactly what each step dropped.

use std::fmt;
use std::mem;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::ops::Range;
use std::sync::atomic::{AtomicPtr, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use zero_core::Error;
use zero_http1::{parse_trailers, Expect, Field, Span, Version};
use zero_http_types::{HeaderName, StatusCode};
use zero_limits::Http1Limits;
use zero_rt::Reset;

use crate::call::{FieldTable, Miss, Request, Response};
use crate::error::{error_status, write_host_error, ErrorShape};
use crate::record::{Record, TRAILER_TABLE};

/// A body buffer kept past this capacity is shrunk when its record or exchange is
/// reused, so one large body does not pin its memory for the rest of the core's
/// life.
pub const BODY_KEEP: usize = 65_536;

/// The field id of a name the interned table does not hold.
pub const HEADER_NONE: u32 = u32::MAX;

/// The method id of a token outside the method registry.
pub const METHOD_OTHER: u8 = 255;

/// View flag: the request arrived over a secure connection.
pub const VIEW_SECURE: u16 = 1;
/// View flag: the request asks to switch protocols.
pub const VIEW_UPGRADE: u16 = 2;
/// View flag: the connection persists after the response.
pub const VIEW_KEEP_ALIVE: u16 = 4;
/// View flag: the request expects `100-continue`.
pub const VIEW_EXPECT_CONTINUE: u16 = 8;
/// View flag: a HEAD request served by the GET route.
pub const VIEW_HEAD_AS_GET: u16 = 16;
/// View flag: the target has a query, possibly empty.
pub const VIEW_QUERY: u16 = 32;

/// The packed form of an absent span.
const ABSENT: u64 = u64::MAX;

/// A byte range of a buffer as offset and length, laid out as the C ABI's span.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct HostSpan {
    /// The offset of the first byte.
    pub start: u32,
    /// The number of bytes.
    pub len: u32,
}

impl HostSpan {
    /// The empty span at offset zero.
    pub const EMPTY: Self = HostSpan { start: 0, len: 0 };

    /// The bytes of the span in `input`.
    ///
    /// # Arguments
    ///
    /// * `input` - the buffer the span indexes.
    ///
    /// # Returns
    ///
    /// The bytes, or nothing when the span is out of range.
    #[must_use]
    pub fn of(self, input: &[u8]) -> &[u8] {
        input.get(self.range()).unwrap_or(&[])
    }

    /// The span as a range of offsets.
    ///
    /// # Returns
    ///
    /// `start..start + len`.
    #[must_use]
    pub const fn range(self) -> Range<usize> {
        let start = self.start as usize;
        start..start.saturating_add(self.len as usize)
    }

    /// The span from `start` up to `end`, saturated to the 32-bit fields.
    pub(crate) fn from_offsets(start: usize, end: usize) -> Self {
        HostSpan {
            start: u32::try_from(start).unwrap_or(u32::MAX),
            len: u32::try_from(end.saturating_sub(start)).unwrap_or(0),
        }
    }

    fn from_span(span: Span) -> Self {
        HostSpan::from_offsets(span.start, span.end)
    }

    const fn pack(self) -> u64 {
        (self.start as u64) << 32 | self.len as u64
    }

    fn unpack(packed: u64) -> Option<Self> {
        (packed != ABSENT).then(|| HostSpan {
            start: u32::try_from(packed >> 32).unwrap_or(u32::MAX),
            len: u32::try_from(packed & u64::from(u32::MAX)).unwrap_or(0),
        })
    }
}

/// One field line as spans into its buffer and the interned id, laid out as the C
/// ABI's field.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HostField {
    /// The field name as received.
    pub name: HostSpan,
    /// The field value without its surrounding whitespace.
    pub value: HostSpan,
    /// The interned name's id, or [`HEADER_NONE`].
    pub id: u32,
}

impl Default for HostField {
    fn default() -> Self {
        HostField::EMPTY
    }
}

impl HostField {
    /// An empty entry with no interned name.
    pub const EMPTY: Self = HostField {
        name: HostSpan::EMPTY,
        value: HostSpan::EMPTY,
        id: HEADER_NONE,
    };

    /// The interned name.
    ///
    /// # Returns
    ///
    /// The name, or `None` when the table does not hold it.
    #[must_use]
    pub fn header(self) -> Option<HeaderName> {
        u8::try_from(self.id).ok().and_then(HeaderName::from_id)
    }

    fn from_field(field: &Field) -> Self {
        HostField {
            name: HostSpan::from_span(field.name),
            value: HostSpan::from_span(field.value),
            id: field.id.map_or(HEADER_NONE, |name| u32::from(name.id())),
        }
    }
}

/// A response body whose bytes another owner keeps, such as a buffer a host filled
/// in place; it is written as one slice and released once written.
pub trait ExternalBody: Send + Sync + 'static {
    /// The bytes to send.
    ///
    /// # Returns
    ///
    /// The body; it must not change while the response is written.
    fn bytes(&self) -> &[u8];
}

/// A response body: bytes the response owns, or an external buffer.
pub enum ResponseBody {
    /// Bytes the response owns.
    Owned(Vec<u8>),
    /// A buffer another owner keeps, written as one slice and dropped after the write.
    External(Arc<dyn ExternalBody>),
}

impl Default for ResponseBody {
    fn default() -> Self {
        ResponseBody::Owned(Vec::new())
    }
}

impl fmt::Debug for ResponseBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResponseBody::Owned(bytes) => f.debug_tuple("Owned").field(&bytes.len()).finish(),
            ResponseBody::External(body) => f
                .debug_tuple("External")
                .field(&body.bytes().len())
                .finish(),
        }
    }
}

impl ResponseBody {
    /// The bytes of the body.
    ///
    /// # Returns
    ///
    /// The owned bytes or the external buffer's bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            ResponseBody::Owned(bytes) => bytes,
            ResponseBody::External(body) => body.bytes(),
        }
    }

    /// The length of the body in octets, read from an owned buffer's length without
    /// forming a slice over its bytes, so it never aliases a body region a host is
    /// filling through the pointer [`Exchange::stage`] returned.
    ///
    /// # Returns
    ///
    /// The number of bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            ResponseBody::Owned(bytes) => bytes.len(),
            ResponseBody::External(body) => body.bytes().len(),
        }
    }

    /// Whether the body is empty, read as [`len`](Self::len) is.
    ///
    /// # Returns
    ///
    /// `true` when there are no bytes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The owned buffer, for writing; an external body is replaced by an empty owned
    /// one first.
    ///
    /// # Returns
    ///
    /// The owned bytes.
    pub fn owned_mut(&mut self) -> &mut Vec<u8> {
        match self {
            ResponseBody::Owned(bytes) => bytes,
            ResponseBody::External(_) => {
                *self = ResponseBody::Owned(Vec::new());
                self.owned_mut()
            }
        }
    }

    /// Empty the body, keeping an owned buffer's capacity and dropping an external one.
    pub(crate) fn clear(&mut self) {
        match self {
            ResponseBody::Owned(bytes) => bytes.clear(),
            ResponseBody::External(_) => *self = ResponseBody::Owned(Vec::new()),
        }
    }

    /// Shrink an owned buffer's capacity toward `capacity`.
    pub(crate) fn shrink_to(&mut self, capacity: usize) {
        if let ResponseBody::Owned(bytes) = self {
            bytes.shrink_to(capacity);
        }
    }

    /// The capacity an owned buffer holds.
    pub(crate) fn capacity(&self) -> usize {
        match self {
            ResponseBody::Owned(bytes) => bytes.capacity(),
            ResponseBody::External(_) => 0,
        }
    }
}

/// Work a host asks for that runs on the worker once the response is imported,
/// because it needs the connection: at most one per request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Action {
    /// Nothing beyond sending the response.
    #[default]
    None,
    /// Serve a file from a root directory.
    File {
        /// The root directory.
        root: Vec<u8>,
        /// The path of the file under the root.
        path: Vec<u8>,
    },
    /// Open a server-sent event stream on the connection.
    Sse {
        /// The connection id the host sends events with.
        conn: u64,
        /// The interval of the keep-alive comment, in milliseconds; 0 sends none.
        keep_alive_ms: u32,
    },
    /// Accept a WebSocket handshake on the connection.
    Ws {
        /// The connection id the host sends messages with.
        conn: u64,
        /// The subprotocol chosen, empty for none.
        protocol: Vec<u8>,
    },
}

impl Action {
    /// Whether the action reads the request head, so import copies it back.
    const fn needs_head(&self) -> bool {
        !matches!(self, Action::None)
    }
}

/// The rule that finds the client of a request behind trusted proxies.
pub type ClientRule = Arc<dyn Fn(&Request<'_>) -> Option<SocketAddr> + Send + Sync>;

/// What export keeps beyond the request itself, set once per server.
#[derive(Clone, Default)]
pub struct ExportOptions {
    /// The trailer names a host may read, compared without regard to case; a
    /// trailer whose name is not here is not offered. The trailers stay a table
    /// apart from the header fields and are never merged into them (RFC 9110
    /// Sections 6.5.1 and 6.5.2).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-6.5.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-6.5.2>
    pub trailers: Vec<Box<[u8]>>,
    /// The client of a request, from the trust-proxy rule; without a rule, or when
    /// it answers `None`, the client is the peer.
    pub client: Option<ClientRule>,
}

impl fmt::Debug for ExportOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExportOptions")
            .field("trailers", &self.trailers.len())
            .field("client", &self.client.is_some())
            .finish()
    }
}

impl ExportOptions {
    /// Whether a host may read a trailer of this name.
    ///
    /// # Arguments
    ///
    /// * `name` - the trailer field name.
    ///
    /// # Returns
    ///
    /// `true` when the name is on the allow list.
    #[must_use]
    pub fn allows_trailer(&self, name: &[u8]) -> bool {
        self.trailers
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(name))
    }
}

/// One request leased to a host and the response the host writes.
///
/// The request side is filled by [`Call::export`](crate::Call::export) and read
/// through [`request`](Self::request); the response side starts empty and is written
/// through [`response`](Self::response) and the other writers here, then moved back
/// by [`Call::import`](crate::Call::import). [`Reset`] clears both and keeps the
/// buffers' capacity up to [`BODY_KEEP`] for a body, so a warm exchange allocates
/// nothing; [`release`](Self::release) does the same and can give every buffer
/// back.
#[derive(Default)]
pub struct Exchange {
    head: Vec<u8>,
    fields: Vec<HostField>,
    parsed: Option<zero_http1::Head>,
    body: Vec<u8>,
    trailers: Vec<u8>,
    trailer_fields: Vec<HostField>,
    route_path: Vec<u8>,
    params: Vec<HostSpan>,
    peer: Option<SocketAddr>,
    secure: bool,
    client: Option<SocketAddr>,
    route: u32,
    head_as_get: bool,
    miss: Option<Miss>,
    status: Option<StatusCode>,
    response_fields: Vec<u8>,
    response_body: ResponseBody,
    action: Action,
    sealed: bool,
    staged: bool,
    touched: bool,
    request_charge: u64,
    response_charge: u64,
}

impl fmt::Debug for Exchange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Exchange")
            .field("route", &self.route)
            .field("miss", &self.miss)
            .field("head", &self.head.len())
            .field("body", &self.body.len())
            .field("status", &self.status)
            .field("response_body", &self.response_body)
            .field("action", &self.action)
            .field("sealed", &self.sealed)
            .field("staged", &self.staged)
            .field("counted", &self.counted())
            .finish_non_exhaustive()
    }
}

impl Reset for Exchange {
    /// Clear the request and the response side for the next lease; a body or
    /// trailer buffer above [`BODY_KEEP`] is shrunk to it, and the counted octets go
    /// to zero, so a caller that keeps a budget reads [`Exchange::counted`] first.
    fn reset(&mut self) {
        self.head.clear();
        self.fields.clear();
        self.parsed = None;
        self.body.clear();
        self.body.shrink_to(BODY_KEEP);
        self.trailers.clear();
        self.trailers.shrink_to(BODY_KEEP);
        self.trailer_fields.clear();
        self.route_path.clear();
        self.params.clear();
        self.peer = None;
        self.secure = false;
        self.client = None;
        self.route = 0;
        self.head_as_get = false;
        self.miss = None;
        self.clear_response();
        self.response_body.shrink_to(BODY_KEEP);
        self.sealed = false;
        self.request_charge = 0;
        self.response_charge = 0;
    }
}

impl Exchange {
    /// Clear the exchange for reuse, as [`Reset::reset`] does, and give every
    /// buffer back when the exchange is not kept warm.
    ///
    /// # Arguments
    ///
    /// * `cold` - whether every buffer's capacity goes back to the allocator.
    ///
    /// # Returns
    ///
    /// The octets the exchange still had counted, which leave the owner's budget.
    pub fn release(&mut self, cold: bool) -> u64 {
        let counted = self.counted();
        self.reset();
        if cold {
            self.head.shrink_to_fit();
            self.fields.shrink_to_fit();
            self.body.shrink_to_fit();
            self.trailers.shrink_to_fit();
            self.trailer_fields.shrink_to_fit();
            self.route_path.shrink_to_fit();
            self.params.shrink_to_fit();
            self.response_fields.shrink_to_fit();
            self.response_body.shrink_to(0);
        }
        counted
    }

    /// The octets this exchange holds on its owner's memory budget: the request
    /// body's charge from export until the release, and what
    /// [`count`](Self::count) added until the import or the release.
    ///
    /// # Returns
    ///
    /// The counted octets.
    #[must_use]
    pub const fn counted(&self) -> u64 {
        self.request_charge.saturating_add(self.response_charge)
    }

    /// Record response octets the caller added to its memory budget for this
    /// exchange. [`Call::import`](crate::Call::import) returns them when it moves
    /// the response into the request record, and [`release`](Self::release)
    /// returns whatever an import did not take, such as a canceled lease's
    /// response.
    ///
    /// # Arguments
    ///
    /// * `octets` - the octets added.
    pub fn count(&mut self, octets: u64) {
        self.response_charge = self.response_charge.saturating_add(octets);
    }

    /// The response octets [`count`](Self::count) recorded that the exchange still
    /// holds, so a caller that counts a body it replaces can add only what the new
    /// body grows.
    ///
    /// # Returns
    ///
    /// The counted response octets, 0 after an import or a release.
    #[must_use]
    pub const fn response_counted(&self) -> u64 {
        self.response_charge
    }

    /// The octets of message content the exchange holds now: the request head,
    /// body and trailers, and the response fields and body.
    ///
    /// # Returns
    ///
    /// The total length in octets.
    #[must_use]
    pub fn leased_bytes(&self) -> u64 {
        let total = self
            .head
            .len()
            .saturating_add(self.body.len())
            .saturating_add(self.trailers.len())
            .saturating_add(self.response_fields.len())
            .saturating_add(self.response_body.len());
        u64::try_from(total).unwrap_or(u64::MAX)
    }

    /// The octets of buffer capacity the exchange keeps, used or not.
    ///
    /// # Returns
    ///
    /// The capacity of every buffer, in octets.
    #[must_use]
    pub fn capacity(&self) -> usize {
        let field = mem::size_of::<HostField>();
        let param = mem::size_of::<HostSpan>();
        self.head
            .capacity()
            .saturating_add(self.fields.capacity().saturating_mul(field))
            .saturating_add(self.body.capacity())
            .saturating_add(self.trailers.capacity())
            .saturating_add(self.trailer_fields.capacity().saturating_mul(field))
            .saturating_add(self.route_path.capacity())
            .saturating_add(self.params.capacity().saturating_mul(param))
            .saturating_add(self.response_fields.capacity())
            .saturating_add(self.response_body.capacity())
    }

    /// The request as exported, through the same accessors a handler uses.
    ///
    /// # Returns
    ///
    /// The request view.
    #[must_use]
    pub fn request(&self) -> Request<'_> {
        Request {
            head: &self.head,
            fields: FieldTable::Host(&self.fields),
            parsed: self.parsed,
            body: &self.body,
            trailers: &self.trailers,
            peer: self.peer,
            secure: self.secure,
            route_path: &self.route_path,
            params: &self.params,
        }
    }

    /// The response side, through the same writers and validators a handler uses.
    ///
    /// # Returns
    ///
    /// The response view.
    pub fn response(&mut self) -> Response<'_> {
        Response {
            status: &mut self.status,
            fields: &mut self.response_fields,
            body: &mut self.response_body,
            touched: &mut self.touched,
        }
    }

    /// The field table, as spans into the head the published view points at.
    ///
    /// # Returns
    ///
    /// One entry per field line, in order.
    #[must_use]
    pub fn fields(&self) -> &[HostField] {
        &self.fields
    }

    /// The route id the request was exported for.
    ///
    /// # Returns
    ///
    /// The id given to export.
    #[must_use]
    pub const fn route(&self) -> u32 {
        self.route
    }

    /// For a request routed to the miss route, what the core would have answered.
    ///
    /// # Returns
    ///
    /// The status and the `Allow` set, or `None` for a matched route.
    #[must_use]
    pub const fn miss(&self) -> Option<Miss> {
        self.miss
    }

    /// Whether the request is HEAD served by the GET route, whose response the
    /// driver sends without a body.
    ///
    /// # Returns
    ///
    /// The flag given to export.
    #[must_use]
    pub const fn head_as_get(&self) -> bool {
        self.head_as_get
    }

    /// The client address after the trust-proxy rule.
    ///
    /// # Returns
    ///
    /// The client, which is the peer without a rule.
    #[must_use]
    pub const fn client(&self) -> Option<SocketAddr> {
        self.client
    }

    /// The first trailer with this name among those the allow list kept.
    ///
    /// # Arguments
    ///
    /// * `name` - the trailer field name, compared without regard to case.
    ///
    /// # Returns
    ///
    /// The trailer's value, or `None`.
    #[must_use]
    pub fn trailer(&self, name: &[u8]) -> Option<&[u8]> {
        self.trailer_fields
            .iter()
            .find(|field| field.name.of(&self.trailers).eq_ignore_ascii_case(name))
            .map(|field| field.value.of(&self.trailers))
    }

    /// The trailers the allow list kept, as spans into
    /// [`Request::trailers`](crate::Request::trailers).
    ///
    /// # Returns
    ///
    /// The trailer table.
    #[must_use]
    pub fn trailer_fields(&self) -> &[HostField] {
        &self.trailer_fields
    }

    /// Mark the response complete; later writes are refused by the caller's rules.
    pub fn seal(&mut self) {
        self.sealed = true;
    }

    /// Whether the response is sealed.
    ///
    /// # Returns
    ///
    /// `true` after [`seal`](Self::seal) or an action.
    #[must_use]
    pub const fn sealed(&self) -> bool {
        self.sealed
    }

    /// Whether any status, field, body or action was written since the last reset.
    ///
    /// # Returns
    ///
    /// `true` once the response was written to.
    #[must_use]
    pub const fn touched(&self) -> bool {
        self.touched
    }

    /// Whether a body region from [`stage`](Self::stage) is open.
    ///
    /// # Returns
    ///
    /// `true` while the region is open.
    #[must_use]
    pub const fn staged(&self) -> bool {
        self.staged
    }

    /// Open a body region: the body becomes `len` zero bytes the caller fills in
    /// place through the returned pointer.
    ///
    /// The pointer is valid until the body is next changed, the response is
    /// imported, or the exchange is reset; the caller refuses every other body
    /// write while the region is open, since one could move the buffer.
    ///
    /// # Arguments
    ///
    /// * `len` - the body length in octets; the caller checks it against its limit.
    ///
    /// # Returns
    ///
    /// The start of the region.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] when the response is sealed, [`Error::Protocol`] when a
    /// region is already open, and [`Error::Limit`] when no buffer can hold `len`
    /// octets or the allocator refuses them, which is asked before the body is
    /// touched; nothing changes then.
    pub fn stage(&mut self, len: usize) -> Result<*mut u8, Error> {
        if self.sealed {
            return Err(Error::Closed);
        }
        if self.staged {
            return Err(Error::Protocol("a body region is already open".to_owned()));
        }
        let refused = || Error::Limit(format!("a body region of {len} octets cannot be allocated"));
        if let ResponseBody::External(_) = self.response_body {
            let mut owned = Vec::new();
            owned.try_reserve_exact(len).map_err(|_| refused())?;
            self.response_body = ResponseBody::Owned(owned);
        }
        let body = self.response_body.owned_mut();
        body.try_reserve_exact(len.saturating_sub(body.len()))
            .map_err(|_| refused())?;
        body.clear();
        body.resize(len, 0);
        self.staged = true;
        self.touched = true;
        Ok(body.as_mut_ptr())
    }

    /// Record the action that runs on the worker after import, and seal.
    ///
    /// # Arguments
    ///
    /// * `action` - the action.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] when the response is already sealed, which also refuses a
    /// second action; nothing changes then.
    pub fn set_action(&mut self, action: Action) -> Result<(), Error> {
        if self.sealed {
            return Err(Error::Closed);
        }
        self.action = action;
        self.touched = true;
        self.sealed = true;
        Ok(())
    }

    /// The action recorded, if any.
    ///
    /// # Returns
    ///
    /// The action, [`Action::None`] when there is none.
    #[must_use]
    pub const fn action(&self) -> &Action {
        &self.action
    }

    /// Take the action out, leaving [`Action::None`].
    ///
    /// # Returns
    ///
    /// The action recorded.
    pub fn take_action(&mut self) -> Action {
        mem::take(&mut self.action)
    }

    /// Make an external buffer the body.
    ///
    /// # Arguments
    ///
    /// * `body` - the buffer; it is written as one slice and dropped after the write.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] when the response is sealed and [`Error::Protocol`] while a
    /// body region is open; nothing changes then.
    pub fn set_external(&mut self, body: Arc<dyn ExternalBody>) -> Result<(), Error> {
        if self.sealed {
            return Err(Error::Closed);
        }
        if self.staged {
            return Err(Error::Protocol("a body region is open".to_owned()));
        }
        self.response_body = ResponseBody::External(body);
        self.touched = true;
        Ok(())
    }

    /// Discard the status, the fields, the body and the action written so far; an
    /// open body region is closed and its pointer is no longer valid.
    pub fn clear_response(&mut self) {
        self.status = None;
        self.response_fields.clear();
        self.response_body.clear();
        self.action = Action::None;
        self.staged = false;
        self.touched = false;
    }

    /// Replace the response with an error in a body shape: the status, the shape's
    /// `Content-Type`, and the body of [`write_host_error`]. The caller seals.
    ///
    /// # Arguments
    ///
    /// * `shape` - the body shape.
    /// * `status` - the status; one outside 400 to 599 is answered 500.
    /// * `code` - the error's code.
    /// * `message` - the human-readable message, if any.
    /// * `details_json` - one JSON value the caller already checked, if any.
    pub fn write_error(
        &mut self,
        shape: ErrorShape,
        status: StatusCode,
        code: &str,
        message: Option<&str>,
        details_json: Option<&[u8]>,
    ) {
        self.clear_response();
        let status = error_status(status);
        self.status = Some(status);
        self.response_fields
            .extend_from_slice(shape.content_type_line());
        write_host_error(
            shape,
            status,
            code,
            message,
            details_json,
            self.response_body.owned_mut(),
        );
        self.touched = true;
    }

    /// Move the request side out of a record: the head, the body, the trailers and
    /// the route path by swaps (the record receives this exchange's cleared
    /// buffers), the field table and the parameters by copy, and the body's charge.
    ///
    /// # Returns
    ///
    /// The body octets whose charge moved from the record to this exchange.
    pub(crate) fn take_request(
        &mut self,
        record: &mut Record,
        route: u32,
        head_as_get: bool,
        options: &ExportOptions,
    ) -> u64 {
        mem::swap(&mut self.head, &mut record.head);
        self.fields.clear();
        self.fields
            .extend(record.live_fields().iter().map(HostField::from_field));
        self.parsed = record.parsed;
        mem::swap(&mut self.body, &mut record.body);
        mem::swap(&mut self.trailers, &mut record.trailers);
        self.keep_trailers(options);
        mem::swap(&mut self.route_path, &mut record.route_path);
        self.params.clear();
        self.params.extend_from_slice(record.live_params());
        self.peer = record.peer;
        self.secure = record.secure;
        self.route = route;
        self.head_as_get = head_as_get;
        self.miss = record.miss;
        let rule = options.client.as_ref();
        self.client = rule.and_then(|rule| rule(&self.request())).or(self.peer);
        let moved = mem::take(&mut record.charge);
        self.request_charge = self.request_charge.saturating_add(moved);
        moved
    }

    /// Parse the trailer section into the table, keeping the names on the allow
    /// list. The driver already validated the section against the configured
    /// limits, so the field length is not checked again.
    fn keep_trailers(&mut self, options: &ExportOptions) {
        self.trailer_fields.clear();
        if self.trailers.is_empty() || options.trailers.is_empty() {
            return;
        }
        let limits = Http1Limits {
            max_header_field: usize::MAX,
            ..Http1Limits::DEFAULT
        };
        let mut table = [Field::EMPTY; TRAILER_TABLE];
        let section = Span::new(0, self.trailers.len());
        let Ok(count) = parse_trailers(&self.trailers, section, &mut table, &limits) else {
            return;
        };
        let trailers = &self.trailers;
        self.trailer_fields.extend(
            table
                .iter()
                .take(count)
                .filter(|field| options.allows_trailer(field.name(trailers)))
                .map(HostField::from_field),
        );
    }

    /// Move the response side into a record: the status when one was set, the
    /// field lines after the record's own, and the body, whose charge leaves the
    /// exchange with it.
    ///
    /// # Returns
    ///
    /// The response octets the exchange had counted.
    pub(crate) fn give_response(&mut self, record: &mut Record) -> u64 {
        if let Some(status) = self.status.take() {
            record.status = Some(status);
        }
        if record.response_fields.is_empty() {
            mem::swap(&mut record.response_fields, &mut self.response_fields);
        } else {
            record
                .response_fields
                .extend_from_slice(&self.response_fields);
        }
        self.response_fields.clear();
        mem::swap(&mut record.response_body, &mut self.response_body);
        self.response_body.clear();
        record.touched |= self.touched;
        self.staged = false;
        mem::take(&mut self.response_charge)
    }

    /// Copy the head and the route path back into a record whose action reads the
    /// request, which makes the record's field spans valid again.
    pub(crate) fn restore_head(&self, record: &mut Record) {
        if !self.action.needs_head() {
            return;
        }
        record.head.clear();
        record.head.extend_from_slice(&self.head);
        record.route_path.clear();
        record.route_path.extend_from_slice(&self.route_path);
    }
}

/// The request of a leased exchange as atomics a host reads without the lock: the
/// worker stores them with release ordering at export, before the lease is
/// published, and a reader loads them with acquire ordering between two checks of
/// the slot's state word.
///
/// The pointers come from `Vec::as_ptr` on the exchange's buffers, which the
/// request side keeps unchanged from export until the exchange is reset; this
/// crate never reads through them.
#[derive(Debug, Default)]
pub struct PublishedView {
    head: AtomicPtr<u8>,
    head_len: AtomicU32,
    meta: AtomicU64,
    method_token: AtomicU64,
    target: AtomicU64,
    path: AtomicU64,
    query: AtomicU64,
    authority: AtomicU64,
    fields: AtomicPtr<HostField>,
    route_path: AtomicPtr<u8>,
    route_meta: AtomicU64,
    body: AtomicPtr<u8>,
    body_len: AtomicU64,
    route: AtomicU64,
    peer_high: AtomicU64,
    peer_low: AtomicU64,
    peer_meta: AtomicU64,
    client_high: AtomicU64,
    client_low: AtomicU64,
    client_meta: AtomicU64,
}

/// One load of every value a [`PublishedView`] holds, as plain integers and raw
/// pointers into the exchange's buffers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewSnapshot {
    /// The head as received; the spans index it.
    pub head: *const u8,
    /// The head's length in octets.
    pub head_len: u32,
    /// The method id, or [`METHOD_OTHER`].
    pub method: u8,
    /// The protocol version: 10 or 11.
    pub version: u8,
    /// The `VIEW_*` flags.
    pub flags: u16,
    /// The number of entries of the field table.
    pub field_count: u32,
    /// The number of route parameters.
    pub param_count: u32,
    /// The method token.
    pub method_token: HostSpan,
    /// The request target.
    pub target: HostSpan,
    /// The path of the target, without the query.
    pub path: HostSpan,
    /// The query without its `?`, when the target has one.
    pub query: Option<HostSpan>,
    /// The authority, when the request has one.
    pub authority: Option<HostSpan>,
    /// The field table, `field_count` entries with spans into the head.
    pub fields: *const HostField,
    /// The normalized path the route matched.
    pub route_path: *const u8,
    /// The length of the route path in octets.
    pub route_path_len: u32,
    /// The buffered body.
    pub body: *const u8,
    /// The body's length in octets.
    pub body_len: u64,
    /// The route id.
    pub route: u32,
    /// The status the core would have answered a request routed to the miss route,
    /// 0 for a matched route.
    pub miss_status: u16,
    /// The methods the path allows, bit `i` for method id `i`, for the miss route.
    pub allow: u16,
    /// The peer's address.
    pub peer: Option<SocketAddr>,
    /// The client after the trust-proxy rule; the peer without one.
    pub client: Option<SocketAddr>,
}

impl PublishedView {
    /// Load every published value.
    ///
    /// # Returns
    ///
    /// The values, each read with acquire ordering; a reader compares the slot's
    /// state word before and after to know they belong to one export.
    #[must_use]
    pub fn snapshot(&self) -> ViewSnapshot {
        let load = Ordering::Acquire;
        let meta = self.meta.load(load);
        let route_meta = self.route_meta.load(load);
        let route = self.route.load(load);
        ViewSnapshot {
            head: self.head.load(load).cast_const(),
            head_len: self.head_len.load(load),
            method: low_u8(meta),
            version: low_u8(meta >> 8),
            flags: low_u16(meta >> 16),
            field_count: low_u32(meta >> 32),
            param_count: low_u32(route_meta >> 32),
            method_token: HostSpan::unpack(self.method_token.load(load)).unwrap_or_default(),
            target: HostSpan::unpack(self.target.load(load)).unwrap_or_default(),
            path: HostSpan::unpack(self.path.load(load)).unwrap_or_default(),
            query: HostSpan::unpack(self.query.load(load)),
            authority: HostSpan::unpack(self.authority.load(load)),
            fields: self.fields.load(load).cast_const(),
            route_path: self.route_path.load(load).cast_const(),
            route_path_len: low_u32(route_meta),
            body: self.body.load(load).cast_const(),
            body_len: self.body_len.load(load),
            route: low_u32(route),
            miss_status: low_u16(route >> 32),
            allow: low_u16(route >> 48),
            peer: unpack_addr(
                self.peer_high.load(load),
                self.peer_low.load(load),
                self.peer_meta.load(load),
            ),
            client: unpack_addr(
                self.client_high.load(load),
                self.client_low.load(load),
                self.client_meta.load(load),
            ),
        }
    }

    /// Store the view of an exchange's request side with release ordering.
    pub(crate) fn publish(&self, exchange: &Exchange) {
        let store = Ordering::Release;
        let head = &exchange.head;
        let mut flags = 0u16;
        let mut method = METHOD_OTHER;
        let mut version = 11u8;
        let mut spans = [ABSENT; 5];
        if let Some(parsed) = exchange.parsed {
            method = parsed.method.map_or(METHOD_OTHER, |method| method.id());
            if parsed.version == Version::Http10 {
                version = 10;
            }
            if parsed.upgrade {
                flags |= VIEW_UPGRADE;
            }
            if parsed.keep_alive {
                flags |= VIEW_KEEP_ALIVE;
            }
            if parsed.expect == Expect::Continue {
                flags |= VIEW_EXPECT_CONTINUE;
            }
            let (path, query) = split_path(parsed.path, head);
            if query.is_some() {
                flags |= VIEW_QUERY;
            }
            spans = [
                HostSpan::from_span(parsed.method_token).pack(),
                HostSpan::from_span(parsed.target).pack(),
                path.pack(),
                query.map_or(ABSENT, HostSpan::pack),
                parsed
                    .authority
                    .map_or(ABSENT, |span| HostSpan::from_span(span).pack()),
            ];
        }
        if exchange.secure {
            flags |= VIEW_SECURE;
        }
        if exchange.head_as_get {
            flags |= VIEW_HEAD_AS_GET;
        }
        let [method_token, target, path, query, authority] = spans;
        let field_count = u64::try_from(exchange.fields.len()).unwrap_or(0);
        let param_count = u64::try_from(exchange.params.len()).unwrap_or(0);
        let route_path_len = u64::from(len_u32(exchange.route_path.len()));
        let (miss_status, allow) = exchange
            .miss
            .map_or((0, 0), |miss| (miss.status.as_u16(), miss.allow_mask()));
        self.head.store(head.as_ptr().cast_mut(), store);
        self.head_len.store(len_u32(head.len()), store);
        self.meta.store(
            u64::from(method)
                | u64::from(version) << 8
                | u64::from(flags) << 16
                | (field_count & u64::from(u32::MAX)) << 32,
            store,
        );
        self.method_token.store(method_token, store);
        self.target.store(target, store);
        self.path.store(path, store);
        self.query.store(query, store);
        self.authority.store(authority, store);
        self.fields
            .store(exchange.fields.as_ptr().cast_mut(), store);
        self.route_path
            .store(exchange.route_path.as_ptr().cast_mut(), store);
        self.route_meta.store(
            route_path_len | (param_count & u64::from(u32::MAX)) << 32,
            store,
        );
        self.body.store(exchange.body.as_ptr().cast_mut(), store);
        self.body_len.store(
            u64::try_from(exchange.body.len()).unwrap_or(u64::MAX),
            store,
        );
        self.route.store(
            u64::from(exchange.route) | u64::from(miss_status) << 32 | u64::from(allow) << 48,
            store,
        );
        let [high, low, meta] = pack_addr(exchange.peer);
        self.peer_high.store(high, store);
        self.peer_low.store(low, store);
        self.peer_meta.store(meta, store);
        let [high, low, meta] = pack_addr(exchange.client);
        self.client_high.store(high, store);
        self.client_low.store(low, store);
        self.client_meta.store(meta, store);
    }
}

/// The path of a target without its query, and the query without its `?`.
fn split_path(path: Span, head: &[u8]) -> (HostSpan, Option<HostSpan>) {
    match path.of(head).iter().position(|&byte| byte == b'?') {
        Some(mark) => {
            let mark = path.start.saturating_add(mark);
            (
                HostSpan::from_offsets(path.start, mark),
                Some(HostSpan::from_offsets(mark.saturating_add(1), path.end)),
            )
        }
        None => (HostSpan::from_span(path), None),
    }
}

/// A length as the view's 32-bit field.
fn len_u32(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

fn low_u8(word: u64) -> u8 {
    u8::try_from(word & 0xFF).unwrap_or(0)
}

fn low_u16(word: u64) -> u16 {
    u16::try_from(word & 0xFFFF).unwrap_or(0)
}

fn low_u32(word: u64) -> u32 {
    u32::try_from(word & u64::from(u32::MAX)).unwrap_or(0)
}

/// An address as three words: the 16 address octets (an IPv4 address in the first
/// four), and the family (4 or 6, 0 for none) with the port above it.
fn pack_addr(addr: Option<SocketAddr>) -> [u64; 3] {
    let (octets, family, port) = match addr {
        None => return [0, 0, 0],
        Some(SocketAddr::V4(v4)) => {
            let mut octets = [0u8; 16];
            for (slot, byte) in octets.iter_mut().zip(v4.ip().octets()) {
                *slot = byte;
            }
            (octets, 4u64, v4.port())
        }
        Some(SocketAddr::V6(v6)) => (v6.ip().octets(), 6u64, v6.port()),
    };
    let bits = u128::from_be_bytes(octets);
    let high = u64::try_from(bits >> 64).unwrap_or(0);
    let low = u64::try_from(bits & u128::from(u64::MAX)).unwrap_or(0);
    [high, low, family | u64::from(port) << 8]
}

fn unpack_addr(high: u64, low: u64, meta: u64) -> Option<SocketAddr> {
    let port = low_u16(meta >> 8);
    match meta & 0xFF {
        4 => Some(SocketAddr::V4(SocketAddrV4::new(
            Ipv4Addr::from(low_u32(high >> 32)),
            port,
        ))),
        6 => Some(SocketAddr::V6(SocketAddrV6::new(
            Ipv6Addr::from(u128::from(high) << 64 | u128::from(low)),
            port,
            0,
            0,
        ))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::Arc;

    use zero_core::Error;
    use zero_http_types::StatusCode;
    use zero_rt::Reset;

    use super::{
        pack_addr, unpack_addr, Action, ErrorShape, Exchange, ExportOptions, ExternalBody,
        HostField, HostSpan, ResponseBody, BODY_KEEP, HEADER_NONE,
    };
    use crate::record::{Record, TRAILER_TABLE};

    struct Shared(Vec<u8>);

    impl ExternalBody for Shared {
        fn bytes(&self) -> &[u8] {
            &self.0
        }
    }

    #[test]
    fn host_spans_and_fields_have_the_c_layout_of_two_and_five_32_bit_words() {
        assert_eq!(std::mem::size_of::<HostSpan>(), 8);
        assert_eq!(std::mem::size_of::<HostField>(), 20);
        assert_eq!(std::mem::align_of::<HostField>(), 4);
        assert_eq!(std::mem::offset_of!(HostField, value), 8);
        assert_eq!(std::mem::offset_of!(HostField, id), 16);
        assert_eq!(HostField::default().id, HEADER_NONE);
        assert_eq!(HostField::default().header(), None);
    }

    #[test]
    fn addresses_survive_the_packed_view_words() {
        for text in [
            "192.0.2.7:8080",
            "[2001:db8::1]:443",
            "[::ffff:192.0.2.1]:1",
        ] {
            let addr: SocketAddr = text.parse().unwrap();
            let [high, low, meta] = pack_addr(Some(addr));
            assert_eq!(unpack_addr(high, low, meta), Some(addr), "{text}");
        }
        let [high, low, meta] = pack_addr(None);
        assert_eq!(unpack_addr(high, low, meta), None);
    }

    #[test]
    fn release_shrinks_each_body_to_body_keep_or_to_nothing_when_cold_and_reports_the_counted_octets(
    ) {
        let mut exchange = Exchange::default();
        exchange.body.resize(BODY_KEEP * 4, 1);
        exchange.trailers.resize(BODY_KEEP * 2, 2);
        exchange.head.resize(512, 3);
        exchange.request_charge = 9;
        exchange.response().body(&vec![4; BODY_KEEP * 3]);
        exchange.count(7);
        assert_eq!(exchange.counted(), 16);
        assert_eq!(
            exchange.release(false),
            16,
            "the counted octets are reported"
        );
        assert_eq!(exchange.counted(), 0);
        assert!(exchange.body.is_empty() && exchange.body.capacity() <= BODY_KEEP);
        assert!(exchange.trailers.capacity() <= BODY_KEEP);
        assert!(exchange.response_body.capacity() <= BODY_KEEP);
        assert_eq!(exchange.head.capacity(), 512, "a head is kept as it grew");
        assert!(!exchange.touched() && !exchange.sealed());

        exchange.body.resize(100, 1);
        exchange.count(3);
        assert_eq!(exchange.release(true), 3);
        assert_eq!(exchange.capacity(), 0, "a cold exchange keeps no buffer");
    }

    #[test]
    fn moving_the_response_into_the_record_returns_the_response_octets_and_keeps_the_body_charge() {
        let mut exchange = Exchange {
            request_charge: 11,
            ..Exchange::default()
        };
        exchange.response().body(b"echo:1234");
        exchange.count(7);
        let mut record = Record::new(1);
        assert_eq!(exchange.give_response(&mut record), 7);
        assert_eq!(
            exchange.counted(),
            11,
            "the body's charge stays until release"
        );
        assert_eq!(record.response_body.as_bytes(), b"echo:1234");
        assert_eq!(
            exchange.give_response(&mut record),
            0,
            "nothing is returned twice"
        );
        assert_eq!(exchange.release(false), 11);
    }

    #[test]
    fn a_trailer_section_as_large_as_the_drivers_table_keeps_every_allowed_trailer() {
        let mut exchange = Exchange::default();
        let mut names = Vec::new();
        for index in 0..TRAILER_TABLE {
            let name = format!("X-T{index}");
            exchange
                .trailers
                .extend_from_slice(format!("{name}: {index}\r\n").as_bytes());
            names.push(Box::from(name.as_bytes()));
        }
        let options = ExportOptions {
            trailers: names,
            client: None,
        };
        exchange.keep_trailers(&options);
        assert_eq!(exchange.trailer_fields().len(), TRAILER_TABLE);
        let last = TRAILER_TABLE - 1;
        assert_eq!(
            exchange.trailer(format!("x-t{last}").as_bytes()),
            Some(last.to_string().as_bytes()),
            "the last line of a full table is kept"
        );
    }

    #[test]
    fn reset_zeroes_the_counted_octets_and_drops_an_external_body() {
        let body: Arc<dyn ExternalBody> = Arc::new(Shared(vec![1, 2, 3]));
        let mut exchange = Exchange::default();
        exchange.set_external(Arc::clone(&body)).unwrap();
        exchange.count(3);
        assert_eq!(exchange.response_body.as_bytes(), [1, 2, 3]);
        exchange.reset();
        assert_eq!(Arc::strong_count(&body), 1);
        assert_eq!(exchange.counted(), 0);
        assert!(matches!(exchange.response_body, ResponseBody::Owned(_)));
    }

    #[test]
    fn a_staged_region_is_zero_filled_refuses_a_second_region_and_closes_with_the_response() {
        let mut exchange = Exchange::default();
        exchange.response().body(b"old");
        let region = exchange.stage(5).unwrap();
        assert!(!region.is_null());
        assert_eq!(exchange.response_body.as_bytes(), [0; 5]);
        assert!(exchange.staged() && exchange.touched());
        assert!(exchange.stage(2).is_err());
        let body: Arc<dyn ExternalBody> = Arc::new(Shared(Vec::new()));
        assert!(exchange.set_external(body).is_err());
        exchange.clear_response();
        assert!(!exchange.staged() && exchange.response_body.is_empty());
    }

    #[test]
    fn a_region_no_buffer_can_hold_is_refused_as_a_limit_and_leaves_the_body_as_it_was() {
        let mut exchange = Exchange::default();
        exchange.response().body(b"kept");
        let past = usize::try_from(isize::MAX).unwrap() + 1;
        for len in [usize::MAX, past] {
            assert!(matches!(exchange.stage(len), Err(Error::Limit(_))), "{len}");
            assert_eq!(exchange.response_body.as_bytes(), b"kept");
            assert!(!exchange.staged());
        }
        let body: Arc<dyn ExternalBody> = Arc::new(Shared(b"shared".to_vec()));
        exchange.set_external(Arc::clone(&body)).unwrap();
        assert!(matches!(exchange.stage(past), Err(Error::Limit(_))));
        assert_eq!(
            exchange.response_body.as_bytes(),
            b"shared",
            "an external body is kept"
        );
        let region = exchange.stage(3).unwrap();
        assert!(!region.is_null());
        assert_eq!(exchange.response_body.as_bytes(), [0; 3]);
        assert_eq!(exchange.response_body.len(), 3);
        assert_eq!(
            Arc::strong_count(&body),
            1,
            "the region replaced the external body"
        );
    }

    #[test]
    fn the_response_counted_octets_are_what_count_added_until_the_import_takes_them() {
        let mut exchange = Exchange {
            request_charge: 11,
            ..Exchange::default()
        };
        exchange.count(7);
        exchange.count(5);
        assert_eq!(exchange.response_counted(), 12);
        assert_eq!(exchange.counted(), 23);
        let mut record = Record::new(1);
        assert_eq!(exchange.give_response(&mut record), 12);
        assert_eq!(exchange.response_counted(), 0);
        assert_eq!(exchange.counted(), 11);
    }

    #[test]
    fn one_action_seals_the_response_and_a_second_is_refused() {
        let mut exchange = Exchange::default();
        exchange
            .set_action(Action::Sse {
                conn: 4,
                keep_alive_ms: 1_000,
            })
            .unwrap();
        assert!(exchange.sealed() && exchange.touched());
        assert!(exchange.set_action(Action::None).is_err());
        assert!(exchange.stage(1).is_err());
        assert_eq!(
            exchange.take_action(),
            Action::Sse {
                conn: 4,
                keep_alive_ms: 1_000
            }
        );
        assert_eq!(*exchange.action(), Action::None);
    }

    #[test]
    fn write_error_replaces_the_response_with_the_shape_and_keeps_errors_out_of_success_statuses() {
        let mut exchange = Exchange::default();
        exchange.response().status(StatusCode::OK).body(b"partial");
        exchange.write_error(
            ErrorShape::Legacy,
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            Some("nope"),
            Some(br#"{"a":1}"#),
        );
        assert_eq!(exchange.status, Some(StatusCode::NOT_FOUND));
        assert_eq!(
            exchange.response_fields,
            b"Content-Type: application/json\r\n"
        );
        assert_eq!(
            exchange.response_body.as_bytes(),
            br#"{"error":"nope","code":"NOT_FOUND","statusCode":404,"details":{"a":1}}"#
        );
        exchange.write_error(ErrorShape::Problem, StatusCode::OK, "BROKEN", None, None);
        assert_eq!(exchange.status, Some(StatusCode::INTERNAL_SERVER_ERROR));
        assert_eq!(
            exchange.response_fields,
            b"Content-Type: application/problem+json\r\n"
        );
        assert_eq!(
            exchange.response_body.as_bytes(),
            br#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"BROKEN"}"#
        );
        assert!(exchange.touched() && !exchange.sealed());
    }
}
