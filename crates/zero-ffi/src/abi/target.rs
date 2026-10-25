//! Pull targets and completion: a host thread blocks in `zero_target_poll` for the next
//! batch of one worker index, or of every worker index of a server, and hands the
//! answered slots back with `zero_batch_complete`.
//!
//! The first thread to poll a target binds it, and only that thread's acknowledgments
//! count. A request batch's slot ids and route ids are copied into the host's arrays; an
//! event batch's payloads move into the target's delivery storage, where the
//! `ZeroEvent` records point, until the next poll or the detach. Nothing a worker owns
//! escapes except those views and the request views of the view rule, and the library
//! never calls into the host: the host's thread calls in and waits.

use std::mem::size_of;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;

use zero_host::realtime::{EVENT_WS_CLOSE, EVENT_WS_MESSAGE, EVENT_WS_PONG};
use zero_host::{EventRec, PullTarget, Status, BATCH_REQUESTS, MAX_BATCH};

use crate::abi::names::{ZERO_ALL_WORKERS, ZERO_EPOCH_NONE};
use crate::abi::{ZeroBatch, ZeroBytes, ZeroEvent, ZeroStatus};
use crate::guard::{guard, Fail};
use crate::ids::Table;
use crate::ptr::{self as host, Zeroed, PTRDIFF_MAX};

/// A pull target and the delivery storage of its event payloads.
pub(crate) struct TargetRecord {
    target: Arc<PullTarget>,
    delivery: Mutex<Vec<EventRec>>,
}

/// Every target a host attached and has not detached.
pub(crate) static TARGETS: Table<Arc<TargetRecord>> = Table::new(
    "the target id is unknown or was detached",
    "a panic poisoned the target table",
);

const WORKER: Fail = Fail::invalid("the worker is not a worker index or ZERO_ALL_WORKERS");
const WORKER_RANGE: Fail = Fail::invalid("the worker index is not below 128");
const SHORT_CAP: Fail = Fail::invalid("the batch arrays hold fewer than ZERO_MAX_BATCH entries");
const SMALL_EVENT: Fail = Fail::invalid("event_size is below the version 1 size of ZeroEvent");
const LONG_ARRAY: Fail = Fail::invalid("an array is longer than PTRDIFF_MAX octets");
const BUSY: Fail = Fail::invalid(
    "another thread is polling the target, which is bound to the thread that polled it first",
);
const POISONED: Fail = Fail::panic("a panic poisoned the target's delivery storage");

/// The `ZeroEvent` record of one event, its data pointing into the delivery storage.
fn event_of(event: &EventRec) -> ZeroEvent {
    let data = match event.kind {
        EVENT_WS_MESSAGE | EVENT_WS_PONG | EVENT_WS_CLOSE => ZeroBytes::of(&event.data),
        _ => ZeroBytes::ABSENT,
    };
    ZeroEvent {
        conn: event.conn,
        route: event.route,
        kind: event.kind,
        opcode: event.opcode,
        close_code: event.code,
        data,
    }
}

/// Attaches a pull target to one of a server's worker indexes, or to every one of them
/// served from one queue. A worker index has at most one target.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `worker` - a global worker index from `zero_server_workers`, or `ZERO_ALL_WORKERS`.
/// * `target_out` - receives the target's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a worker index of another server or outside the indexes;
/// `Limit` when a worker index already has a target; `Closed` once a stop of the server
/// began, or for an unknown server.
///
/// # Safety
///
/// `target_out` must be NULL or point to a writable `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_target_attach(
    server: u64,
    worker: u32,
    target_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(target_out)?;
        let worker = if worker == ZERO_ALL_WORKERS {
            None
        } else {
            Some(u8::try_from(worker).map_err(|_| WORKER)?)
        };
        let target = crate::abi::server::server(server)?.attach_pull(worker)?;
        let record = Arc::new(TargetRecord {
            target: Arc::clone(&target),
            delivery: Mutex::new(Vec::new()),
        });
        let id = match TARGETS.insert(record) {
            Ok(id) => id,
            Err(fail) => {
                target.detach();
                return Err(fail);
            }
        };
        // SAFETY: outputs: `target_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(target_out, size_of::<u64>(), &[id]) }
    })
}

/// Waits for the next batch of a target and copies it out.
///
/// The first thread to poll binds the target. A request batch writes its slot ids to
/// `slots` and their route ids to `routes`; an event batch writes one `ZeroEvent` per
/// event to `events`, `event_size` octets apart, whose payloads stay valid until the next
/// poll on this target or its detach. `batch_out` says which and how many.
///
/// # Arguments
///
/// * `target` - the target's id.
/// * `timeout_ms` - how long to wait in milliseconds; 0 checks once, `ZERO_NONE` waits
///   as long as it takes.
/// * `batch_out` - receives the batch; its `size` is set before the call.
/// * `slots` - receives a request batch's slot ids, `cap` entries.
/// * `routes` - receives their route ids, `cap` entries.
/// * `events` - receives an event batch's records, `cap` entries.
/// * `event_size` - the size of one `ZeroEvent` as the host built the array.
/// * `cap` - the entries each array holds, at least `ZERO_MAX_BATCH`.
///
/// # Returns
///
/// `ZeroStatus_Ok` with a batch written, or a refusal.
///
/// # Errors
///
/// `Timeout` when nothing arrived in time or `zero_target_wake` ended the wait; `Closed`
/// once the target is detached or its server stopped, or for an unknown target;
/// `InvalidArgument` on an I/O worker thread, on a thread other than the bound one, for
/// a `cap` below `ZERO_MAX_BATCH`, an `event_size` below the version 1 size, or an
/// output the rules refuse.
///
/// # Safety
///
/// `batch_out` must be NULL or a writable struct of at least its `size` octets; `slots`,
/// `routes` and `events` must be NULL or writable arrays of `cap` entries, those of
/// `events` `event_size` octets each.
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_target_poll(
    target: u64,
    timeout_ms: u64,
    batch_out: *mut ZeroBatch,
    slots: *mut u64,
    routes: *mut u32,
    events: *mut ZeroEvent,
    event_size: usize,
    cap: usize,
) -> ZeroStatus {
    guard(|| {
        if cap < MAX_BATCH {
            return Err(SHORT_CAP);
        }
        if event_size < ZeroEvent::V1_SIZE {
            return Err(SMALL_EVENT);
        }
        if cap
            .checked_mul(event_size)
            .is_none_or(|bytes| bytes > PTRDIFF_MAX)
        {
            return Err(LONG_ARRAY);
        }
        // SAFETY: sized structs: `batch_out` is NULL or a writable struct whose size the
        // host set.
        let written = unsafe { host::out_size(batch_out) }?;
        host::check_out(slots)?;
        host::check_out(routes)?;
        host::check_out(events)?;
        let record = TARGETS.get(target)?;
        let mut delivery = match record.delivery.try_lock() {
            Ok(delivery) => delivery,
            Err(TryLockError::WouldBlock) => return Err(BUSY),
            Err(TryLockError::Poisoned(_)) => return Err(POISONED),
        };
        let mut ids = [0u64; MAX_BATCH];
        let mut route_ids = [0u32; MAX_BATCH];
        let batch = record.target.poll(
            Duration::from_millis(timeout_ms),
            &mut ids,
            &mut route_ids,
            &mut delivery,
        )?;
        let count = if batch.kind == BATCH_REQUESTS {
            let count =
                usize::try_from(batch.count).map_or(MAX_BATCH, |count| count.min(MAX_BATCH));
            let taken = ids.get(..count).unwrap_or_default();
            // SAFETY: outputs: `slots` was checked and holds `cap` entries, at least a batch.
            unsafe { host::write_elements(slots, size_of::<u64>(), taken) }?;
            let taken = route_ids.get(..count).unwrap_or_default();
            // SAFETY: outputs: `routes` was checked and holds `cap` entries, at least a batch.
            unsafe { host::write_elements(routes, size_of::<u32>(), taken) }?;
            count
        } else {
            let mut records = [ZeroEvent::ZERO; MAX_BATCH];
            for (record, event) in records.iter_mut().zip(delivery.iter()) {
                *record = event_of(event);
            }
            let count = delivery.len().min(MAX_BATCH);
            let taken = records.get(..count).unwrap_or_default();
            // SAFETY: outputs: `events` was checked and holds `cap` entries of
            // `event_size` octets, at least a batch.
            unsafe { host::write_elements(events, event_size, taken) }?;
            count
        };
        let batch = ZeroBatch {
            size: 0,
            worker: batch.worker,
            kind: batch.kind,
            flags: 0,
            count: u32::try_from(count).unwrap_or(u32::MAX),
            reserved: 0,
            epoch: batch.epoch,
        };
        // SAFETY: sized structs: `written` came from `out_size` for this `batch_out`.
        unsafe { host::write_sized(batch_out, written, batch) }
    })
}

/// Ends a poll blocked on a target with `ZeroStatus_Timeout`, or the next poll when none
/// is blocked.
///
/// # Arguments
///
/// * `target` - the target's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for an unknown or detached target.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_target_wake(target: u64) -> ZeroStatus {
    guard(|| {
        TARGETS.get(target)?.target.wake();
        Ok(())
    })
}

/// Detaches a target: the worker indexes it serves close its leases and answer them
/// 503, fail its queued requests the same way, and release the slots it held. The id is
/// released and the target's event views end. The target's thread holds no view through
/// it afterward and makes no view call through it.
///
/// # Arguments
///
/// * `target` - the target's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for an unknown or detached target.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_target_detach(target: u64) -> ZeroStatus {
    guard(|| {
        let record = TARGETS.remove(target)?;
        record.target.detach();
        Ok(())
    })
}

/// Hands answered slots back to their worker and, from the thread bound to the worker's
/// target, acknowledges a batch.
///
/// Each id is checked on its own: an id above `ZERO_ID_MAX` or of another worker index
/// is `InvalidArgument`, and a stale id or a slot neither leased nor completing is
/// `Closed`. The accepted ids are applied with one wake of the worker per 256 ids. A
/// slot completed without a response is answered 500 `NO_RESPONSE`. An acknowledgment
/// is accepted only from the bound thread, for the epoch after the last one
/// acknowledged; a refused one changes nothing but is reported, and the ids of the
/// call are applied anyway.
///
/// # Arguments
///
/// * `worker` - the worker index the ids belong to, `ZeroBatch.worker`.
/// * `slots` - the answered slot ids.
/// * `count` - how many.
/// * `epoch` - the epoch to acknowledge, or `ZERO_EPOCH_NONE`.
/// * `results_out` - NULL, or receives the status of each id, `count` entries, also when
///   the call fails.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a worker index of 128 or more, a refused acknowledgment (from
/// another thread or out of order), or an argument the rules refuse; `Closed` for a
/// worker index no server claimed.
///
/// # Safety
///
/// `slots` must be a readable array of `count` ids, and `results_out` NULL or a writable
/// array of `count` statuses.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_batch_complete(
    worker: u8,
    slots: *const u64,
    count: usize,
    epoch: u64,
    results_out: *mut ZeroStatus,
) -> ZeroStatus {
    guard(|| {
        if u32::from(worker) >= zero_core::slot::MAX_WORKERS {
            return Err(WORKER_RANGE);
        }
        // SAFETY: input arrays: `slots` is `count` readable ids for the call.
        let ids = unsafe { host::read_slice(slots, count) }?;
        let report = !results_out.is_null();
        if report {
            host::check_out(results_out)?;
            if count
                .checked_mul(size_of::<ZeroStatus>())
                .is_none_or(|bytes| bytes > PTRDIFF_MAX)
            {
                return Err(LONG_ARRAY);
            }
        }
        if ids.is_empty() {
            return zero_host::complete(worker, &[], epoch, None).map_err(Fail::from);
        }
        let chunks = ids.len().div_ceil(MAX_BATCH);
        for (index, chunk) in ids.chunks(MAX_BATCH).enumerate() {
            let acknowledged = if index.saturating_add(1) == chunks {
                epoch
            } else {
                ZERO_EPOCH_NONE
            };
            let mut statuses = [Status::Closed; MAX_BATCH];
            let statuses = statuses.get_mut(..chunk.len()).unwrap_or_default();
            let outcome = zero_host::complete(
                worker,
                chunk,
                acknowledged,
                report.then_some(&mut *statuses),
            );
            if report {
                let mut reported = [ZeroStatus::Closed; MAX_BATCH];
                for (into, status) in reported.iter_mut().zip(statuses.iter()) {
                    *into = ZeroStatus::from_host(*status);
                }
                let reported = reported.get(..chunk.len()).unwrap_or_default();
                let at = results_out.wrapping_add(index.saturating_mul(MAX_BATCH));
                // SAFETY: outputs: `results_out` was checked and holds `count` entries,
                // and `at` starts this chunk's entries inside them.
                unsafe { host::write_elements(at, size_of::<ZeroStatus>(), reported) }?;
            }
            outcome?;
        }
        Ok(())
    })
}

impl Zeroed for ZeroEvent {
    const ZERO: Self = ZeroEvent {
        conn: 0,
        route: 0,
        kind: 0,
        opcode: 0,
        close_code: 0,
        data: ZeroBytes::ABSENT,
    };
}
