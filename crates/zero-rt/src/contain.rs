//! Panic containment (`DESIGN.md` section 10.2).
//!
//! tokio's default for a panicking task is to ignore it: the panic goes to the task's
//! join handle and everything else runs on, so a connection task that panicked with
//! nobody reading its handle would leave its connection half-open and its slots leased
//! forever. [`contain`] runs a future with every poll under `catch_unwind`, so the
//! task that panicked answers for itself (a 500 if a head was parsed and nothing sent,
//! the connection closed, its slots freed) and the core keeps serving.

use std::future::{poll_fn, Future};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::pin;
use std::task::Poll;

/// A future panicked; the message the panic carried, when it was a string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Panicked {
    /// The panic message, or a note that it was not a string.
    pub message: String,
}

impl std::fmt::Display for Panicked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a task panicked: {}", self.message)
    }
}

impl std::error::Error for Panicked {}

/// Run `future` with every poll under `catch_unwind`.
///
/// # Arguments
///
/// * `future` - the task body.
///
/// # Returns
///
/// The future's output.
///
/// # Errors
///
/// [`Panicked`] when a poll panicked; the future is dropped and polled no more.
pub async fn contain<F>(future: F) -> Result<F::Output, Panicked>
where
    F: Future,
{
    let mut future = pin!(future);
    let mut done = false;
    poll_fn(move |cx| {
        if done {
            return Poll::Ready(Err(Panicked {
                message: "polled after a panic".to_owned(),
            }));
        }
        match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Err(payload) => {
                done = true;
                let message = payload
                    .downcast_ref::<&str>()
                    .map(|message| (*message).to_owned())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "a payload that is not a string".to_owned());
                Poll::Ready(Err(Panicked { message }))
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use super::{contain, Panicked};

    fn drive<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
        }
    }

    #[test]
    fn a_finished_future_passes_through() {
        assert_eq!(drive(contain(async { 41 + 1 })), Ok(42));
    }

    #[test]
    fn a_panic_becomes_an_error_with_its_message() {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let outcome = drive(contain(async {
            if std::hint::black_box(true) {
                panic!("handler fell over");
            }
            7
        }));
        let formatted = drive(contain(async {
            let code = std::hint::black_box(500);
            panic!("status {code}");
        }));
        std::panic::set_hook(previous);
        assert_eq!(
            outcome,
            Err(Panicked {
                message: "handler fell over".to_owned()
            })
        );
        assert_eq!(formatted.unwrap_err().message, "status 500");
        assert_eq!(
            format!("{}", outcome.unwrap_err()),
            "a task panicked: handler fell over"
        );
    }
}
