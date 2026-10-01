//! The system allocator, counted.
//!
//! [`Counting`] forwards every request to [`System`] and counts the allocations and
//! reallocations the calling thread makes, so a test can show that a path makes none:
//! [`Counting::count`] runs a closure and reports how many it made. The count is kept per
//! thread, so tests that run beside each other never see one another's allocations.
//! A test binary or a measurement harness installs it once:
//!
//! ```
//! #[global_allocator]
//! static ALLOCATOR: zero_sys::alloc::Counting = zero_sys::alloc::Counting::new();
//!
//! let (sum, allocations) = zero_sys::alloc::Counting::count(|| 1 + 2);
//! assert_eq!((sum, allocations), (3, 0));
//! ```
//!
//! Deallocations are not counted: freeing is never the cost a claim is about, and a path
//! that frees without allocating has nothing to answer for.

use core::alloc::{GlobalAlloc, Layout};
use core::cell::Cell;
use std::alloc::System;

thread_local! {
    /// The allocations and reallocations made on this thread. Initialized at compile
    /// time and without a destructor, so touching it from inside the allocator allocates
    /// nothing and runs no user code.
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

/// The system allocator with a per-thread count of allocations and reallocations.
#[derive(Debug, Default, Clone, Copy)]
pub struct Counting;

impl Counting {
    /// A counting allocator, for a `#[global_allocator]` static.
    ///
    /// # Returns
    ///
    /// The allocator; it carries no state of its own.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// The allocations and reallocations the calling thread has made since it started.
    ///
    /// # Returns
    ///
    /// The count, or 0 while the thread's storage is already torn down.
    #[must_use]
    pub fn allocations() -> u64 {
        ALLOCATIONS.try_with(Cell::get).unwrap_or(0)
    }

    /// Run a closure and count the allocations and reallocations it makes on this thread.
    ///
    /// # Arguments
    ///
    /// * `f` - the work to measure.
    ///
    /// # Returns
    ///
    /// What the closure returned, and how many allocations and reallocations the thread
    /// made while it ran.
    pub fn count<R>(f: impl FnOnce() -> R) -> (R, u64) {
        let before = Self::allocations();
        let result = f();
        (result, Self::allocations().saturating_sub(before))
    }

    /// Record one allocation or reallocation on this thread.
    fn record() {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get().wrapping_add(1)));
    }
}

#[allow(unsafe_code)]
// SAFETY: every method forwards to `System`, which upholds the `GlobalAlloc` contract, and
// the count lives in a thread-local that allocates nothing and runs no user code.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        Self::record();
        // SAFETY: the caller upholds the `alloc` contract: `layout` has a non-zero size.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller upholds the `dealloc` contract: `ptr` came from this
        // allocator with this `layout` and is freed once.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        Self::record();
        // SAFETY: the caller upholds the `alloc_zeroed` contract: `layout` has a non-zero
        // size.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        Self::record();
        // SAFETY: the caller upholds the `realloc` contract: `ptr` came from this allocator
        // with this `layout`, and `new_size` is non-zero and does not overflow the layout.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[cfg(test)]
mod tests {
    use super::Counting;

    #[global_allocator]
    static ALLOCATOR: Counting = Counting::new();

    #[test]
    fn an_allocation_is_counted_once() {
        let (buffer, allocations) = Counting::count(|| Vec::<u8>::with_capacity(64));
        assert_eq!(buffer.capacity(), 64);
        assert_eq!(allocations, 1);
    }

    #[test]
    fn growth_counts_as_a_reallocation() {
        let mut buffer = Vec::<u8>::with_capacity(1);
        let (_, allocations) = Counting::count(|| buffer.extend_from_slice(&[0; 4096]));
        assert!(allocations >= 1, "{allocations}");
    }

    #[test]
    fn stack_work_counts_nothing() {
        let (sum, allocations) = Counting::count(|| [1u64, 2, 3].iter().sum::<u64>());
        assert_eq!((sum, allocations), (6, 0));
    }

    #[test]
    fn freeing_counts_nothing() {
        let buffer = vec![0u8; 128];
        let (_, allocations) = Counting::count(move || drop(buffer));
        assert_eq!(allocations, 0);
    }

    #[test]
    fn the_count_is_per_thread() {
        let ((), allocations) = Counting::count(|| {
            let worker = std::thread::spawn(|| {
                let buffers: Vec<Vec<u8>> = (0..16).map(|size| vec![0u8; size + 1]).collect();
                assert_eq!(buffers.len(), 16);
            });
            assert!(worker.join().is_ok());
        });
        // Spawning the thread allocates on this thread; the worker's own allocations do
        // not show here, or the count would be well over sixteen.
        assert!(allocations < 16, "{allocations}");
    }
}
