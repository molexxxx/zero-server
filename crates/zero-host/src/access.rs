//! Host access: how a host thread reads a leased request and writes its response.
//!
//! A slot id names one request leased to a host. Every read of a slot's payload and
//! every write of its response by a host goes through this module, the only caller of
//! a slot's lock and published view outside the runtime's own tests, so the C ABI and
//! every binding apply the same checks. An id is resolved to its worker index and slot
//! and checked against the slot's state word before the lock is taken: a stale id is
//! refused with [`Status::Closed`] without touching the lock the worker takes to export
//! and import, an id above 2^53 - 1 with [`Status::InvalidArgument`].
//!
//! A request is read in one of three ways:
//!
//! - [`with_read`] runs a closure under the slot's lock while the slot is leased or
//!   completing, from any thread, for values the caller copies before it returns: the
//!   closure and its result are `Send`, so no raw pointer into the slot leaves it;
//! - [`with_view`] hands out the published view, with no lock and no atomic
//!   read-modify-write, whose pointers stay valid after the call;
//! - [`with_pinned_read`] runs a closure under the lock for a lookup whose result
//!   points into the slot, such as a field value, which stays valid after the call.
//!
//! The view rule governs the last two: a call that hands out a pointer into a slot
//! succeeds for a thread that holds a pin on the slot ([`pin`]), and for the thread
//! bound to the worker index's target from the delivery of the batch that leased the
//! slot until that thread acknowledges the batch or the target is detached; a thread
//! that binds after a detach is the target thread of the next target only. Any other
//! thread is refused with [`Status::InvalidArgument`]. A pointer stays valid until the
//! later of that thread's unpin and its acknowledgment, because a pinned slot is never
//! retired and an index is reused only once the acknowledgment floor passes its
//! retirement. [`with_values`] reads the published values with no rule, since it hands
//! out no pointer.
//!
//! A response is written under the lock while the slot is leased and the response is
//! not sealed, otherwise [`Status::Closed`]: the status ([`status`]), field lines
//! ([`header`], [`header_id`]), the body ([`body`], [`json`]), a body region a host
//! fills in place ([`body_alloc`]), an error in the server's error shape ([`error`]),
//! everything at once ([`respond`], [`respond_external`]), the seal ([`send`]), a
//! reset ([`reset`]), and an action the core runs once the response is back ([`file`],
//! [`sse_open`], [`ws_accept`]), which a sealed response refuses with
//! [`Status::Closed`] and an open body region with [`Status::InvalidArgument`]. The
//! actions return [`HostError`], since their refusals can name the argument they
//! refused; the other calls return [`Access`]. The response body is counted on the
//! worker index's retained memory and on the exchange at the length of the longest
//! body the response held, each write adding only what it grows that length by, since
//! a write that replaces the body reuses its buffer; the exchange hands the octets back
//! when the worker takes the response, so the core's request-memory budget sees them
//! while the host holds them.
//!
//! Refusals carry a fixed message, so refusing a call allocates nothing, except when
//! the allocator refuses a body region, which zero-http reports with a message of its
//! own before the call ends with [`Status::Limit`], and an action refusing its
//! argument.

use std::borrow::Cow;
use std::cell::RefCell;
use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use zero_core::slot::{MAX_ENCODED, MAX_WORKERS};
use zero_core::SlotId;
use zero_http::{
    is_driver_field, ErrorShape, Exchange, ExternalBody, PublishedView, ViewSnapshot, DRIVER_FIELDS,
};
use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::{HeaderName, StatusCode};
use zero_limits::services::MAX_RESPONSE_BODY;
use zero_rt::{Refused, Slot, SlotState};

use crate::registry::{self, HostExchange, WorkerShared};
use crate::target::current_token;
use crate::{HostError, Status};

/// The most pins one thread holds at once.
pub const MAX_PINS: usize = 64;

/// The worker indexes a process can hold.
const WORKERS: usize = MAX_WORKERS as usize;

/// The media type of a JSON body.
const JSON: &[u8] = b"application/json";

/// The UTF-8 byte order mark.
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// The longest error code, in octets.
const MAX_CODE: usize = 64;

/// The stored form of [`ErrorShape::Problem`].
const PROBLEM: u8 = 0;

/// The stored form of [`ErrorShape::Legacy`].
const LEGACY: u8 = 1;

/// A refused slot access: the status a binding returns and a fixed message naming
/// the refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    status: Status,
    message: &'static str,
}

impl Access {
    const fn new(status: Status, message: &'static str) -> Self {
        Access { status, message }
    }

    /// The status the call ends with, numbered as the C ABI's status codes.
    ///
    /// # Returns
    ///
    /// The status; never [`Status::Ok`].
    #[must_use]
    pub const fn status(self) -> Status {
        self.status
    }

    /// What was refused, for the host's last-error message.
    ///
    /// # Returns
    ///
    /// The message, which lives as long as the program.
    #[must_use]
    pub const fn message(self) -> &'static str {
        self.message
    }
}

impl fmt::Display for Access {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.status, self.message)
    }
}

impl std::error::Error for Access {}

impl From<Access> for HostError {
    fn from(access: Access) -> Self {
        HostError::new(access.status, access.message)
    }
}

const OUT_OF_RANGE: Access = Access::new(Status::InvalidArgument, "the slot id is above 2^53 - 1");
const NO_WORKER: Access = Access::new(
    Status::Closed,
    "the slot id names a worker index no server claimed",
);
const NO_SLOT: Access = Access::new(
    Status::Closed,
    "the slot id names an index its arena never grew to",
);
const NOT_LEASED: Access = Access::new(
    Status::Closed,
    "the slot is not leased at the generation of the id",
);
const POISONED: Access = Access::new(Status::Panic, "a panic poisoned the slot's lock");
const NO_VIEW: Access = Access::new(
    Status::InvalidArgument,
    "a view of a slot needs the calling thread's pin, or the target's thread before it acknowledged the slot's batch",
);
const PINNED: Access = Access::new(
    Status::InvalidArgument,
    "the calling thread already pinned the slot",
);
const NOT_PINNED: Access = Access::new(
    Status::InvalidArgument,
    "the calling thread holds no pin on the slot",
);
const PINS_FULL: Access = Access::new(Status::Limit, "the calling thread holds 64 pins");
const READERS_FULL: Access = Access::new(Status::Limit, "the slot counts the most pins it can");
const EXITING: Access = Access::new(Status::InvalidArgument, "the calling thread is exiting");
const SEALED: Access = Access::new(Status::Closed, "the response is sealed");
const REGION_OPEN: Access = Access::new(Status::InvalidArgument, "a body region is open");
const REGION_PIN: Access = Access::new(
    Status::InvalidArgument,
    "a body region needs the calling thread's pin on the slot",
);
const STATUS_RANGE: Access = Access::new(
    Status::InvalidArgument,
    "a host sets a status from 200 to 599",
);
const FIELD_NAME: Access = Access::new(Status::InvalidArgument, "the field name is not a token");
const FIELD_VALUE: Access = Access::new(
    Status::InvalidArgument,
    "the field value holds a control character or starts or ends with whitespace",
);
const FIELD_RESERVED: Access = Access::new(
    Status::InvalidArgument,
    "the driver writes Content-Length, Connection, Transfer-Encoding and Date itself",
);
const FIELD_REFUSED: Access = Access::new(Status::InvalidArgument, "the field line is refused");
const HEADER_ID: Access = Access::new(Status::InvalidArgument, "the header id names no header");
const BODY_LIMIT: Access = Access::new(
    Status::Limit,
    "the body is larger than the server's response limit",
);
const REGION_ALLOC: Access = Access::new(
    Status::Limit,
    "the allocator cannot give a body region of that length",
);
const ERROR_CODE: Access = Access::new(
    Status::InvalidArgument,
    "an error code is 1 to 64 octets of A to Z, 0 to 9 and _",
);

/// How a field write treats the lines already written under its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FieldMode {
    /// Replace every line of the name with this one.
    Set,
    /// Add one more line, so each value leaves as a field line of its own, as every
    /// `Set-Cookie` value must.
    Append,
}

/// The error shape and the response limit the host calls on one worker index answer
/// with.
struct Answers {
    shape: AtomicU8,
    max_body: AtomicU64,
}

impl Answers {
    const fn new() -> Self {
        Answers {
            shape: AtomicU8::new(PROBLEM),
            max_body: AtomicU64::new(MAX_RESPONSE_BODY),
        }
    }
}

static ANSWERS: [Answers; WORKERS] = [const { Answers::new() }; WORKERS];

/// Set what the host calls on worker index `worker` answer with: the error shape and
/// the response limit of the server that claimed the index, which
/// [`Server::new`](crate::Server::new) sets for every index it claims. An index no
/// server configured answers in the problem shape with the default limit.
pub(crate) fn configure(worker: u8, shape: ErrorShape, max_response_body: u64) {
    if let Some(answers) = ANSWERS.get(usize::from(worker)) {
        let stored = match shape {
            ErrorShape::Problem => PROBLEM,
            ErrorShape::Legacy => LEGACY,
        };
        answers.shape.store(stored, Ordering::Release);
        answers.max_body.store(max_response_body, Ordering::Release);
    }
}

/// The error shape of the server that holds worker index `worker`.
fn shape(worker: u8) -> ErrorShape {
    let stored = ANSWERS
        .get(usize::from(worker))
        .map(|answers| answers.shape.load(Ordering::Acquire));
    match stored {
        Some(LEGACY) => ErrorShape::Legacy,
        _ => ErrorShape::Problem,
    }
}

/// The response limit of the server that holds worker index `worker`, in octets.
fn max_body(worker: u8) -> u64 {
    ANSWERS
        .get(usize::from(worker))
        .map_or(MAX_RESPONSE_BODY, |answers| {
            answers.max_body.load(Ordering::Acquire)
        })
}

/// The slot ids a thread pinned, at most [`MAX_PINS`].
struct PinTable {
    ids: [u64; MAX_PINS],
    len: usize,
}

impl PinTable {
    const fn new() -> Self {
        PinTable {
            ids: [0; MAX_PINS],
            len: 0,
        }
    }

    fn held(&self) -> &[u64] {
        self.ids.get(..self.len).unwrap_or(&[])
    }

    fn contains(&self, id: u64) -> bool {
        self.held().contains(&id)
    }

    fn is_full(&self) -> bool {
        self.len >= MAX_PINS
    }

    fn insert(&mut self, id: u64) {
        if let Some(free) = self.ids.get_mut(self.len) {
            *free = id;
            self.len = self.len.saturating_add(1);
        }
    }

    fn remove(&mut self, id: u64) -> bool {
        let Some(position) = self.held().iter().position(|&held| held == id) else {
            return false;
        };
        let last = self.len.saturating_sub(1);
        if let Some(&moved) = self.ids.get(last) {
            if let Some(entry) = self.ids.get_mut(position) {
                *entry = moved;
            }
        }
        self.len = last;
        true
    }

    fn pop(&mut self) -> Option<u64> {
        let last = self.len.checked_sub(1)?;
        self.len = last;
        self.ids.get(last).copied()
    }
}

thread_local! {
    /// The calling thread's pins. A const initializer and no destructor, so the view
    /// rule reads it without allocating, taking a lock or registering a destructor.
    static PINS: RefCell<PinTable> = const { RefCell::new(PinTable::new()) };

    /// Touched by [`pin`] only: its destructor counts out every pin the thread still
    /// holds when it exits, since the thread can no longer use a view.
    static PIN_RELEASE: PinRelease = const { PinRelease };
}

/// Counts out the exiting thread's pins.
struct PinRelease;

impl Drop for PinRelease {
    fn drop(&mut self) {
        let _ = PINS.try_with(|pins| {
            if let Ok(mut pins) = pins.try_borrow_mut() {
                while let Some(id) = pins.pop() {
                    let _ = count_out(id);
                }
            }
        });
    }
}

/// Whether the calling thread holds a pin on `id`.
fn holds_pin(id: u64) -> bool {
    PINS.try_with(|pins| pins.try_borrow().is_ok_and(|pins| pins.contains(id)))
        .unwrap_or(false)
}

/// Count a pin out of its slot and off the worker index's gauge.
fn count_out(id: u64) -> Result<(), Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    slot.word().unpin(slot_id.generation()).map_err(refused)?;
    let pinned = &shared.counters.pinned;
    let mut current = pinned.load(Ordering::Relaxed);
    while current > 0 {
        match pinned.compare_exchange_weak(
            current,
            current.saturating_sub(1),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(seen) => current = seen,
        }
    }
    Ok(())
}

/// The worker index's state, the id and the slot `raw` names, before any check of
/// the slot's state.
fn resolve(
    raw: u64,
) -> Result<(&'static WorkerShared, SlotId, &'static Slot<HostExchange>), Access> {
    let id = match SlotId::from_raw(raw) {
        Some(id) if raw <= MAX_ENCODED => id,
        _ => return Err(OUT_OF_RANGE),
    };
    let shared: &'static WorkerShared = registry::worker(id.worker()).ok_or(NO_WORKER)?;
    let slot = shared.arena.lookup(id).map_err(|_| NO_SLOT)?;
    Ok((shared, id, slot))
}

/// The refusal a slot's refusal is reported as.
const fn refused(refusal: Refused) -> Access {
    match refusal {
        Refused::Poisoned => POISONED,
        Refused::Full => READERS_FULL,
        Refused::Stale
        | Refused::State(_)
        | Refused::Readers(_)
        | Refused::Canceled
        | Refused::Busy
        | Refused::Unknown => NOT_LEASED,
    }
}

/// Check with one load of the word that the slot is leased or completing at
/// `generation`, the states a host reads in.
fn readable(slot: &Slot<HostExchange>, generation: u32) -> Result<(), Access> {
    slot.word()
        .check_lease(generation)
        .map(drop)
        .map_err(refused)
}

/// The view rule: the calling thread holds a pin on the slot, or it is the thread
/// bound to the worker index's target, no detach waits for the worker, and the thread
/// has not acknowledged the batch that leased the slot. The pin table decides, not the
/// slot's pin count, which another thread's pin also raises. A detach unbinds the
/// target's thread at once, and until the worker settled the lost target the floor
/// does not cover that target's batches, so a thread bound since the detach reads only
/// the views of the next target's batches.
fn view_allowed(id: u64, shared: &WorkerShared, slot: &Slot<HostExchange>) -> bool {
    if holds_pin(id) {
        return true;
    }
    let token = current_token();
    token != 0
        && shared.intake.bound_thread() == token
        && !shared.intake.detaching()
        && slot.lease_epoch() > shared.intake.acked()
}

/// Read a leased or completing slot's exchange under its lock, from any thread. What
/// `read` returns is copied out before the lock is released, and no pointer into the
/// slot leaves the call, so no view rule applies: a reference cannot outlive the
/// closure's borrow of the exchange, and the closure and its result must be `Send`,
/// which a raw pointer, and a capture that stores one, are not.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `read` - the read; it runs under the lock.
///
/// # Returns
///
/// What `read` returned.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1, [`Status::Closed`] for a
/// stale or unknown id or a slot neither leased nor completing at its generation, and
/// [`Status::Panic`] when a panic poisoned the slot's lock.
///
/// # Examples
///
/// A value copied out of the slot leaves the call:
///
/// ```
/// # fn read(id: u64) -> Result<Vec<u8>, zero_host::access::Access> {
/// zero_host::access::with_read(id, |exchange| exchange.request().body().to_vec())
/// # }
/// ```
///
/// A pointer into the slot does not, returned or stored through a capture:
///
/// ```compile_fail,E0277
/// # fn read(id: u64) -> Result<*const u8, zero_host::access::Access> {
/// zero_host::access::with_read(id, |exchange| exchange.request().body().as_ptr())
/// # }
/// ```
///
/// ```compile_fail,E0277
/// # fn read(id: u64) {
/// let mut kept = std::ptr::null();
/// let _ = zero_host::access::with_read(id, |exchange| kept = exchange.request().body().as_ptr());
/// # }
/// ```
pub fn with_read<R, F>(id: u64, read: F) -> Result<R, Access>
where
    F: FnOnce(&Exchange) -> R + Send,
    R: Send,
{
    let (_, slot_id, slot) = resolve(id)?;
    slot.with_read(slot_id.generation(), |exchange| read(&exchange.0))
        .map_err(refused)
}

/// Read a slot's exchange under its lock for a lookup whose result points into the
/// slot, such as a field value or a route parameter: the view rule applies, so the
/// pointer stays valid until the later of the calling thread's unpin and its
/// acknowledgment of the slot's batch.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `read` - the lookup; it runs under the lock.
///
/// # Returns
///
/// What `read` returned.
///
/// # Errors
///
/// As [`with_read`], and [`Status::InvalidArgument`] for a thread the view rule
/// refuses.
pub fn with_pinned_read<R>(id: u64, read: impl FnOnce(&Exchange) -> R) -> Result<R, Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    let generation = slot_id.generation();
    readable(slot, generation)?;
    if !view_allowed(id, shared, slot) {
        return Err(NO_VIEW);
    }
    slot.with_read(generation, |exchange| read(&exchange.0))
        .map_err(refused)
}

/// Read a slot's published view: one acquire load of each published value between two
/// loads of the slot's word, with no lock and no atomic read-modify-write. The view
/// rule applies, so the pointers stay valid until the later of the calling thread's
/// unpin and its acknowledgment of the slot's batch.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `read` - what to take from the snapshot.
///
/// # Returns
///
/// What `read` returned.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1 or a thread the view rule
/// refuses, and [`Status::Closed`] for a stale or unknown id or a slot neither leased
/// nor completing at its generation on either load of its word.
pub fn with_view<R>(id: u64, read: impl FnOnce(&ViewSnapshot) -> R) -> Result<R, Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    let generation = slot_id.generation();
    readable(slot, generation)?;
    if !view_allowed(id, shared, slot) {
        return Err(NO_VIEW);
    }
    let view = slot
        .read_view(generation, PublishedView::snapshot)
        .map_err(refused)?;
    Ok(read(&view))
}

/// Read the values of a slot's published view from any thread, with no view rule:
/// every pointer of the snapshot is null, so only values leave the call, such as the
/// method, the route, the counts and the peer.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `read` - what to take from the snapshot.
///
/// # Returns
///
/// What `read` returned.
///
/// # Errors
///
/// As [`with_view`], without the view rule.
pub fn with_values<R>(id: u64, read: impl FnOnce(&ViewSnapshot) -> R) -> Result<R, Access> {
    let (_, slot_id, slot) = resolve(id)?;
    let mut values = slot
        .read_view(slot_id.generation(), PublishedView::snapshot)
        .map_err(refused)?;
    values.head = std::ptr::null();
    values.fields = std::ptr::null();
    values.route_path = std::ptr::null();
    values.body = std::ptr::null();
    Ok(read(&values))
}

/// Pin a slot for the calling thread: while the pin is held the slot is not retired,
/// so the views the thread reads stay valid, and a body region can be opened. The
/// count is taken first and the id recorded only once it was taken. A thread that
/// exits holding pins counts them out as it exits.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1 or a slot the calling thread
/// already pinned, [`Status::Closed`] for a stale or unknown id or a slot neither
/// leased nor completing at its generation, and [`Status::Limit`] when the thread
/// holds [`MAX_PINS`] pins or the slot counts the most pins it can.
pub fn pin(id: u64) -> Result<(), Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    let generation = slot_id.generation();
    readable(slot, generation)?;
    let (pinned, full) = PINS
        .try_with(|pins| {
            pins.try_borrow()
                .map_or((false, true), |pins| (pins.contains(id), pins.is_full()))
        })
        .map_err(|_| EXITING)?;
    if pinned {
        return Err(PINNED);
    }
    if full {
        return Err(PINS_FULL);
    }
    PIN_RELEASE.try_with(|_| ()).map_err(|_| EXITING)?;
    slot.word().pin(generation).map_err(refused)?;
    let recorded = PINS
        .try_with(|pins| {
            pins.try_borrow_mut()
                .map(|mut pins| pins.insert(id))
                .is_ok()
        })
        .unwrap_or(false);
    if !recorded {
        let _ = slot.word().unpin(generation);
        return Err(EXITING);
    }
    shared.counters.pinned.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Release the calling thread's pin on a slot. The id leaves the thread's table first
/// and the count is released only when the id was there.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1 or a slot the calling thread
/// holds no pin on.
pub fn unpin(id: u64) -> Result<(), Access> {
    if id > MAX_ENCODED {
        return Err(OUT_OF_RANGE);
    }
    let removed = PINS
        .try_with(|pins| pins.try_borrow_mut().is_ok_and(|mut pins| pins.remove(id)))
        .unwrap_or(false);
    if !removed {
        return Err(NOT_PINNED);
    }
    count_out(id)
}

/// Whether a slot's request was canceled: its lease was closed because the request's
/// connection or the worker index's target went away. A host may stop working on a
/// canceled request; its writes are refused anyway.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Returns
///
/// `true` for a canceled or closed lease.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1, [`Status::Closed`] for a
/// stale or unknown id, including a lease the worker already retired.
pub fn canceled(id: u64) -> Result<bool, Access> {
    let (_, slot_id, slot) = resolve(id)?;
    let word = slot.word();
    let states = [SlotState::Leased, SlotState::Completing, SlotState::Closed];
    match word.check(slot_id.generation(), &states) {
        Ok(SlotState::Closed) => Ok(true),
        Ok(_) => Ok(word.is_canceled()),
        Err(refusal) => Err(refused(refusal)),
    }
}

/// Run `write` on the exchange of a leased slot under its lock, with no check of the
/// seal: the test hooks write through it.
#[cfg(feature = "testing")]
pub(crate) fn with_write<R>(id: u64, write: impl FnOnce(&mut Exchange) -> R) -> Result<R, Access> {
    let (_, slot_id, slot) = resolve(id)?;
    slot.with_write(slot_id.generation(), |exchange| write(&mut exchange.0))
        .map_err(refused)
}

/// Run a response write under the slot's lock while the slot is leased at the id's
/// generation and its response is not sealed.
fn write<R>(
    id: u64,
    apply: impl FnOnce(&mut Exchange, &WorkerShared) -> Result<R, Access>,
) -> Result<R, Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    write_resolved(shared, slot_id, slot, apply)
}

/// [`write`] for a slot already resolved.
fn write_resolved<R>(
    shared: &WorkerShared,
    id: SlotId,
    slot: &Slot<HostExchange>,
    apply: impl FnOnce(&mut Exchange, &WorkerShared) -> Result<R, Access>,
) -> Result<R, Access> {
    let written = slot.with_write(id.generation(), |exchange| {
        let exchange = &mut exchange.0;
        if exchange.sealed() {
            return Err(SEALED);
        }
        apply(exchange, shared)
    });
    match written {
        Ok(outcome) => outcome,
        Err(refusal) => Err(refused(refusal)),
    }
}

/// Count a body of `len` octets a host's write left the response holding: what it adds
/// beyond the octets the exchange already counts for the response, on the worker
/// index's retained memory and on the exchange, which returns them when the worker
/// takes the response or releases the slot. A write that replaces the body reuses its
/// buffer, so the count follows the longest body the response held, not the sum of
/// the writes.
fn charge(shared: &WorkerShared, exchange: &mut Exchange, len: usize) {
    let len = u64::try_from(len).unwrap_or(u64::MAX);
    let added = len.saturating_sub(exchange.response_counted());
    if added == 0 {
        return;
    }
    shared.counters.retained.fetch_add(added, Ordering::Relaxed);
    exchange.count(added);
}

/// Whether `len` octets fit `limit`.
fn fits(len: usize, limit: u64) -> bool {
    u64::try_from(len).is_ok_and(|len| len <= limit)
}

/// Refuse a body longer than the server's response limit.
fn within_limit(shared: &WorkerShared, len: usize) -> Result<(), Access> {
    if fits(len, max_body(shared.index)) {
        Ok(())
    } else {
        Err(BODY_LIMIT)
    }
}

/// A status a host may set. RFC 9110 Section 15: "All valid status codes are within
/// the range of 100 to 599, inclusive." Every informational status is refused as
/// well: 100 belongs to the driver, which sends it for `Expect: 100-continue`, 101
/// only to an accepted upgrade, and Section 15.2 says "a server MUST NOT send a 1xx
/// response to an HTTP/1.0 client", which a host cannot tell apart from the status
/// call.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2>
fn response_status(code: u16) -> Result<StatusCode, Access> {
    match StatusCode::new(code) {
        Some(status) if !status.is_informational() => Ok(status),
        _ => Err(STATUS_RANGE),
    }
}

/// The status of a call that takes 0 for "keep what is set".
fn kept_or(code: u16) -> Result<Option<StatusCode>, Access> {
    if code == 0 {
        Ok(None)
    } else {
        response_status(code).map(Some)
    }
}

/// Refuse an interned name the driver writes itself, one of zero-http's
/// [`DRIVER_FIELDS`].
fn check_known(name: HeaderName) -> Result<(), Access> {
    if DRIVER_FIELDS.contains(&name) {
        Err(FIELD_RESERVED)
    } else {
        Ok(())
    }
}

/// Refuse a field name that is not a token (RFC 9110 Section 5.1) or that the driver
/// writes itself, as zero-http's [`is_driver_field`] decides.
fn check_name(name: &[u8]) -> Result<(), Access> {
    validate_field_name(name).map_err(|_| FIELD_NAME)?;
    if is_driver_field(name) {
        Err(FIELD_RESERVED)
    } else {
        Ok(())
    }
}

/// Refuse a value that is not a field value without surrounding whitespace (RFC 9110
/// Section 5.5).
fn check_value(value: &[u8]) -> Result<(), Access> {
    validate_field_value(value).map_err(|_| FIELD_VALUE)
}

/// Check a field line with the rule every field write of this module applies,
/// without writing it, as a binding checks a header when it is set and writes the
/// response later: the name is a token (RFC 9110 Section 5.1) the driver does not
/// write itself (zero-http's [`DRIVER_FIELDS`]), and the value is a field value:
/// visible octets and obs-text, with spaces and tabs inside it but at neither end
/// (Section 5.5).
///
/// # Arguments
///
/// * `name` - the field name.
/// * `value` - the field value.
///
/// # Errors
///
/// [`Status::InvalidArgument`] with the refusal [`header`] gives the same line: a
/// name that is not a token, a name the driver writes itself, or a value that is not
/// a field value.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
pub fn field_check(name: &[u8], value: &[u8]) -> Result<(), Access> {
    check_name(name)?;
    check_value(value)
}

/// Check every field line of a call before any is written, so a refused call leaves
/// the response as it was.
fn checked<'f, I>(fields: I) -> Result<I::IntoIter, Access>
where
    I: IntoIterator<Item = (&'f [u8], &'f [u8])>,
    I::IntoIter: Clone,
{
    let fields = fields.into_iter();
    for (name, value) in fields.clone() {
        check_name(name)?;
        check_value(value)?;
    }
    Ok(fields)
}

/// Write a status, when one is given, and append checked field lines.
fn head<'f>(
    exchange: &mut Exchange,
    status: Option<StatusCode>,
    fields: impl Iterator<Item = (&'f [u8], &'f [u8])>,
) -> Result<(), Access> {
    let mut response = exchange.response();
    if let Some(status) = status {
        response.status(status);
    }
    for (name, value) in fields {
        response.header(name, value).map_err(|_| FIELD_REFUSED)?;
    }
    Ok(())
}

/// Replace the body with `bytes` and count them.
fn replace_body(exchange: &mut Exchange, shared: &WorkerShared, bytes: &[u8]) {
    let mut response = exchange.response();
    let body = response.body_mut();
    body.clear();
    body.extend_from_slice(bytes);
    charge(shared, exchange, bytes.len());
}

/// Set the response status.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `status` - the status, 200 to 599.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a status outside 100 to 599, an informational
/// status, or an id above 2^53 - 1; [`Status::Closed`] for a stale or unknown id, a
/// slot that is not leased, or a sealed response; [`Status::Panic`] for a poisoned
/// slot. Nothing is written then.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2>
pub fn status(id: u64, status: u16) -> Result<(), Access> {
    let status = response_status(status)?;
    write(id, |exchange, _| {
        exchange.response().status(status);
        Ok(())
    })
}

/// Write a field line. [`FieldMode::Append`] adds one more line, so values given one
/// at a time leave as separate field lines: `Set-Cookie` does not use the list syntax
/// and "cannot be combined into a single field value" (RFC 9110 Section 5.3), and
/// "Origin servers and intermediaries MUST NOT combine multiple Set-Cookie header
/// fields into a single header field" (RFC 6265bis Section 3). [`FieldMode::Set`]
/// replaces every line of the name, compared without regard to case.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `name` - the field name, a token.
/// * `value` - the field value, with no control character and no surrounding
///   whitespace.
/// * `mode` - whether the line replaces the lines of its name or follows them.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a name that is not a token, a value that is not a
/// field value, a name the driver writes itself (zero-http's [`DRIVER_FIELDS`]), or an
/// id above 2^53 - 1; otherwise as [`status`].
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
/// @see <https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis#section-3>
pub fn header(id: u64, name: &[u8], value: &[u8], mode: FieldMode) -> Result<(), Access> {
    check_name(name)?;
    check_value(value)?;
    write(id, |exchange, _| {
        let mut response = exchange.response();
        let written = match mode {
            FieldMode::Set => response.set_header(name, value).map(drop),
            FieldMode::Append => response.header(name, value).map(drop),
        };
        written.map_err(|_| FIELD_REFUSED)
    })
}

/// Write a field line under an interned name, as [`header`] does.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `name` - the interned name's id.
/// * `value` - the field value.
/// * `mode` - whether the line replaces the lines of its name or follows them.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id that names no interned name; otherwise as
/// [`header`].
pub fn header_id(id: u64, name: u32, value: &[u8], mode: FieldMode) -> Result<(), Access> {
    let name = u8::try_from(name)
        .ok()
        .and_then(HeaderName::from_id)
        .ok_or(HEADER_ID)?;
    check_known(name)?;
    check_value(value)?;
    write(id, |exchange, _| {
        let mut response = exchange.response();
        let written = match mode {
            FieldMode::Set => response.set_header_id(name, value).map(drop),
            FieldMode::Append => response.header_id(name, value).map(drop),
        };
        written.map_err(|_| FIELD_REFUSED)
    })
}

/// Replace the response body with a copy of `bytes`.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `bytes` - the body.
///
/// # Errors
///
/// [`Status::Limit`] for a body longer than the server's response limit,
/// [`Status::InvalidArgument`] while a body region is open; otherwise as [`status`].
pub fn body(id: u64, bytes: &[u8]) -> Result<(), Access> {
    write(id, |exchange, shared| {
        within_limit(shared, bytes.len())?;
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        replace_body(exchange, shared, bytes);
        Ok(())
    })
}

/// Replace the response body with a copy of a JSON text and set `Content-Type` to
/// `application/json`, the media type of JSON text (RFC 8259 Section 11), replacing
/// any `Content-Type` written before. The text is not parsed.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `json` - the JSON text.
///
/// # Errors
///
/// As [`body`].
///
/// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-11>
pub fn json(id: u64, json: &[u8]) -> Result<(), Access> {
    write(id, |exchange, shared| {
        within_limit(shared, json.len())?;
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        exchange
            .response()
            .set_header_id(HeaderName::ContentType, JSON)
            .map_err(|_| FIELD_REFUSED)?;
        replace_body(exchange, shared, json);
        Ok(())
    })
}

/// A host's error code: 1 to 64 octets of `A` to `Z`, `0` to `9` and `_`.
fn error_code(code: &[u8]) -> Result<&str, Access> {
    let valid = (1..=MAX_CODE).contains(&code.len())
        && code
            .iter()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'0'..=b'9' | b'_'));
    if !valid {
        return Err(ERROR_CODE);
    }
    std::str::from_utf8(code).map_err(|_| ERROR_CODE)
}

/// A host's details text when it is one JSON value, checked with the strict parser at
/// its default limits, or `None` when it is malformed, longer than
/// [`DEFAULT_SIZE`](zero_json::parse::DEFAULT_SIZE) (1 MiB) or nested deeper than
/// [`DEFAULT_DEPTH`](zero_json::parse::DEFAULT_DEPTH) (64). RFC 8259 Section 9: "An
/// implementation may set limits on the size of texts that it accepts" and "on the
/// maximum depth of nesting"; these bound the value the check builds. A leading byte
/// order mark, which a parser "MAY ignore" (RFC 8259 Section 8.1) and which never
/// belongs inside a JSON text, is dropped, since the value is written as a member of
/// the error body.
///
/// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-8.1>
/// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-9>
fn json_value(text: &[u8]) -> Option<&[u8]> {
    zero_json::parse(text).ok()?;
    Some(text.strip_prefix(BOM).unwrap_or(text))
}

/// The octets `text` takes inside a JSON string as zero-http writes it: two for a
/// quotation mark, a reverse solidus, a line feed, a carriage return and a tab, six for
/// any other control character, which RFC 8259 Section 7 requires escaped along with
/// the first two, and one for every other octet.
///
/// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-7>
fn escaped_len(text: &str) -> usize {
    text.bytes().fold(0, |len: usize, byte| {
        let octets = match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' => 2,
            0x00..=0x1F => 6,
            _ => 1,
        };
        len.saturating_add(octets)
    })
}

/// What [`Exchange::write_error`] writes besides the message and the details.
struct Envelope<'c> {
    shape: ErrorShape,
    status: StatusCode,
    code: &'c str,
}

impl Envelope<'_> {
    /// Replace the response with the error carrying `message` and `details`; the
    /// length of the body written.
    fn write(
        &self,
        exchange: &mut Exchange,
        message: Option<&str>,
        details: Option<&[u8]>,
    ) -> usize {
        exchange.write_error(self.shape, self.status, self.code, message, details);
        exchange.response().body_mut().len()
    }
}

/// Answer with an error in the server's error shape and seal: the response written so
/// far is replaced by the status, the shape's `Content-Type` and the error body. An
/// error path never fails a second time: a status outside 400 to 599 is answered 500,
/// a message that is not UTF-8 is written with its invalid sequences replaced, and
/// details are dropped when malformed, longer than 1 MiB or nested deeper than 64, the
/// limits of zero-json's strict check. The server's response limit bounds the body as
/// written, escapes included: the message is kept when the body with it fits, then the
/// details when the body with them fits too, and each is left out otherwise. The
/// envelope of the status, the reason phrase and the code is written even under a
/// smaller limit, so the answer keeps the server's shape. Only a refusal of the call
/// itself fails it.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `status` - the status, 400 to 599.
/// * `code` - the error's code, 1 to 64 octets of `A` to `Z`, `0` to `9` and `_`.
/// * `message` - the human-readable message; without one, the reason phrase.
/// * `details` - one JSON value with the details, if any.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a code outside its alphabet or length, while a
/// body region is open, or for an id above 2^53 - 1; [`Status::Closed`] for a stale
/// or unknown id, a slot that is not leased, or a sealed response; [`Status::Panic`]
/// for a poisoned slot. Nothing is written then.
pub fn error(
    id: u64,
    status: u16,
    code: &[u8],
    message: Option<&[u8]>,
    details: Option<&[u8]>,
) -> Result<(), Access> {
    let code = error_code(code)?;
    let status = StatusCode::new(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let message: Option<Cow<'_, str>> = message.map(String::from_utf8_lossy);
    let details = details.and_then(json_value);
    write(id, |exchange, shared| {
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        let envelope = Envelope {
            shape: shape(shared.index),
            status,
            code,
        };
        let budget = max_body(shared.index);
        let bare = envelope.write(exchange, None, None);
        let message = message.as_deref().and_then(|text| {
            let len = envelope
                .write(exchange, Some(""), None)
                .saturating_add(escaped_len(text));
            fits(len, budget).then_some((text, len))
        });
        let head = message.map_or(bare, |(_, len)| len);
        let details = details.filter(|value| {
            let member = envelope
                .write(exchange, None, Some(b"0"))
                .saturating_sub(bare.saturating_add(1));
            fits(
                head.saturating_add(member).saturating_add(value.len()),
                budget,
            )
        });
        let written = envelope.write(exchange, message.map(|(text, _)| text), details);
        exchange.seal();
        charge(shared, exchange, written);
        Ok(())
    })
}

/// Open a body region: the body becomes `len` zero octets that the calling thread
/// fills in place through the returned pointer, so a host that writes less than it
/// asked for never sends another response's bytes. The region needs the calling
/// thread's pin and is valid while the pin is held and until the response is sealed;
/// while it is open, every other body write and [`reset`] are refused, so the buffer
/// cannot move, and the worker takes the response only once no pin is held. Creating
/// the pointer forms no reference to the buffer.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `len` - the body length in octets.
///
/// # Returns
///
/// The start of the region.
///
/// # Errors
///
/// [`Status::InvalidArgument`] without the calling thread's pin, while a region is
/// already open, or for an id above 2^53 - 1; [`Status::Limit`] for a length above the
/// server's response limit or one the allocator cannot give, which leaves the body as
/// it was; [`Status::Closed`] for a stale or unknown id, a slot that is not leased, or
/// a sealed response; [`Status::Panic`] for a poisoned slot.
pub fn body_alloc(id: u64, len: usize) -> Result<*mut u8, Access> {
    let (shared, slot_id, slot) = resolve(id)?;
    slot.word()
        .check(slot_id.generation(), &[SlotState::Leased])
        .map_err(refused)?;
    if !holds_pin(id) {
        return Err(REGION_PIN);
    }
    write_resolved(shared, slot_id, slot, |exchange, shared| {
        within_limit(shared, len)?;
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        let region = exchange.stage(len).map_err(|refusal| match refusal {
            zero_core::Error::Limit(_) => REGION_ALLOC,
            _ => REGION_OPEN,
        })?;
        charge(shared, exchange, len);
        Ok(region)
    })
}

/// Write the status, the field lines and the body in one call and seal. Every field
/// line is checked before any is written, so a refused call leaves the response as it
/// was; the lines are appended after those written before, each a line of its own.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `status` - the status, 200 to 599, or 0 to keep the one set before (200 when
///   none was).
/// * `fields` - the field lines as name and value, appended in order.
/// * `body` - the body; it replaces any body written before.
///
/// # Errors
///
/// As [`status`], [`header`] and [`body`].
pub fn respond<'f, I>(id: u64, status: u16, fields: I, body: &[u8]) -> Result<(), Access>
where
    I: IntoIterator<Item = (&'f [u8], &'f [u8])>,
    I::IntoIter: Clone,
{
    let status = kept_or(status)?;
    let fields = checked(fields)?;
    write(id, |exchange, shared| {
        within_limit(shared, body.len())?;
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        head(exchange, status, fields)?;
        replace_body(exchange, shared, body);
        exchange.seal();
        Ok(())
    })
}

/// Write the status and the field lines, make a buffer another owner keeps the body,
/// and seal, as a binding sends a body it staged in its own memory. The buffer is
/// written as one slice and dropped once written.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `status` - the status, 200 to 599, or 0 to keep the one set before.
/// * `fields` - the field lines as name and value, appended in order.
/// * `body` - the buffer; its bytes must not change until it is dropped.
///
/// # Errors
///
/// As [`respond`].
pub fn respond_external<'f, I>(
    id: u64,
    status: u16,
    fields: I,
    body: Arc<dyn ExternalBody>,
) -> Result<(), Access>
where
    I: IntoIterator<Item = (&'f [u8], &'f [u8])>,
    I::IntoIter: Clone,
{
    let status = kept_or(status)?;
    let fields = checked(fields)?;
    let len = body.bytes().len();
    write(id, |exchange, shared| {
        within_limit(shared, len)?;
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        head(exchange, status, fields)?;
        exchange.set_external(body).map_err(|_| REGION_OPEN)?;
        exchange.seal();
        charge(shared, exchange, len);
        Ok(())
    })
}

/// Seal the response as written. An open body region closes for the host: it may no
/// longer write to it, and the worker takes the response once no pin is held.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Errors
///
/// As [`status`], without its range.
pub fn send(id: u64) -> Result<(), Access> {
    write(id, |exchange, _| {
        exchange.seal();
        Ok(())
    })
}

/// Discard the status, the field lines, the body and the action written so far.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Errors
///
/// [`Status::InvalidArgument`] while a body region is open; otherwise as [`send`].
pub fn reset(id: u64) -> Result<(), Access> {
    write(id, |exchange, _| {
        if exchange.staged() {
            return Err(REGION_OPEN);
        }
        exchange.clear_response();
        Ok(())
    })
}

/// Check that a slot's response can still be written, as a binding does before it
/// stages a body in its own memory.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Errors
///
/// [`Status::InvalidArgument`] while a body region is open; otherwise as [`send`].
pub fn writable(id: u64) -> Result<(), Access> {
    write(id, |exchange, _| {
        if exchange.staged() {
            Err(REGION_OPEN)
        } else {
            Ok(())
        }
    })
}

/// Serve a file as the response once the host completes it, as
/// [`actions::file`](crate::actions::file) describes.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `root` - the root directory, UTF-8.
/// * `path` - the path of the file under the root, percent-encoded as a request path
///   is.
///
/// # Errors
///
/// [`Status::InvalidArgument`] while a body region is open; otherwise as
/// [`actions::file`](crate::actions::file) and [`send`]. Nothing changes then.
pub fn file(id: u64, root: &[u8], path: &[u8]) -> Result<(), HostError> {
    act(id, |exchange| crate::actions::file(exchange, root, path))
}

/// Answer with a server-sent event stream once the host completes the response, as
/// [`actions::sse_open`](crate::actions::sse_open) describes.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `keep_alive_ms` - the interval of the keep-alive comment; 0 writes none.
///
/// # Returns
///
/// The connection's id, valid at once.
///
/// # Errors
///
/// As [`file`], and as [`actions::sse_open`](crate::actions::sse_open).
pub fn sse_open(id: u64, keep_alive_ms: u32) -> Result<u64, HostError> {
    act(id, |exchange| {
        crate::actions::sse_open(id, exchange, keep_alive_ms)
    })
}

/// Accept a WebSocket route's upgrade request once the host completes the response,
/// as [`actions::ws_accept`](crate::actions::ws_accept) describes.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `protocol` - the subprotocol the client offered and the route allows; empty for
///   none.
///
/// # Returns
///
/// The connection's id, valid at once.
///
/// # Errors
///
/// As [`file`], and as [`actions::ws_accept`](crate::actions::ws_accept).
pub fn ws_accept(id: u64, protocol: &[u8]) -> Result<u64, HostError> {
    act(id, |exchange| {
        crate::actions::ws_accept(id, exchange, protocol)
    })
}

/// Record an action under the slot's lock while the slot is leased at the id's
/// generation and its response is neither sealed nor staged in a body region.
fn act<R>(
    id: u64,
    action: impl FnOnce(&mut Exchange) -> Result<R, HostError>,
) -> Result<R, HostError> {
    let (_, slot_id, slot) = resolve(id)?;
    let recorded = slot.with_write(slot_id.generation(), |exchange| {
        let exchange = &mut exchange.0;
        if exchange.sealed() {
            return Err(HostError::from(SEALED));
        }
        if exchange.staged() {
            return Err(HostError::from(REGION_OPEN));
        }
        action(exchange)
    });
    match recorded {
        Ok(outcome) => outcome,
        Err(refusal) => Err(refused(refusal).into()),
    }
}

#[cfg(test)]
mod tests {
    use zero_http::{ErrorShape, Exchange, DRIVER_FIELDS};
    use zero_http_types::StatusCode;

    use super::{escaped_len, field_check, FIELD_NAME, FIELD_RESERVED, FIELD_VALUE};
    use crate::Status;

    /// Whether the conformance entry's `responseSplitting` section accepts a line.
    fn conformance_accepts(name: &str, value: &[u8]) -> bool {
        let hex: String = value.iter().map(|byte| format!("{byte:02x}")).collect();
        let input = format!(r#"{{"cases":[{{"field":"{name}","value":"{hex}"}}]}}"#);
        let result = crate::conformance::case(b"responseSplitting", input.as_bytes())
            .expect("the entry runs the case");
        result.contains(r#""accepted":true"#)
    }

    /// RFC 9110 Sections 5.1 and 5.5: a host's field line is a token name the
    /// driver does not write and a field value without CR, LF, NUL or surrounding
    /// whitespace; the check refuses what the field writes refuse, with their
    /// refusals, and agrees with the shared vectors' rule on every value octet.
    #[test]
    fn field_check_applies_the_rule_of_the_field_writes() {
        for (name, value) in [
            (&b"X-Request-Id"[..], &b"abc"[..]),
            (b"Set-Cookie", b"a=1; Path=/"),
            (b"x-latin", b"caf\xe9"),
            (b"!#$%&'*+-.^_`|~", b"inner space"),
        ] {
            assert_eq!(field_check(name, value), Ok(()), "{name:?}");
        }
        for name in [&b""[..], b"two words", b"a:b", b"x\r\ny", b"caf\xe9"] {
            assert_eq!(field_check(name, b"1"), Err(FIELD_NAME), "{name:?}");
        }
        for name in DRIVER_FIELDS {
            assert_eq!(
                field_check(name.canonical().as_bytes(), b"1"),
                Err(FIELD_RESERVED)
            );
            assert_eq!(field_check(name.as_bytes(), b"1"), Err(FIELD_RESERVED));
        }
        for value in [
            &b"a\rb"[..],
            b"a\nb",
            b"a\r\nInjected: yes",
            b"a\0b",
            b" leading",
            b"trailing\t",
        ] {
            assert_eq!(field_check(b"X-A", value), Err(FIELD_VALUE), "{value:?}");
        }
        assert_eq!(FIELD_VALUE.status(), Status::InvalidArgument);
        for byte in 0..=u8::MAX {
            for value in [vec![byte], vec![b'a', byte, b'b']] {
                assert_eq!(
                    field_check(b"x-probe", &value).is_ok(),
                    conformance_accepts("x-probe", &value),
                    "{value:?}"
                );
            }
        }
    }

    #[test]
    fn the_refusal_of_a_field_the_driver_writes_names_every_such_field() {
        for name in DRIVER_FIELDS {
            assert!(
                FIELD_RESERVED.message().contains(name.canonical()),
                "{}",
                name.canonical()
            );
        }
    }

    /// The length of the error body the writer gives `message`.
    fn written(exchange: &mut Exchange, shape: ErrorShape, message: &str) -> usize {
        exchange.write_error(shape, StatusCode::NOT_FOUND, "CODE", Some(message), None);
        exchange.response().body_mut().len()
    }

    /// RFC 8259 Section 7: the quotation mark, the reverse solidus and U+0000 to
    /// U+001F must be escaped; the writer adds exactly the escaped length for each.
    #[test]
    fn the_escaped_length_of_a_message_is_what_the_error_writer_adds_for_it() {
        let mut exchange = Exchange::default();
        for shape in [ErrorShape::Problem, ErrorShape::Legacy] {
            let empty = written(&mut exchange, shape, "");
            for byte in 0u8..0x80 {
                let text = char::from(byte).to_string();
                assert_eq!(
                    written(&mut exchange, shape, &text) - empty,
                    escaped_len(&text),
                    "{byte:#04x}"
                );
            }
            let text = "caf\u{e9} \u{1f600} \"q\" \\ \u{7f}\r\n\t\u{0}\u{1f}";
            assert_eq!(
                written(&mut exchange, shape, text) - empty,
                escaped_len(text)
            );
        }
    }
}
