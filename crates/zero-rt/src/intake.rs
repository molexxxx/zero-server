//! The completion intake of one worker index: what host threads hand back to the
//! worker, and the epoch counters that gate index reuse.
//!
//! A host appends the ids it completed and, from the thread bound to the target, the
//! acknowledgment of the oldest unacknowledged batch, under one lock; it takes the
//! worker's waker in the same section and wakes it once after unlocking, so a call
//! costs one lock and one cross-thread wake however many ids it carries. The worker
//! swaps the id vector out each turn. Target attachment and loss reach the worker the
//! same way.
//!
//! `published` is the newest epoch posted to the target: the dispatcher stores a
//! batch's epoch before it posts the batch and stores the previous value back when the
//! post did not deliver it, so a host that acknowledges before the post returns on
//! the worker is never refused. `acked` advances by exactly one per accepted
//! acknowledgment, which must name the next epoch and one already published, or to
//! `published` when the worker settles a lost target. The intake does not see the
//! calling thread: the caller of [`Intake::complete`] passes an epoch only from the
//! thread bound to the target, which [`Intake::bound_thread`] reports. A detach
//! unbinds that thread at once, and [`Intake::detaching`] reports the detach until the
//! worker settled it, since until then `acked` does not cover every batch the lost
//! target received. The invariants the intake keeps are listed with the others in
//! [`arena`](crate::arena).

use std::fmt;
use std::task::Waker;

use zero_core::SlotId;

use crate::dispatch::Target;
use crate::slot::Refused;
use crate::sync::{self, AtomicU64, Mutex, Ordering};

/// What hosts left for the worker under the intake lock.
#[derive(Default)]
struct Inbox {
    completed: Vec<u64>,
    waker: Option<Waker>,
    attach: Option<std::sync::Arc<dyn Target>>,
    detach: bool,
    dirty: bool,
}

/// A change of target the worker applies on its next turn.
#[derive(Default)]
pub(crate) struct Change {
    /// The target was detached or lost; applied before `attach`.
    pub(crate) detach: bool,
    /// A target to attach.
    pub(crate) attach: Option<std::sync::Arc<dyn Target>>,
}

/// The completion intake and epoch counters of one worker index.
pub struct Intake {
    inbox: Mutex<Inbox>,
    published: AtomicU64,
    acked: AtomicU64,
    bound: AtomicU64,
    /// 1 from a detach until the worker settles the target it lost, otherwise 0.
    detaching: AtomicU64,
}

impl fmt::Debug for Intake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Intake")
            .field("published", &self.published())
            .field("acked", &self.acked())
            .field("bound_thread", &self.bound_thread())
            .field("detaching", &self.detaching())
            .finish_non_exhaustive()
    }
}

impl Default for Intake {
    fn default() -> Self {
        Self::new()
    }
}

impl Intake {
    /// An empty intake with both epochs at 0.
    ///
    /// # Returns
    ///
    /// The intake.
    #[must_use]
    pub fn new() -> Self {
        Intake {
            inbox: Mutex::new(Inbox::default()),
            published: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            bound: AtomicU64::new(0),
            detaching: AtomicU64::new(0),
        }
    }

    /// Hand completed ids back to the worker and, when `epoch` is not 0, acknowledge
    /// the batch of that epoch. The ids are delivered whether or not the
    /// acknowledgment is accepted. The caller has already checked each id and passes
    /// an epoch only from the thread bound to the target.
    ///
    /// # Arguments
    ///
    /// * `ids` - the completed slot ids.
    /// * `epoch` - the epoch to acknowledge, or 0 for none.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] when `epoch` is not the next unacknowledged epoch or was
    /// never published; nothing about the acknowledgments changed then.
    pub fn complete(
        &self,
        ids: impl IntoIterator<Item = SlotId>,
        epoch: u64,
    ) -> Result<(), Refused> {
        let mut inbox = sync::lock_recovered(&self.inbox);
        let before = inbox.completed.len();
        inbox.completed.extend(ids.into_iter().map(SlotId::as_u64));
        let outcome = if epoch == 0 {
            Ok(())
        } else {
            self.acknowledge(epoch)
        };
        let changed = inbox.completed.len() != before || (epoch != 0 && outcome.is_ok());
        let waker = if changed {
            inbox.dirty = true;
            inbox.waker.take()
        } else {
            None
        };
        drop(inbox);
        if let Some(waker) = waker {
            waker.wake();
        }
        outcome
    }

    /// Hand a target to the worker; it is attached on the worker's next turn.
    ///
    /// # Arguments
    ///
    /// * `target` - the target that receives this worker index's batches.
    pub fn attach(&self, target: std::sync::Arc<dyn Target>) {
        self.change(|inbox| inbox.attach = Some(target));
    }

    /// Tell the worker its target is gone: it closes the leases, fails the queued
    /// jobs, and settles the acknowledgment floor on its next turn. The bound thread
    /// is unbound now, so a thread that binds after this call, to a target attached
    /// after it, keeps its binding when the worker applies the detach, and
    /// [`detaching`](Self::detaching) reports the detach from now until the worker
    /// settled it.
    pub fn detach(&self) {
        self.change(|inbox| {
            inbox.attach = None;
            inbox.detach = true;
            self.detaching.store(1, Ordering::Release);
            self.bound.store(0, Ordering::Release);
        });
    }

    /// Whether a detach waits for the worker: from [`detach`](Self::detach) until the
    /// worker settled the target it lost. Until then `acked` does not cover every
    /// batch that target received, so no thread is that target's thread, a thread
    /// bound since the detach included; a thread that binds after the detach sees it
    /// waiting or sees the settled floor, since the detach stores this before it
    /// unbinds and the settle stores the floor before it clears this.
    ///
    /// # Returns
    ///
    /// `true` while a detach waits, from an acquire load.
    #[must_use]
    pub fn detaching(&self) -> bool {
        self.detaching.load(Ordering::Acquire) != 0
    }

    /// The newest epoch posted to the target.
    ///
    /// # Returns
    ///
    /// The epoch, from an acquire load.
    #[must_use]
    pub fn published(&self) -> u64 {
        self.published.load(Ordering::Acquire)
    }

    /// The newest epoch the target acknowledged: the acknowledgment floor.
    ///
    /// # Returns
    ///
    /// The epoch, from an acquire load.
    #[must_use]
    pub fn acked(&self) -> u64 {
        self.acked.load(Ordering::Acquire)
    }

    /// The token of the host thread bound to this worker index's target.
    ///
    /// # Returns
    ///
    /// The token, or 0 while no thread is bound.
    #[must_use]
    pub fn bound_thread(&self) -> u64 {
        self.bound.load(Ordering::Acquire)
    }

    /// Bind a host thread to the target, if no thread is bound yet.
    ///
    /// # Arguments
    ///
    /// * `token` - the thread's token; not 0.
    ///
    /// # Returns
    ///
    /// Whether `token` is the bound thread now.
    pub fn bind_thread(&self, token: u64) -> bool {
        match self
            .bound
            .compare_exchange(0, token, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => token != 0,
            Err(bound) => bound == token,
        }
    }

    /// Make room for `total` completed ids without allocating on the next appends; the
    /// dispatcher calls it on the turn that sees the arena grown.
    ///
    /// # Arguments
    ///
    /// * `total` - the ids the vector should hold.
    pub fn reserve(&self, total: usize) {
        let mut inbox = sync::lock_recovered(&self.inbox);
        let len = inbox.completed.len();
        inbox.completed.reserve(total.saturating_sub(len));
    }

    /// Store the worker's waker unless work is already waiting.
    ///
    /// # Arguments
    ///
    /// * `waker` - the dispatcher task's waker.
    ///
    /// # Returns
    ///
    /// Whether ids, an acknowledgment or a target change arrived since the last
    /// drain, in which case the waker is not stored and the worker should turn now.
    pub fn register(&self, waker: &Waker) -> bool {
        let mut inbox = sync::lock_recovered(&self.inbox);
        if inbox.dirty {
            return true;
        }
        match &inbox.waker {
            Some(stored) if stored.will_wake(waker) => {}
            _ => inbox.waker = Some(waker.clone()),
        }
        false
    }

    /// Swap the completed ids into `into`, an empty vector of the same capacity, and
    /// take the pending target change.
    pub(crate) fn drain(&self, into: &mut Vec<u64>) -> Change {
        into.clear();
        let mut inbox = sync::lock_recovered(&self.inbox);
        std::mem::swap(&mut inbox.completed, into);
        inbox.dirty = false;
        Change {
            detach: std::mem::take(&mut inbox.detach),
            attach: inbox.attach.take(),
        }
    }

    /// Store `epoch` as the newest posted epoch: before a post, and back to the
    /// previous value when the post did not deliver the batch.
    pub(crate) fn publish(&self, epoch: u64) {
        self.published.store(epoch, Ordering::Release);
    }

    /// The target is gone: no view of it can exist, so every posted epoch counts as
    /// acknowledged, and the detach that reported the loss is settled. A loss the
    /// worker found itself (`unbind`) also unbinds the thread, unless a detach is
    /// pending: that detach unbound it when the host made it, and a binding made since
    /// belongs to the next target. A detach the worker applies leaves the binding alone
    /// for the same reason. A detach made after the worker took the one it applies
    /// stays pending until its own settle.
    pub(crate) fn settle(&self, unbind: bool) {
        let inbox = sync::lock_recovered(&self.inbox);
        self.acked.store(self.published(), Ordering::Release);
        if !inbox.detach {
            self.detaching.store(0, Ordering::Release);
            if unbind {
                self.bound.store(0, Ordering::Release);
            }
        }
        drop(inbox);
    }

    /// The address and capacity of the completed-id vector, for the test that a warm
    /// path grows no buffer.
    #[cfg(test)]
    pub(crate) fn completed_buffer(&self) -> (usize, usize) {
        let inbox = sync::lock_recovered(&self.inbox);
        (inbox.completed.as_ptr().addr(), inbox.completed.capacity())
    }

    /// Accept `epoch` if it is the next one and was published; under the intake lock.
    fn acknowledge(&self, epoch: u64) -> Result<(), Refused> {
        let acked = self.acked();
        if Some(epoch) != acked.checked_add(1) || epoch > self.published() {
            return Err(Refused::Stale);
        }
        self.acked
            .compare_exchange(acked, epoch, Ordering::AcqRel, Ordering::Acquire)
            .map(drop)
            .map_err(|_| Refused::Stale)
    }

    /// Apply a target change under the lock and wake the worker.
    fn change(&self, apply: impl FnOnce(&mut Inbox)) {
        let waker = {
            let mut inbox = sync::lock_recovered(&self.inbox);
            apply(&mut inbox);
            inbox.dirty = true;
            inbox.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Intake;

    #[test]
    fn a_detach_waits_from_the_call_until_the_worker_settles_it_and_a_later_binding_stays() {
        let intake = Intake::new();
        assert!(!intake.detaching());
        intake.publish(1);
        assert!(intake.bind_thread(5));
        intake.detach();
        assert!(intake.detaching());
        assert_eq!(intake.bound_thread(), 0, "the detach unbinds at once");
        assert!(
            intake.bind_thread(6),
            "a thread binds while the detach waits"
        );
        let mut drained = Vec::new();
        assert!(intake.drain(&mut drained).detach);
        assert!(intake.detaching(), "taken by the worker, not settled yet");
        intake.settle(false);
        assert!(!intake.detaching());
        assert_eq!(intake.acked(), 1);
        assert_eq!(
            intake.bound_thread(),
            6,
            "the binding made since belongs to the next target"
        );
    }

    #[test]
    fn a_detach_made_after_the_worker_took_one_waits_for_its_own_settle() {
        let intake = Intake::new();
        let mut drained = Vec::new();
        intake.detach();
        assert!(intake.drain(&mut drained).detach);
        intake.detach();
        intake.settle(false);
        assert!(intake.detaching(), "the second detach is not settled");
        intake.settle(true);
        assert!(
            intake.detaching(),
            "a loss the worker found settles no pending detach"
        );
        assert!(intake.drain(&mut drained).detach);
        intake.settle(false);
        assert!(!intake.detaching());
        assert!(intake.bind_thread(7));
        intake.settle(true);
        assert_eq!(
            intake.bound_thread(),
            0,
            "a loss the worker found unbinds while no detach waits"
        );
        assert!(!intake.detaching());
    }
}

#[cfg(all(test, zero_loom))]
mod loom_models {
    use loom::thread;

    use super::Intake;
    use crate::sync::Arc;

    /// A thread that binds after a detach, while the worker takes and settles it, sees
    /// the detach waiting or the settled floor, never a window on the batch the lost
    /// target received. The lost target's thread is bound first, so a bind that
    /// succeeds read the detach's unbinding.
    #[test]
    fn loom_a_thread_bound_after_a_detach_sees_it_waiting_or_settled() {
        let mut builder = loom::model::Builder::new();
        builder.preemption_bound = Some(3);
        builder.check(|| {
            let intake = Arc::new(Intake::new());
            intake.publish(1);
            assert!(intake.bind_thread(9));
            let detacher = {
                let intake = Arc::clone(&intake);
                thread::spawn(move || intake.detach())
            };
            let next = {
                let intake = Arc::clone(&intake);
                thread::spawn(move || {
                    if intake.bind_thread(5) {
                        let window =
                            intake.bound_thread() == 5 && !intake.detaching() && intake.acked() < 1;
                        assert!(!window, "a window on the lost target's batch");
                    }
                })
            };
            let mut drained = Vec::new();
            if intake.drain(&mut drained).detach {
                intake.settle(false);
            }
            detacher.join().unwrap();
            next.join().unwrap();
        });
    }
}
