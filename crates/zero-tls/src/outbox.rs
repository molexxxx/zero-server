//! Ciphertext waiting for the transport.
//!
//! Both drivers queue every TLS record they produce here and write it from here, in
//! order. The connection driver drops a write future whenever another event wins the
//! turn, so a flush that is dropped mid-write puts what it had not yet written back at
//! the front of the queue, and the next flush continues where it stopped: no record is
//! lost, repeated or reordered.

use std::cell::RefCell;
use std::io::{self, IoSlice};

use zero_io::seam::Stream;

/// The queue.
#[derive(Debug, Default)]
pub(crate) struct Outbox {
    bytes: RefCell<Vec<u8>>,
}

impl Outbox {
    /// Run `fill` with the queue, to append records to it.
    pub(crate) fn fill<T>(&self, fill: impl FnOnce(&mut Vec<u8>) -> T) -> T {
        fill(&mut self.bytes.borrow_mut())
    }

    /// Write everything queued.
    ///
    /// # Errors
    ///
    /// The transport's error, or `WriteZero` when it took nothing.
    pub(crate) async fn flush<S: Stream>(&self, stream: &S) -> io::Result<()> {
        loop {
            let pending = std::mem::take(&mut *self.bytes.borrow_mut());
            if pending.is_empty() {
                return Ok(());
            }
            let mut unwritten = Unwritten {
                outbox: self,
                bytes: pending,
                written: 0,
            };
            let rest = unwritten.bytes.get(unwritten.written..).unwrap_or(&[]);
            let count = stream.writev(&[IoSlice::new(rest)]).await?;
            if count == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            unwritten.written = unwritten.written.saturating_add(count);
        }
    }
}

/// Bytes taken from the queue for one write; whatever the write did not take goes
/// back to the front of the queue when this is dropped, also when the write future is.
struct Unwritten<'a> {
    outbox: &'a Outbox,
    bytes: Vec<u8>,
    written: usize,
}

impl Drop for Unwritten<'_> {
    fn drop(&mut self) {
        if self.written >= self.bytes.len() {
            return;
        }
        let mut queued = self.outbox.bytes.borrow_mut();
        let mut rest = self.bytes.split_off(self.written);
        rest.extend_from_slice(&queued);
        *queued = rest;
    }
}
