//! The boundary guard: every export runs inside [`node_guard`], so a refusal reaches
//! JavaScript as an `Error` whose `code` is `ZERO_` and the status name, and a panic
//! as one whose `code` is `ZERO_PANIC`, never as an unwind into Node.

use std::any::Any;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard, PoisonError};

use zero_host::access::Access;
use zero_host::{HostError, Status};

/// The `code` property of an `Error` a native call throws: `ZERO_` and the name of
/// the status the core refused the call with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Code(&'static str);

impl Code {
    /// An argument is out of its range, or the call came from a thread that may not
    /// make it.
    pub(crate) const INVALID_ARGUMENT: Code = Code::of(Status::InvalidArgument);
    /// The id is stale or unknown, or the slot, connection, target or server is gone.
    pub(crate) const CLOSED: Code = Code::of(Status::Closed);
    /// The runtime or the build cannot do what was asked.
    pub(crate) const UNSUPPORTED: Code = Code::of(Status::Unsupported);
    /// A bound is reached, or Node-API refused to create a value.
    pub(crate) const LIMIT: Code = Code::of(Status::Limit);
    /// A panic was caught at the boundary.
    pub(crate) const PANIC: Code = Code::of(Status::Panic);

    /// The code of a status.
    ///
    /// # Arguments
    ///
    /// * `status` - the status the core answered with.
    ///
    /// # Returns
    ///
    /// The code.
    pub(crate) const fn of(status: Status) -> Code {
        Code(match status {
            Status::Ok => "ZERO_OK",
            Status::Protocol => "ZERO_PROTOCOL",
            Status::Io => "ZERO_IO",
            Status::Codec => "ZERO_CODEC",
            Status::Closed => "ZERO_CLOSED",
            Status::Auth => "ZERO_AUTH",
            Status::Unsupported => "ZERO_UNSUPPORTED",
            Status::Timeout => "ZERO_TIMEOUT",
            Status::Limit => "ZERO_LIMIT",
            Status::InvalidArgument => "ZERO_INVALID_ARGUMENT",
            Status::Panic => "ZERO_PANIC",
        })
    }
}

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        self.0
    }
}

/// A refused call on its way to JavaScript: the code and the message.
#[derive(Debug)]
pub(crate) struct Fail {
    code: Code,
    message: String,
}

impl Fail {
    /// A refusal with a code and a message.
    pub(crate) fn new(code: Code, message: impl Into<String>) -> Self {
        Fail {
            code,
            message: message.into(),
        }
    }

    /// An argument out of its range.
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Fail::new(Code::INVALID_ARGUMENT, message)
    }

    /// A stale or unknown id.
    pub(crate) fn closed(message: impl Into<String>) -> Self {
        Fail::new(Code::CLOSED, message)
    }

    /// A Node-API call that refused to create or change a value.
    pub(crate) fn napi(error: &napi::Error) -> Self {
        Fail::new(
            Code::LIMIT,
            format!("Node-API refused the call: {}", error.reason),
        )
    }

    /// The code of the refusal.
    #[cfg(test)]
    pub(crate) const fn code(&self) -> Code {
        self.code
    }
}

impl From<HostError> for Fail {
    fn from(error: HostError) -> Self {
        Fail::new(Code::of(error.status()), error.message())
    }
}

impl From<Access> for Fail {
    fn from(access: Access) -> Self {
        Fail::new(Code::of(access.status()), access.message())
    }
}

/// Run an export's body: its refusals become `Error`s with their code, and a panic
/// becomes an `Error` with `ZERO_PANIC`. `AssertUnwindSafe` holds because a body
/// touches only the registries, whose locks are taken back from poisoning, the
/// core's slots through zero-host, which reports a poisoned slot as a status, and
/// Node-API values that live no longer than the call.
///
/// # Arguments
///
/// * `body` - the export's work.
///
/// # Returns
///
/// What the body returned.
///
/// # Errors
///
/// The body's refusal, or `ZERO_PANIC` with the panic message.
pub(crate) fn node_guard<T>(body: impl FnOnce() -> Result<T, Fail>) -> napi::Result<T, Code> {
    match panic::catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(fail)) => Err(napi::Error::new(fail.code, fail.message)),
        Err(payload) => {
            let message = format!(
                "a panic was caught at the native boundary: {}",
                panic_message(payload.as_ref())
            );
            dispose(payload);
            Err(napi::Error::new(Code::PANIC, message))
        }
    }
}

/// Run work on a thread Node-API or the core called into, such as a cleanup hook,
/// a stop listener or a status sink, where nothing can be reported: a panic is
/// caught and dropped.
///
/// # Arguments
///
/// * `work` - the work.
pub(crate) fn contained(work: impl FnOnce()) {
    if let Err(payload) = panic::catch_unwind(AssertUnwindSafe(work)) {
        dispose(payload);
    }
}

/// The message a panic carried.
///
/// # Arguments
///
/// * `payload` - the panic payload.
///
/// # Returns
///
/// The message, or a fixed text when the payload holds none.
pub(crate) fn panic_message(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&'static str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic without a message")
}

/// Drop a panic payload. Dropping one may panic again; the payload of that second
/// panic is leaked rather than dropped, so nothing unwinds out of this call.
///
/// # Arguments
///
/// * `payload` - the payload.
pub(crate) fn dispose(payload: Box<dyn Any + Send>) {
    if let Err(again) = panic::catch_unwind(AssertUnwindSafe(move || drop(payload))) {
        let _ = Box::leak(again);
    }
}

/// Lock a registry, taking the data back from a poisoned lock: every registry keeps
/// its entries consistent between statements.
///
/// # Arguments
///
/// * `mutex` - the registry's lock.
///
/// # Returns
///
/// The guard.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
