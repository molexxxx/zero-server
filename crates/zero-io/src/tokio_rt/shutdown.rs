//! The shutdown signal: one flag every core reads, one wake every core gets.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::Poll;

use tokio::sync::Notify;

use crate::seam::Shutdown;

/// A handle on the process-wide shutdown signal; clones share it.
#[derive(Clone, Debug, Default)]
pub struct ShutdownHandle {
    inner: Arc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    requested: AtomicBool,
    notify: Notify,
}

impl ShutdownHandle {
    /// A signal nobody has requested yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl Shutdown for ShutdownHandle {
    fn request(&self) {
        self.inner.requested.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }

    fn is_requested(&self) -> bool {
        self.inner.requested.load(Ordering::Acquire)
    }

    async fn requested(&self) {
        loop {
            // Register before checking the flag, so a request between the check
            // and the wait still wakes this task.
            let mut notified = pin!(self.inner.notify.notified());
            notified.as_mut().enable();
            if self.is_requested() {
                return;
            }
            notified.await;
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
            // motion (a listener closing its handoff channel, a task ending) is never
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
    use crate::seam::Shutdown;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn a_request_wakes_every_waiter_and_stays_requested() {
        let handle = ShutdownHandle::new();
        assert!(!handle.is_requested());
        let runtime = runtime();
        let local = tokio::task::LocalSet::new();
        local.block_on(&runtime, async {
            let waiters: Vec<_> = (0..3)
                .map(|_| {
                    let waiter = handle.clone();
                    tokio::task::spawn_local(async move { waiter.requested().await })
                })
                .collect();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!handle.is_requested());
            handle.request();
            for waiter in waiters {
                waiter.await.unwrap();
            }
            assert!(handle.is_requested());
            handle.requested().await;
        });
    }

    #[test]
    fn until_yields_the_future_or_none_on_shutdown() {
        let handle = ShutdownHandle::new();
        let runtime = runtime();
        let local = tokio::task::LocalSet::new();
        local.block_on(&runtime, async {
            assert_eq!(handle.until(async { 7 }).await, Some(7));
            let stopper = handle.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                stopper.request();
            });
            let outcome = handle
                .until(tokio::time::sleep(Duration::from_secs(30)))
                .await;
            assert_eq!(outcome, None);
        });
    }
}
