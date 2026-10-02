//! The per-connection pipelining ring.
//!
//! Every parsed request takes the next position; responses leave from the head in
//! request order, which RFC 9112 Section 9.3.2 requires. The ring holds at most
//! [`CAP`] requests, the codec's cap, and the driver stops parsing at the configured
//! `max_pipelined`, leaving excess input in the socket buffer so TCP back pressure
//! applies. A running request's handler future lives in a pinned box at the ring
//! position, allocated once per position and reused for every later request there.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Instant;

use zero_http1::ChunkedDecoder;
use zero_limits::http1::PIPELINE_CODEC_CAP;

use crate::record::Record;

/// The most requests one connection holds in flight, whatever the configuration.
pub(crate) const CAP: usize = PIPELINE_CODEC_CAP;

/// How a pending body is delimited.
#[derive(Debug)]
pub(crate) enum Framing {
    /// This many octets remain.
    Length(u64),
    /// Chunked, until the last chunk.
    Chunked(ChunkedDecoder),
}

/// Where a request is on its way through the ring.
#[derive(Debug)]
pub(crate) enum Stage {
    /// The head is parsed and the body is being read; only the last entry can be.
    Body {
        /// The body framing and what remains of it.
        framing: Framing,
        /// A `100 Continue` is owed before the client sends the body.
        continue_pending: bool,
        /// The largest decoded body this request may carry, from the handler's
        /// per-request limit or the server's `max_body`.
        max_body: u64,
    },
    /// The request is complete and waits for its turn to run.
    Waiting,
    /// The handler future runs; the record is inside it.
    Running,
    /// The response is serialized and waits for the writer.
    Done,
}

/// One request in the ring.
#[derive(Debug)]
pub(crate) struct Entry {
    /// The record, except while the handler future holds it.
    pub(crate) record: Option<Box<Record>>,
    /// Where the request is.
    pub(crate) stage: Stage,
    /// When the head completed; the request total timeout runs from here.
    pub(crate) accepted: Instant,
    /// When the last body byte arrived; the body idle timeout runs from here.
    pub(crate) last_byte: Instant,
    /// Whether the method is safe, which decides whether it runs beside its
    /// predecessors.
    pub(crate) safe: bool,
    /// Whether the request asked to switch protocols, which stops the parsing of
    /// later input until it is answered.
    pub(crate) upgrade: bool,
    /// The body bytes counted on the core's request-memory budget for this entry.
    pub(crate) body_bytes: u64,
    /// The future slot the running handler lives in.
    pub(crate) slot: Option<usize>,
}

impl Entry {
    /// An entry for a request whose head just completed.
    pub(crate) fn new(record: Box<Record>, stage: Stage, now: Instant) -> Self {
        let safe = record.safe();
        let upgrade = record.parsed.is_some_and(|head| head.upgrade);
        Entry {
            record: Some(record),
            stage,
            accepted: now,
            last_byte: now,
            safe,
            upgrade,
            body_bytes: 0,
            slot: None,
        }
    }
}

/// The ring: entries in request order and the pinned future slots the running
/// handlers live in. A slot is allocated when more handlers run at once than ever
/// before on the connection and reused after, so a connection that never pipelines
/// holds one.
pub(crate) struct Ring<F> {
    entries: [Option<Entry>; CAP],
    futures: Vec<Pin<Box<Option<F>>>>,
    free_slots: Vec<usize>,
    head: usize,
    len: usize,
}

impl<F> std::fmt::Debug for Ring<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ring")
            .field("head", &self.head)
            .field("len", &self.len)
            .finish_non_exhaustive()
    }
}

impl<F> Ring<F> {
    /// An empty ring.
    pub(crate) fn new() -> Self {
        Ring {
            entries: std::array::from_fn(|_| None),
            futures: Vec::new(),
            free_slots: Vec::new(),
            head: 0,
            len: 0,
        }
    }

    /// How many requests are in flight.
    pub(crate) const fn len(&self) -> usize {
        self.len
    }

    /// Whether no request is in flight.
    pub(crate) const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The position of the `index`th request from the head.
    pub(crate) const fn position(&self, index: usize) -> usize {
        (self.head + index) % CAP
    }

    /// Add a request at the tail.
    ///
    /// # Returns
    ///
    /// Its position.
    ///
    /// # Errors
    ///
    /// The entry back when the ring is full.
    pub(crate) fn push(&mut self, entry: Entry) -> Result<usize, Entry> {
        if self.len >= CAP {
            return Err(entry);
        }
        let position = self.position(self.len);
        if let Some(slot) = self.entries.get_mut(position) {
            *slot = Some(entry);
            self.len += 1;
            Ok(position)
        } else {
            Err(entry)
        }
    }

    /// The entry at a position.
    pub(crate) fn entry(&self, position: usize) -> Option<&Entry> {
        self.entries.get(position).and_then(Option::as_ref)
    }

    /// The entry at a position, for change.
    pub(crate) fn entry_mut(&mut self, position: usize) -> Option<&mut Entry> {
        self.entries.get_mut(position).and_then(Option::as_mut)
    }

    /// The entry at the head.
    pub(crate) fn first(&self) -> Option<&Entry> {
        if self.len == 0 {
            return None;
        }
        self.entry(self.head)
    }

    /// The entry at the tail, for change.
    pub(crate) fn last_mut(&mut self) -> Option<&mut Entry> {
        if self.len == 0 {
            return None;
        }
        let position = self.position(self.len - 1);
        self.entry_mut(position)
    }

    /// Whether the tail entry is still reading its body.
    pub(crate) fn body_pending(&self) -> bool {
        if self.len == 0 {
            return false;
        }
        self.entry(self.position(self.len - 1))
            .is_some_and(|entry| matches!(entry.stage, Stage::Body { .. }))
    }

    /// Whether the tail entry asked to switch protocols and its body is in, so the
    /// input after it may belong to another protocol and is left unparsed.
    pub(crate) fn upgrade_pending(&self) -> bool {
        if self.len == 0 {
            return false;
        }
        self.entry(self.position(self.len - 1))
            .is_some_and(|entry| entry.upgrade && !matches!(entry.stage, Stage::Body { .. }))
    }

    /// The index from the head of the entry at a position, if one is there.
    pub(crate) fn index_of(&self, position: usize) -> Option<usize> {
        let index = (position + CAP - self.head) % CAP;
        (index < self.len).then_some(index)
    }

    /// Remove the head entry; its future, if any, is dropped.
    pub(crate) fn pop_front(&mut self) -> Option<Entry> {
        if self.len == 0 {
            return None;
        }
        let position = self.head;
        self.clear_future(position);
        let entry = self.entries.get_mut(position).and_then(Option::take);
        self.head = (self.head + 1) % CAP;
        self.len -= 1;
        entry
    }

    /// Remove the tail entry; its future, if any, is dropped.
    pub(crate) fn pop_back(&mut self) -> Option<Entry> {
        if self.len == 0 {
            return None;
        }
        let position = self.position(self.len - 1);
        self.clear_future(position);
        let entry = self.entries.get_mut(position).and_then(Option::take);
        self.len -= 1;
        entry
    }

    /// Put the entry at a position to running with `future` in a free slot.
    ///
    /// # Returns
    ///
    /// Whether a slot was found; the future is dropped otherwise.
    pub(crate) fn start(&mut self, position: usize, future: F) -> bool {
        let slot = match self.free_slots.pop() {
            Some(slot) => slot,
            None => {
                self.futures.push(Box::pin(None));
                self.futures.len() - 1
            }
        };
        let Some(entry) = self.entries.get_mut(position).and_then(Option::as_mut) else {
            self.free_slots.push(slot);
            return false;
        };
        let Some(pinned) = self.futures.get_mut(slot) else {
            return false;
        };
        pinned.as_mut().set(Some(future));
        entry.slot = Some(slot);
        entry.stage = Stage::Running;
        true
    }

    /// Drop the future of the entry at a position, if one is set, and free its slot.
    pub(crate) fn clear_future(&mut self, position: usize) {
        let Some(entry) = self.entries.get_mut(position).and_then(Option::as_mut) else {
            return;
        };
        let Some(slot) = entry.slot.take() else {
            return;
        };
        if let Some(pinned) = self.futures.get_mut(slot) {
            pinned.as_mut().set(None);
        }
        self.free_slots.push(slot);
    }

    /// The entries and the future slots apart, so a write can borrow the records
    /// while the running futures are polled.
    pub(crate) fn split(&mut self) -> Split<'_, F> {
        Split {
            entries: &self.entries,
            futures: &mut self.futures,
            head: self.head,
            len: self.len,
        }
    }
}

/// The ring's entries and future slots as separate borrows.
pub(crate) struct Split<'a, F> {
    /// The entries, by position.
    pub(crate) entries: &'a [Option<Entry>; CAP],
    /// The future slots, by position.
    pub(crate) futures: &'a mut [Pin<Box<Option<F>>>],
    /// The head position.
    pub(crate) head: usize,
    /// How many entries are in flight.
    pub(crate) len: usize,
}

/// The record of the `index`th entry from `head`.
pub(crate) fn record_at(
    entries: &[Option<Entry>; CAP],
    head: usize,
    index: usize,
) -> Option<&Record> {
    entries
        .get((head + index) % CAP)
        .and_then(Option::as_ref)
        .and_then(|entry| entry.record.as_deref())
}

/// Poll every running future once; a completed one goes to `completed` with its
/// position and the slot is cleared.
///
/// # Arguments
///
/// * `entries` - the entries, to find the running ones.
/// * `futures` - the future slots.
/// * `head` - the head position.
/// * `len` - how many entries are in flight.
/// * `cx` - the task context.
/// * `completed` - where completed outputs go.
pub(crate) fn poll_running<F: Future>(
    entries: &[Option<Entry>; CAP],
    futures: &mut [Pin<Box<Option<F>>>],
    head: usize,
    len: usize,
    cx: &mut Context<'_>,
    completed: &mut Vec<(usize, F::Output)>,
) {
    for index in 0..len {
        let position = (head + index) % CAP;
        let Some(entry) = entries.get(position).and_then(Option::as_ref) else {
            continue;
        };
        if !matches!(entry.stage, Stage::Running) {
            continue;
        }
        let Some(pinned) = entry.slot.and_then(|slot| futures.get_mut(slot)) else {
            continue;
        };
        let Some(future) = pinned.as_mut().as_pin_mut() else {
            continue;
        };
        if let Poll::Ready(output) = future.poll(cx) {
            pinned.as_mut().set(None);
            completed.push((position, output));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::{Entry, Ring, Stage, CAP};
    use crate::record::Record;

    fn entry() -> Entry {
        Entry::new(Box::new(Record::new(2)), Stage::Waiting, Instant::now())
    }

    #[test]
    fn positions_wrap_and_the_ring_refuses_more_than_its_cap() {
        let mut ring: Ring<std::future::Ready<()>> = Ring::new();
        assert!(ring.is_empty() && !ring.body_pending());
        for _ in 0..CAP {
            ring.push(entry()).unwrap();
        }
        assert!(ring.push(entry()).is_err());
        assert_eq!(ring.len(), CAP);
        for _ in 0..5 {
            ring.pop_front().unwrap();
        }
        assert_eq!(ring.position(0), 5);
        let position = ring.push(entry()).unwrap();
        assert_eq!(position, 0, "the tail wrapped to the front");
        assert!(ring.first().is_some());
        ring.last_mut().unwrap().stage = Stage::Running;
        ring.pop_back().unwrap();
        assert_eq!(ring.len(), CAP - 5);
    }

    #[test]
    fn one_future_slot_serves_a_connection_that_never_pipelines() {
        let mut ring: Ring<std::future::Ready<()>> = Ring::new();
        for _ in 0..3 {
            let position = ring.push(entry()).unwrap();
            assert!(ring.start(position, std::future::ready(())));
            assert_eq!(ring.entry(position).unwrap().slot, Some(0));
            ring.clear_future(position);
            ring.pop_front().unwrap();
        }
        assert_eq!(ring.futures.len(), 1);
        let first = ring.push(entry()).unwrap();
        let second = ring.push(entry()).unwrap();
        assert!(ring.start(first, std::future::ready(())));
        assert!(ring.start(second, std::future::ready(())));
        assert_eq!(ring.entry(second).unwrap().slot, Some(1));
        assert_eq!(ring.futures.len(), 2);
    }
}
