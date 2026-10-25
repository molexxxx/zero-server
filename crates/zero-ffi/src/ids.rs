//! The ids of apps, servers and targets.
//!
//! zero-host hands out these three as Rust values, so the library keeps each behind a
//! `uint64_t` id in a table of its own. Ids come from one counter that starts at 1 and
//! never hands an id out twice, so a freed or a made-up id is unknown to every table
//! and returns `ZeroStatus_Closed`, and an id of one kind given where another is
//! expected is unknown as well. An id above `ZERO_ID_MAX` returns
//! `ZeroStatus_InvalidArgument`. Slots and connections carry zero-host's own
//! generation-checked ids.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::abi::names::ZERO_ID_MAX;
use crate::guard::Fail;

/// The next id to hand out.
static NEXT: AtomicU64 = AtomicU64::new(1);

const WIDE: Fail = Fail::invalid("an id is above ZERO_ID_MAX");
const EXHAUSTED: Fail = Fail::limit("every id up to ZERO_ID_MAX was handed out");

/// Check that an id is not above `ZERO_ID_MAX`.
///
/// # Arguments
///
/// * `id` - the id.
///
/// # Errors
///
/// `InvalidArgument` for an id above `ZERO_ID_MAX`.
pub(crate) fn check(id: u64) -> Result<(), Fail> {
    if id > ZERO_ID_MAX {
        Err(WIDE)
    } else {
        Ok(())
    }
}

/// The next unused id.
fn next() -> Result<u64, Fail> {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == 0 || id > ZERO_ID_MAX {
        Err(EXHAUSTED)
    } else {
        Ok(id)
    }
}

/// The values of one kind of id.
pub(crate) struct Table<T> {
    entries: Mutex<BTreeMap<u64, T>>,
    unknown: &'static str,
    poisoned: &'static str,
}

impl<T> Table<T> {
    /// An empty table.
    ///
    /// # Arguments
    ///
    /// * `unknown` - the message of an id the table does not hold.
    /// * `poisoned` - the message of a lock a panic poisoned.
    pub(crate) const fn new(unknown: &'static str, poisoned: &'static str) -> Self {
        Table {
            entries: Mutex::new(BTreeMap::new()),
            unknown,
            poisoned,
        }
    }

    /// Lock the table.
    ///
    /// # Errors
    ///
    /// `Panic` when a panic poisoned the lock.
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, BTreeMap<u64, T>>, Fail> {
        self.entries.lock().map_err(|_| Fail::panic(self.poisoned))
    }

    /// The refusal of an id the table does not hold.
    pub(crate) const fn unknown(&self) -> Fail {
        Fail::closed(self.unknown)
    }

    /// Hold a value under a new id.
    ///
    /// # Arguments
    ///
    /// * `value` - the value.
    ///
    /// # Returns
    ///
    /// Its id.
    ///
    /// # Errors
    ///
    /// `Limit` when every id was handed out, `Panic` for a poisoned lock; the value is
    /// dropped then.
    pub(crate) fn insert(&self, value: T) -> Result<u64, Fail> {
        let mut entries = self.lock()?;
        let id = next()?;
        entries.insert(id, value);
        Ok(id)
    }

    /// Run `apply` on the value of an id under the table's lock.
    ///
    /// # Arguments
    ///
    /// * `id` - the id.
    /// * `apply` - what to do with the value.
    ///
    /// # Returns
    ///
    /// What `apply` returned.
    ///
    /// # Errors
    ///
    /// `InvalidArgument` for an id above `ZERO_ID_MAX`, `Closed` for an id the table
    /// does not hold, `Panic` for a poisoned lock.
    pub(crate) fn with<R>(&self, id: u64, apply: impl FnOnce(&mut T) -> R) -> Result<R, Fail> {
        check(id)?;
        let mut entries = self.lock()?;
        let value = entries.get_mut(&id).ok_or_else(|| self.unknown())?;
        Ok(apply(value))
    }

    /// Take the value of an id out of the table, when `allow` accepts it.
    ///
    /// # Arguments
    ///
    /// * `id` - the id.
    /// * `allow` - checks the value under the lock before it is taken.
    ///
    /// # Returns
    ///
    /// The value; the caller drops it once the lock is released.
    ///
    /// # Errors
    ///
    /// As [`with`](Self::with), and whatever `allow` refuses with, in which case the
    /// value stays.
    pub(crate) fn remove_if(
        &self,
        id: u64,
        allow: impl FnOnce(&T) -> Result<(), Fail>,
    ) -> Result<T, Fail> {
        check(id)?;
        let mut entries = self.lock()?;
        let value = entries.get(&id).ok_or_else(|| self.unknown())?;
        allow(value)?;
        entries.remove(&id).ok_or_else(|| self.unknown())
    }

    /// Take the value of an id out of the table.
    ///
    /// # Arguments
    ///
    /// * `id` - the id.
    ///
    /// # Returns
    ///
    /// The value.
    ///
    /// # Errors
    ///
    /// As [`with`](Self::with).
    pub(crate) fn remove(&self, id: u64) -> Result<T, Fail> {
        self.remove_if(id, |_| Ok(()))
    }
}

impl<T: Clone> Table<T> {
    /// A copy of the value of an id, used once the lock is released.
    ///
    /// # Arguments
    ///
    /// * `id` - the id.
    ///
    /// # Returns
    ///
    /// The copy.
    ///
    /// # Errors
    ///
    /// As [`with`](Self::with).
    pub(crate) fn get(&self, id: u64) -> Result<T, Fail> {
        self.with(id, |value| value.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::{check, Table};
    use crate::abi::names::ZERO_ID_MAX;
    use crate::abi::ZeroStatus;

    static NUMBERS: Table<u32> = Table::new("the number is unknown", "the table is poisoned");

    #[test]
    fn an_id_is_never_handed_out_twice_and_a_freed_one_is_unknown() {
        let first = NUMBERS.insert(1).unwrap();
        let second = NUMBERS.insert(2).unwrap();
        assert_ne!(first, second);
        assert_eq!(NUMBERS.get(first).unwrap(), 1);
        assert_eq!(NUMBERS.remove(first).unwrap(), 1);
        let gone = NUMBERS.get(first).unwrap_err();
        assert_eq!(gone.status(), ZeroStatus::Closed);
        let kept = NUMBERS
            .remove_if(second, |_| Err(crate::guard::Fail::limit("kept")))
            .unwrap_err();
        assert_eq!(kept.status(), ZeroStatus::Limit);
        assert_eq!(NUMBERS.get(second).unwrap(), 2);
        let third = NUMBERS.insert(3).unwrap();
        assert!(third > second);
    }

    #[test]
    fn an_id_above_the_largest_is_an_invalid_argument() {
        assert!(check(ZERO_ID_MAX).is_ok());
        let wide = NUMBERS.get(ZERO_ID_MAX + 1).unwrap_err();
        assert_eq!(wide.status(), ZeroStatus::InvalidArgument);
        assert_eq!(
            NUMBERS.get(u64::MAX).unwrap_err().status(),
            ZeroStatus::InvalidArgument
        );
    }
}
