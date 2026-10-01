//! `OwnedBuf`: the fixed-capacity byte buffer that crosses the I/O seam by value.
//!
//! A read takes the buffer, fills it, and hands it back with the count, so no
//! borrowed slice ever outlives the operation that uses it. The storage is
//! allocated once at its final capacity and is never grown.

use alloc::boxed::Box;
use alloc::format;
use alloc::vec::Vec;
use core::fmt;

use crate::{Error, Result};

/// A byte buffer with a fixed capacity and a filled prefix.
///
/// The bytes before `len()` are the filled region, written by a read or by
/// [`put`](Self::put); the bytes from `len()` to `capacity()` are free for the
/// next write. The capacity is set at construction and never changes.
pub struct OwnedBuf {
    storage: Box<[u8]>,
    filled: usize,
}

impl OwnedBuf {
    /// Allocates an empty buffer that can hold `capacity` bytes.
    ///
    /// # Arguments
    ///
    /// * `capacity` - the number of bytes the buffer holds; it never grows.
    ///
    /// # Returns
    ///
    /// A buffer with no filled bytes.
    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            storage: alloc::vec![0; capacity].into_boxed_slice(),
            filled: 0,
        }
    }

    /// Wraps a vector as a buffer whose filled region is the whole vector.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the bytes to wrap; their length becomes the capacity.
    ///
    /// # Returns
    ///
    /// A buffer that is completely filled.
    #[must_use]
    pub fn from_vec(bytes: Vec<u8>) -> Self {
        let filled = bytes.len();
        Self {
            storage: bytes.into_boxed_slice(),
            filled,
        }
    }

    /// Wraps a boxed slice as a buffer with `filled` bytes already in it.
    ///
    /// A completion backend hands the storage to the kernel by value and gets it
    /// back with a count; this puts the two together again without a copy.
    ///
    /// # Arguments
    ///
    /// * `storage` - the bytes; their length is the capacity.
    /// * `filled` - how many leading bytes are filled; more than the capacity
    ///   counts as the whole capacity.
    ///
    /// # Returns
    ///
    /// The buffer.
    #[must_use]
    pub fn from_parts(storage: Box<[u8]>, filled: usize) -> Self {
        let filled = filled.min(storage.len());
        Self { storage, filled }
    }

    /// Takes the buffer apart into its storage and its filled length.
    ///
    /// # Returns
    ///
    /// The storage, whose length is the capacity, and the filled length.
    #[must_use]
    pub fn into_parts(self) -> (Box<[u8]>, usize) {
        (self.storage, self.filled)
    }

    /// Returns the number of bytes the buffer can hold.
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.storage.len()
    }

    /// Returns the number of filled bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.filled
    }

    /// Returns `true` when no byte is filled.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.filled == 0
    }

    /// Returns the number of bytes that can still be written.
    #[must_use]
    pub fn remaining(&self) -> usize {
        self.storage.len().saturating_sub(self.filled)
    }

    /// Returns the filled bytes.
    #[must_use]
    pub fn filled(&self) -> &[u8] {
        self.storage.get(..self.filled).unwrap_or(&[])
    }

    /// Returns the filled bytes for in-place modification.
    #[must_use]
    pub fn filled_mut(&mut self) -> &mut [u8] {
        self.storage.get_mut(..self.filled).unwrap_or(&mut [])
    }

    /// Returns the unfilled bytes, for a read to write into.
    ///
    /// Call [`advance`](Self::advance) afterwards with the number of bytes the
    /// read produced.
    #[must_use]
    pub fn unfilled_mut(&mut self) -> &mut [u8] {
        self.storage.get_mut(self.filled..).unwrap_or(&mut [])
    }

    /// Marks `count` more bytes as filled.
    ///
    /// # Arguments
    ///
    /// * `count` - the number of bytes written into the unfilled region.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Limit`] if `count` exceeds the unfilled capacity; the
    /// buffer is unchanged.
    pub fn advance(&mut self, count: usize) -> Result<()> {
        let filled = self
            .filled
            .checked_add(count)
            .filter(|&filled| filled <= self.storage.len())
            .ok_or_else(|| {
                Error::Limit(format!(
                    "advance of {count} bytes exceeds the {} unfilled bytes",
                    self.remaining()
                ))
            })?;
        self.filled = filled;
        Ok(())
    }

    /// Copies `bytes` into the unfilled region and marks them filled.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the bytes to append.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Limit`] if `bytes` is longer than the unfilled capacity;
    /// the buffer is unchanged.
    pub fn put(&mut self, bytes: &[u8]) -> Result<()> {
        let count = bytes.len();
        let Some(target) = self.unfilled_mut().get_mut(..count) else {
            return Err(Error::Limit(format!(
                "put of {count} bytes exceeds the {} unfilled bytes",
                self.remaining()
            )));
        };
        target.copy_from_slice(bytes);
        self.advance(count)
    }

    /// Discards the first `count` filled bytes and moves the rest to the front.
    ///
    /// A parser that finished a message head calls this to keep the bytes that
    /// belong to the next message.
    ///
    /// # Arguments
    ///
    /// * `count` - the number of leading bytes to discard.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Limit`] if `count` exceeds the filled length; the buffer
    /// is unchanged.
    pub fn consume(&mut self, count: usize) -> Result<()> {
        let Some(kept) = self.filled.checked_sub(count) else {
            return Err(Error::Limit(format!(
                "consume of {count} bytes exceeds the {} filled bytes",
                self.filled
            )));
        };
        self.storage.copy_within(count..self.filled, 0);
        self.filled = kept;
        Ok(())
    }

    /// Shortens the filled region to `len` bytes, or leaves it if already shorter.
    ///
    /// # Arguments
    ///
    /// * `len` - the new filled length.
    pub fn truncate(&mut self, len: usize) {
        self.filled = self.filled.min(len);
    }

    /// Marks every byte unfilled; the capacity is kept.
    pub fn clear(&mut self) {
        self.filled = 0;
    }

    /// Returns the filled bytes as a vector, giving up the spare capacity.
    #[must_use]
    pub fn into_vec(self) -> Vec<u8> {
        let mut bytes = Vec::from(self.storage);
        bytes.truncate(self.filled);
        bytes
    }
}

impl AsRef<[u8]> for OwnedBuf {
    fn as_ref(&self) -> &[u8] {
        self.filled()
    }
}

impl From<Vec<u8>> for OwnedBuf {
    fn from(bytes: Vec<u8>) -> Self {
        Self::from_vec(bytes)
    }
}

impl fmt::Debug for OwnedBuf {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OwnedBuf")
            .field("len", &self.filled)
            .field("capacity", &self.storage.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec;

    use super::OwnedBuf;
    use crate::Error;

    #[test]
    fn starts_empty_at_the_requested_capacity() {
        let buf = OwnedBuf::with_capacity(8);
        assert_eq!(buf.capacity(), 8);
        assert_eq!(buf.len(), 0);
        assert!(buf.is_empty());
        assert_eq!(buf.remaining(), 8);
        assert!(buf.filled().is_empty());
    }

    #[test]
    fn a_read_fills_the_unfilled_region_then_advances() {
        let mut buf = OwnedBuf::with_capacity(4);
        if let Some(first) = buf.unfilled_mut().first_mut() {
            *first = 7;
        }
        assert!(buf.advance(1).is_ok());
        assert_eq!(buf.filled(), [7]);
        assert_eq!(buf.remaining(), 3);
        assert_eq!(buf.unfilled_mut().len(), 3);
    }

    #[test]
    fn advance_past_the_capacity_is_a_limit_error() {
        let mut buf = OwnedBuf::with_capacity(2);
        assert!(matches!(buf.advance(3), Err(Error::Limit(_))));
        assert_eq!(buf.len(), 0);
        assert!(buf.advance(usize::MAX).is_err());
    }

    #[test]
    fn put_appends_and_refuses_overflow() {
        let mut buf = OwnedBuf::with_capacity(3);
        assert!(buf.put(b"ab").is_ok());
        assert!(matches!(buf.put(b"cd"), Err(Error::Limit(_))));
        assert_eq!(buf.filled(), b"ab");
        assert!(buf.put(b"c").is_ok());
        assert_eq!(buf.as_ref(), b"abc");
    }

    #[test]
    fn consume_keeps_the_tail() {
        let mut buf = OwnedBuf::from_vec(vec![1, 2, 3, 4]);
        assert!(buf.consume(3).is_ok());
        assert_eq!(buf.filled(), [4]);
        assert_eq!(buf.remaining(), 3);
        assert!(matches!(buf.consume(2), Err(Error::Limit(_))));
        assert_eq!(buf.filled(), [4]);
    }

    #[test]
    fn truncate_clear_and_into_vec() {
        let mut buf = OwnedBuf::from(vec![9, 8, 7]);
        buf.truncate(10);
        assert_eq!(buf.len(), 3);
        buf.truncate(2);
        assert_eq!(buf.filled(), [9, 8]);
        if let Some(byte) = buf.filled_mut().first_mut() {
            *byte = 1;
        }
        assert_eq!(buf.clone_filled(), vec![1, 8]);
        buf.clear();
        assert!(buf.is_empty());
        assert_eq!(buf.capacity(), 3);
    }

    #[test]
    fn debug_shows_sizes_not_bytes() {
        let buf = OwnedBuf::from_vec(vec![0; 16]);
        assert_eq!(
            alloc::format!("{buf:?}"),
            "OwnedBuf { len: 16, capacity: 16 }"
        );
    }

    impl OwnedBuf {
        fn clone_filled(&self) -> alloc::vec::Vec<u8> {
            self.filled().to_vec()
        }
    }

    #[test]
    fn parts_round_trip_without_losing_the_capacity() {
        let mut buf = OwnedBuf::with_capacity(8);
        assert!(buf.put(b"abc").is_ok());
        let (storage, filled) = buf.into_parts();
        assert_eq!((storage.len(), filled), (8, 3));
        let buf = OwnedBuf::from_parts(storage, filled);
        assert_eq!((buf.capacity(), buf.filled()), (8, &b"abc"[..]));
        let clamped = OwnedBuf::from_parts(alloc::vec![1; 4].into_boxed_slice(), 9);
        assert_eq!(clamped.len(), 4);
    }
}
