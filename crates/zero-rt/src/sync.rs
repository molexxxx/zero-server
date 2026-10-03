//! The atomics and locks the slot protocol is built on: `std`'s, or loom's when the
//! crate is built with `RUSTFLAGS="--cfg zero_loom"` for model checking.
//!
//! Every atomic and lock that the worker and host threads share in the slot word,
//! the slot payload, the intake and the batch ring comes from this module, so the
//! loom models run the protocol's own code. loom's `Mutex` has no poison state, so
//! under loom a lock is never reported poisoned. The cfg is named `zero_loom` rather
//! than `loom` because `RUSTFLAGS` reach every crate in the build and tokio gates
//! code of its own on `cfg(loom)`.

#[cfg(zero_loom)]
pub use loom::sync::atomic::{AtomicPtr, AtomicU32, AtomicU64, Ordering};
#[cfg(zero_loom)]
pub use loom::sync::{Arc, Mutex, MutexGuard};
#[cfg(not(zero_loom))]
pub use std::sync::atomic::{AtomicPtr, AtomicU32, AtomicU64, Ordering};
#[cfg(not(zero_loom))]
pub use std::sync::{Arc, Mutex, MutexGuard};

use std::sync::TryLockError;

/// What a non-blocking attempt to take a lock found.
pub(crate) enum TryLock<'a, T> {
    /// The lock was free and is now held.
    Locked(MutexGuard<'a, T>),
    /// Another thread holds the lock.
    Busy,
    /// The lock was free but poisoned by a panic; it is held now, still poisoned.
    Poisoned(MutexGuard<'a, T>),
}

/// Take `mutex` if it is free, without waiting.
pub(crate) fn try_lock<T>(mutex: &Mutex<T>) -> TryLock<'_, T> {
    match mutex.try_lock() {
        Ok(guard) => TryLock::Locked(guard),
        Err(TryLockError::WouldBlock) => TryLock::Busy,
        Err(TryLockError::Poisoned(poisoned)) => TryLock::Poisoned(poisoned.into_inner()),
    }
}

/// Take `mutex`, waiting for it; `Err` carries the guard of a poisoned lock.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, MutexGuard<'_, T>> {
    mutex.lock().map_err(std::sync::PoisonError::into_inner)
}

/// Take `mutex`, waiting for it, and clear a poison flag a panic left on it: for
/// state that stays consistent whatever a panicking holder did to it.
pub(crate) fn lock_recovered<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match lock(mutex) {
        Ok(guard) => guard,
        Err(guard) => {
            clear_poison(mutex);
            guard
        }
    }
}

/// Mark `mutex` as recovered from a panic.
#[cfg(not(zero_loom))]
pub(crate) fn clear_poison<T>(mutex: &Mutex<T>) {
    mutex.clear_poison();
}

/// loom's `Mutex` is never poisoned, so there is nothing to clear.
#[cfg(zero_loom)]
pub(crate) fn clear_poison<T>(_mutex: &Mutex<T>) {}
