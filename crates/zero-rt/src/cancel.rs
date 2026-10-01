//! The per-request cancel flag: set by the worker when the client goes away or a
//! deadline passes, observed by whoever holds the request.

use std::cell::{Cell, RefCell};
use std::future::{poll_fn, Future};
use std::rc::Rc;
use std::task::{Poll, Waker};

/// A cancel flag shared between the worker and a request's holder on one core.
#[derive(Clone, Debug, Default)]
pub struct Cancel {
    inner: Rc<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    cancelled: Cell<bool>,
    waker: RefCell<Option<Waker>>,
}

impl Cancel {
    /// A flag that is not set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the flag and wake whoever waits on it.
    pub fn cancel(&self) {
        self.inner.cancelled.set(true);
        if let Some(waker) = self.inner.waker.take() {
            waker.wake();
        }
    }

    /// Whether the flag is set.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.get()
    }

    /// Wait until the flag is set; returns at once when it already is.
    pub fn cancelled(&self) -> impl Future<Output = ()> + '_ {
        poll_fn(move |cx| {
            if self.inner.cancelled.get() {
                return Poll::Ready(());
            }
            let mut slot = self.inner.waker.borrow_mut();
            match slot.as_ref() {
                Some(waker) if waker.will_wake(cx.waker()) => {}
                _ => *slot = Some(cx.waker().clone()),
            }
            Poll::Pending
        })
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use super::Cancel;

    #[test]
    fn the_flag_wakes_its_waiter_once_set() {
        let cancel = Cancel::new();
        let other = cancel.clone();
        assert!(!cancel.is_cancelled());
        let mut waiting = pin!(cancel.cancelled());
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(waiting.as_mut().poll(&mut cx), Poll::Pending);
        other.cancel();
        assert!(cancel.is_cancelled());
        assert_eq!(waiting.as_mut().poll(&mut cx), Poll::Ready(()));
        let mut again = pin!(other.cancelled());
        assert_eq!(again.as_mut().poll(&mut cx), Poll::Ready(()));
    }
}
