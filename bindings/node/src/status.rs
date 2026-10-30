//! The status callback: the core's status events (a core started or stopped, a
//! contained panic, a failed host dispatch, a batch given up on) delivered to an
//! isolate.
//!
//! The core reports an event on the core's own thread, and a batch given up on is
//! reported on the thread that gave it up, so the event crosses through a weak
//! threadsafe function, which never keeps the isolate's event loop alive, bounded at
//! 16 queued calls. Node-API keeps nothing of a call it refuses, and a
//! refused call's payload would be lost, so the binding counts the calls in Node's
//! queue itself and drops an event that would make it 17 before any call, counting
//! it in `status_dropped`. A call carries only the event's kind, core and sequence
//! number; the message text waits in a ring of the last 64 details, which the
//! callback reads on the isolate thread (a detail already overwritten reads as an
//! empty string). No host code runs on a core thread.

use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Function;
use napi::threadsafe_function::{
    ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use napi::{Env, JsValue};
use napi_derive::napi;
use zero_host::{Event, StatusSink};

use crate::guard::{contained, dispose, lock, node_guard, Code, Fail};
use crate::server::{self, Counters};
use crate::target::RawArgs;

/// The most calls the status function holds in Node's queue.
const QUEUED_MAX: u32 = 16;

/// How many status details the ring keeps.
const DETAILS: u64 = 64;

/// What a status call carries: the event's kind, its core and its sequence number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StatusRef {
    kind: Kind,
    core: u8,
    seq: u64,
}

/// The kinds of status event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Started,
    Stopped,
    TaskPanic,
    WorkerPanic,
    HostFailed,
    DispatchFailed,
}

impl Kind {
    /// The name the callback receives.
    const fn name(self) -> &'static str {
        match self {
            Kind::Started => "started",
            Kind::Stopped => "stopped",
            Kind::TaskPanic => "taskPanic",
            Kind::WorkerPanic => "workerPanic",
            Kind::HostFailed => "hostFailed",
            Kind::DispatchFailed => "dispatchFailed",
        }
    }
}

/// The kind, the core and the detail text of an event.
fn describe(event: Event) -> (Kind, usize, String) {
    match event {
        Event::Started { core } => (Kind::Started, core, String::new()),
        Event::Stopped { core } => (Kind::Stopped, core, String::new()),
        Event::TaskPanic { core, message } => (Kind::TaskPanic, core, message),
        Event::WorkerPanic { core, message } => (Kind::WorkerPanic, core, message),
        Event::HostFailed { core, message } => (Kind::HostFailed, core, message),
        Event::DispatchFailed { core, message, .. } => (Kind::DispatchFailed, core, message),
    }
}

/// The last 64 status details, by sequence number.
#[derive(Debug)]
pub(crate) struct Details {
    next: u64,
    entries: Vec<(u64, String)>,
}

impl Details {
    /// An empty ring.
    pub(crate) fn new() -> Self {
        let capacity = usize::try_from(DETAILS).unwrap_or(64);
        Details {
            next: 0,
            entries: (0..capacity).map(|_| (u64::MAX, String::new())).collect(),
        }
    }

    /// Keep a detail and give it the next sequence number, overwriting the detail 64
    /// numbers older.
    pub(crate) fn record(&mut self, text: String) -> u64 {
        let seq = self.next;
        self.next = seq.wrapping_add(1);
        if let Some(entry) = self.entry(seq) {
            *entry = (seq, text);
        }
        seq
    }

    /// The detail of a sequence number, or an empty string once it was overwritten.
    pub(crate) fn read(&self, seq: u64) -> String {
        usize::try_from(seq % DETAILS)
            .ok()
            .and_then(|index| self.entries.get(index))
            .filter(|(kept, _)| *kept == seq)
            .map(|(_, text)| text.clone())
            .unwrap_or_default()
    }

    fn entry(&mut self, seq: u64) -> Option<&mut (u64, String)> {
        let index = usize::try_from(seq % DETAILS).ok()?;
        self.entries.get_mut(index)
    }
}

/// The status function, weak and bounded at 16 queued calls.
type StatusFunction = ThreadsafeFunction<
    StatusRef,
    UnknownReturnValue,
    RawArgs,
    napi::Status,
    false,
    true,
    { QUEUED_MAX as usize },
>;

/// What the core's sink and the isolate's callback share.
struct StatusChannel {
    queued: AtomicU32,
    details: Mutex<Details>,
    counters: Arc<Counters>,
}

impl StatusChannel {
    /// Take one place in Node's queue, unless 16 calls already wait there.
    fn reserve(&self) -> bool {
        let mut queued = self.queued.load(Ordering::Acquire);
        loop {
            if queued >= QUEUED_MAX {
                return false;
            }
            match self.queued.compare_exchange_weak(
                queued,
                queued.saturating_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(seen) => queued = seen,
            }
        }
    }

    /// Hand one event to the isolate, on the core's thread: keep its detail, take a
    /// place in Node's queue or drop it, then call.
    fn post(&self, function: &StatusFunction, event: Event) {
        self.counters.status_events.fetch_add(1, Ordering::Relaxed);
        let (kind, core, detail) = describe(event);
        let seq = lock(&self.details).record(detail);
        if !self.reserve() {
            self.counters.status_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let call = StatusRef {
            kind,
            core: u8::try_from(core).unwrap_or(u8::MAX),
            seq,
        };
        if function.call(call, ThreadsafeFunctionCallMode::NonBlocking) != napi::Status::Ok {
            self.queued.fetch_sub(1, Ordering::AcqRel);
            self.counters.status_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The callback's arguments `(event, core, detail)`, made on the isolate thread.
    /// It never fails: without them the callback runs with no argument.
    fn arguments(&self, env: &Env, call: StatusRef) -> RawArgs {
        let made = panic::catch_unwind(AssertUnwindSafe(|| -> napi::Result<RawArgs> {
            let detail = lock(&self.details).read(call.seq);
            let event = env.create_string(call.kind.name())?;
            let core = env.create_uint32(u32::from(call.core))?;
            let detail = env.create_string(&detail)?;
            Ok(RawArgs::new(vec![event.raw(), core.raw(), detail.raw()]))
        }));
        match made {
            Ok(Ok(arguments)) => arguments,
            Ok(Err(_)) => RawArgs::new(Vec::new()),
            Err(payload) => {
                dispose(payload);
                RawArgs::new(Vec::new())
            }
        }
    }
}

/// Receive the server's status events: `callback(event, core, detail)` runs on this
/// isolate for `started`, `stopped`, `taskPanic`, `workerPanic`, `hostFailed` and
/// `dispatchFailed`, a batch the core posted that could not be handed to the
/// isolate and was answered in Rust (its requests 500 `DISPATCH_FAILED`, its events
/// dropped). The detail is the panic message, for `dispatchFailed` the batch's worker
/// index and what was given up on, and empty otherwise. The function is weak, so it
/// never keeps the event loop alive, and at most 16 calls wait in Node's queue: an
/// event past them is dropped and counted in the server's `status_dropped`. The
/// callback must not throw, since a throw from it reaches
/// `process.on('uncaughtException')`. A second call replaces the first callback.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `callback` - the function the events are delivered to.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` once the server started, `ZERO_CLOSED` for an unknown or
/// stopped server, and `ZERO_LIMIT` when Node-API cannot create the function.
#[napi(
    catch_unwind,
    ts_args_type = "server: number, callback: (event: string, core: number, detail: string) => void"
)]
pub fn server_on_status(
    server: f64,
    callback: Function<'_, RawArgs, UnknownReturnValue>,
) -> napi::Result<(), Code> {
    node_guard(|| {
        let (id, server) = server::running_arg(server)?;
        let counters =
            server::counters(id).ok_or_else(|| Fail::closed(format!("no server {id}")))?;
        let channel = Arc::new(StatusChannel {
            queued: AtomicU32::new(0),
            details: Mutex::new(Details::new()),
            counters,
        });
        let delivered = Arc::clone(&channel);
        let function: StatusFunction = callback
            .build_threadsafe_function::<StatusRef>()
            .callee_handled::<false>()
            .weak::<true>()
            .max_queue_size::<{ QUEUED_MAX as usize }>()
            .build_callback(move |context: ThreadsafeCallContext<StatusRef>| {
                delivered.queued.fetch_sub(1, Ordering::AcqRel);
                Ok(delivered.arguments(&context.env, context.value))
            })
            .map_err(|error| Fail::napi(&error))?;
        let sink: StatusSink = Arc::new(move |event: Event| {
            contained(|| channel.post(&function, event));
        });
        server.on_event(sink).map_err(Fail::from)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_detail_ring_keeps_the_last_sixty_four_details() {
        let mut details = Details::new();
        let first = details.record("first".to_owned());
        assert_eq!(details.read(first), "first");
        let mut last = first;
        for index in 0..64 {
            last = details.record(format!("detail {index}"));
        }
        assert_eq!(
            details.read(first),
            "",
            "an overwritten detail reads as empty"
        );
        assert_eq!(details.read(last), "detail 63");
        assert_eq!(details.read(last.wrapping_sub(63)), "detail 0");
        assert_eq!(
            details.read(last.wrapping_add(1)),
            "",
            "a future number reads as empty"
        );
    }

    #[test]
    fn a_batch_given_up_on_reaches_the_callback_as_dispatch_failed_with_its_core_and_detail() {
        let event = Event::DispatchFailed {
            core: 3,
            worker: 7,
            message: "what was given up on".to_owned(),
        };
        let (kind, core, detail) = describe(event);
        assert_eq!(
            (kind.name(), core, detail.as_str()),
            ("dispatchFailed", 3, "what was given up on")
        );
    }
}
