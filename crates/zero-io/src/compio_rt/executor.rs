//! The per-core executor over compio-driver's proactor: a run queue of `!Send`
//! tasks, the future one operation becomes, and the loop that runs what is ready
//! and then waits on the driver with the next timer as its deadline.
//!
//! A task's waker only pushes the task's index onto the core's queue; from another
//! thread it also interrupts the driver, which is the one cross-core wake there is
//! (`DESIGN.md` section 5.1). From the core's own thread, which is where every
//! completion and every timer fires, the queue is read before the next wait, so no
//! interrupt is needed.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use compio_buf::BufResult;
use compio_driver::{Key, OpCode, Proactor, PushEntry};
use zero_core::OwnedBuf;

use super::time::Timers;
use crate::pool::Pool;

thread_local! {
    static CURRENT: RefCell<Option<Rc<Handle>>> = const { RefCell::new(None) };
}

/// How many staging buffers a core keeps for vectored writes.
const STAGING_KEPT: usize = 64;

/// The entries the driver's queues are created with.
const DRIVER_CAPACITY: u32 = 1024;

/// How many driver turns a stopping core gives its cancellations.
const CLEAR_TURNS: usize = 4;

/// A core's driver and executor, shared by everything that runs on the core.
pub(crate) struct Handle {
    proactor: RefCell<Proactor>,
    tasks: RefCell<Tasks>,
    queue: Arc<Queue>,
    scratch: RefCell<Vec<usize>>,
    pub(crate) timers: RefCell<Timers>,
    live: Cell<usize>,
    staging: RefCell<Vec<Vec<u8>>>,
    /// This core's receive-buffer pool, where a cancelled read returns its lease.
    pub(crate) pool: Rc<Pool>,
}

/// The spawned tasks, by index; a freed index is reused.
#[derive(Default)]
struct Tasks {
    slots: Vec<Option<Task>>,
    free: Vec<usize>,
}

struct Task {
    future: Pin<Box<dyn Future<Output = ()>>>,
    waker: Arc<TaskWaker>,
}

/// The run queue: the indices of the tasks that were woken, the driver's own waker
/// for a wake from another thread, and which thread owns the queue.
struct Queue {
    ready: Mutex<Vec<usize>>,
    driver: Waker,
    owner: ThreadId,
}

impl Queue {
    fn ready(&self) -> MutexGuard<'_, Vec<usize>> {
        self.ready.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A task's waker: one index on the queue, at most once until the task runs.
struct TaskWaker {
    id: usize,
    scheduled: AtomicBool,
    queue: Arc<Queue>,
}

impl Wake for TaskWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if self.scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        self.queue.ready().push(self.id);
        if std::thread::current().id() != self.queue.owner {
            self.queue.driver.wake_by_ref();
        }
    }
}

impl Handle {
    /// A driver and an executor for the current thread.
    ///
    /// # Arguments
    ///
    /// * `pool` - the core's receive-buffer pool.
    pub(crate) fn new(pool: Rc<Pool>) -> io::Result<Rc<Self>> {
        let proactor = Proactor::builder().capacity(DRIVER_CAPACITY).build()?;
        let queue = Arc::new(Queue {
            ready: Mutex::new(Vec::with_capacity(DRIVER_CAPACITY as usize)),
            driver: proactor.waker(),
            owner: std::thread::current().id(),
        });
        Ok(Rc::new(Handle {
            proactor: RefCell::new(proactor),
            tasks: RefCell::new(Tasks::default()),
            queue,
            scratch: RefCell::new(Vec::with_capacity(DRIVER_CAPACITY as usize)),
            timers: RefCell::new(Timers::default()),
            live: Cell::new(0),
            staging: RefCell::new(Vec::new()),
            pool,
        }))
    }

    /// The handle of the core running on this thread, if one is.
    pub(crate) fn current() -> Option<Rc<Self>> {
        CURRENT.with(|current| current.borrow().clone())
    }

    /// Make this the core of the current thread, or clear it with `None`.
    fn set_current(handle: Option<Rc<Self>>) {
        CURRENT.with(|current| *current.borrow_mut() = handle);
    }

    /// Whether the driver is io_uring, for a caller that chooses a path by it.
    pub(crate) fn is_io_uring(&self) -> bool {
        self.proactor.borrow().driver_type().is_iouring()
    }

    /// Attach a descriptor to the driver, which IOCP needs once per socket; the
    /// other drivers accept any descriptor.
    #[cfg(windows)]
    pub(crate) fn attach(&self, fd: compio_driver::RawFd) -> io::Result<()> {
        self.proactor.borrow_mut().attach(fd)
    }

    /// How many spawned tasks have not ended.
    pub(crate) fn live(&self) -> usize {
        self.live.get()
    }

    /// Queue `future` as a task of this core.
    pub(crate) fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + 'static,
    {
        let mut tasks = self.tasks.borrow_mut();
        let id = match tasks.free.pop() {
            Some(id) => id,
            None => {
                tasks.slots.push(None);
                tasks.slots.len().saturating_sub(1)
            }
        };
        let waker = Arc::new(TaskWaker {
            id,
            scheduled: AtomicBool::new(true),
            queue: Arc::clone(&self.queue),
        });
        if let Some(slot) = tasks.slots.get_mut(id) {
            *slot = Some(Task {
                future: Box::pin(future),
                waker,
            });
        }
        drop(tasks);
        self.live.set(self.live.get().saturating_add(1));
        self.queue.ready().push(id);
    }

    /// The driver, for a caller that keeps an operation of its own in flight.
    pub(crate) fn proactor(&self) -> std::cell::RefMut<'_, Proactor> {
        self.proactor.borrow_mut()
    }

    /// Cancel an operation whose future is gone. The driver keeps the operation
    /// and its buffer until the cancellation completes, so a block leased from the
    /// pool returns its lease now and the block itself goes with the operation.
    pub(crate) fn abandon<T: OpCode>(&self, key: Key<T>, pooled: bool) {
        drop(self.proactor.borrow_mut().cancel(key));
        if pooled {
            self.pool.release(OwnedBuf::with_capacity(0));
        }
    }

    /// Submit an operation; the future it returns completes with the result.
    pub(crate) fn push<T: OpCode + 'static>(self: &Rc<Self>, op: T) -> Op<T> {
        Op {
            handle: Rc::clone(self),
            state: Some(State::Fresh(op)),
            pooled: false,
        }
    }

    /// Submit a receive into a block leased from the pool, whose lease returns to
    /// the pool if the future is dropped before the receive completes.
    pub(crate) fn push_pooled<T: OpCode + 'static>(self: &Rc<Self>, op: T) -> Op<T> {
        Op {
            handle: Rc::clone(self),
            state: Some(State::Fresh(op)),
            pooled: true,
        }
    }

    /// A staging buffer for a vectored write, empty, with whatever capacity it kept.
    pub(crate) fn take_staging(&self) -> Vec<u8> {
        self.staging.borrow_mut().pop().unwrap_or_default()
    }

    /// Return a staging buffer for reuse.
    pub(crate) fn give_staging(&self, mut buffer: Vec<u8>) {
        buffer.clear();
        let mut staging = self.staging.borrow_mut();
        if staging.len() < STAGING_KEPT {
            staging.push(buffer);
        }
    }

    /// Poll every task that was woken; true when any was.
    fn run_ready(&self) -> bool {
        let mut ready = self.scratch.borrow_mut();
        std::mem::swap(&mut *ready, &mut *self.queue.ready());
        if ready.is_empty() {
            return false;
        }
        for &id in ready.iter() {
            let taken = self
                .tasks
                .borrow_mut()
                .slots
                .get_mut(id)
                .and_then(Option::take);
            let Some(mut task) = taken else {
                continue;
            };
            task.waker.scheduled.store(false, Ordering::Release);
            let waker = Waker::from(Arc::clone(&task.waker));
            let mut cx = Context::from_waker(&waker);
            match task.future.as_mut().poll(&mut cx) {
                Poll::Ready(()) => {
                    drop(task);
                    self.tasks.borrow_mut().free.push(id);
                    self.live.set(self.live.get().saturating_sub(1));
                }
                Poll::Pending => {
                    if let Some(slot) = self.tasks.borrow_mut().slots.get_mut(id) {
                        *slot = Some(task);
                    }
                }
            }
        }
        ready.clear();
        true
    }

    /// Wait on the driver until a completion, a timer or a wake, at most `limit`.
    fn park(&self, limit: Option<Duration>) {
        let now = Instant::now();
        let mut timeout = if self.queue.ready().is_empty() {
            self.timers.borrow().next_timeout(now)
        } else {
            Some(Duration::ZERO)
        };
        if let Some(limit) = limit {
            timeout = Some(timeout.map_or(limit, |t| t.min(limit)));
        }
        let outcome = self.proactor.borrow_mut().poll(timeout);
        if let Err(err) = outcome {
            match err.kind() {
                io::ErrorKind::TimedOut | io::ErrorKind::Interrupted => {}
                // A driver that fails outright would spin this loop; a short pause
                // keeps the core responsive to a shutdown instead.
                _ => std::thread::sleep(Duration::from_millis(1)),
            }
        }
        self.timers.borrow_mut().fire(Instant::now());
    }

    /// Run `future` to completion on this core, beside the tasks already queued.
    pub(crate) fn block_on<F>(&self, future: F) -> F::Output
    where
        F: Future + 'static,
    {
        let output = Rc::new(RefCell::new(None));
        let slot = Rc::clone(&output);
        self.spawn(async move {
            *slot.borrow_mut() = Some(future.await);
        });
        loop {
            self.run_ready();
            if let Some(value) = output.borrow_mut().take() {
                return value;
            }
            self.park(None);
        }
    }

    /// Run the remaining tasks until none is left or `deadline` passes.
    pub(crate) fn drain(&self, deadline: Duration) {
        let until = Instant::now().checked_add(deadline);
        loop {
            self.run_ready();
            if self.live.get() == 0 {
                return;
            }
            let now = Instant::now();
            let left = match until {
                Some(until) if until > now => until.duration_since(now),
                Some(_) => return,
                None => Duration::MAX,
            };
            self.park(Some(left));
        }
    }

    /// Drop every task that is still queued, which cancels its operations and
    /// closes its sockets, then give the driver a few turns to process the
    /// cancellations before it goes.
    pub(crate) fn clear(&self) {
        let slots = std::mem::take(&mut self.tasks.borrow_mut().slots);
        drop(slots);
        self.tasks.borrow_mut().free.clear();
        self.live.set(0);
        for _ in 0..CLEAR_TURNS {
            let outcome = self.proactor.borrow_mut().poll(Some(Duration::ZERO));
            if let Err(err) = outcome {
                if !matches!(
                    err.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                ) {
                    return;
                }
            }
        }
    }
}

/// Run `future` on a core of its own on the current thread, for a test or a tool
/// that needs the backend without the workers.
///
/// # Arguments
///
/// * `future` - the work; tasks it spawns through a [`Core`](super::Core) it does
///   not have are not available here, so it is one future and its operations.
///
/// # Returns
///
/// The future's output.
///
/// # Errors
///
/// When the driver cannot be created on this thread.
pub fn block_on<F>(future: F) -> io::Result<F::Output>
where
    F: Future + 'static,
{
    let pool = Rc::new(Pool::new(
        zero_limits::http1::RECEIVE_BLOCK,
        zero_limits::services::REQUEST_MEMORY_PER_CORE,
    ));
    let handle = Handle::new(pool)?;
    Handle::set_current(Some(Rc::clone(&handle)));
    let output = handle.block_on(future);
    handle.clear();
    Handle::set_current(None);
    Ok(output)
}

/// Which driver compio's fusion picks on this machine: `io_uring`, `epoll` (the
/// polling fallback), `kqueue` or `iocp`.
///
/// # Errors
///
/// When a driver cannot be created on this thread.
pub fn driver() -> io::Result<&'static str> {
    let proactor = Proactor::builder().capacity(8).build()?;
    Ok(match proactor.driver_type() {
        compio_driver::DriverType::IoUring => "io_uring",
        compio_driver::DriverType::IOCP => "iocp",
        compio_driver::DriverType::Poll => {
            if cfg!(target_os = "linux") {
                "epoll"
            } else {
                "kqueue"
            }
        }
    })
}

/// The core of the current thread, for a socket that is created outside the
/// accept path.
pub(crate) fn current() -> io::Result<Rc<Handle>> {
    Handle::current().ok_or_else(|| io::Error::other("no core runs on this thread"))
}

/// Make `handle` the core of the current thread for the worker's lifetime.
pub(crate) fn enter(handle: &Rc<Handle>) {
    Handle::set_current(Some(Rc::clone(handle)));
}

/// Clear the current thread's core.
pub(crate) fn exit() {
    Handle::set_current(None);
}

/// One operation on its way through the driver.
pub(crate) struct Op<T: OpCode + 'static> {
    handle: Rc<Handle>,
    state: Option<State<T>>,
    pooled: bool,
}

enum State<T: OpCode + 'static> {
    Fresh(T),
    Pending(Key<T>),
}

impl<T> Future for Op<T>
where
    T: OpCode + Unpin + 'static,
{
    type Output = BufResult<usize, T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let mut proactor = this.handle.proactor.borrow_mut();
        let pushed = match this.state.take() {
            Some(State::Fresh(op)) => proactor.push(op),
            Some(State::Pending(key)) => proactor.pop(key),
            None => return Poll::Pending,
        };
        match pushed {
            PushEntry::Ready(result) => Poll::Ready(result),
            PushEntry::Pending(key) => {
                proactor.update_waker(&key, cx.waker());
                this.state = Some(State::Pending(key));
                Poll::Pending
            }
        }
    }
}

impl<T: OpCode + 'static> Drop for Op<T> {
    fn drop(&mut self) {
        if let Some(State::Pending(key)) = self.state.take() {
            self.handle.abandon(key, self.pooled);
        }
    }
}
