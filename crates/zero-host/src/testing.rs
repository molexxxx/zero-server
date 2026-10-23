//! Hooks for the tests of this crate and of the crates built over it, which enable
//! the `testing` feature only through their dev-dependencies, so no shipped build
//! contains them.
//!
//! Without the feature only [`maybe_panic`] exists, as an inlined no-op. With it,
//! a test can arm the next guarded call to panic, run code on a worker thread, make a
//! core's dispatcher panic or hold it, cap the slots a core may claim, read a core's
//! allocator, read or answer a leased slot directly, hold a thread at a named point of
//! a server's lifecycle or of a completion's checks, and make the calling thread's
//! next start fail at its reaper thread or once its cores ran.

#[cfg(feature = "testing")]
use std::cell::Cell;
#[cfg(feature = "testing")]
use std::future::{poll_fn, Future};
#[cfg(feature = "testing")]
use std::panic::{catch_unwind, AssertUnwindSafe};
#[cfg(feature = "testing")]
use std::pin::pin;
#[cfg(feature = "testing")]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(feature = "testing")]
use std::sync::mpsc::{self, RecvTimeoutError};
#[cfg(feature = "testing")]
use std::sync::{Arc, Condvar, Mutex, PoisonError};
#[cfg(feature = "testing")]
use std::task::{Poll, Waker};
#[cfg(feature = "testing")]
use std::time::Duration;

#[cfg(feature = "testing")]
use zero_http::Exchange;
#[cfg(feature = "testing")]
use zero_rt::Refused;

#[cfg(feature = "testing")]
use crate::handler::CoreHost;
#[cfg(feature = "testing")]
use crate::registry::{self, lock};
#[cfg(feature = "testing")]
use crate::{HostError, Server, Status};

#[cfg(feature = "testing")]
thread_local! {
    static PANIC_NEXT: Cell<bool> = const { Cell::new(false) };
    static REFUSE_REAPER: Cell<bool> = const { Cell::new(false) };
    static REFUSE_SERVE: Cell<bool> = const { Cell::new(false) };
}

/// Panic when [`panic_next_call`] armed the calling thread; the guard of every C
/// ABI export calls it first. Without the `testing` feature it does nothing.
#[inline]
pub fn maybe_panic() {
    #[cfg(feature = "testing")]
    if PANIC_NEXT.with(|armed| armed.replace(false)) {
        panic!("the call was armed to panic");
    }
}

/// Arm the calling thread's next [`maybe_panic`] to panic.
#[cfg(feature = "testing")]
pub fn panic_next_call() {
    PANIC_NEXT.with(|armed| armed.set(true));
}

/// Work a test hands to a core's dispatcher, run at the start of its next turn.
#[cfg(feature = "testing")]
type Hook = Box<dyn FnOnce(&CoreHost) + Send>;

#[cfg(feature = "testing")]
#[derive(Default)]
struct HookQueue {
    hooks: Vec<Hook>,
    waker: Option<Waker>,
}

/// The hooks waiting for one worker index's dispatcher.
#[cfg(feature = "testing")]
#[derive(Default)]
pub(crate) struct Hooks {
    queue: Mutex<HookQueue>,
}

#[cfg(feature = "testing")]
impl Hooks {
    fn push(&self, hook: Hook) {
        let waker = {
            let mut queue = lock(&self.queue);
            queue.hooks.push(hook);
            queue.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Store the dispatcher task's waker; whether hooks wait.
    fn pending(&self, waker: &Waker) -> bool {
        let mut queue = lock(&self.queue);
        match &queue.waker {
            Some(stored) if stored.will_wake(waker) => {}
            _ => queue.waker = Some(waker.clone()),
        }
        !queue.hooks.is_empty()
    }

    fn take(&self) -> Vec<Hook> {
        std::mem::take(&mut lock(&self.queue).hooks)
    }
}

/// Run the hooks waiting for `core`'s worker index.
#[cfg(feature = "testing")]
pub(crate) fn run_hooks(core: &CoreHost) {
    for hook in core.shared().hooks.take() {
        hook(core);
    }
}

/// The dispatcher task with a wake for the hooks: a hook kicks the dispatcher so its
/// next turn runs it. While [`hold_dispatcher`] holds the core, the hooks run here and
/// the dispatcher takes no turn.
#[cfg(feature = "testing")]
pub(crate) async fn with_hooks(core: &CoreHost, run: impl Future<Output = ()>) {
    let mut run = pin!(run);
    poll_fn(|cx| {
        let waiting = core.shared().hooks.pending(cx.waker());
        if core.held.get() {
            if waiting {
                run_hooks(core);
            }
            if core.held.get() {
                return Poll::Pending;
            }
            core.kick.wake();
        } else if waiting {
            core.kick.wake();
        }
        run.as_mut().poll(cx)
    })
    .await;
}

/// Run `job` on the core in its dispatcher's next turn, with its panic contained so
/// the dispatcher serves on.
#[cfg(feature = "testing")]
fn on_core<R: Send + 'static>(
    server: &Server,
    worker: u8,
    job: impl FnOnce(&CoreHost) -> R + Send + 'static,
) -> Result<R, HostError> {
    let shared = server.worker_shared(worker)?;
    let (sender, receiver) = mpsc::channel();
    shared.hooks.push(Box::new(move |core| {
        let ran = catch_unwind(AssertUnwindSafe(|| job(core)));
        let _ = sender.send(ran.map_err(drop));
    }));
    match receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(())) => Err(HostError::new(
            Status::Panic,
            "the hook panicked on the worker",
        )),
        Err(RecvTimeoutError::Disconnected) => Err(HostError::new(
            Status::Panic,
            "the worker dropped the hook in a panic",
        )),
        Err(RecvTimeoutError::Timeout) => Err(HostError::new(
            Status::Timeout,
            "the worker did not run the hook",
        )),
    }
}

/// Run `job` on the I/O worker thread of one of the server's worker indexes, in its
/// dispatcher's next turn.
///
/// # Arguments
///
/// * `server` - the running server.
/// * `worker` - the global worker index.
/// * `job` - the work.
///
/// # Returns
///
/// What `job` returned.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a worker index of another server,
/// [`Status::Panic`] when `job` panicked, which the worker contains so its
/// dispatcher serves on, and [`Status::Timeout`] when the worker did not run it
/// within ten seconds.
#[cfg(feature = "testing")]
pub fn run_on_worker<R: Send + 'static>(
    server: &Server,
    worker: u8,
    job: impl FnOnce() -> R + Send + 'static,
) -> Result<R, HostError> {
    on_core(server, worker, move |_| job())
}

/// Make the next turn of a worker index's dispatcher panic, which fails that core's
/// host dispatch.
///
/// # Arguments
///
/// * `server` - the running server.
/// * `worker` - the global worker index.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a worker index of another server.
#[cfg(feature = "testing")]
pub fn panic_next_turn(server: &Server, worker: u8) -> Result<(), HostError> {
    let shared = server.worker_shared(worker)?;
    shared
        .hooks
        .push(Box::new(|_| panic!("the dispatcher was armed to panic")));
    Ok(())
}

/// Hold a worker index's dispatcher, or let it go on. A held dispatcher takes no
/// turns: completions, acknowledgments, the release of the quarantine and the posting
/// of new jobs wait, while the hooks still run and the core serves its connections.
/// A test lets the dispatcher go on before the server stops.
///
/// # Arguments
///
/// * `server` - the running server.
/// * `worker` - the global worker index.
/// * `held` - whether the dispatcher is held.
///
/// # Errors
///
/// As [`run_on_worker`].
#[cfg(feature = "testing")]
pub fn hold_dispatcher(server: &Server, worker: u8, held: bool) -> Result<(), HostError> {
    on_core(server, worker, move |core| core.held.set(held))
}

/// Cap how many slots a core holds at once, live and quarantined together, so a test
/// reaches the exhausted arena without 65,536 requests.
///
/// # Arguments
///
/// * `server` - the running server.
/// * `worker` - the global worker index.
/// * `cap` - the cap, or `None` for the arena's own limit.
///
/// # Errors
///
/// As [`run_on_worker`].
#[cfg(feature = "testing")]
pub fn cap_slots(server: &Server, worker: u8, cap: Option<usize>) -> Result<(), HostError> {
    on_core(server, worker, move |core| core.slot_cap.set(cap))
}

/// What a core's allocator holds.
#[cfg(feature = "testing")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllocatorState {
    /// Slots claimed and not retired.
    pub live: usize,
    /// Free indexes that keep their buffers.
    pub warm: usize,
    /// Free indexes that gave their buffers back.
    pub cold: usize,
    /// Retired indexes waiting for the acknowledgment floor.
    pub quarantined: usize,
}

/// Read a core's allocator.
///
/// # Arguments
///
/// * `server` - the running server.
/// * `worker` - the global worker index.
///
/// # Returns
///
/// The allocator's counts.
///
/// # Errors
///
/// As [`run_on_worker`].
#[cfg(feature = "testing")]
pub fn allocator(server: &Server, worker: u8) -> Result<AllocatorState, HostError> {
    on_core(server, worker, |core| {
        let alloc = core.alloc.borrow();
        AllocatorState {
            live: alloc.live(),
            warm: alloc.warm(),
            cold: alloc.cold(),
            quarantined: alloc.quarantined(),
        }
    })
}

#[cfg(feature = "testing")]
fn refusal(id: u64, refused: Refused) -> HostError {
    match refused {
        Refused::Poisoned => HostError::new(Status::Panic, format!("slot {id} is poisoned")),
        _ => HostError::closed(format!("slot {id} is not leased at its generation")),
    }
}

/// Read the exchange of a leased or completing slot under its lock.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `read` - the read.
///
/// # Returns
///
/// What `read` returned.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for an id above 2^53 - 1, [`Status::Closed`] for a
/// stale or unknown id or a slot in another state, and [`Status::Panic`] for a
/// poisoned slot.
#[cfg(feature = "testing")]
pub fn inspect<R>(id: u64, read: impl FnOnce(&Exchange) -> R) -> Result<R, HostError> {
    let (_, slot_id, slot) = registry::slot(id)?;
    slot.with_read(slot_id.generation(), |exchange| read(&exchange.0))
        .map_err(|refused| refusal(id, refused))
}

/// Write the response of a leased slot under its lock.
///
/// # Arguments
///
/// * `id` - the slot id.
/// * `write` - the write.
///
/// # Returns
///
/// What `write` returned.
///
/// # Errors
///
/// As [`inspect`], and [`Status::Closed`] for a slot that is not leased.
#[cfg(feature = "testing")]
pub fn respond<R>(id: u64, write: impl FnOnce(&mut Exchange) -> R) -> Result<R, HostError> {
    let (_, slot_id, slot) = registry::slot(id)?;
    slot.with_write(slot_id.generation(), |exchange| write(&mut exchange.0))
        .map_err(|refused| refusal(id, refused))
}

/// A point of a server's code where [`hold`] stops the next thread that reaches it.
#[cfg(feature = "testing")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// A stop of the server began and released nothing yet.
    Stop,
    /// A stop of the server released its targets and still holds its worker indexes.
    Release,
    /// [`Server::tls`] built the identity and has not stored it.
    Tls,
}

/// Where a held thread stops: a stage of one server, by its serial, or the check of
/// one slot id in [`complete`](crate::complete).
#[cfg(feature = "testing")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Point {
    Stage(u64, Stage),
    Check(u64),
}

#[cfg(feature = "testing")]
#[derive(Debug, Default)]
struct GateState {
    reached: bool,
    released: bool,
}

#[cfg(feature = "testing")]
#[derive(Debug, Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

/// The points armed to hold the next thread that reaches them.
#[cfg(feature = "testing")]
static GATES: Mutex<Vec<(Point, Arc<Gate>)>> = Mutex::new(Vec::new());

/// How many points are armed, so a thread passes a point without a lock when none is.
#[cfg(feature = "testing")]
static ARMED: AtomicUsize = AtomicUsize::new(0);

/// A point armed by [`hold`] or [`hold_check`]: the next thread that reaches it
/// stops there until this handle is dropped, and dropping it before any thread
/// reached the point disarms it.
#[cfg(feature = "testing")]
#[derive(Debug)]
pub struct Held {
    gate: Arc<Gate>,
}

#[cfg(feature = "testing")]
impl Held {
    /// Wait until a thread reached the point and stopped there.
    ///
    /// # Arguments
    ///
    /// * `timeout` - the longest wait.
    ///
    /// # Returns
    ///
    /// Whether a thread is held at the point.
    #[must_use]
    pub fn reached(&self, timeout: Duration) -> bool {
        let state = lock(&self.gate.state);
        let (state, _) = self
            .gate
            .changed
            .wait_timeout_while(state, timeout, |state| !state.reached)
            .unwrap_or_else(PoisonError::into_inner);
        state.reached
    }
}

#[cfg(feature = "testing")]
impl Drop for Held {
    fn drop(&mut self) {
        {
            let mut gates = lock(&GATES);
            if let Some(position) = gates
                .iter()
                .position(|(_, armed)| Arc::ptr_eq(armed, &self.gate))
            {
                gates.swap_remove(position);
                ARMED.fetch_sub(1, Ordering::SeqCst);
            }
        }
        lock(&self.gate.state).released = true;
        self.gate.changed.notify_all();
    }
}

#[cfg(feature = "testing")]
fn arm(point: Point) -> Held {
    let gate = Arc::new(Gate::default());
    lock(&GATES).push((point, Arc::clone(&gate)));
    ARMED.fetch_add(1, Ordering::SeqCst);
    Held { gate }
}

/// Hold the next thread that reaches `stage` in `server`.
///
/// # Arguments
///
/// * `server` - the server.
/// * `stage` - the point.
///
/// # Returns
///
/// The armed point; the held thread goes on when it is dropped.
#[cfg(feature = "testing")]
#[must_use]
pub fn hold(server: &Server, stage: Stage) -> Held {
    arm(Point::Stage(server.serial(), stage))
}

/// Hold the next thread that checks the slot id `id` in [`complete`](crate::complete),
/// before the check.
///
/// # Arguments
///
/// * `id` - the slot id.
///
/// # Returns
///
/// The armed point; the held thread goes on when it is dropped.
#[cfg(feature = "testing")]
#[must_use]
pub fn hold_check(id: u64) -> Held {
    arm(Point::Check(id))
}

/// Stop at `point` while a test holds it.
#[cfg(feature = "testing")]
pub(crate) fn reach(point: Point) {
    if ARMED.load(Ordering::SeqCst) == 0 {
        return;
    }
    let gate = {
        let mut gates = lock(&GATES);
        let Some(position) = gates.iter().position(|(armed, _)| *armed == point) else {
            return;
        };
        ARMED.fetch_sub(1, Ordering::SeqCst);
        gates.swap_remove(position).1
    };
    let mut state = lock(&gate.state);
    state.reached = true;
    gate.changed.notify_all();
    while !state.released {
        state = gate
            .changed
            .wait(state)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

/// Make the calling thread's next [`Server::start`] fail to start its reaper thread,
/// as when the operating system refuses a new thread.
#[cfg(feature = "testing")]
pub fn refuse_next_reaper() {
    REFUSE_REAPER.with(|armed| armed.set(true));
}

/// Make the calling thread's next [`Server::start`] fail once its cores ran, as when
/// the operating system refuses the thread of a later core: the cores that started
/// stop, and the start fails with [`Status::Io`].
#[cfg(feature = "testing")]
pub fn refuse_next_serve() {
    REFUSE_SERVE.with(|armed| armed.set(true));
}

/// Whether [`refuse_next_reaper`] armed the calling thread; disarms it.
#[cfg(feature = "testing")]
pub(crate) fn reaper_refused() -> bool {
    REFUSE_REAPER.with(|armed| armed.replace(false))
}

/// Whether [`refuse_next_serve`] armed the calling thread; disarms it.
#[cfg(feature = "testing")]
pub(crate) fn serve_refused() -> bool {
    REFUSE_SERVE.with(|armed| armed.replace(false))
}

#[cfg(feature = "testing")]
impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hooks")
            .field("waiting", &lock(&self.queue).hooks.len())
            .finish()
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    #[test]
    fn an_armed_call_panics_once() {
        super::panic_next_call();
        assert!(std::panic::catch_unwind(super::maybe_panic).is_err());
        super::maybe_panic();
    }
}
