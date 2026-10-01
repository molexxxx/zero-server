//! The per-core receive-buffer pool.
//!
//! Receive buffers are fixed blocks, leased to a connection when it becomes readable
//! and returned when it goes idle with no partial head and no unread body, so an idle
//! connection holds its connection record and nothing else (`DESIGN.md` section 5.6).
//! The pool counts the blocks out on lease and refuses a lease that would take the
//! core past its request-memory budget, which is how the budget pauses accepts rather
//! than the body limit times the connection count bounding memory. Returned blocks are
//! kept for reuse up to a cap, so the steady state allocates nothing.
//!
//! The pool is per core and never shared between threads, so its counters are plain
//! cells.

use std::cell::{Cell, RefCell};

use zero_core::OwnedBuf;

/// How many returned blocks a pool keeps for reuse.
const KEEP: usize = 1024;

/// A pool of equally sized receive blocks.
#[derive(Debug)]
pub struct Pool {
    block: usize,
    budget: u64,
    free: RefCell<Vec<OwnedBuf>>,
    leased: Cell<usize>,
    leased_bytes: Cell<u64>,
}

impl Pool {
    /// A pool of `block`-byte buffers that lends at most `budget` bytes at once.
    ///
    /// # Arguments
    ///
    /// * `block` - the capacity of every buffer, in bytes.
    /// * `budget` - the bytes that may be out on lease at once.
    ///
    /// # Returns
    ///
    /// An empty pool; blocks are allocated on first lease.
    #[must_use]
    pub fn new(block: usize, budget: u64) -> Self {
        Pool {
            block,
            budget,
            free: RefCell::new(Vec::new()),
            leased: Cell::new(0),
            leased_bytes: Cell::new(0),
        }
    }

    /// The capacity of every buffer.
    #[must_use]
    pub const fn block(&self) -> usize {
        self.block
    }

    /// The bytes that may be out on lease at once.
    #[must_use]
    pub const fn budget(&self) -> u64 {
        self.budget
    }

    /// How many buffers are out on lease.
    #[must_use]
    pub fn leased(&self) -> usize {
        self.leased.get()
    }

    /// How many bytes are out on lease.
    #[must_use]
    pub fn leased_bytes(&self) -> u64 {
        self.leased_bytes.get()
    }

    /// Lease an empty buffer.
    ///
    /// # Returns
    ///
    /// A buffer of [`block`](Self::block) capacity with nothing filled, or `None` when
    /// one more would take the pool past its budget.
    #[must_use]
    pub fn lease(&self) -> Option<OwnedBuf> {
        let block = u64::try_from(self.block).ok()?;
        let after = self.leased_bytes.get().checked_add(block)?;
        if after > self.budget {
            return None;
        }
        let buf = self
            .free
            .borrow_mut()
            .pop()
            .unwrap_or_else(|| OwnedBuf::with_capacity(self.block));
        self.leased.set(self.leased.get().saturating_add(1));
        self.leased_bytes.set(after);
        Some(buf)
    }

    /// Return a leased buffer; its contents are discarded.
    ///
    /// # Arguments
    ///
    /// * `buf` - a buffer this pool leased. A buffer of another capacity is dropped
    ///   rather than kept, and still counts as one lease returned.
    pub fn release(&self, mut buf: OwnedBuf) {
        self.leased.set(self.leased.get().saturating_sub(1));
        let block = u64::try_from(self.block).unwrap_or(u64::MAX);
        self.leased_bytes
            .set(self.leased_bytes.get().saturating_sub(block));
        if buf.capacity() != self.block {
            return;
        }
        buf.clear();
        let mut free = self.free.borrow_mut();
        if free.len() < KEEP {
            free.push(buf);
        }
    }

    /// How many returned buffers are waiting for reuse.
    #[must_use]
    pub fn idle(&self) -> usize {
        self.free.borrow().len()
    }
}

#[cfg(test)]
mod tests {
    use super::Pool;

    #[test]
    fn leases_count_out_and_back_in() {
        let pool = Pool::new(8, 24);
        assert_eq!((pool.leased(), pool.leased_bytes(), pool.idle()), (0, 0, 0));
        let a = pool.lease().unwrap();
        let b = pool.lease().unwrap();
        let c = pool.lease().unwrap();
        assert_eq!(a.capacity(), 8);
        assert_eq!((pool.leased(), pool.leased_bytes()), (3, 24));
        assert!(pool.lease().is_none(), "the budget is spent");
        pool.release(b);
        assert_eq!(
            (pool.leased(), pool.leased_bytes(), pool.idle()),
            (2, 16, 1)
        );
        let again = pool.lease().unwrap();
        assert_eq!(pool.idle(), 0, "the returned block is reused");
        pool.release(again);
        pool.release(a);
        pool.release(c);
        assert_eq!((pool.leased(), pool.leased_bytes(), pool.idle()), (0, 0, 3));
    }

    #[test]
    fn a_returned_buffer_is_empty_and_a_foreign_one_is_dropped() {
        let pool = Pool::new(4, 64);
        let mut buf = pool.lease().unwrap();
        buf.put(b"abcd").unwrap();
        pool.release(buf);
        let reused = pool.lease().unwrap();
        assert!(reused.is_empty());
        pool.release(zero_core::OwnedBuf::with_capacity(16));
        assert_eq!(pool.idle(), 0);
        assert_eq!(pool.leased(), 0, "a foreign buffer still returns a lease");
        pool.release(reused);
        assert_eq!(pool.idle(), 1);
    }

    #[test]
    fn a_budget_below_one_block_lends_nothing() {
        let pool = Pool::new(8_192, 100);
        assert!(pool.lease().is_none());
        assert_eq!(pool.block(), 8_192);
        assert_eq!(pool.budget(), 100);
    }
}
