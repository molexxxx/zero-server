//! The clock: the deadlines of a core in a binary heap whose entries know their
//! position, so a sleep that is dropped early leaves in logarithmic time and the
//! structure allocates nothing once it has grown to its working size. The first
//! deadline bounds the wait on the driver.

use std::future::{poll_fn, Future};
use std::pin::{pin, Pin};
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use super::executor::Handle;
use crate::seam::Elapsed;

/// One registered sleep.
struct Entry {
    deadline: Instant,
    waker: Waker,
    /// Where the entry sits in the heap.
    position: usize,
    /// Which registration this is, unique for the life of the clock.
    sequence: u64,
}

/// What a sleep holds while it is registered: the slot of its entry and the
/// sequence of the registration. A fire frees the slot before the sleep it woke
/// runs again, and another sleep can take the slot in between, so removing and
/// refreshing act only on the entry whose sequence matches.
#[derive(Clone, Copy)]
struct Key {
    slot: usize,
    sequence: u64,
}

/// The deadlines of a core, each with the waker to call when it passes.
#[derive(Default)]
pub(crate) struct Timers {
    /// The entries by slot; a freed slot is reused.
    slots: Vec<Option<Entry>>,
    free: Vec<usize>,
    /// The slots ordered by deadline, earliest at the root.
    heap: Vec<usize>,
    /// The sequence of the next registration.
    next_sequence: u64,
}

impl Timers {
    fn deadline_of(&self, slot: usize) -> Option<Instant> {
        self.slots
            .get(slot)
            .and_then(Option::as_ref)
            .map(|entry| entry.deadline)
    }

    fn set_position(&mut self, slot: usize, position: usize) {
        if let Some(Some(entry)) = self.slots.get_mut(slot) {
            entry.position = position;
        }
    }

    /// Move the entry at `position` toward the root while it is earlier than its
    /// parent.
    fn sift_up(&mut self, mut position: usize) {
        while position > 0 {
            let parent = (position - 1) / 2;
            let (Some(&slot), Some(&above)) = (self.heap.get(position), self.heap.get(parent))
            else {
                return;
            };
            if self.deadline_of(slot) >= self.deadline_of(above) {
                return;
            }
            self.heap.swap(position, parent);
            self.set_position(slot, parent);
            self.set_position(above, position);
            position = parent;
        }
    }

    /// Move the entry at `position` toward the leaves while a child is earlier.
    fn sift_down(&mut self, mut position: usize) {
        loop {
            let left = position * 2 + 1;
            let right = left + 1;
            let mut earliest = position;
            for child in [left, right] {
                if let (Some(&candidate), Some(&current)) =
                    (self.heap.get(child), self.heap.get(earliest))
                {
                    if self.deadline_of(candidate) < self.deadline_of(current) {
                        earliest = child;
                    }
                }
            }
            if earliest == position {
                return;
            }
            let (Some(&slot), Some(&below)) = (self.heap.get(position), self.heap.get(earliest))
            else {
                return;
            };
            self.heap.swap(position, earliest);
            self.set_position(slot, earliest);
            self.set_position(below, position);
            position = earliest;
        }
    }

    /// Register a sleep; the key identifies it from then on.
    fn insert(&mut self, deadline: Instant, waker: &Waker) -> Key {
        let position = self.heap.len();
        let sequence = self.next_sequence;
        self.next_sequence = sequence.wrapping_add(1);
        let entry = Entry {
            deadline,
            waker: waker.clone(),
            position,
            sequence,
        };
        let slot = match self.free.pop() {
            Some(slot) => {
                if let Some(place) = self.slots.get_mut(slot) {
                    *place = Some(entry);
                }
                slot
            }
            None => {
                self.slots.push(Some(entry));
                self.slots.len().saturating_sub(1)
            }
        };
        self.heap.push(slot);
        self.sift_up(position);
        Key { slot, sequence }
    }

    /// The entry `key` registered, while it is still in its slot.
    fn entry_mut(&mut self, key: Key) -> Option<&mut Entry> {
        self.slots
            .get_mut(key.slot)
            .and_then(Option::as_mut)
            .filter(|entry| entry.sequence == key.sequence)
    }

    /// Replace the waker of a registered sleep.
    fn refresh(&mut self, key: Key, waker: &Waker) {
        if let Some(entry) = self.entry_mut(key) {
            if !entry.waker.will_wake(waker) {
                entry.waker.clone_from(waker);
            }
        }
    }

    /// Take a sleep out, wherever it sits in the heap; `None` once its entry has
    /// fired or been removed, whichever sleep holds the slot now.
    fn remove(&mut self, key: Key) -> Option<Entry> {
        self.entry_mut(key)?;
        self.take(key.slot)
    }

    /// Take the entry in `slot` out of the heap and free the slot.
    fn take(&mut self, slot: usize) -> Option<Entry> {
        let entry = self.slots.get_mut(slot).and_then(Option::take)?;
        self.free.push(slot);
        let position = entry.position;
        let last = self.heap.len().saturating_sub(1);
        if position != last {
            self.heap.swap(position, last);
            if let Some(&moved) = self.heap.get(position) {
                self.set_position(moved, position);
            }
        }
        self.heap.pop();
        if position < self.heap.len() {
            self.sift_up(position);
            self.sift_down(position);
        }
        Some(entry)
    }

    /// How long until the first deadline, `None` when there is none.
    pub(crate) fn next_timeout(&self, now: Instant) -> Option<Duration> {
        self.heap
            .first()
            .and_then(|&slot| self.deadline_of(slot))
            .map(|deadline| deadline.saturating_duration_since(now))
    }

    /// Wake every sleep whose deadline has passed.
    pub(crate) fn fire(&mut self, now: Instant) {
        while let Some(&slot) = self.heap.first() {
            match self.deadline_of(slot) {
                Some(deadline) if deadline <= now => {
                    if let Some(entry) = self.take(slot) {
                        entry.waker.wake();
                    }
                }
                _ => return,
            }
        }
    }
}

/// A sleep on the core's clock.
pub(crate) struct Sleep {
    handle: Rc<Handle>,
    /// `None` when the duration overflowed the clock: never.
    deadline: Option<Instant>,
    /// The registration, while there is one.
    key: Option<Key>,
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let Some(deadline) = this.deadline else {
            return Poll::Pending;
        };
        if Instant::now() >= deadline {
            if let Some(key) = this.key.take() {
                this.handle.timers.borrow_mut().remove(key);
            }
            return Poll::Ready(());
        }
        let mut timers = this.handle.timers.borrow_mut();
        match this.key {
            Some(key) => timers.refresh(key, cx.waker()),
            None => this.key = Some(timers.insert(deadline, cx.waker())),
        }
        Poll::Pending
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.handle.timers.borrow_mut().remove(key);
        }
    }
}

/// Wait for `duration` on `handle`'s clock.
pub(crate) fn sleep_on(handle: &Rc<Handle>, duration: Duration) -> Sleep {
    Sleep {
        handle: Rc::clone(handle),
        deadline: Instant::now().checked_add(duration),
        key: None,
    }
}

/// Run `future` for at most `duration` on `handle`'s clock.
pub(crate) async fn timeout_on<F>(
    handle: &Rc<Handle>,
    duration: Duration,
    future: F,
) -> Result<F::Output, Elapsed>
where
    F: Future,
{
    let mut future = pin!(future);
    let mut deadline = pin!(sleep_on(handle, duration));
    poll_fn(|cx| {
        if let Poll::Ready(output) = future.as_mut().poll(cx) {
            return Poll::Ready(Ok(output));
        }
        if deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(Elapsed));
        }
        Poll::Pending
    })
    .await
}

/// Wait for `duration` on the clock of the core running on this thread; outside a
/// core the thread itself sleeps for the duration.
///
/// # Arguments
///
/// * `duration` - how long.
pub async fn sleep(duration: Duration) {
    match Handle::current() {
        Some(handle) => self::sleep_on(&handle, duration).await,
        None => std::thread::sleep(duration),
    }
}

/// Run `future` for at most `duration` on the clock of the core running on this
/// thread; outside a core there is no clock, so the future runs without a deadline.
///
/// # Arguments
///
/// * `duration` - the deadline, from now.
/// * `future` - the work.
///
/// # Returns
///
/// The future's output.
///
/// # Errors
///
/// [`Elapsed`] when the deadline passed first; the future is dropped.
pub async fn timeout<F>(duration: Duration, future: F) -> Result<F::Output, Elapsed>
where
    F: Future,
{
    match Handle::current() {
        Some(handle) => timeout_on(&handle, duration, future).await,
        None => Ok(future.await),
    }
}

#[cfg(test)]
mod tests {
    use std::future::{poll_fn, Future};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::task::{Poll, Wake, Waker};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{sleep, sleep_on, timeout, Handle, Timers};
    use crate::compio_rt::block_on;
    use crate::seam::Elapsed;

    /// A waker that counts its wakes.
    struct Wakes(AtomicUsize);

    impl Wake for Wakes {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Arm a sleep and let the core's clock fire it, arm a second sleep, which takes
    /// the slot the fire freed, then poll the first to its end or drop it; true when
    /// the second sleep completes within a bound kept by another thread, since a core
    /// whose clock lost the entry waits on its driver forever.
    fn the_sleep_in_the_reused_slot_completes(poll_first: bool) -> bool {
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let outcome = block_on(async move {
                let handle = Handle::current().unwrap();
                println!("io_uring: {}", handle.is_io_uring());
                let mut first = sleep_on(&handle, Duration::from_millis(5));
                poll_fn(|cx| {
                    let _ = Pin::new(&mut first).poll(cx);
                    Poll::Ready(())
                })
                .await;
                poll_fn(|_| {
                    if handle.timers.borrow().heap.is_empty() {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
                .await;
                let mut second = sleep_on(&handle, Duration::from_millis(50));
                poll_fn(|cx| {
                    let _ = Pin::new(&mut second).poll(cx);
                    if poll_first {
                        let _ = Pin::new(&mut first).poll(cx);
                    }
                    Poll::Ready(())
                })
                .await;
                drop(first);
                second.await;
            });
            let _ = done.send(outcome.is_ok());
        });
        finished.recv_timeout(Duration::from_secs(10)) == Ok(true)
    }

    #[test]
    fn refreshing_or_removing_a_fired_sleep_spares_the_sleep_that_reused_its_slot() {
        let mut timers = Timers::default();
        let now = Instant::now();
        let wakes = Arc::new(Wakes(AtomicUsize::new(0)));
        let fired = timers.insert(now + Duration::from_millis(10), Waker::noop());
        timers.fire(now + Duration::from_millis(10));
        timers.insert(
            now + Duration::from_millis(20),
            &Waker::from(Arc::clone(&wakes)),
        );
        assert_eq!(timers.slots.len(), 1, "the later sleep took the freed slot");
        timers.refresh(fired, Waker::noop());
        assert!(timers.remove(fired).is_none());
        timers.fire(now + Duration::from_millis(20));
        assert_eq!(
            wakes.0.load(Ordering::Relaxed),
            1,
            "the later sleep was woken"
        );
    }

    #[test]
    fn a_fired_sleep_polled_after_its_slot_is_reused_spares_the_new_sleep() {
        assert!(
            the_sleep_in_the_reused_slot_completes(true),
            "the sleep in the reused slot never completed"
        );
    }

    #[test]
    fn a_fired_sleep_dropped_after_its_slot_is_reused_spares_the_new_sleep() {
        assert!(
            the_sleep_in_the_reused_slot_completes(false),
            "the sleep in the reused slot never completed"
        );
    }

    #[test]
    fn the_heap_keeps_the_earliest_deadline_first_through_removals() {
        let mut timers = Timers::default();
        let now = Instant::now();
        let waker = Waker::noop();
        let keys: Vec<_> = [50, 10, 40, 20, 30]
            .into_iter()
            .map(|ms| timers.insert(now + Duration::from_millis(ms), waker))
            .collect();
        assert_eq!(timers.next_timeout(now), Some(Duration::from_millis(10)));
        assert!(timers.remove(keys[1]).is_some());
        assert_eq!(timers.next_timeout(now), Some(Duration::from_millis(20)));
        assert!(timers.remove(keys[3]).is_some());
        assert_eq!(timers.next_timeout(now), Some(Duration::from_millis(30)));
        timers.fire(now + Duration::from_millis(45));
        assert_eq!(timers.next_timeout(now), Some(Duration::from_millis(50)));
        timers.fire(now + Duration::from_secs(1));
        assert_eq!(timers.next_timeout(now), None);
        assert_eq!(timers.heap.len(), 0);
        assert_eq!(timers.free.len(), 5);
    }

    #[test]
    fn the_clock_sleeps_and_times_out() {
        let outcome = block_on(async {
            let start = Instant::now();
            sleep(Duration::from_millis(15)).await;
            assert!(start.elapsed() >= Duration::from_millis(15));
            assert_eq!(timeout(Duration::from_secs(5), async { 3 }).await, Ok(3));
            timeout(Duration::from_millis(10), sleep(Duration::from_secs(5))).await
        });
        assert_eq!(outcome.ok(), Some(Err(Elapsed)));
    }
}
