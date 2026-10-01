//! The shutdown signal: one flag every core reads, one wake every waiter gets.
//!
//! A waiter registers its waker in a slot of the shared list and takes it out when
//! it is dropped; the request takes every waker out and calls it, and a waker from
//! another core interrupts that core's driver on its own.

use std::future::{poll_fn, Future};
use std::pin::{pin, Pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use crate::seam::Shutdown;

/// A handle on the process-wide shutdown signal; clones share it.
#[derive(Clone, Debug, Default)]
pub struct ShutdownHandle {
    inner: Arc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    requested: AtomicBool,
    waiters: Mutex<Waiters>,
}

/// The registered wakers, by slot; a freed slot is reused.
#[derive(Debug, Default)]
struct Waiters {
    slots: Vec<Option<Waker>>,
    free: Vec<usize>,
}

impl Inner {
    fn waiters(&self) -> MutexGuard<'_, Waiters> {
        self.waiters.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ShutdownHandle {
    /// A signal nobody has requested yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

/// The wait for the signal: registered in one slot until it is requested or the
/// wait is dropped.
struct Requested<'a> {
    handle: &'a ShutdownHandle,
    slot: Option<usize>,
}

impl Future for Requested<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        // The flag is read under the lock, so a request between the read and the
        // registration still finds the waker.
        let mut waiters = this.handle.inner.waiters();
        if this.handle.is_requested() {
            return Poll::Ready(());
        }
        match this.slot {
            Some(slot) => {
                if let Some(entry) = waiters.slots.get_mut(slot) {
                    *entry = Some(cx.waker().clone());
                }
            }
            None => {
                let slot = match waiters.free.pop() {
                    Some(slot) => slot,
                    None => {
                        waiters.slots.push(None);
                        waiters.slots.len().saturating_sub(1)
                    }
                };
                if let Some(entry) = waiters.slots.get_mut(slot) {
                    *entry = Some(cx.waker().clone());
                }
                this.slot = Some(slot);
            }
        }
        Poll::Pending
    }
}

impl Drop for Requested<'_> {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            let mut waiters = self.handle.inner.waiters();
            if let Some(entry) = waiters.slots.get_mut(slot) {
                *entry = None;
            }
            waiters.free.push(slot);
        }
    }
}

impl Shutdown for ShutdownHandle {
    fn request(&self) {
        let wakers: Vec<Waker> = {
            let mut waiters = self.inner.waiters();
            self.inner.requested.store(true, Ordering::Release);
            waiters.slots.iter_mut().filter_map(Option::take).collect()
        };
        for waker in wakers {
            waker.wake();
        }
    }

    fn is_requested(&self) -> bool {
        self.inner.requested.load(Ordering::Acquire)
    }

    fn requested(&self) -> impl Future<Output = ()> {
        Requested {
            handle: self,
            slot: None,
        }
    }

    async fn until<F>(&self, future: F) -> Option<F::Output>
    where
        F: Future,
    {
        let mut future = pin!(future);
        let mut stop = pin!(self.requested());
        poll_fn(|cx| {
            // The signal is read before the future, so that what the signal set in
            // motion (a listener closing its handoff, a task ending) is never
            // reported as the future's own outcome.
            if self.is_requested() {
                return Poll::Ready(None);
            }
            if let Poll::Ready(output) = future.as_mut().poll(cx) {
                return Poll::Ready(Some(output));
            }
            if stop.as_mut().poll(cx).is_ready() {
                return Poll::Ready(None);
            }
            Poll::Pending
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::ShutdownHandle;
    use crate::compio_rt::block_on;
    use crate::seam::Shutdown;

    #[test]
    fn a_request_from_another_thread_ends_the_wait_and_stays_requested() {
        let handle = ShutdownHandle::new();
        assert!(!handle.is_requested());
        let stopper = handle.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            stopper.request();
        });
        let waited = block_on(async move {
            handle.requested().await;
            assert!(handle.is_requested());
            handle.requested().await;
            handle.until(std::future::pending::<()>()).await
        });
        assert_eq!(waited.ok(), Some(None));
        assert!(thread.join().is_ok());
    }

    #[test]
    fn until_yields_the_future_when_nothing_was_requested() {
        let handle = ShutdownHandle::new();
        let outcome = block_on(async move { handle.until(async { 7 }).await });
        assert_eq!(outcome.ok(), Some(Some(7)));
    }
}
