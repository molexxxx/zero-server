//! The export wrapper: every export runs inside `catch_unwind`, so no panic unwinds
//! into the host, and a refusal records its message before its status is returned.
//!
//! `AssertUnwindSafe` holds because an export touches only state that stays consistent
//! across a panic: a slot, whose lock zero-host maps to a status once a panic poisoned
//! it; the calling thread's last error, written with `try_borrow_mut`; the pin table of
//! zero-host; and the id tables of this crate, whose poisoned locks are reported as
//! `ZeroStatus_Panic`. The exports are `extern "C"`, not `"C-unwind"`: with every one
//! under `catch_unwind` no panic reaches the boundary, and one that did would abort the
//! process, as the Rust Reference states for a non-unwinding ABI.
//!
//! @see <https://doc.rust-lang.org/reference/items/functions.html#unwinding>
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#ffi-panic>

use std::any::Any;
use std::panic::{self, AssertUnwindSafe};

use zero_host::access::Access;
use zero_host::HostError;

use crate::abi::ZeroStatus;
use crate::last_error;

/// The text of a refusal.
#[derive(Debug)]
enum Text {
    /// A fixed message.
    Fixed(&'static str),
    /// A zero-host refusal, which carries its own message.
    Host(HostError),
}

/// A refused call: the status the export returns and the message it records.
#[derive(Debug)]
pub(crate) struct Fail {
    status: ZeroStatus,
    text: Text,
}

impl Fail {
    /// A refusal with a fixed message.
    pub(crate) const fn new(status: ZeroStatus, message: &'static str) -> Fail {
        Fail {
            status,
            text: Text::Fixed(message),
        }
    }

    /// An `InvalidArgument` refusal.
    pub(crate) const fn invalid(message: &'static str) -> Fail {
        Fail::new(ZeroStatus::InvalidArgument, message)
    }

    /// A `Closed` refusal.
    pub(crate) const fn closed(message: &'static str) -> Fail {
        Fail::new(ZeroStatus::Closed, message)
    }

    /// A `Limit` refusal.
    pub(crate) const fn limit(message: &'static str) -> Fail {
        Fail::new(ZeroStatus::Limit, message)
    }

    /// An `Unsupported` refusal.
    pub(crate) const fn unsupported(message: &'static str) -> Fail {
        Fail::new(ZeroStatus::Unsupported, message)
    }

    /// A `Panic` refusal: a panic poisoned state the call needs.
    pub(crate) const fn panic(message: &'static str) -> Fail {
        Fail::new(ZeroStatus::Panic, message)
    }

    /// The status the export returns.
    pub(crate) const fn status(&self) -> ZeroStatus {
        self.status
    }

    /// The message the export records.
    pub(crate) fn message(&self) -> &str {
        match &self.text {
            Text::Fixed(message) => message,
            Text::Host(error) => error.message(),
        }
    }
}

impl From<HostError> for Fail {
    fn from(error: HostError) -> Fail {
        Fail {
            status: ZeroStatus::from_host(error.status()),
            text: Text::Host(error),
        }
    }
}

impl From<Access> for Fail {
    fn from(access: Access) -> Fail {
        Fail::new(ZeroStatus::from_host(access.status()), access.message())
    }
}

/// Run a status-returning export.
///
/// # Arguments
///
/// * `call` - the export's body.
///
/// # Returns
///
/// `Ok` when the body succeeded; the refusal's status, after recording its message,
/// when it refused; `Panic`, after recording the panic, when it panicked.
pub(crate) fn guard(call: impl FnOnce() -> Result<(), Fail>) -> ZeroStatus {
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
        zero_host::testing::maybe_panic();
        call()
    }));
    match outcome {
        Ok(Ok(())) => ZeroStatus::Ok,
        Ok(Err(fail)) => {
            last_error::record(&[fail.message()]);
            fail.status()
        }
        Err(payload) => {
            last_error::record(&["the call panicked: ", panic_text(payload.as_ref())]);
            dispose(payload);
            ZeroStatus::Panic
        }
    }
}

/// Run a value-returning export.
///
/// # Arguments
///
/// * `on_panic` - what the export returns when the body panics: NULL or 0.
/// * `call` - the export's body.
///
/// # Returns
///
/// What the body returned, or `on_panic`, after recording the panic, when it panicked.
pub(crate) fn guard_value<R>(on_panic: R, call: impl FnOnce() -> R) -> R {
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
        zero_host::testing::maybe_panic();
        call()
    }));
    match outcome {
        Ok(value) => value,
        Err(payload) => {
            last_error::record(&["the call panicked: ", panic_text(payload.as_ref())]);
            dispose(payload);
            on_panic
        }
    }
}

/// The text a panic carried, or a fixed one when its payload is not text.
fn panic_text(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&'static str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a payload that is not text")
}

/// Drop a panic's payload. Dropping a payload may panic again; that second payload is
/// leaked rather than dropped, so nothing unwinds out of the export.
fn dispose(payload: Box<dyn Any + Send>) {
    if let Err(again) = panic::catch_unwind(AssertUnwindSafe(move || drop(payload))) {
        let _ = Box::leak(again);
    }
}

#[cfg(test)]
mod tests {
    use std::panic;

    use super::{guard, guard_value, Fail};
    use crate::abi::ZeroStatus;
    use crate::last_error;

    /// A payload whose drop panics.
    struct PanicsOnDrop;

    impl Drop for PanicsOnDrop {
        fn drop(&mut self) {
            panic!("the payload's drop panicked");
        }
    }

    fn message() -> String {
        last_error::with_message(|message| {
            String::from_utf8(message.unwrap_or_default().to_vec()).unwrap()
        })
    }

    #[test]
    fn a_refusal_returns_its_status_and_records_its_message_and_success_keeps_it() {
        assert_eq!(
            guard(|| Err(Fail::closed("the id is unknown"))),
            ZeroStatus::Closed
        );
        assert_eq!(message(), "the id is unknown");
        assert_eq!(guard(|| Ok(())), ZeroStatus::Ok);
        assert_eq!(message(), "the id is unknown");
    }

    #[test]
    fn a_panic_is_contained_and_its_text_recorded() {
        assert_eq!(guard(|| panic!("boom")), ZeroStatus::Panic);
        assert_eq!(message(), "the call panicked: boom");
        let value: *const u8 = guard_value(std::ptr::null(), || panic!("again"));
        assert!(value.is_null());
        assert_eq!(message(), "the call panicked: again");
        assert_eq!(guard_value(7u32, || 5), 5);
    }

    #[test]
    #[cfg_attr(
        miri,
        ignore = "the second payload is leaked by design, which Miri reports as a leak"
    )]
    fn a_payload_whose_drop_panics_is_leaked_rather_than_unwound() {
        let status = guard(|| panic::panic_any(PanicsOnDrop));
        assert_eq!(status, ZeroStatus::Panic);
        assert_eq!(message(), "the call panicked: a payload that is not text");
        assert_eq!(guard(|| Ok(())), ZeroStatus::Ok);
    }
}
