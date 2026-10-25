//! The connection table of each worker index: the WebSocket and event stream
//! connections a host sends on, by id.
//!
//! A host reserves a connection when it answers a request with a WebSocket accept or
//! an event stream, so it holds the id at once and may send before the connection
//! starts; what it sends waits in the connection's outbox. A table lives as long as
//! the process, one per worker index, and an id carries the worker index, the entry
//! and the entry's generation in the slot id layout, so an id of an earlier
//! connection, or of an earlier server, reads closed. Generations start at 1, so no
//! id is 0. Reserving and closing take the free list's lock, which no request path
//! takes; a send checks the entry's word without a lock, then clones the outbox
//! under the entry's own lock. Every outbox of a worker index counts its queued
//! octets on the index's [`OutboxTotal`], which the core adds to its request-memory
//! budget.
//!
//! A reservation names the slot whose response made it. It stays on the table's
//! reserved list until the worker runs that response's action, and a worker turn
//! that finds the slot retired or closed with the reservation still listed closes
//! the connection: a lease that ends without its action, because its client went
//! away or its target was lost, leaves no connection behind. A core whose host
//! dispatch failed closes its reservations at once, and a core that ends closes
//! every connection of its index still open, so none outlives the core that would
//! have served it and a later server on the index never reports one of them.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use zero_core::slot::{next_generation, GENERATION_MASK, MAX_ENCODED, MAX_WORKERS};
use zero_core::SlotId;
use zero_realtime::{Outbox, OutboxTotal};

use super::Routes;
use crate::registry::lock;
use crate::HostError;

/// The worker indexes a process can hold.
const WORKER_COUNT: usize = MAX_WORKERS as usize;

/// The entries of one chunk.
const CHUNK: usize = 256;

/// The entries a table holds: one per index of the slot id layout.
const ENTRIES: usize = 65_536;

/// The bit of an entry's word that marks the entry open; the generation is below it.
const OPEN: u64 = 1 << 32;

/// What a connection is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A WebSocket.
    WebSocket,
    /// A server-sent event stream.
    EventStream,
}

/// An open entry: the connection's outbox, its kind and the route it was opened on.
#[derive(Clone, Debug)]
pub(crate) struct Live {
    pub(crate) outbox: Arc<Outbox>,
    pub(crate) kind: Kind,
    pub(crate) route: u32,
}

#[derive(Debug, Default)]
struct Entry {
    /// [`OPEN`] while the entry holds a connection, and the generation.
    word: AtomicU64,
    live: Mutex<Option<Live>>,
}

/// A connection reserved by the response of a slot whose action has not run yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Reservation {
    conn: SlotId,
    slot: SlotId,
}

#[derive(Debug, Default)]
struct Free {
    indexes: VecDeque<u16>,
    grown: usize,
}

/// The connections of one worker index.
#[derive(Debug)]
pub(crate) struct Table {
    worker: u8,
    chunks: Box<[OnceLock<Box<[Entry]>>]>,
    free: Mutex<Free>,
    total: Arc<OutboxTotal>,
    reserved: Mutex<Vec<Reservation>>,
    reservations: AtomicUsize,
    routes: Mutex<Option<Arc<Routes>>>,
}

static TABLES: [OnceLock<Table>; WORKER_COUNT] = [const { OnceLock::new() }; WORKER_COUNT];

/// The table of worker index `worker`, made on first use.
pub(crate) fn table(worker: u8) -> Option<&'static Table> {
    let cell = TABLES.get(usize::from(worker))?;
    Some(cell.get_or_init(|| Table::new(worker)))
}

/// The id `raw` names, checked against the id range.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) above 2^53 - 1, and
/// [`Status::Closed`](crate::Status::Closed) for generation 0, which no connection
/// has.
pub(crate) fn parse(raw: u64) -> Result<SlotId, HostError> {
    if raw > MAX_ENCODED {
        return Err(HostError::invalid(format!(
            "the connection id {raw} is out of range"
        )));
    }
    SlotId::from_raw(raw)
        .filter(|id| id.generation() != 0)
        .ok_or_else(|| HostError::closed(format!("the connection id {raw} names no connection")))
}

/// The open connection `raw` names.
///
/// # Errors
///
/// As [`parse`], and [`Status::Closed`](crate::Status::Closed) for a connection that
/// ended or an id no connection had.
pub(crate) fn find(raw: u64) -> Result<Live, HostError> {
    let id = parse(raw)?;
    TABLES
        .get(usize::from(id.worker()))
        .and_then(OnceLock::get)
        .and_then(|table| table.live(id))
        .ok_or_else(|| HostError::closed(format!("the connection {raw} is closed")))
}

/// The generation an entry opens with after `generation`: the next one, never 0.
fn opening(generation: u32) -> u32 {
    match next_generation(generation) {
        0 => 1,
        next => next,
    }
}

impl Table {
    fn new(worker: u8) -> Self {
        Table {
            worker,
            chunks: (0..ENTRIES / CHUNK).map(|_| OnceLock::new()).collect(),
            free: Mutex::new(Free::default()),
            total: Arc::new(OutboxTotal::default()),
            reserved: Mutex::new(Vec::new()),
            reservations: AtomicUsize::new(0),
            routes: Mutex::new(None),
        }
    }

    /// The octets every outbox of this worker index holds, which the core counts in
    /// its request-memory budget.
    pub(crate) fn total(&self) -> &Arc<OutboxTotal> {
        &self.total
    }

    fn entry(&self, index: u16) -> Option<&Entry> {
        let index = usize::from(index);
        self.chunks.get(index / CHUNK)?.get()?.get(index % CHUNK)
    }

    /// Take a free entry, growing the table by a chunk when none is free.
    fn take_index(&self) -> Result<u16, HostError> {
        let mut free = lock(&self.free);
        if let Some(index) = free.indexes.pop_front() {
            return Ok(index);
        }
        let index = free.grown;
        let grown = u16::try_from(index)
            .ok()
            .zip(self.chunks.get(index / CHUNK))
            .ok_or_else(|| {
                HostError::limit(format!(
                    "worker {} holds {ENTRIES} connections already",
                    self.worker
                ))
            })?;
        grown
            .1
            .get_or_init(|| (0..CHUNK).map(|_| Entry::default()).collect());
        free.grown = index.saturating_add(1);
        Ok(grown.0)
    }

    /// Reserve a connection for the response of `slot`. The entry opens first, then
    /// `leased` checks the slot's lease again, and only then is the reservation listed
    /// for the worker's sweep: a host thread that checked the lease, was suspended
    /// while its server stopped and the next one started on the index, and reserved
    /// only then, finds the lease over here, and the entry it opened closes without a
    /// report. An entry is listed only after that check, so a sweep never reports one
    /// that was not reserved under a live lease, and a core that ends or starts closes
    /// an entry it finds open whether or not it is listed yet.
    ///
    /// # Returns
    ///
    /// The connection's id.
    ///
    /// # Errors
    ///
    /// [`Status::Limit`](crate::Status::Limit) when every entry holds a connection, and
    /// [`Status::Closed`](crate::Status::Closed) when the lease ended meanwhile.
    pub(crate) fn reserve(
        &self,
        kind: Kind,
        route: u32,
        slot: SlotId,
        leased: impl FnOnce() -> bool,
    ) -> Result<u64, HostError> {
        let index = self.take_index()?;
        let entry = self
            .entry(index)
            .ok_or_else(|| HostError::limit("the connection table cannot grow"))?;
        let mut live = lock(&entry.live);
        let generation = opening(
            u32::try_from(entry.word.load(Ordering::Acquire) & u64::from(GENERATION_MASK))
                .unwrap_or(0),
        );
        let Some(id) = SlotId::new(self.worker, generation, index) else {
            drop(live);
            lock(&self.free).indexes.push_back(index);
            return Err(HostError::limit("the connection id cannot be formed"));
        };
        *live = Some(Live {
            outbox: Arc::new(Outbox::new(Arc::clone(&self.total))),
            kind,
            route,
        });
        entry
            .word
            .store(OPEN | u64::from(generation), Ordering::Release);
        drop(live);
        if !leased() {
            self.close(id);
            return Err(HostError::closed(
                "the slot's lease ended before its connection was reserved",
            ));
        }
        lock(&self.reserved).push(Reservation { conn: id, slot });
        self.reservations.fetch_add(1, Ordering::Release);
        Ok(id.as_u64())
    }

    /// The connection `id` names, while it is open; an id of another worker index
    /// names none here.
    pub(crate) fn live(&self, id: SlotId) -> Option<Live> {
        if id.worker() != self.worker {
            return None;
        }
        let entry = self.entry(id.index())?;
        let open = OPEN | u64::from(id.generation());
        if entry.word.load(Ordering::Acquire) != open {
            return None;
        }
        let live = lock(&entry.live);
        if entry.word.load(Ordering::Acquire) != open {
            return None;
        }
        live.clone()
    }

    /// End the connection `id` names: its outbox closes, later sends are refused,
    /// and the entry is free for another connection under the next generation.
    ///
    /// # Returns
    ///
    /// What the entry held, or `None` when the connection had already ended or the
    /// id is of another worker index.
    pub(crate) fn close(&self, id: SlotId) -> Option<Live> {
        if id.worker() != self.worker {
            return None;
        }
        let entry = self.entry(id.index())?;
        let mut live = lock(&entry.live);
        if entry.word.load(Ordering::Acquire) != OPEN | u64::from(id.generation()) {
            return None;
        }
        entry
            .word
            .store(u64::from(id.generation()), Ordering::Release);
        let ended = live.take();
        drop(live);
        if let Some(ended) = &ended {
            ended.outbox.close();
        }
        self.drop_reservation(id);
        lock(&self.free).indexes.push_back(id.index());
        ended
    }

    /// The action that reserved `conn` runs: the reservation is no longer the
    /// table's to settle.
    pub(crate) fn drop_reservation(&self, conn: SlotId) {
        if conn.worker() != self.worker || self.reservations.load(Ordering::Acquire) == 0 {
            return;
        }
        let mut reserved = lock(&self.reserved);
        let before = reserved.len();
        reserved.retain(|reservation| reservation.conn != conn);
        let dropped = before.saturating_sub(reserved.len());
        if dropped > 0 {
            self.reservations.fetch_sub(dropped, Ordering::Release);
        }
    }

    /// Close every reserved connection whose slot `gone` reports retired or closed,
    /// since its action can no longer run; a reservation whose entry another path
    /// closed already leaves the list without a report.
    ///
    /// # Returns
    ///
    /// The ids and what each entry held.
    pub(crate) fn sweep(&self, gone: impl Fn(SlotId) -> bool) -> Vec<(SlotId, Live)> {
        if self.reservations.load(Ordering::Acquire) == 0 {
            return Vec::new();
        }
        let abandoned: Vec<SlotId> = lock(&self.reserved)
            .iter()
            .filter(|reservation| gone(reservation.slot))
            .map(|reservation| reservation.conn)
            .collect();
        abandoned
            .into_iter()
            .filter_map(|conn| match self.close(conn) {
                Some(live) => Some((conn, live)),
                None => {
                    self.drop_reservation(conn);
                    None
                }
            })
            .collect()
    }

    /// Close every reserved connection, whose action can no longer run.
    pub(crate) fn close_reserved(&self) {
        if self.reservations.load(Ordering::Acquire) == 0 {
            return;
        }
        let reserved: Vec<SlotId> = lock(&self.reserved)
            .iter()
            .map(|reservation| reservation.conn)
            .collect();
        for conn in reserved {
            if self.close(conn).is_none() {
                self.drop_reservation(conn);
            }
        }
    }

    /// Close every connection the table holds, reserved or not, for a core that
    /// ended, or for a core that starts on this worker index after another server
    /// held it, so no connection outlives the core that would have served it.
    pub(crate) fn close_all(&self) {
        self.close_reserved();
        let grown = lock(&self.free).grown;
        for index in (0..grown).filter_map(|index| u16::try_from(index).ok()) {
            let Some(entry) = self.entry(index) else {
                continue;
            };
            let word = entry.word.load(Ordering::Acquire);
            if word & OPEN == 0 {
                continue;
            }
            let generation = u32::try_from(word & u64::from(GENERATION_MASK)).unwrap_or(0);
            if let Some(id) = SlotId::new(self.worker, generation, index) {
                self.close(id);
            }
        }
    }

    /// Install the WebSocket routes of the server that holds this worker index.
    pub(crate) fn set_routes(&self, routes: Arc<Routes>) {
        *lock(&self.routes) = Some(routes);
    }

    /// The WebSocket routes of the server that holds this worker index.
    pub(crate) fn routes(&self) -> Option<Arc<Routes>> {
        lock(&self.routes).clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use zero_core::SlotId;

    use super::{table, Kind};
    use crate::Status;

    #[test]
    fn a_reservation_is_listed_for_the_sweep_only_once_its_lease_checks_again() {
        let Some(table) = table(125) else {
            panic!("the table exists");
        };
        let slot = SlotId::new(125, 1, 0).unwrap();
        let ended = table
            .reserve(Kind::EventStream, 0, slot, || false)
            .unwrap_err();
        assert_eq!(ended.status(), Status::Closed);
        assert!(
            table.sweep(|_| true).is_empty(),
            "a lease that ended leaves nothing for the sweep to report"
        );

        let closed_first = table
            .reserve(Kind::EventStream, 0, slot, || {
                table.close_all();
                true
            })
            .unwrap();
        assert!(
            table
                .live(SlotId::from_raw(closed_first).unwrap())
                .is_none(),
            "a core that ended or started closed the entry before it was listed"
        );
        assert!(
            table.sweep(|_| true).is_empty(),
            "the sweep reports no entry another path closed"
        );
        assert_eq!(
            table.reservations.load(Ordering::Acquire),
            0,
            "and drops its listing"
        );
    }

    #[test]
    fn a_table_answers_nothing_for_the_id_of_another_worker_index() {
        let (Some(ours), Some(theirs)) = (table(126), table(127)) else {
            panic!("both tables exist");
        };
        let own = ours
            .reserve(Kind::WebSocket, 0, SlotId::new(126, 1, 0).unwrap(), || true)
            .unwrap();
        let foreign = theirs
            .reserve(Kind::WebSocket, 0, SlotId::new(127, 1, 0).unwrap(), || true)
            .unwrap();
        let (own, foreign) = (
            SlotId::from_raw(own).unwrap(),
            SlotId::from_raw(foreign).unwrap(),
        );
        assert_eq!(
            (own.index(), own.generation()),
            (foreign.index(), foreign.generation()),
            "the same entry and generation on two worker indexes"
        );
        assert!(ours.live(foreign).is_none());
        assert!(ours.close(foreign).is_none());
        ours.drop_reservation(foreign);
        assert!(
            ours.live(own).is_some(),
            "the index's own connection is untouched"
        );
        assert!(theirs.live(foreign).is_some());
        assert!(ours.close(own).is_some());
        assert!(theirs.close(foreign).is_some());
    }
}
