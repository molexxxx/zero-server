//! The batch ring of one worker index: one entry per batch that can be in flight,
//! each holding the slot ids and route ids, or the event records, of one batch until
//! the target acknowledges it.
//!
//! A target is handed only a [`BatchRef`], sixteen octets with no `Drop`, and copies
//! the batch out of the ring on the host's thread. The worker writes an entry only
//! while it is not in flight, and every read checks the entry still holds the
//! epoch the reference names, so a reference kept past its acknowledgment reads
//! nothing.

use std::fmt;

use zero_limits::services::MAX_BATCHES_IN_FLIGHT_CEILING;

use crate::slot::Refused;
use crate::sync::{self, Mutex};

/// The kind of a batch of tier 3 requests.
pub const REQUESTS: u8 = 1;
/// The kind of a batch of WebSocket and SSE events.
pub const EVENTS: u8 = 2;

/// A batch as a target receives it: where it is in the ring and which epoch it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchRef {
    /// The worker index whose ring holds the batch.
    pub worker: u8,
    /// The ring entry.
    pub entry: u8,
    /// [`REQUESTS`] or [`EVENTS`].
    pub kind: u8,
    /// How many requests or events the batch carries.
    pub count: u16,
    /// The batch's epoch, which the target acknowledges.
    pub epoch: u64,
}

/// One WebSocket or SSE occurrence on its way to the host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EventRec {
    /// The connection id.
    pub conn: u64,
    /// The route the connection was accepted on.
    pub route: u32,
    /// What happened: open, message, pong, close, drained, closed.
    pub kind: u8,
    /// The message opcode, for a message.
    pub opcode: u8,
    /// The close code, for a close.
    pub code: u16,
    /// The payload, moved from the decoder.
    pub data: Vec<u8>,
}

/// One entry of the ring.
#[derive(Debug, Default)]
pub struct BatchBuf {
    pub(crate) epoch: u64,
    pub(crate) kind: u8,
    pub(crate) slots: Vec<u64>,
    pub(crate) routes: Vec<u32>,
    pub(crate) events: Vec<EventRec>,
}

impl BatchBuf {
    fn with_capacity(batch: usize) -> Self {
        BatchBuf {
            epoch: 0,
            kind: 0,
            slots: Vec::with_capacity(batch),
            routes: Vec::with_capacity(batch),
            events: Vec::with_capacity(batch),
        }
    }

    /// Empty the entry for the batch of `epoch`, keeping capacity.
    pub(crate) fn start(&mut self, epoch: u64, kind: u8) {
        self.epoch = epoch;
        self.kind = kind;
        self.slots.clear();
        self.routes.clear();
        self.events.clear();
    }

    /// Empty the entry once its batch is acknowledged, dropping event payloads the
    /// target did not take.
    pub(crate) fn free(&mut self) {
        self.start(0, 0);
    }
}

/// The ring entries of one worker index; permanent.
pub struct BatchRing {
    entries: Box<[Mutex<BatchBuf>]>,
}

impl fmt::Debug for BatchRing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BatchRing")
            .field("entries", &self.entries.len())
            .finish()
    }
}

impl BatchRing {
    /// A ring of `entries` entries, each with room for `batch` records.
    ///
    /// # Arguments
    ///
    /// * `entries` - the batches that can be in flight; 1 to 8 are used.
    /// * `batch` - the most records one batch carries.
    ///
    /// # Returns
    ///
    /// The ring.
    #[must_use]
    pub fn new(entries: usize, batch: usize) -> Self {
        let entries = entries.clamp(1, MAX_BATCHES_IN_FLIGHT_CEILING);
        BatchRing {
            entries: (0..entries)
                .map(|_| Mutex::new(BatchBuf::with_capacity(batch)))
                .collect(),
        }
    }

    /// How many entries the ring has.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the ring has no entry; never true.
    ///
    /// # Returns
    ///
    /// `false`.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Copy a request batch out: run `f` over its slot ids and route ids if the
    /// entry still holds the batch `r` names.
    ///
    /// # Arguments
    ///
    /// * `r` - the batch reference the target received.
    /// * `f` - the copy; it runs under the entry's lock.
    ///
    /// # Returns
    ///
    /// What `f` returned.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] when the entry moved on to another batch or holds events,
    /// [`Refused::Unknown`] for an entry the ring does not have.
    pub fn read<R>(&self, r: BatchRef, f: impl FnOnce(&[u64], &[u32]) -> R) -> Result<R, Refused> {
        let buf = sync::lock_recovered(self.entry(r.entry).ok_or(Refused::Unknown)?);
        if buf.epoch != r.epoch || buf.kind != REQUESTS || r.epoch == 0 {
            return Err(Refused::Stale);
        }
        Ok(f(&buf.slots, &buf.routes))
    }

    /// Move an event batch's records into `into`, which is emptied first, by swapping
    /// vector headers: no payload is copied. `into` should have room for a whole
    /// batch, since the entry keeps the vector it hands over.
    ///
    /// # Arguments
    ///
    /// * `r` - the batch reference the target received.
    /// * `into` - where the records go.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] when the entry moved on to another batch or holds requests,
    /// [`Refused::Unknown`] for an entry the ring does not have.
    pub fn take_events(&self, r: BatchRef, into: &mut Vec<EventRec>) -> Result<(), Refused> {
        let mut buf = sync::lock_recovered(self.entry(r.entry).ok_or(Refused::Unknown)?);
        if buf.epoch != r.epoch || buf.kind != EVENTS || r.epoch == 0 {
            return Err(Refused::Stale);
        }
        into.clear();
        std::mem::swap(&mut buf.events, into);
        Ok(())
    }

    /// The lock of entry `index`.
    pub(crate) fn entry(&self, index: u8) -> Option<&Mutex<BatchBuf>> {
        self.entries.get(usize::from(index))
    }
}
