//! The events a connection reports to the host, and the bookkeeping that bounds
//! what a connection has waiting for the host.
//!
//! Each connection task turns what happens on its connection into an event record
//! and hands it to the core's dispatcher, which posts events in batches beside the
//! request batches. Events reach the host in the order they happened on each
//! connection. A connection keeps at most
//! [`MAX_PENDING_EVENTS_PER_CONN`](zero_limits::services::MAX_PENDING_EVENTS_PER_CONN)
//! events the host has not acknowledged, and stops reading its socket while it holds
//! that many or while the payloads of every event its core handed over and the host
//! has not acknowledged pass half the core's request-memory budget, so a client
//! that floods it is held back by TCP flow control rather than by server memory.
//! Those payload octets also count in the budget itself, which pauses accepts.
//!
//! The dispatcher does not say which batch carried which event, so the core keeps a
//! ledger: every event handed over gets the next sequence number, and after each
//! dispatcher turn the core records the newest posted epoch beside the count and the
//! payload octets of the events posted so far. Once the target acknowledged that
//! epoch, every event up to that count is acknowledged; events the dispatcher
//! dropped when its target was lost count as acknowledged when the loss settles the
//! epochs, and so does every event once the core's host dispatch failed. An event
//! that finds the dispatcher's queue full waits on its connection, or in the core's
//! own queue for the close event of a connection that never started, and an event
//! for a worker index with no target is dropped, since no host is there to take it.

use std::collections::VecDeque;
use std::task::{Context, Poll, Waker};

use zero_limits::services::MAX_PENDING_EVENTS_PER_CONN;
use zero_rt::EventRec;

use crate::handler::CoreHost;

/// What the dispatcher had posted or dropped when a turn posted events: the newest
/// epoch then, and the count and the payload octets of the events up to then.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Mark {
    epoch: u64,
    through: u64,
    octets: u64,
}

/// Which events of one core the host has acknowledged.
#[derive(Debug, Default)]
pub(crate) struct Ledger {
    /// Events handed to the dispatcher; the sequence number of the newest.
    pushed: u64,
    /// The payload octets of the events handed to the dispatcher.
    pushed_octets: u64,
    /// Events posted or dropped as of the last turn.
    posted: u64,
    /// The turns that posted events and are not acknowledged yet.
    marks: VecDeque<Mark>,
    /// Events acknowledged or dropped.
    acked: u64,
    /// The payload octets of the events acknowledged or dropped.
    acked_octets: u64,
    /// The dispatcher could take an event, or drop it for want of a target.
    open: bool,
    /// Connections waiting for an acknowledgment.
    for_acks: Vec<Waker>,
    /// Connections waiting for the dispatcher to take an event.
    for_room: Vec<Waker>,
}

/// An event's payload octets.
pub(crate) fn octets_of(event: &EventRec) -> u64 {
    u64::try_from(event.data.len()).unwrap_or(u64::MAX)
}

impl Ledger {
    /// Count an event the dispatcher took.
    ///
    /// # Arguments
    ///
    /// * `octets` - its payload octets.
    ///
    /// # Returns
    ///
    /// The event's sequence number.
    pub(crate) fn took(&mut self, octets: u64) -> u64 {
        self.pushed = self.pushed.saturating_add(1);
        self.pushed_octets = self.pushed_octets.saturating_add(octets);
        self.pushed
    }

    /// How many events are acknowledged or dropped.
    pub(crate) const fn acked(&self) -> u64 {
        self.acked
    }

    /// The payload octets of the events handed to the dispatcher that are neither
    /// acknowledged nor dropped: queued, or posted in a batch the host holds.
    pub(crate) const fn outstanding(&self) -> u64 {
        self.pushed_octets.saturating_sub(self.acked_octets)
    }

    /// The dispatcher refused an event: its queue holds its bound until a turn
    /// finds room again.
    pub(crate) fn full(&mut self) {
        self.open = false;
    }

    /// The core's host dispatch failed, so no event will be acknowledged: count
    /// every event acknowledged and wake every waiting connection, which then
    /// drops what it holds for want of a target.
    pub(crate) fn forget(&mut self) {
        self.marks.clear();
        self.posted = self.pushed;
        self.acked = self.pushed;
        self.acked_octets = self.pushed_octets;
        self.open = true;
        wake(&mut self.for_acks);
        wake(&mut self.for_room);
    }

    /// Ready once more events than `since` are acknowledged or, with `room`, once
    /// the dispatcher can take an event; registers the task otherwise.
    pub(crate) fn poll_change(&mut self, since: u64, room: bool, cx: &Context<'_>) -> Poll<()> {
        if self.acked > since || (room && self.open) {
            return Poll::Ready(());
        }
        let waiting = if room {
            &mut self.for_room
        } else {
            &mut self.for_acks
        };
        if !waiting.iter().any(|waker| waker.will_wake(cx.waker())) {
            waiting.push(cx.waker().clone());
        }
        Poll::Pending
    }

    /// Record a dispatcher turn: what it posted and what the target acknowledged,
    /// and wake the connections whose wait may be over.
    ///
    /// # Arguments
    ///
    /// * `queued` - the events the dispatcher still queues, and their payload octets.
    /// * `published` - the newest epoch posted.
    /// * `floor` - the newest epoch acknowledged.
    /// * `open` - whether the dispatcher can take an event now, or has no target.
    pub(crate) fn settle(
        &mut self,
        queued: (usize, usize),
        published: u64,
        floor: u64,
        open: bool,
    ) {
        let (queued, queued_octets) = queued;
        let posted = self
            .pushed
            .saturating_sub(u64::try_from(queued).unwrap_or(u64::MAX));
        if posted > self.posted {
            self.marks.push_back(Mark {
                epoch: published,
                through: posted,
                octets: self
                    .pushed_octets
                    .saturating_sub(u64::try_from(queued_octets).unwrap_or(u64::MAX)),
            });
            self.posted = posted;
        }
        let before = self.acked;
        while let Some(&mark) = self.marks.front() {
            if mark.epoch > floor {
                break;
            }
            self.acked = mark.through;
            self.acked_octets = mark.octets;
            self.marks.pop_front();
        }
        self.open = open;
        if self.acked > before {
            wake(&mut self.for_acks);
            wake(&mut self.for_room);
        } else if open {
            wake(&mut self.for_room);
        }
    }
}

fn wake(waiting: &mut Vec<Waker>) {
    for waker in waiting.drain(..) {
        waker.wake();
    }
}

/// What a connection waits for before it reads its socket again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Wait {
    /// The connection holds its bound of events, or an event the dispatcher refused.
    pub(crate) paused: bool,
    /// The acknowledged count the wait started from.
    pub(crate) since: u64,
    /// An event waits for room in the dispatcher's queue.
    pub(crate) room: bool,
}

/// The events of one connection the host has not acknowledged, and those still
/// waiting for the dispatcher to take them.
#[derive(Debug)]
pub(crate) struct Pending {
    conn: u64,
    route: u32,
    sequences: VecDeque<u64>,
    held: VecDeque<EventRec>,
}

impl Pending {
    pub(crate) fn new(conn: u64, route: u32) -> Self {
        Pending {
            conn,
            route,
            sequences: VecDeque::with_capacity(MAX_PENDING_EVENTS_PER_CONN),
            held: VecDeque::new(),
        }
    }

    /// An event of this connection.
    pub(crate) fn event(&self, kind: u8, opcode: u8, code: u16, data: Vec<u8>) -> EventRec {
        EventRec {
            conn: self.conn,
            route: self.route,
            kind,
            opcode,
            code,
            data,
        }
    }

    /// Queue an event after those already waiting and hand what the dispatcher takes
    /// over.
    pub(crate) fn report(&mut self, core: &CoreHost, event: EventRec) {
        self.held.push_back(event);
        self.flush(core);
    }

    /// Hand the waiting events to the dispatcher in order while it takes them, or
    /// drop them when no target is attached.
    pub(crate) fn flush(&mut self, core: &CoreHost) {
        if self.held.is_empty() {
            return;
        }
        let (Ok(mut dispatch), Ok(mut ledger)) = (
            core.dispatch.try_borrow_mut(),
            core.realtime().ledger.try_borrow_mut(),
        ) else {
            return;
        };
        if !dispatch.has_target() {
            self.held.clear();
            return;
        }
        let mut took = false;
        while let Some(event) = self.held.pop_front() {
            let octets = octets_of(&event);
            match dispatch.push_event(event) {
                Ok(()) => {
                    self.sequences.push_back(ledger.took(octets));
                    took = true;
                }
                Err(event) => {
                    self.held.push_front(event);
                    ledger.full();
                    break;
                }
            }
        }
        drop((dispatch, ledger));
        if took {
            core.kick.wake();
        }
    }

    /// Hand over what waits, forget what the host acknowledged, and tell whether the
    /// connection must stop reading until the ledger changes: it holds its bound of
    /// events, an event waits for room, or its core holds more than half its
    /// request-memory budget in event payloads the host has not acknowledged.
    pub(crate) fn settle(&mut self, core: &CoreHost) -> Wait {
        self.flush(core);
        let budget = core.settings().realtime.memory_budget;
        let (acked, over) = core
            .realtime()
            .ledger
            .try_borrow()
            .map_or((0, false), |ledger| {
                (ledger.acked(), ledger.outstanding() > budget / 2)
            });
        while self
            .sequences
            .front()
            .is_some_and(|&sequence| sequence <= acked)
        {
            self.sequences.pop_front();
        }
        let room = !self.held.is_empty();
        Wait {
            paused: room
                || over
                || self.sequences.len().saturating_add(self.held.len())
                    >= MAX_PENDING_EVENTS_PER_CONN,
            since: acked,
            room,
        }
    }

    /// Whether every event was handed over or dropped.
    pub(crate) fn is_clear(&self) -> bool {
        self.held.is_empty()
    }
}
