//! Targets: an isolate attaches to worker indexes with one bounded threadsafe
//! function per worker, receives each batch as dispatch arguments on its own thread,
//! and hands the answered slots back with [`batch_complete`].
//!
//! The core posts a batch from its own thread with a non-blocking call; a full
//! function queue answers `Full`, so the core keeps the batch and posts it after the
//! next acknowledgment, and a closing function answers `Gone`. The callback never
//! returns an error, because Node-API hands one to `napi_fatal_exception`: a batch
//! that is no longer in the ring (its target was detached, or the index serves a
//! newer server) becomes a skipped delivery, and a batch that cannot be handed to
//! JavaScript is answered in Rust, 500 `DISPATCH_FAILED` and acknowledged, so
//! neither its requests nor the acknowledgment order stall. The function is strong,
//! which keeps the isolate's event loop alive while it serves; detaching the target
//! or stopping the server drops the core's last handle, which releases it.
//!
//! An isolate's targets live in a thread-local of its thread. Each target registers
//! an environment cleanup hook whose data is its id and its server's id only, so an
//! isolate torn down without detaching (`worker.terminate()`, a crash) still detaches
//! its targets and their leased requests are answered, and [`target_detach`] removes
//! the hook again.
//!
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_call_threadsafe_function>
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_release_threadsafe_function>
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_add_env_cleanup_hook>

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::{
    BufferSlice, Float64ArraySlice, Function, JsValuesTupleIntoVec, Null, ToNapiValue,
};
use napi::threadsafe_function::{
    ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use napi::{sys, CleanupEnvHook, Env, JsValue};
use napi_derive::napi;
use zero_host::realtime::{EVENT_WS_CLOSE, EVENT_WS_MESSAGE, EVENT_WS_PONG, OPCODE_TEXT};
use zero_host::{
    abandon_batch, bind_thread, complete, read_batch, take_events, BatchRef, EventRec, Post,
    Server, Status, Target, BATCH_EVENTS, BATCH_REQUESTS, MAX_BATCH,
};

use crate::guard::{contained, dispose, node_guard, Code, Fail};
use crate::server::{self, Counters};
use crate::{ids, staging};

/// The octets of one request record: the slot id as a little-endian double, the
/// route id as a little-endian 32-bit integer, and 32 reserved zero bits.
pub(crate) const RECORD: usize = 16;

/// The most batches one worker's function holds in Node's queue, the ceiling of
/// `maxBatchesInFlight`, so a queue-full answer cannot occur in steady state.
const QUEUE: usize = 8;

/// The next target id.
static NEXT_TARGET: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// The targets this isolate attached, by id.
    static TARGETS: RefCell<BTreeMap<u64, TargetEntry>> = const { RefCell::new(BTreeMap::new()) };

    /// The ids of the last [`batch_complete`] call, kept so a completion allocates
    /// only when it carries more ids than any before.
    static COMPLETED: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

/// Arguments made inside a threadsafe function's callback, handed to its JavaScript
/// function as they are, so nothing that can fail runs after the callback returns.
pub struct RawArgs(Vec<sys::napi_value>);

impl RawArgs {
    /// The arguments, in order.
    pub(crate) const fn new(values: Vec<sys::napi_value>) -> Self {
        RawArgs(values)
    }
}

impl JsValuesTupleIntoVec for RawArgs {
    fn into_vec(self, _env: sys::napi_env) -> napi::Result<Vec<sys::napi_value>> {
        Ok(self.0)
    }
}

/// One WebSocket or SSE event of an event batch, as the dispatch function receives
/// it.
#[napi(object, object_from_js = false)]
pub struct ZeroEvent {
    /// The connection id.
    pub conn: f64,
    /// The route the connection was accepted on.
    pub route: u32,
    /// 1 WebSocket open, 2 message, 3 pong, 4 close, 5 drained, 6 event stream
    /// closed, 7 event stream drained.
    pub kind: u32,
    /// The opcode of a message: 1 text, 2 binary; 0 otherwise.
    pub opcode: u32,
    /// The close code of a close event: the peer's, 1005 for a Close without one,
    /// 1006 when none arrived; 0 otherwise.
    pub code: u32,
    /// A text message or a close reason as a string, a binary message or a pong's
    /// data as a `Buffer` copy, otherwise `null`.
    #[napi(ts_type = "Buffer | string | null")]
    pub data: sys::napi_value,
}

/// What one target's callbacks share with the registry.
struct TargetState {
    counters: Arc<Counters>,
    fail_next: AtomicBool,
}

/// One target of this isolate.
struct TargetEntry {
    server: u64,
    workers: Vec<u8>,
    hook: Option<CleanupEnvHook<Teardown>>,
    state: Arc<TargetState>,
}

/// The data of a target's cleanup hook: ids only, never a handle that would keep
/// the dispatch function alive.
#[derive(Clone, Copy, Debug)]
struct Teardown {
    target: u64,
    server: u64,
}

/// The dispatch function of one worker, strong and bounded at [`QUEUE`] batches.
type DispatchFunction =
    ThreadsafeFunction<BatchRef, UnknownReturnValue, RawArgs, napi::Status, false, false, QUEUE>;

/// The core's view of a worker's dispatch function.
struct TsfnTarget {
    function: DispatchFunction,
}

impl Target for TsfnTarget {
    fn post(&self, batch: BatchRef) -> Post {
        let posted = panic::catch_unwind(AssertUnwindSafe(|| {
            self.function
                .call(batch, ThreadsafeFunctionCallMode::NonBlocking)
        }));
        match posted {
            Ok(napi::Status::Ok) => Post::Taken,
            Ok(napi::Status::QueueFull) => Post::Full,
            Ok(_) => Post::Gone,
            Err(payload) => {
                dispose(payload);
                Post::Gone
            }
        }
    }
}

/// Why a batch reached the callback without becoming dispatch arguments.
enum Delivery {
    /// The ring no longer holds the batch: nothing to run, nothing to acknowledge.
    Stale,
    /// The batch is live but could not be handed to JavaScript.
    Failed,
}

/// Write each request of a batch as one record.
///
/// # Arguments
///
/// * `slots` - the slot ids, each at most 2^53 - 1.
/// * `routes` - the route ids, one per slot.
/// * `out` - room for the records.
///
/// # Returns
///
/// The octets written: [`RECORD`] per request that fit.
pub(crate) fn encode(slots: &[u64], routes: &[u32], out: &mut [u8]) -> usize {
    let mut written = 0;
    let (records, _) = out.as_chunks_mut::<RECORD>();
    for ((record, &slot), &route) in records.iter_mut().zip(slots).zip(routes) {
        let (id, rest) = record.split_at_mut(8);
        let (route_out, reserved) = rest.split_at_mut(4);
        id.copy_from_slice(&ids::number(slot).to_le_bytes());
        route_out.copy_from_slice(&route.to_le_bytes());
        reserved.fill(0);
        written += RECORD;
    }
    written
}

/// The JavaScript `null`.
fn null(env: &Env) -> napi::Result<sys::napi_value> {
    Ok(Null.into_unknown(env)?.raw())
}

/// The dispatch arguments `(worker, epoch, kind, records, events)`.
fn dispatch_values(
    env: &Env,
    batch: BatchRef,
    records: Option<sys::napi_value>,
    events: Option<sys::napi_value>,
) -> napi::Result<RawArgs> {
    let worker = env.create_uint32(u32::from(batch.worker))?.raw();
    let epoch = env.create_double(ids::number(batch.epoch))?.raw();
    let kind = env.create_uint32(u32::from(batch.kind))?.raw();
    let records = match records {
        Some(value) => value,
        None => null(env)?,
    };
    let events = match events {
        Some(value) => value,
        None => null(env)?,
    };
    Ok(RawArgs::new(vec![worker, epoch, kind, records, events]))
}

/// A skipped delivery: `records` and `events` are both `null`, and the dispatch
/// function neither runs nor acknowledges anything. Without even those values the
/// function is called with no argument, which reads the same way.
fn skip(env: &Env, batch: BatchRef) -> RawArgs {
    dispatch_values(env, batch, None, None).unwrap_or_else(|_| RawArgs::new(Vec::new()))
}

/// The payload of one event, as the dispatch function receives it.
fn payload(env: &Env, event: &EventRec) -> napi::Result<sys::napi_value> {
    let text = |data: &[u8]| -> napi::Result<sys::napi_value> {
        Ok(env.create_string(String::from_utf8_lossy(data))?.raw())
    };
    match event.kind {
        EVENT_WS_MESSAGE if event.opcode == OPCODE_TEXT => text(&event.data),
        EVENT_WS_MESSAGE | EVENT_WS_PONG => Ok(BufferSlice::copy_from(env, &event.data)?.raw()),
        EVENT_WS_CLOSE => text(&event.data),
        _ => null(env),
    }
}

/// An event batch as an array of [`ZeroEvent`].
fn events_value(env: &Env, events: &[EventRec]) -> napi::Result<sys::napi_value> {
    let length = u32::try_from(events.len()).unwrap_or(u32::MAX);
    let mut array = env.create_array(length)?;
    for (index, event) in (0..length).zip(events) {
        array.set(
            index,
            ZeroEvent {
                conn: ids::number(event.conn),
                route: event.route,
                kind: u32::from(event.kind),
                opcode: u32::from(event.opcode),
                code: u32::from(event.code),
                data: payload(env, event)?,
            },
        )?;
    }
    Ok(array.raw())
}

/// Turn a batch into the dispatch arguments.
fn arguments(env: &Env, state: &TargetState, batch: BatchRef) -> Result<RawArgs, Delivery> {
    if state.fail_next.swap(false, Ordering::AcqRel) {
        return Err(Delivery::Failed);
    }
    match batch.kind {
        BATCH_REQUESTS => {
            let mut slots = [0u64; MAX_BATCH];
            let mut routes = [0u32; MAX_BATCH];
            let count = read_batch(batch, &mut slots, &mut routes).map_err(|_| Delivery::Stale)?;
            let mut records = [0u8; RECORD * MAX_BATCH];
            let slots = slots.get(..count).unwrap_or(&[]);
            let routes = routes.get(..count).unwrap_or(&[]);
            let length = encode(slots, routes, &mut records);
            let bytes = records.get(..length).unwrap_or(&[]);
            let buffer = BufferSlice::copy_from(env, bytes).map_err(|_| Delivery::Failed)?;
            dispatch_values(env, batch, Some(buffer.raw()), None).map_err(|_| Delivery::Failed)
        }
        BATCH_EVENTS => {
            let mut events = Vec::new();
            take_events(batch, &mut events).map_err(|_| Delivery::Stale)?;
            let array = events_value(env, &events).map_err(|_| Delivery::Failed)?;
            dispatch_values(env, batch, None, Some(array)).map_err(|_| Delivery::Failed)
        }
        _ => Err(Delivery::Stale),
    }
}

/// Turn one delivery into the dispatch arguments, on the isolate thread. It never
/// fails: a stale batch becomes a skipped delivery, and a batch that cannot be handed
/// to JavaScript, or whose conversion panicked, is answered in Rust and acknowledged
/// before the skipped delivery is returned.
fn deliver(env: &Env, state: &TargetState, batch: BatchRef) -> RawArgs {
    match panic::catch_unwind(AssertUnwindSafe(|| arguments(env, state, batch))) {
        Ok(Ok(arguments)) => arguments,
        Ok(Err(Delivery::Stale)) => {
            state
                .counters
                .stale_deliveries
                .fetch_add(1, Ordering::Relaxed);
            skip(env, batch)
        }
        Ok(Err(Delivery::Failed)) => {
            contained(|| {
                let _ = abandon_batch(batch);
            });
            skip(env, batch)
        }
        Err(payload) => {
            dispose(payload);
            contained(|| {
                let _ = abandon_batch(batch);
            });
            skip(env, batch)
        }
    }
}

/// The worker indexes a target attaches to: at least one, each one of the server's,
/// none twice.
fn worker_list(server: &Server, workers: &[f64]) -> Result<Vec<u8>, Fail> {
    if workers.is_empty() {
        return Err(Fail::invalid(
            "a target attaches to at least one worker index",
        ));
    }
    let mut indexes = Vec::with_capacity(workers.len());
    for &worker in workers {
        let index = ids::worker(worker)?;
        if !server.workers().contains(&index) {
            return Err(Fail::invalid(format!(
                "worker {index} is not one of the server's"
            )));
        }
        if indexes.contains(&index) {
            return Err(Fail::invalid(format!("worker {index} is listed twice")));
        }
        indexes.push(index);
    }
    Ok(indexes)
}

/// Build one worker's dispatch function, bind this thread to the worker index and
/// attach the function as its target.
fn attach_worker(
    server: &Server,
    worker: u8,
    dispatch: &Function<'_, RawArgs, UnknownReturnValue>,
    state: &Arc<TargetState>,
) -> Result<(), Fail> {
    let delivered = Arc::clone(state);
    let function: DispatchFunction = dispatch
        .build_threadsafe_function::<BatchRef>()
        .callee_handled::<false>()
        .max_queue_size::<QUEUE>()
        .build_callback(move |context: ThreadsafeCallContext<BatchRef>| {
            Ok(deliver(&context.env, &delivered, context.value))
        })
        .map_err(|error| Fail::napi(&error))?;
    bind_thread(worker)?;
    server.attach(worker, Arc::new(TsfnTarget { function }))?;
    Ok(())
}

/// Detach a target's worker indexes, when its server still runs.
fn detach_workers(server: u64, workers: &[u8]) {
    if let Ok(server) = server::running(server) {
        for &worker in workers {
            let _ = server.detach(worker);
        }
    }
}

/// The cleanup hook: the isolate is torn down with the target still attached, so
/// its worker indexes are detached and their leased requests answered. Every run
/// counts in the server's `teardown_detaches`.
fn teardown(hook: Teardown) {
    contained(|| {
        if let Some(counters) = server::counters(hook.server) {
            counters.teardown_detaches.fetch_add(1, Ordering::Relaxed);
        }
        let entry = TARGETS
            .try_with(|targets| {
                targets
                    .try_borrow_mut()
                    .ok()
                    .and_then(|mut targets| targets.remove(&hook.target))
            })
            .ok()
            .flatten();
        if let Some(entry) = entry {
            detach_workers(entry.server, &entry.workers);
        }
    });
}

/// Run `work` on this isolate's targets.
fn with_targets<R>(
    work: impl FnOnce(&mut BTreeMap<u64, TargetEntry>) -> Result<R, Fail>,
) -> Result<R, Fail> {
    TARGETS
        .try_with(|targets| {
            let mut targets = targets
                .try_borrow_mut()
                .map_err(|_| Fail::invalid("the target registry is in use"))?;
            work(&mut targets)
        })
        .map_err(|_| Fail::closed("the isolate is shutting down"))?
}

/// Attach this isolate to worker indexes of a server: one bounded threadsafe
/// function per worker calls `dispatch(worker, epoch, kind, records, events)` on
/// this isolate's thread for every batch, and this thread becomes the one whose
/// acknowledgments count. `records` holds 16 octets per request of a request batch:
/// the slot id as a little-endian double, the route id as a little-endian 32-bit
/// integer and four zero octets; `events` holds the events of an event batch. Both
/// `null` is a skipped delivery: the batch is gone, nothing runs and nothing is
/// acknowledged. `dispatch` must not throw, since a throw from it reaches
/// `process.on('uncaughtException')`. While attached, the functions keep the event
/// loop alive; detaching, the server's stop, or the isolate's teardown releases
/// them.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `workers` - the global worker indexes to serve, from `serverWorkers`.
/// * `dispatch` - the function batches are delivered to.
///
/// # Returns
///
/// The target's id, valid in this isolate.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for an empty list, an index of another server or one
/// listed twice, or an index another thread is bound to; `ZERO_LIMIT` when an index
/// already has a target or Node-API cannot create a function; `ZERO_CLOSED` for an
/// unknown or stopped server. Nothing stays attached then.
#[napi(
    catch_unwind,
    ts_args_type = "server: number, workers: number[], dispatch: (worker: number, epoch: number, kind: number, records: Buffer | null, events: ZeroEvent[] | null) => void"
)]
pub fn target_attach(
    env: &Env,
    server: f64,
    workers: Vec<f64>,
    dispatch: Function<'_, RawArgs, UnknownReturnValue>,
) -> napi::Result<f64, Code> {
    node_guard(|| {
        let (server_id, server) = server::running_arg(server)?;
        let counters = server::counters(server_id)
            .ok_or_else(|| Fail::closed(format!("no server {server_id}")))?;
        let indexes = worker_list(&server, &workers)?;
        let id = NEXT_TARGET.fetch_add(1, Ordering::Relaxed);
        if id > ids::ID_MAX {
            return Err(Fail::new(
                Code::LIMIT,
                "the process handed out every target id",
            ));
        }
        let state = Arc::new(TargetState {
            counters,
            fail_next: AtomicBool::new(false),
        });
        let mut attached = Vec::with_capacity(indexes.len());
        for &worker in &indexes {
            if let Err(fail) = attach_worker(&server, worker, &dispatch, &state) {
                detach_workers(server_id, &attached);
                return Err(fail);
            }
            attached.push(worker);
        }
        let teardown_data = Teardown {
            target: id,
            server: server_id,
        };
        let hook = match env.add_env_cleanup_hook(teardown_data, teardown) {
            Ok(hook) => hook,
            Err(error) => {
                detach_workers(server_id, &attached);
                return Err(Fail::napi(&error));
            }
        };
        let entry = TargetEntry {
            server: server_id,
            workers: indexes,
            hook: Some(hook),
            state,
        };
        let stored = with_targets(|targets| {
            targets.insert(id, entry);
            Ok(())
        });
        if let Err(fail) = stored {
            let _ = env.remove_env_cleanup_hook(hook);
            detach_workers(server_id, &attached);
            return Err(fail);
        }
        Ok(ids::number(id))
    })
}

/// Detach a target of this isolate: its worker indexes close the target's leases and
/// answer them 503, fail its queued requests the same way, and release its
/// functions, so the event loop can exit; its cleanup hook is removed. Deliveries
/// still in Node's queue arrive as skipped deliveries.
///
/// # Arguments
///
/// * `target` - the target id.
///
/// # Errors
///
/// `ZERO_CLOSED` for a target this isolate does not hold.
#[napi(catch_unwind)]
pub fn target_detach(env: &Env, target: f64) -> napi::Result<(), Code> {
    node_guard(|| {
        let id = ids::id(target, "the target id")?;
        let entry = with_targets(|targets| {
            targets
                .remove(&id)
                .ok_or_else(|| Fail::closed(format!("no target {id} in this isolate")))
        })?;
        if let Some(hook) = entry.hook {
            let _ = env.remove_env_cleanup_hook(hook);
        }
        detach_workers(entry.server, &entry.workers);
        Ok(())
    })
}

/// Make the next batch delivered to a target of this isolate fail as a failed
/// conversion would: its requests are answered 500 `DISPATCH_FAILED` and it is
/// acknowledged, and the batch after it is delivered as usual. A test hook, left
/// out of the typed surface.
///
/// # Arguments
///
/// * `target` - the target id.
///
/// # Errors
///
/// `ZERO_CLOSED` for a target this isolate does not hold.
#[napi(catch_unwind, js_name = "__failNextDelivery", skip_typescript)]
pub fn fail_next_delivery(target: f64) -> napi::Result<(), Code> {
    node_guard(|| {
        let id = ids::id(target, "the target id")?;
        with_targets(|targets| {
            let entry = targets
                .get(&id)
                .ok_or_else(|| Fail::closed(format!("no target {id} in this isolate")))?;
            entry.state.fail_next.store(true, Ordering::Release);
            Ok(())
        })
    })
}

/// Hand answered slots back to a worker and, from the thread bound to its target,
/// acknowledge a batch. Each id is checked on its own: an id that is stale, closed,
/// of another worker or not a slot id is skipped, and the others are applied with
/// one wake of the worker. A slot completed without a response is answered 500
/// `NO_RESPONSE`. The staged body of a completed slot that was never sent is dropped.
///
/// # Arguments
///
/// * `worker` - the worker index the ids belong to.
/// * `ids` - the completion buffer; its first `count` entries are slot ids.
/// * `count` - how many entries to apply.
/// * `epoch` - the epoch of the batch to acknowledge, or 0 for none.
///
/// # Returns
///
/// 0, or 9 (`InvalidArgument`) when the acknowledgment was refused, from another
/// thread or out of order; the ids were applied either way.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a worker index outside 0 to 127, a count past the
/// buffer or an epoch that is not a whole number, and `ZERO_CLOSED` for a worker
/// index no server ever claimed.
#[napi(catch_unwind)]
pub fn batch_complete(
    worker: f64,
    ids: Float64ArraySlice<'_>,
    count: f64,
    epoch: f64,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let worker = ids::worker(worker)?;
        let count = ids::length(count, "the count")?;
        let epoch = ids::id(epoch, "the epoch")?;
        let entries = ids
            .get(..count)
            .ok_or_else(|| Fail::invalid("the count is past the end of the buffer"))?;
        COMPLETED
            .try_with(|completed| {
                let mut completed = completed
                    .try_borrow_mut()
                    .map_err(|_| Fail::invalid("the completion buffer is in use"))?;
                completed.clear();
                completed.extend(
                    entries
                        .iter()
                        .map(|&entry| ids::whole_in(entry, ids::ID_MAX).unwrap_or(u64::MAX)),
                );
                staging::forget(&completed);
                match complete(worker, &completed, epoch, None) {
                    Ok(()) => Ok(Status::Ok.code()),
                    Err(error) if epoch != 0 && error.status() == Status::InvalidArgument => {
                        Ok(Status::InvalidArgument.code())
                    }
                    Err(error) => Err(Fail::from(error)),
                }
            })
            .map_err(|_| Fail::closed("the isolate is shutting down"))?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(records: &[u8]) -> Vec<(u64, u32, u32)> {
        records
            .as_chunks::<RECORD>()
            .0
            .iter()
            .map(|record| {
                let mut id = [0u8; 8];
                let mut route = [0u8; 4];
                let mut reserved = [0u8; 4];
                id.copy_from_slice(&record[..8]);
                route.copy_from_slice(&record[8..12]);
                reserved.copy_from_slice(&record[12..16]);
                (
                    f64::from_le_bytes(id) as u64,
                    u32::from_le_bytes(route),
                    u32::from_le_bytes(reserved),
                )
            })
            .collect()
    }

    #[test]
    fn a_request_record_is_a_little_endian_double_id_a_route_and_four_zero_octets() {
        let slots = [0, 1, 4_097, (1 << 32) + 5, ids::ID_MAX];
        let routes = [7, 0, u32::MAX, 12, 3];
        let mut out = [0xAAu8; RECORD * 8];
        let written = encode(&slots, &routes, &mut out);
        assert_eq!(written, RECORD * slots.len());
        let decoded = decode(&out[..written]);
        let expected: Vec<(u64, u32, u32)> = slots
            .iter()
            .zip(routes)
            .map(|(&slot, route)| (slot, route, 0))
            .collect();
        assert_eq!(decoded, expected);
        assert!(
            out[written..].iter().all(|&byte| byte == 0xAA),
            "nothing past the records"
        );
        assert_eq!(&out[..8], &0f64.to_le_bytes());
        assert_eq!(&out[8..12], &7u32.to_le_bytes());
    }

    #[test]
    fn a_full_batch_fits_its_record_buffer_and_a_short_buffer_takes_what_fits() {
        let slots: Vec<u64> = (0..MAX_BATCH as u64).map(|slot| slot * 3).collect();
        let routes: Vec<u32> = (0..MAX_BATCH as u32).collect();
        let mut out = vec![0u8; RECORD * MAX_BATCH];
        assert_eq!(encode(&slots, &routes, &mut out), RECORD * MAX_BATCH);
        assert_eq!(decode(&out).len(), MAX_BATCH);
        let mut short = [0u8; RECORD * 2 + 3];
        assert_eq!(encode(&slots, &routes, &mut short), RECORD * 2);
    }
}
