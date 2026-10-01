//! The HTTP/1.1 connection driver: one task per connection that reads heads and
//! bodies, runs handlers inline, and writes responses in request order.
//!
//! The task is one loop. Each turn does the bookkeeping (expired timers, the input
//! buffer, requests that may start, the next write), then waits on every pending
//! operation at once: the running handler futures in the ring, the write in
//! progress, the read, the earliest deadline, and the shutdown signal. The read and
//! write futures borrow nothing the ring owns, so a handler keeps being polled while
//! the socket is not ready. A receive block is leased only when the socket is readable
//! and returned as soon as its bytes are consumed, so a waiting connection holds its
//! record, its ring and its deadline and no buffer (`DESIGN.md` section 5.6).

use std::cell::{Cell, RefCell};
use std::future::{poll_fn, Future};
use std::io::{self, IoSlice};
use std::net::SocketAddr;
use std::pin::pin;
use std::rc::Rc;
use std::task::Poll;
use std::time::{Duration, Instant};

use zero_core::OwnedBuf;
use zero_http1::{
    body_allowed, content_length_allowed, parse_request, parse_trailers, BodyLength,
    ChunkedDecoder, Expect, Field, Head, Reject, ResponseWriter, Status, Step, Version, WriteError,
};
use zero_http_types::{HeaderName, StatusCode};
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Shutdown, Stream, Timer};
use zero_limits::Http1Limits;
use zero_rt::{contain, Reset, Worker};

use crate::call::Call;
use crate::error::Problem;
use crate::handler::Handler;
use crate::record::{Record, RESPONSE_HEAD_CAPACITY};
use crate::ring::{poll_running, record_at, Entry, Framing, Ring, Split, Stage, CAP};
use crate::takeover::{TakeOver, Taken};

/// The interim response owed to a `100-continue` expectation.
const CONTINUE: &[u8] = b"HTTP/1.1 100 Continue\r\n\r\n";

/// The most records a core keeps for reuse.
const RECORDS_KEPT: usize = 4_096;

/// How long a closed connection keeps reading for the peer's close, so the last
/// response is not lost to a reset (RFC 9112 Section 9.6).
const LINGER: Duration = Duration::from_secs(1);

/// How long a connection waits for pool budget before trying to read again.
const BUDGET_RETRY: Duration = Duration::from_millis(1);

/// A response head is never grown past this.
const MAX_RESPONSE_HEAD: usize = 16 * 1024 * 1024;

/// The most slices one write names: the `100 Continue` block plus a head and a body
/// per response.
const SLICES: usize = 1 + 2 * CAP;

/// The trailer table a chunked body's trailers are validated into.
const TRAILER_TABLE: usize = 16;

/// What every connection on a core shares.
pub(crate) struct Shared<H> {
    pub(crate) worker: Worker,
    pub(crate) handler: H,
    pub(crate) limits: Http1Limits,
    /// The `Server` field line, or empty.
    pub(crate) server: Vec<u8>,
    // Records move between this list, the ring and the handler future by pointer,
    // which is why they stay boxed.
    #[allow(clippy::vec_box)]
    records: RefCell<Vec<Box<Record>>>,
    bodies: Cell<u64>,
    budget: u64,
}

impl<H> Shared<H> {
    /// The core's shared state.
    pub(crate) fn new(
        worker: Worker,
        handler: H,
        limits: Http1Limits,
        server: Vec<u8>,
        budget: u64,
    ) -> Self {
        Shared {
            worker,
            handler,
            limits,
            server,
            records: RefCell::new(Vec::new()),
            bodies: Cell::new(0),
            budget,
        }
    }

    /// A reset record: one the core kept, else a new one.
    pub(crate) fn take_record(&self) -> Box<Record> {
        self.records
            .borrow_mut()
            .pop()
            .unwrap_or_else(|| Box::new(Record::new(self.limits.header_table_entries)))
    }

    /// Keep a record for reuse.
    pub(crate) fn give_record(&self, mut record: Box<Record>) {
        record.reset();
        let mut free = self.records.borrow_mut();
        if free.len() < RECORDS_KEPT {
            free.push(record);
        }
    }

    /// Whether leased receive blocks plus buffered bodies exceed the core's
    /// request-memory budget, in which case the core pauses accepts.
    pub(crate) fn over_budget(&self) -> bool {
        self.worker
            .core()
            .pool
            .leased_bytes()
            .saturating_add(self.bodies.get())
            > self.budget
    }

    fn count_body(&self, bytes: u64) {
        self.bodies.set(self.bodies.get().saturating_add(bytes));
    }

    fn uncount_body(&self, bytes: u64) {
        self.bodies.set(self.bodies.get().saturating_sub(bytes));
    }

    fn pool(&self) -> &Pool {
        &self.worker.core().pool
    }
}

/// Run the handler for one request under panic containment; the record comes back
/// with the response set, from the handler, the registry or the panic rule.
pub(crate) async fn request_task<H: Handler>(
    shared: Rc<Shared<H>>,
    mut record: Box<Record>,
) -> Box<Record> {
    let outcome = {
        let mut call = Call::new(&mut record, &shared.worker);
        contain(shared.handler.handle(&mut call)).await
    };
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => record.problem(&Problem::from_error(&error)),
        Err(panicked) => {
            shared.worker.note_panic(panicked.message);
            record.problem(&Problem::panicked());
        }
    }
    record
}

/// The unconsumed input of a connection: nothing, a leased block, or heap bytes when
/// a head outgrew one block.
enum Input {
    None,
    Block { buf: OwnedBuf, consumed: usize },
    Heap { bytes: Vec<u8>, consumed: usize },
}

impl Input {
    fn tail(&self) -> &[u8] {
        match self {
            Input::None => &[],
            Input::Block { buf, consumed } => buf.filled().get(*consumed..).unwrap_or(&[]),
            Input::Heap { bytes, consumed } => bytes.get(*consumed..).unwrap_or(&[]),
        }
    }

    fn is_empty(&self) -> bool {
        self.tail().is_empty()
    }

    fn consume(&mut self, count: usize) {
        match self {
            Input::None => {}
            Input::Block { consumed, .. } | Input::Heap { consumed, .. } => {
                *consumed = consumed.saturating_add(count);
            }
        }
    }

    /// Apply the consumed prefix: release an exhausted block, move a partial tail to
    /// the front.
    fn compact(&mut self, pool: &Pool) {
        match self {
            Input::None => {}
            Input::Block { buf, consumed } => {
                if *consumed >= buf.len() {
                    if let Input::Block { buf, .. } = std::mem::replace(self, Input::None) {
                        pool.release(buf);
                    }
                } else if *consumed > 0 {
                    if buf.consume(*consumed).is_err() {
                        buf.clear();
                    }
                    *consumed = 0;
                }
            }
            Input::Heap { bytes, consumed } => {
                if *consumed >= bytes.len() {
                    *self = Input::None;
                } else if *consumed > 0 {
                    bytes.drain(..*consumed);
                    *consumed = 0;
                }
            }
        }
    }

    /// Take in a block just read: it becomes the input, joins a partial head in the
    /// current block, or moves everything to the heap when the block is full.
    fn absorb(&mut self, new: OwnedBuf, pool: &Pool) {
        self.compact(pool);
        match self {
            Input::None => {
                *self = Input::Block {
                    buf: new,
                    consumed: 0,
                }
            }
            Input::Block { buf, .. } => {
                if buf.remaining() >= new.len() && buf.put(new.filled()).is_ok() {
                    pool.release(new);
                    return;
                }
                let mut bytes = Vec::with_capacity(buf.len().saturating_add(new.len()));
                bytes.extend_from_slice(buf.filled());
                bytes.extend_from_slice(new.filled());
                pool.release(new);
                if let Input::Block { buf, .. } = std::mem::replace(self, Input::None) {
                    pool.release(buf);
                }
                *self = Input::Heap { bytes, consumed: 0 };
            }
            Input::Heap { bytes, .. } => {
                bytes.extend_from_slice(new.filled());
                pool.release(new);
            }
        }
    }

    /// Discard everything.
    fn clear(&mut self, pool: &Pool) {
        if let Input::Block { buf, .. } = std::mem::replace(self, Input::None) {
            pool.release(buf);
        }
    }
}

/// The write in progress: the first `count` entries of the ring, all `Done`, after an
/// optional `100 Continue` for the head entry.
#[derive(Clone, Copy, Debug)]
struct Writing {
    count: usize,
    prefix: bool,
    written: usize,
    total: usize,
}

/// What one turn of the loop woke up for.
enum Event {
    Read(io::Result<Leased>),
    Wrote(io::Result<usize>),
    Progress,
    Timer,
    Shutdown,
}

/// What feeding body bytes to the tail entry did.
enum Fed {
    Progress,
    Stalled,
    Reject(StatusCode),
}

/// The driver of one connection.
pub(crate) struct Conn<S, H, Req> {
    shared: Rc<Shared<H>>,
    stream: Rc<S>,
    peer: SocketAddr,
    make: fn(Rc<Shared<H>>, Box<Record>) -> Req,
    input: Input,
    /// The record a head is being parsed into.
    next: Option<Box<Record>>,
    /// When the first byte of an incomplete head arrived.
    head_since: Option<Instant>,
    /// When the connection last became idle.
    idle_since: Instant,
    ring: Ring<Req>,
    writing: Option<Writing>,
    completed: Vec<(usize, Box<Record>)>,
    requests: u32,
    /// No further request is read; the connection closes once the ring is written.
    close: bool,
    /// The shutdown signal was seen.
    draining: bool,
    /// The pool had no budget; reading resumes at this time.
    retry_read_at: Option<Instant>,
    /// The socket failed; nothing more is written.
    aborted: bool,
    /// A handler claimed the connection; no further input is parsed or read.
    taking: bool,
    /// The claimed request, once its response head is written.
    taken: Option<Box<Record>>,
}

impl<S, H, Req> Conn<S, H, Req>
where
    S: Stream + 'static,
    H: Handler,
    Req: std::future::Future<Output = Box<Record>>,
{
    /// A driver for an accepted connection.
    pub(crate) fn new(
        shared: Rc<Shared<H>>,
        stream: Rc<S>,
        peer: SocketAddr,
        make: fn(Rc<Shared<H>>, Box<Record>) -> Req,
    ) -> Self {
        Conn {
            shared,
            stream,
            peer,
            make,
            input: Input::None,
            next: None,
            head_since: None,
            idle_since: Instant::now(),
            ring: Ring::new(),
            writing: None,
            completed: Vec::with_capacity(CAP),
            requests: 0,
            close: false,
            draining: false,
            retry_read_at: None,
            aborted: false,
            taking: false,
            taken: None,
        }
    }

    /// Serve the connection until it closes.
    ///
    /// This is an async block over a captured binding rather than an `async fn`
    /// taking `self`: an `async fn` keeps every argument twice, as the value moved
    /// in and as the local it is moved into, which would store the ring in the
    /// task twice over.
    pub(crate) fn run(self) -> impl Future<Output = ()> {
        let mut conn = self;
        async move {
            loop {
                conn.tick();
                if conn.taken.is_some()
                    || conn.aborted
                    || (conn.close && conn.ring.is_empty() && conn.writing.is_none())
                {
                    break;
                }
                let event = conn.wait().await;
                conn.apply(event);
            }
            let leftover = conn.input.tail().to_vec();
            conn.input.clear(conn.shared.pool());
            if let Some(record) = conn.next.take() {
                conn.shared.give_record(record);
            }
            conn.discard_from(0);
            if conn.aborted {
                return;
            }
            if let Some(record) = conn.taken.take() {
                if let Some(claim) = record.claim {
                    let taken = Taken::new(
                        Rc::clone(&conn.stream),
                        leftover,
                        record,
                        conn.shared.worker.clone(),
                        claim,
                    );
                    conn.shared.handler.taken(taken).await;
                }
            }
            conn.linger().await;
        }
    }

    fn limits(&self) -> &Http1Limits {
        &self.shared.limits
    }

    fn max_pipelined(&self) -> usize {
        self.shared.limits.max_pipelined.clamp(1, CAP)
    }

    /// The bookkeeping of one turn.
    fn tick(&mut self) {
        let now = Instant::now();
        self.expire(now);
        self.process_input(now);
        self.start_runnable();
        self.plan_write();
    }

    /// Wait for the next event: a handler completing, the write, the read, the
    /// earliest deadline, or the shutdown signal.
    async fn wait(&mut self) -> Event {
        let now = Instant::now();
        let deadline = self.next_deadline(now);
        let want_read = (self.input.is_empty() || self.head_since.is_some())
            && (!self.close || self.ring.body_pending())
            && self.retry_read_at.is_none()
            && !self.taking
            && !self.ring.upgrade_pending();
        let watch_shutdown = !self.draining;
        let Conn {
            shared,
            stream,
            ring,
            writing,
            completed,
            ..
        } = self;
        let core = shared.worker.core();
        let pool = &core.pool;
        let Split {
            entries,
            futures,
            head,
            len,
        } = ring.split();
        let mut slices = [IoSlice::new(&[]); SLICES];
        let (skipped, filled) = match writing {
            Some(writing) => fill_slices(entries, head, *writing, &mut slices),
            None => (0, 0),
        };
        let to_write = slices.get(skipped..filled).unwrap_or(&[]);
        let mut read = pin!(stream.read_leased(pool));
        let mut write = pin!(stream.writev(to_write));
        let mut sleep = pin!(
            core.sleep(deadline.map_or(Duration::ZERO, |at| { at.saturating_duration_since(now) }))
        );
        let mut shutdown = pin!(shared.worker.shutdown().requested());
        poll_fn(|cx| {
            poll_running(entries, futures, head, len, cx, completed);
            if !to_write.is_empty() {
                if let Poll::Ready(outcome) = write.as_mut().poll(cx) {
                    return Poll::Ready(Event::Wrote(outcome));
                }
            }
            if want_read {
                if let Poll::Ready(outcome) = read.as_mut().poll(cx) {
                    return Poll::Ready(Event::Read(outcome));
                }
            }
            if deadline.is_some() && sleep.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Event::Timer);
            }
            if watch_shutdown && shutdown.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Event::Shutdown);
            }
            if completed.is_empty() {
                Poll::Pending
            } else {
                Poll::Ready(Event::Progress)
            }
        })
        .await
    }

    /// React to what the wait produced.
    fn apply(&mut self, event: Event) {
        let now = Instant::now();
        self.drain_completed();
        match event {
            Event::Read(Ok(Leased::Data(buf))) => self.input.absorb(buf, self.shared.pool()),
            Event::Read(Ok(Leased::Eof)) => self.eof(),
            Event::Read(Ok(Leased::NoBudget)) => self.retry_read_at = Some(now + BUDGET_RETRY),
            Event::Read(Err(_)) | Event::Wrote(Err(_) | Ok(0)) => self.aborted = true,
            Event::Wrote(Ok(count)) => self.wrote(count, now),
            Event::Progress | Event::Timer => {}
            Event::Shutdown => {
                self.draining = true;
                self.mark_close();
            }
        }
    }

    /// Serialize every completed response and mark its entry done.
    fn drain_completed(&mut self) {
        while let Some((position, record)) = self.completed.pop() {
            self.complete(position, record);
        }
    }

    fn complete(&mut self, position: usize, mut record: Box<Record>) {
        let last = !self.ring.is_empty() && self.ring.position(self.ring.len() - 1) == position;
        let close = record.close || (self.close && last);
        serialize(&self.shared, &mut record, close);
        if record.claim.is_some() {
            // The connection ends with the claim: nothing after it is parsed, and
            // requests pipelined behind it are dropped.
            self.taking = true;
            if let Some(index) = self.ring.index_of(position) {
                self.discard_from(index.saturating_add(1));
            }
        }
        self.ring.clear_future(position);
        if let Some(entry) = self.ring.entry_mut(position) {
            entry.record = Some(record);
            entry.stage = Stage::Done;
        } else {
            self.shared.give_record(record);
        }
    }

    /// The peer closed its side: an incomplete request gets no response, the
    /// complete ones are answered, then the connection closes.
    fn eof(&mut self) {
        self.input.clear(self.shared.pool());
        self.head_since = None;
        if let Some(record) = self.next.take() {
            self.shared.give_record(record);
        }
        if self.ring.body_pending() {
            if let Some(entry) = self.ring.pop_back() {
                self.release_entry(entry);
            }
        }
        self.mark_close();
    }

    /// Bytes were written: finish the batch when it is complete.
    fn wrote(&mut self, count: usize, now: Instant) {
        let Some(mut writing) = self.writing else {
            return;
        };
        writing.written = writing.written.saturating_add(count);
        if writing.written < writing.total {
            self.writing = Some(writing);
            return;
        }
        self.writing = None;
        if writing.prefix {
            if let Some(entry) = self.ring.entry_mut(self.ring.position(0)) {
                if let Stage::Body {
                    continue_pending, ..
                } = &mut entry.stage
                {
                    *continue_pending = false;
                }
                if let Some(record) = entry.record.as_mut() {
                    record.continued = true;
                }
            }
        }
        let mut closed = false;
        for _ in 0..writing.count {
            if let Some(mut entry) = self.ring.pop_front() {
                closed |= entry.record.as_ref().is_some_and(|record| record.close);
                if entry
                    .record
                    .as_ref()
                    .is_some_and(|record| record.claim.is_some())
                {
                    self.taken = entry.record.take();
                }
                self.release_entry(entry);
            }
        }
        if closed {
            self.discard_from(0);
            self.close = true;
        }
        if self.ring.is_empty() {
            self.idle_since = now;
        }
    }

    /// Return an entry's record and body budget.
    fn release_entry(&mut self, entry: Entry) {
        self.shared.uncount_body(entry.body_bytes);
        if let Some(record) = entry.record {
            self.shared.give_record(record);
        }
    }

    /// Drop every entry from the `from`th onward; their handlers are cancelled.
    fn discard_from(&mut self, from: usize) {
        while self.ring.len() > from {
            if let Some(entry) = self.ring.pop_back() {
                self.release_entry(entry);
            }
        }
    }

    /// Fire every deadline that passed.
    fn expire(&mut self, now: Instant) {
        if self.retry_read_at.is_some_and(|at| now >= at) {
            self.retry_read_at = None;
        }
        let limits = *self.limits();
        if self.idle() && !self.close && now >= self.idle_since + limits.idle_keep_alive {
            // RFC 9112 Section 9.5: a server that wishes to time out issues a graceful
            // close; no response is owed.
            self.close = true;
            return;
        }
        if self
            .head_since
            .is_some_and(|since| now >= since + limits.header_read_timeout)
        {
            self.head_since = None;
            self.input.clear(self.shared.pool());
            let record = self
                .next
                .take()
                .unwrap_or_else(|| self.shared.take_record());
            self.answer_now(record, StatusCode::REQUEST_TIMEOUT, now);
            return;
        }
        for index in 0..self.ring.len() {
            let position = self.ring.position(index);
            let Some(entry) = self.ring.entry(position) else {
                continue;
            };
            let total = entry.accepted + limits.request_total;
            let expired = match entry.stage {
                Stage::Body { .. } => (now >= entry.last_byte + limits.body_read_idle
                    || now >= total)
                    .then_some(StatusCode::REQUEST_TIMEOUT),
                Stage::Waiting | Stage::Running => {
                    (now >= total).then_some(StatusCode::SERVICE_UNAVAILABLE)
                }
                Stage::Done => None,
            };
            if let Some(status) = expired {
                self.fail_at(index, status);
                return;
            }
        }
    }

    /// Whether nothing is in flight and nothing is being read.
    fn idle(&self) -> bool {
        self.ring.is_empty()
            && self.input.is_empty()
            && self.head_since.is_none()
            && self.writing.is_none()
    }

    /// The earliest deadline, if any.
    fn next_deadline(&self, now: Instant) -> Option<Instant> {
        let limits = self.limits();
        let mut earliest: Option<Instant> = self.retry_read_at;
        let mut note = |at: Instant| {
            earliest = Some(earliest.map_or(at, |current| current.min(at)));
        };
        if self.idle() && !self.close {
            note(self.idle_since + limits.idle_keep_alive);
        }
        if let Some(since) = self.head_since {
            note(since + limits.header_read_timeout);
        }
        for index in 0..self.ring.len() {
            let Some(entry) = self.ring.entry(self.ring.position(index)) else {
                continue;
            };
            match entry.stage {
                Stage::Body { .. } => {
                    note(entry.last_byte + limits.body_read_idle);
                    note(entry.accepted + limits.request_total);
                }
                Stage::Waiting | Stage::Running => note(entry.accepted + limits.request_total),
                Stage::Done => {}
            }
        }
        earliest.map(|at| at.max(now))
    }

    /// Answer the `index`th request with `status` and close; later requests are
    /// discarded, a running handler is cancelled.
    fn fail_at(&mut self, index: usize, status: StatusCode) {
        self.discard_from(index.saturating_add(1));
        let position = self.ring.position(index);
        self.ring.clear_future(position);
        let mut record = self
            .ring
            .entry_mut(position)
            .and_then(|entry| entry.record.take())
            .unwrap_or_else(|| self.shared.take_record());
        record.clear_response();
        record.status = Some(status);
        record.close = true;
        serialize(&self.shared, &mut record, true);
        if let Some(entry) = self.ring.entry_mut(position) {
            entry.record = Some(record);
            entry.stage = Stage::Done;
        }
        self.input.clear(self.shared.pool());
        self.mark_close();
    }

    /// Answer a request that has no entry yet (a rejected or timed-out head) and
    /// close.
    fn answer_now(&mut self, mut record: Box<Record>, status: StatusCode, now: Instant) {
        record.clear_response();
        record.status = Some(status);
        record.close = true;
        serialize(&self.shared, &mut record, true);
        let entry = Entry::new(record, Stage::Done, now);
        if let Err(entry) = self.ring.push(entry) {
            self.release_entry(entry);
            self.aborted = true;
        }
        self.input.clear(self.shared.pool());
        self.mark_close();
    }

    /// No further request is read; the last response says so.
    fn mark_close(&mut self) {
        self.close = true;
        if self.ring.is_empty() {
            return;
        }
        let last = self.ring.len() - 1;
        let in_batch = self.writing.is_some_and(|writing| last < writing.count);
        if in_batch {
            return;
        }
        let position = self.ring.position(last);
        if let Some(entry) = self.ring.entry_mut(position) {
            if matches!(entry.stage, Stage::Done) {
                if let Some(record) = entry.record.as_mut() {
                    serialize(&self.shared, record, true);
                }
            }
        }
    }

    /// Parse heads and read bodies from the input.
    fn process_input(&mut self, now: Instant) {
        loop {
            if self.input.is_empty() {
                break;
            }
            if self.ring.body_pending() {
                match self.feed_body(now) {
                    Fed::Progress => continue,
                    Fed::Stalled => break,
                    Fed::Reject(status) => {
                        let last = self.ring.len().saturating_sub(1);
                        self.fail_at(last, status);
                        break;
                    }
                }
            }
            if self.taking || self.ring.upgrade_pending() {
                // RFC 9110 Section 7.8: what follows an upgrade request may be the
                // new protocol; it stays unparsed until the handler decides.
                break;
            }
            if self.close {
                // RFC 9112 Section 9.6: no further request on this connection is
                // processed.
                self.input.clear(self.shared.pool());
                break;
            }
            if self.ring.len() >= self.max_pipelined() {
                break;
            }
            if !self.parse_head(now) {
                break;
            }
        }
        self.input.compact(self.shared.pool());
    }

    /// Feed body bytes to the tail entry.
    fn feed_body(&mut self, now: Instant) -> Fed {
        let Conn {
            ring,
            input,
            shared,
            ..
        } = self;
        let limits = &shared.limits;
        let Some(entry) = ring.last_mut() else {
            return Fed::Stalled;
        };
        let Stage::Body {
            framing,
            continue_pending,
            max_body,
        } = &mut entry.stage
        else {
            return Fed::Stalled;
        };
        let Some(record) = entry.record.as_mut() else {
            return Fed::Stalled;
        };
        let tail = input.tail();
        if tail.is_empty() {
            return Fed::Stalled;
        }
        // RFC 9110 Section 10.1.1: the 100 may be omitted once content arrived.
        *continue_pending = false;
        entry.last_byte = now;
        match framing {
            Framing::Length(remaining) => {
                let take = usize::try_from(*remaining)
                    .unwrap_or(usize::MAX)
                    .min(tail.len());
                record
                    .body
                    .extend_from_slice(tail.get(..take).unwrap_or(&[]));
                let counted = u64::try_from(take).unwrap_or(u64::MAX);
                entry.body_bytes = entry.body_bytes.saturating_add(counted);
                shared.count_body(counted);
                *remaining = remaining.saturating_sub(counted);
                input.consume(take);
                if *remaining == 0 {
                    entry.stage = Stage::Waiting;
                }
                Fed::Progress
            }
            Framing::Chunked(decoder) => match decoder.decode(tail, limits) {
                Ok(Step::Data { data, consumed }) => {
                    let after = u64::try_from(record.body.len().saturating_add(data.len()))
                        .unwrap_or(u64::MAX);
                    if after > *max_body {
                        return Fed::Reject(StatusCode::CONTENT_TOO_LARGE);
                    }
                    record.body.extend_from_slice(data);
                    let counted = u64::try_from(data.len()).unwrap_or(u64::MAX);
                    entry.body_bytes = entry.body_bytes.saturating_add(counted);
                    shared.count_body(counted);
                    input.consume(consumed);
                    Fed::Progress
                }
                Ok(Step::NeedMore { consumed }) => {
                    input.consume(consumed);
                    if consumed == 0 {
                        Fed::Stalled
                    } else {
                        Fed::Progress
                    }
                }
                Ok(Step::Done { trailers, consumed }) => {
                    let mut table = [Field::EMPTY; TRAILER_TABLE];
                    if let Err(reject) = parse_trailers(tail, trailers, &mut table, limits) {
                        return Fed::Reject(reject.status);
                    }
                    record.trailers.extend_from_slice(trailers.of(tail));
                    input.consume(consumed);
                    entry.stage = Stage::Waiting;
                    Fed::Progress
                }
                Err(reject) => Fed::Reject(reject.status),
            },
        }
    }

    /// Parse one head from the input.
    ///
    /// # Returns
    ///
    /// Whether the loop should go on parsing.
    fn parse_head(&mut self, now: Instant) -> bool {
        let Conn {
            next,
            input,
            shared,
            ..
        } = self;
        let record = next.get_or_insert_with(|| shared.take_record());
        let status = parse_request(input.tail(), &mut record.fields, &shared.limits);
        match status {
            Status::Complete(head) => {
                let Some(record) = next.take() else {
                    return false;
                };
                self.head_since = None;
                self.accept(record, head, now);
                true
            }
            Status::Partial => {
                self.head_since.get_or_insert(now);
                false
            }
            Status::Reject(reject) => {
                self.head_since = None;
                let Some(record) = next.take() else {
                    return false;
                };
                self.reject_head(record, reject, now);
                false
            }
        }
    }

    /// Take in a complete head: copy it into the record, decide the framing, and
    /// queue the request.
    fn accept(&mut self, mut record: Box<Record>, head: Head, now: Instant) {
        self.requests = self.requests.saturating_add(1);
        let limits = *self.limits();
        let head_bytes = self.input.tail().get(..head.len).unwrap_or(&[]);
        record.head.extend_from_slice(head_bytes);
        record.parsed = Some(head);
        record.peer = Some(self.peer);
        self.input.consume(head.len);
        let last = self.requests >= limits.max_requests_per_connection;
        if !head.keep_alive || last {
            self.close = true;
        }
        if head.expect == Expect::Other {
            // RFC 9110 Section 10.1.1: an expectation this server does not define may
            // be answered 417; the body that would follow is not read.
            return self.answer_now(record, StatusCode::EXPECTATION_FAILED, now);
        }
        let stage = match head.body {
            BodyLength::None | BodyLength::Length(0) => Stage::Waiting,
            BodyLength::Length(length) => {
                let max_body = self.body_limit(&record, head);
                if length > max_body {
                    // RFC 9110 Section 15.5.14: refused before any content is read.
                    return self.answer_now(record, StatusCode::CONTENT_TOO_LARGE, now);
                }
                Stage::Body {
                    framing: Framing::Length(length),
                    continue_pending: self.owes_continue(head),
                    max_body,
                }
            }
            BodyLength::Chunked => Stage::Body {
                framing: Framing::Chunked(ChunkedDecoder::new()),
                continue_pending: self.owes_continue(head),
                max_body: self.body_limit(&record, head),
            },
        };
        let entry = Entry::new(record, stage, now);
        if let Err(entry) = self.ring.push(entry) {
            self.release_entry(entry);
            self.aborted = true;
        }
    }

    /// The body limit for one request: the handler's answer for its method and path,
    /// or the server's `max_body`.
    fn body_limit(&self, record: &Record, head: Head) -> u64 {
        let path = record
            .head
            .get(head.path.start..head.path.end)
            .unwrap_or(&[]);
        self.shared
            .handler
            .body_limit(head.method, path)
            .unwrap_or(self.shared.limits.max_body)
    }

    /// Whether a `100 Continue` is owed: an HTTP/1.1 request that expects it and
    /// whose content has not started arriving (RFC 9110 Section 10.1.1).
    fn owes_continue(&self, head: Head) -> bool {
        head.expect == Expect::Continue && head.version == Version::Http11 && self.input.is_empty()
    }

    /// Answer a rejected head and close (RFC 9112 Section 2.2).
    fn reject_head(&mut self, record: Box<Record>, reject: Reject, now: Instant) {
        self.answer_now(record, reject.status, now);
    }

    /// Start every waiting request that may run: the head of the ring always, a
    /// later one only when it and everything before it is a safe method
    /// (RFC 9112 Section 9.3.2).
    fn start_runnable(&mut self) {
        let mut all_safe_before = true;
        for index in 0..self.ring.len() {
            let position = self.ring.position(index);
            let Some(entry) = self.ring.entry_mut(position) else {
                continue;
            };
            let safe = entry.safe;
            let waiting = matches!(entry.stage, Stage::Waiting);
            if waiting && (index == 0 || (all_safe_before && safe)) {
                if let Some(record) = entry.record.take() {
                    let future = (self.make)(Rc::clone(&self.shared), record);
                    if !self.ring.start(position, future) {
                        self.aborted = true;
                    }
                }
            }
            let started = self
                .ring
                .entry(position)
                .is_some_and(|entry| matches!(entry.stage, Stage::Running | Stage::Done));
            all_safe_before = all_safe_before && safe && started;
        }
    }

    /// Choose the next write: every consecutive done response from the head, or the
    /// `100 Continue` the head entry owes.
    fn plan_write(&mut self) {
        if self.writing.is_some() || self.aborted {
            return;
        }
        let mut count = 0;
        let mut total = 0usize;
        for index in 0..self.ring.len() {
            let Some(entry) = self.ring.entry(self.ring.position(index)) else {
                break;
            };
            let Stage::Done = entry.stage else {
                break;
            };
            let Some(record) = entry.record.as_ref() else {
                break;
            };
            count += 1;
            total = total.saturating_add(response_len(record));
        }
        if count > 0 {
            self.writing = Some(Writing {
                count,
                prefix: false,
                written: 0,
                total,
            });
            return;
        }
        let owes = self.ring.first().is_some_and(|entry| {
            matches!(
                entry.stage,
                Stage::Body {
                    continue_pending: true,
                    ..
                }
            )
        });
        if owes {
            self.writing = Some(Writing {
                count: 0,
                prefix: true,
                written: 0,
                total: CONTINUE.len(),
            });
        }
    }

    /// Half-close, then read until the peer closes or a second passes, so the last
    /// response reaches a client that is still sending (RFC 9112 Section 9.6).
    async fn linger(&self) {
        if self.stream.shutdown_write().is_err() {
            return;
        }
        let stream = Rc::clone(&self.stream);
        let core = self.shared.worker.core();
        let pool = Rc::clone(&core.pool);
        let drain = async move {
            while let Ok(Leased::Data(buf)) = stream.read_leased(&pool).await {
                pool.release(buf);
            }
        };
        let _ = core.timeout(LINGER, drain).await;
    }
}

/// The bytes a done response puts on the wire.
fn response_len(record: &Record) -> usize {
    let status = record.status.unwrap_or(StatusCode::OK);
    let body = if body_allowed(record.head_request(), status) {
        record.response_body.len()
    } else {
        0
    };
    record.response_head.len().saturating_add(body)
}

/// Fill the slice array for a write: the prefix, then each done response's head and
/// body, with the bytes already written skipped.
///
/// # Returns
///
/// The index of the first slice still to write and the number of slices filled.
fn fill_slices<'a>(
    entries: &'a [Option<Entry>; CAP],
    head: usize,
    writing: Writing,
    slices: &mut [IoSlice<'a>; SLICES],
) -> (usize, usize) {
    let mut filled = 0;
    let mut push = |bytes: &'a [u8]| {
        if bytes.is_empty() {
            return;
        }
        if let Some(slot) = slices.get_mut(filled) {
            *slot = IoSlice::new(bytes);
            filled += 1;
        }
    };
    if writing.prefix {
        push(CONTINUE);
    }
    for index in 0..writing.count {
        let Some(record) = record_at(entries, head, index) else {
            break;
        };
        push(&record.response_head);
        let status = record.status.unwrap_or(StatusCode::OK);
        if body_allowed(record.head_request(), status) {
            push(&record.response_body);
        }
    }
    let mut remaining: &mut [IoSlice<'a>] = slices.get_mut(..filled).unwrap_or(&mut []);
    let total: usize = remaining.iter().map(|slice| slice.len()).sum();
    if writing.written < total {
        IoSlice::advance_slices(&mut remaining, writing.written);
    }
    let skipped = filled.saturating_sub(remaining.len());
    (skipped, filled)
}

/// Serialize the response head of a record: status line, `Date`, `Server`,
/// `Content-Length`, the handler's fields, and `Connection` when the connection
/// closes or an HTTP/1.0 client asked to persist.
pub(crate) fn serialize<H>(shared: &Shared<H>, record: &mut Record, close: bool) {
    let date = shared.worker.core().date.block();
    let status = record.status.unwrap_or(StatusCode::OK);
    let head_request = record.head_request();
    // A claim holds only for the response it was made for: a handler that changed
    // the status afterwards, or failed, answers as usual.
    let kind = match record.claim.map(|claim| claim.kind) {
        Some(TakeOver::Upgrade) if status == StatusCode::SWITCHING_PROTOCOLS => {
            Some(TakeOver::Upgrade)
        }
        Some(TakeOver::Stream) if body_allowed(head_request, status) => Some(TakeOver::Stream),
        _ => None,
    };
    if kind.is_none() {
        record.claim = None;
    }
    let close = match kind {
        Some(TakeOver::Upgrade) => false,
        Some(TakeOver::Stream) => true,
        None => close,
    };
    let parts = HeadParts {
        status,
        head_request,
        date: &date,
        server: &shared.server,
        body_len: u64::try_from(record.response_body.len()).unwrap_or(u64::MAX),
        close,
        keep_alive_10: !close && record.version() == Version::Http10 && record.keep_alive(),
        upgrade: kind == Some(TakeOver::Upgrade),
        advertise_upgrade: record.advertise_upgrade,
        stream: kind == Some(TakeOver::Stream),
    };
    // RFC 9110 Section 7.8: a request with both Upgrade and 100-continue gets the
    // 100 before the 101.
    let owed_continue = parts.upgrade
        && !record.continued
        && record
            .parsed
            .is_some_and(|head| head.expect == Expect::Continue);
    let mut capacity = record.response_head.capacity().max(RESPONSE_HEAD_CAPACITY);
    loop {
        record.response_head.clear();
        record.response_head.resize(capacity, 0);
        let mut writer = ResponseWriter::new(&mut record.response_head, parts.head_request);
        match write_head(&mut writer, &parts, &record.response_fields) {
            Ok(()) => {
                let len = writer.len();
                record.response_head.truncate(len);
                if owed_continue {
                    record.response_head.splice(0..0, CONTINUE.iter().copied());
                }
                return;
            }
            Err(_) if capacity < MAX_RESPONSE_HEAD => capacity = capacity.saturating_mul(2),
            Err(_) => {
                // A head that cannot be written at all answers 500 with no fields.
                record.clear_response();
                record.status = Some(StatusCode::INTERNAL_SERVER_ERROR);
                let bare = HeadParts {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    body_len: 0,
                    upgrade: false,
                    advertise_upgrade: false,
                    stream: false,
                    ..parts
                };
                record.response_head.resize(RESPONSE_HEAD_CAPACITY, 0);
                let mut writer = ResponseWriter::new(&mut record.response_head, parts.head_request);
                let len = write_head(&mut writer, &bare, &[]).map_or(0, |()| writer.len());
                record.response_head.truncate(len);
                return;
            }
        }
    }
}

/// What a response head is made of besides the handler's fields.
#[derive(Clone, Copy)]
struct HeadParts<'a> {
    status: StatusCode,
    head_request: bool,
    date: &'a [u8],
    server: &'a [u8],
    body_len: u64,
    close: bool,
    keep_alive_10: bool,
    /// A `101` that switches protocols: `Connection: upgrade`.
    upgrade: bool,
    /// Another response with an `Upgrade` field: `Connection` lists `upgrade` too.
    advertise_upgrade: bool,
    /// A streamed body: no `Content-Length`.
    stream: bool,
}

fn write_head(
    writer: &mut ResponseWriter<'_>,
    parts: &HeadParts<'_>,
    fields: &[u8],
) -> Result<(), WriteError> {
    writer.status_line(parts.status)?;
    writer.raw(parts.date)?;
    if !parts.server.is_empty() {
        writer.raw(parts.server)?;
    }
    if content_length_allowed(parts.status) && !parts.stream {
        writer.content_length(parts.body_len)?;
    }
    writer.raw(fields)?;
    if parts.upgrade || parts.advertise_upgrade {
        writer.field_id(HeaderName::Connection, b"upgrade")?;
    }
    if parts.close {
        writer.connection_close()?;
    } else if parts.keep_alive_10 {
        writer.field_id(HeaderName::Connection, b"keep-alive")?;
    }
    writer.end_head()
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::rc::Rc;

    use zero_core::Error;
    use zero_io::rt::TcpStream;

    use super::{request_task, Conn, Shared};
    use crate::call::Call;
    use crate::handler::Handler;
    use crate::record::Record;

    struct Nothing;

    impl Handler for Nothing {
        async fn handle(&self, _: &mut Call<'_>) -> Result<(), Error> {
            Ok(())
        }
    }

    /// The driver's size and its task's size, for a handler and a request future.
    fn sizes<S, H, Req, F>(
        _: fn(Rc<Shared<H>>, Box<Record>) -> Req,
        _: fn(Conn<S, H, Req>) -> F,
    ) -> (usize, usize)
    where
        F: Future,
    {
        (
            std::mem::size_of::<Conn<S, H, Req>>(),
            std::mem::size_of::<F>(),
        )
    }

    /// An idle connection holds its driver and one turn's futures, nothing else,
    /// so the task stays within the driver plus a turn.
    #[test]
    fn an_idle_connection_task_holds_the_driver_once_plus_one_turn() {
        let (driver, task) = sizes::<TcpStream, Nothing, _, _>(request_task::<Nothing>, Conn::run);
        assert!(
            task < driver.saturating_mul(2),
            "the task is {task} bytes for a {driver}-byte driver"
        );
    }
}
