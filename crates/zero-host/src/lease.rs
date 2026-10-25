//! The tier 3 path: a request leased to the host and its response taken back.
//!
//! [`dispatch`] admits the request, claims a slot whose lock it holds through the
//! export and the hold, so no host can lock the slot in between, exports the request
//! into it, queues the job for the core's dispatcher and waits on the slot's waiter.
//! From the claim on, the [`LeaseGuard`] owns the slot: every way the future ends,
//! dropped included, closes and retires it exactly once. When the host sealed the
//! response, the import takes the slot's lock without waiting; a lock a host still
//! holds, or a pin on a staged body, puts the slot on the dispatcher's late list
//! until the lock is free. A response the host never wrote is answered 500
//! `NO_RESPONSE`, and the action a response carries runs once the response is back
//! ([`actions`](crate::actions)).

use std::future::{poll_fn, Future};
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use zero_core::{Error, SlotId};
use zero_http::{Action, Call, Exchange, Problem, Routed};
use zero_http_types::StatusCode;
use zero_rt::dispatch::{Failure, Job, Late, Sealed, Waiters};
use zero_rt::{Refused, Slot, SlotState};

use crate::app::RouteDesc;
use crate::handler::CoreHost;
use crate::overload::{self, Overload};
use crate::registry::{HostExchange, WorkerShared};

/// The code of the answer to a lease the host sealed without writing a response.
pub(crate) const NO_RESPONSE: &str = "NO_RESPONSE";

/// The code of the answer to a lease whose core's host dispatch failed.
pub(crate) const DISPATCH_FAILED: &str = "DISPATCH_FAILED";

/// How a lease's wait ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The host completed the slot.
    Sealed,
    /// The target was lost: answered 503.
    TargetGone,
    /// The core's host dispatch failed: answered 500.
    Failed,
}

/// The record of one future waiting on its lease.
#[derive(Debug, Default)]
struct Waiter {
    generation: u32,
    live: bool,
    /// The dispatcher counts the lease in its `leased` gauge.
    counted: bool,
    /// The import waits for the late list to find the lock free.
    late: bool,
    outcome: Option<Outcome>,
    waker: Option<Waker>,
}

impl Waiter {
    fn wake(&mut self) {
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}

/// The waiters of one core, one entry per slot index.
#[derive(Debug)]
pub(crate) struct WaiterTable {
    entries: Vec<Waiter>,
    live: usize,
    shared: Arc<WorkerShared>,
}

impl WaiterTable {
    pub(crate) fn new(shared: Arc<WorkerShared>) -> Self {
        WaiterTable {
            entries: Vec::new(),
            live: 0,
            shared,
        }
    }

    /// The live entry of `id`, at its generation.
    fn entry(&mut self, id: SlotId) -> Option<&mut Waiter> {
        self.entries
            .get_mut(usize::from(id.index()))
            .filter(|waiter| waiter.live && waiter.generation == id.generation())
    }

    /// Start waiting on `id`; the table grows only when the arena did.
    pub(crate) fn arm(&mut self, id: SlotId) {
        let index = usize::from(id.index());
        if self.entries.len() <= index {
            let capacity = self.shared.arena.capacity().max(index.saturating_add(1));
            self.entries.resize_with(capacity, Waiter::default);
        }
        if let Some(waiter) = self.entries.get_mut(index) {
            if !waiter.live {
                self.live = self.live.saturating_add(1);
            }
            *waiter = Waiter {
                generation: id.generation(),
                live: true,
                ..Waiter::default()
            };
        }
    }

    /// Stop waiting on `id`.
    pub(crate) fn clear(&mut self, id: SlotId) {
        if let Some(waiter) = self.entry(id) {
            waiter.live = false;
            waiter.waker = None;
            self.live = self.live.saturating_sub(1);
        }
    }

    /// Whether the dispatcher counts `id`'s lease, and stop counting it.
    pub(crate) fn take_count(&mut self, id: SlotId) -> bool {
        self.entry(id)
            .is_some_and(|waiter| std::mem::take(&mut waiter.counted))
    }

    fn poll_outcome(&mut self, id: SlotId, cx: &Context<'_>) -> Poll<Outcome> {
        let Some(waiter) = self.entry(id) else {
            return Poll::Ready(Outcome::Failed);
        };
        match waiter.outcome {
            Some(outcome) => Poll::Ready(outcome),
            None => {
                store(&mut waiter.waker, cx.waker());
                Poll::Pending
            }
        }
    }

    fn set_late(&mut self, id: SlotId) {
        if let Some(waiter) = self.entry(id) {
            waiter.late = true;
        }
    }

    fn poll_late(&mut self, id: SlotId, cx: &Context<'_>) -> Poll<()> {
        match self.entry(id) {
            Some(waiter) if waiter.late => {
                store(&mut waiter.waker, cx.waker());
                Poll::Pending
            }
            _ => Poll::Ready(()),
        }
    }

    /// The core's host dispatch failed: every wait ends.
    pub(crate) fn fail_all(&mut self) {
        for waiter in self.entries.iter_mut().filter(|waiter| waiter.live) {
            if waiter.outcome.is_none() {
                waiter.outcome = Some(Outcome::Failed);
            }
            waiter.late = false;
            waiter.wake();
        }
    }
}

fn store(slot: &mut Option<Waker>, waker: &Waker) {
    match slot {
        Some(stored) if stored.will_wake(waker) => {}
        _ => *slot = Some(waker.clone()),
    }
}

impl Waiters for WaiterTable {
    fn sealed(&mut self, id: SlotId) -> Sealed {
        match self.entry(id) {
            Some(waiter) if waiter.outcome.is_none() => {
                waiter.outcome = Some(Outcome::Sealed);
                waiter.counted = false;
                waiter.wake();
                Sealed::Woken
            }
            _ => Sealed::Stale,
        }
    }

    fn posted(&mut self, id: SlotId) {
        if let Some(waiter) = self.entry(id) {
            waiter.counted = true;
        }
    }

    fn fail(&mut self, id: SlotId, failure: Failure) -> bool {
        match self.entry(id) {
            Some(waiter) if waiter.outcome.is_none() => {
                waiter.outcome = Some(match failure {
                    Failure::TargetGone => Outcome::TargetGone,
                    Failure::Failed => Outcome::Failed,
                });
                waiter.counted = false;
                waiter.wake();
                true
            }
            _ => false,
        }
    }

    fn late(&mut self, id: SlotId) -> bool {
        let index = usize::from(id.index());
        let arena = &self.shared.arena;
        let Some(waiter) = self
            .entries
            .get_mut(index)
            .filter(|waiter| waiter.live && waiter.generation == id.generation() && waiter.late)
        else {
            return true;
        };
        let ready = match arena.lookup(id) {
            Ok(slot) => {
                match slot.with_worker(id.generation(), |exchange, _| exchange.0.staged()) {
                    Ok(staged) => !staged || slot.word().readers() == 0,
                    Err(Refused::Busy) => false,
                    Err(_) => true,
                }
            }
            Err(_) => true,
        };
        if ready {
            waiter.late = false;
            waiter.wake();
        }
        ready
    }

    fn is_empty(&self) -> bool {
        self.live == 0
    }
}

/// What the import took back.
enum Imported {
    /// The response and the action the host asked for.
    Response(Action),
    /// A panic poisoned the slot's lock.
    Poisoned,
    /// The lease ended before the response could be taken.
    Lost,
}

/// The owner of one claimed slot, from the claim to the retirement.
pub(crate) struct LeaseGuard {
    core: Rc<CoreHost>,
    id: SlotId,
    done: bool,
}

impl LeaseGuard {
    fn new(core: Rc<CoreHost>, id: SlotId) -> Self {
        core.waiters.borrow_mut().arm(id);
        LeaseGuard {
            core,
            id,
            done: false,
        }
    }

    fn slot(&self) -> Option<&Slot<HostExchange>> {
        self.core.shared().arena.lookup(self.id).ok()
    }

    fn wait(&self) -> impl Future<Output = Outcome> + '_ {
        poll_fn(move |cx| self.core.waiters.borrow_mut().poll_outcome(self.id, cx))
    }

    /// Take the response back: `begin_import`, then the lock without waiting, on the
    /// late list while a host holds it or a staged body is pinned.
    async fn import(&self, call: &mut Call<'_>) -> Imported {
        let Some(slot) = self.slot() else {
            return Imported::Lost;
        };
        let generation = self.id.generation();
        if slot.word().begin_import(generation).is_err() {
            return Imported::Lost;
        }
        loop {
            let attempt = slot.with_worker(generation, |exchange, _| {
                if exchange.0.staged() && slot.word().readers() > 0 {
                    return None;
                }
                Some(take_response(&self.core, call, &mut exchange.0))
            });
            match attempt {
                Ok(Some(action)) => return Imported::Response(action),
                Ok(None) | Err(Refused::Busy) if !self.core.failed.get() => self.late().await,
                Err(Refused::Poisoned) => return Imported::Poisoned,
                _ => return Imported::Lost,
            }
        }
    }

    /// Wait until the dispatcher's late list finds the slot's lock free.
    async fn late(&self) {
        let core = &*self.core;
        core.waiters.borrow_mut().set_late(self.id);
        if let Ok(mut dispatch) = core.dispatch.try_borrow_mut() {
            dispatch.defer(self.id, Late::Import, Instant::now());
        }
        core.kick.wake();
        poll_fn(|cx| core.waiters.borrow_mut().poll_late(self.id, cx)).await;
    }

    /// Close what the slot still holds: a lease with `close_leased`, a queued job
    /// with `close`, so a host's later write is refused and the slot can retire.
    fn close(&self) {
        let Some(slot) = self.slot() else {
            return;
        };
        let generation = self.id.generation();
        let word = slot.word();
        if word.generation() != generation {
            return;
        }
        match word.state() {
            SlotState::Leased => {
                if word.close_leased(generation).is_ok() {
                    let counted = self
                        .core
                        .waiters
                        .try_borrow_mut()
                        .is_ok_and(|mut waiters| waiters.take_count(self.id));
                    if counted {
                        self.core.uncount_lease();
                    }
                }
            }
            SlotState::Parsing | SlotState::WorkerOwned => {
                let _ = word.close(generation);
            }
            SlotState::Free | SlotState::Completing | SlotState::Closed => {}
        }
    }

    /// Retire the slot, or leave it on the late list while a pin holds it.
    fn retire(&mut self) {
        self.close();
        self.done = true;
        let core = &*self.core;
        if let Ok(mut waiters) = core.waiters.try_borrow_mut() {
            waiters.clear(self.id);
        }
        let shared = core.shared();
        let retired = core
            .alloc
            .try_borrow_mut()
            .map(|mut alloc| alloc.retire(&shared.arena, self.id, shared.intake.published()));
        if let Ok(Err(Refused::Readers(_))) = retired {
            if let Ok(mut dispatch) = core.dispatch.try_borrow_mut() {
                dispatch.defer(self.id, Late::Retire, Instant::now());
            }
        }
        core.kick.wake();
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if !self.done {
            self.retire();
        }
    }
}

/// Move the host's response into the call, with the policies' fields; a response
/// never written is answered 500 `NO_RESPONSE` in the server's shape.
fn take_response(core: &CoreHost, call: &mut Call<'_>, exchange: &mut Exchange) -> Action {
    let settings = core.settings();
    if !exchange.sealed() && !exchange.touched() {
        exchange.write_error(
            settings.shape,
            StatusCode::INTERNAL_SERVER_ERROR,
            NO_RESPONSE,
            None,
            None,
        );
    }
    let moved = call.import(exchange, |request, response| {
        settings.rules.after_with(request, response);
    });
    core.uncount(moved);
    exchange.take_action()
}

/// Answer `overload` and add the policies' fields.
fn answered(core: &CoreHost, call: &mut Call<'_>, overload: Overload) -> Result<(), Error> {
    let settings = core.settings();
    overload::answer(call, settings, overload);
    settings.rules.after(call);
    Ok(())
}

/// Answer 500 with `code` in the server's shape and add the policies' fields.
fn internal(core: &CoreHost, call: &mut Call<'_>, code: &'static str) -> Result<(), Error> {
    call.problem(&Problem::new(StatusCode::INTERNAL_SERVER_ERROR, code));
    core.settings().rules.after(call);
    Ok(())
}

/// Lease a request to the host and send what it answers.
///
/// A refused admission, an exhausted arena and a lost target are answered 503 on the
/// core; a failed host dispatch is answered 500 `DISPATCH_FAILED`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4>
pub(crate) async fn dispatch(
    core: &Rc<CoreHost>,
    call: &mut Call<'_>,
    routed: Routed<RouteDesc>,
) -> Result<(), Error> {
    if let Some(overload) = core.admit() {
        return answered(core, call, overload);
    }
    let route = routed.descriptor.route;
    let mut guard = {
        let Ok((id, mut payload, freed)) = core.allocate() else {
            core.shared()
                .counters
                .refused_503
                .fetch_add(1, Ordering::Relaxed);
            return answered(core, call, Overload::Arena);
        };
        core.uncount(freed);
        let mut guard = LeaseGuard::new(Rc::clone(core), id);
        let held = match core.shared().arena.lookup(id) {
            Ok(slot) => {
                call.export(
                    &mut payload.0,
                    slot.view(),
                    route,
                    routed.head,
                    &core.settings().export,
                );
                core.count(payload.0.counted());
                slot.word().hold(id.generation()).is_ok()
            }
            Err(_) => false,
        };
        drop(payload);
        if !held {
            guard.retire();
            return internal(core, call, DISPATCH_FAILED);
        }
        guard
    };
    let id = guard.id;
    let hold = core
        .dispatch
        .borrow()
        .backlogged()
        .then(|| call.hold_reads());
    core.dispatch
        .borrow_mut()
        .push(Job { slot: id, route }, hold);
    core.kick.wake();
    match guard.wait().await {
        Outcome::Sealed => {
            let imported = guard.import(call).await;
            guard.retire();
            match imported {
                Imported::Response(action) => crate::actions::apply(core, call, route, action),
                Imported::Poisoned => {
                    call.problem(&Problem::panicked());
                    core.settings().rules.after(call);
                    Ok(())
                }
                Imported::Lost => answered(core, call, Overload::TargetGone),
            }
        }
        Outcome::TargetGone => {
            guard.retire();
            answered(core, call, Overload::TargetGone)
        }
        Outcome::Failed => {
            guard.retire();
            internal(core, call, DISPATCH_FAILED)
        }
    }
}
