//! The hook into the driver: one [`HostHandler`] per core, over the core's
//! [`CoreHost`].
//!
//! The driver polls each request's handler future inline in its connection task, so
//! a tier 3 request waiting on its lease costs the core nothing while it serves the
//! connection's other work and every other connection. The core's dispatcher runs as
//! a task of its own under panic containment: a panic there marks the core's host
//! dispatch failed, answers every waiting lease 500, answers new host requests 503,
//! and reports `Event::HostFailed`, while the routes answered in Rust keep serving.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use zero_core::{Error, SlotId};
use zero_http::{Call, ErrorShape, Handler, Problem, ReadHold, Routed};
use zero_http_types::{Method, StatusCode};
use zero_io::seam::Shutdown;
use zero_router::Resolution;
use zero_rt::dispatch::{Admission, Dispatcher, Kick, Parts, Turned};
use zero_rt::sync::MutexGuard;
use zero_rt::{contain, Allocator, Event, Exhausted, Worker};

use crate::app::{RouteKind, RouteSpec};
use crate::lease::{self, WaiterTable};
use crate::overload::{self, Overload};
use crate::registry::{HostExchange, WorkerShared};
use crate::rules::Answered;
use crate::server::Settings;
use crate::spec::HostSpec;
use crate::tier0::{self, Served};

/// The state of one core: the worker index's permanent parts and the worker-local
/// allocator, dispatcher, waiters and per-route files.
pub(crate) struct CoreHost {
    worker: Worker,
    shared: Arc<WorkerShared>,
    settings: Arc<Settings>,
    pub(crate) alloc: RefCell<Allocator>,
    pub(crate) dispatch: RefCell<Dispatcher<ReadHold>>,
    pub(crate) waiters: RefCell<WaiterTable>,
    pub(crate) kick: Kick,
    pub(crate) failed: Cell<bool>,
    scratch: RefCell<Vec<u8>>,
    #[cfg(feature = "static")]
    files: Vec<Option<zero_static::Files>>,
    #[cfg(feature = "testing")]
    pub(crate) slot_cap: Cell<Option<usize>>,
    #[cfg(feature = "testing")]
    pub(crate) held: Cell<bool>,
}

impl CoreHost {
    /// Build the core's state on its worker thread and spawn its dispatcher task.
    pub(crate) fn start(
        worker: &Worker,
        shared: Arc<WorkerShared>,
        settings: Arc<Settings>,
    ) -> Rc<Self> {
        #[cfg(feature = "static")]
        let files = settings
            .app
            .routes
            .iter()
            .map(|spec| match spec {
                Some(RouteSpec::Static(route)) => {
                    zero_static::Files::new(&route.spec.root, route.spec.options.clone()).ok()
                }
                _ => None,
            })
            .collect();
        let core = Rc::new(CoreHost {
            worker: worker.clone(),
            alloc: RefCell::new(Allocator::adopt(&shared.arena)),
            dispatch: RefCell::new(Dispatcher::new(
                settings.dispatch,
                Arc::clone(&shared.counters),
            )),
            waiters: RefCell::new(WaiterTable::new(Arc::clone(&shared))),
            kick: Kick::new(),
            failed: Cell::new(false),
            scratch: RefCell::new(Vec::with_capacity(256)),
            #[cfg(feature = "static")]
            files,
            #[cfg(feature = "testing")]
            slot_cap: Cell::new(None),
            #[cfg(feature = "testing")]
            held: Cell::new(false),
            shared,
            settings,
        });
        let task = Rc::clone(&core);
        worker.spawn(async move {
            if let Err(panicked) = contain(run_dispatcher(&task)).await {
                task.host_failed(panicked.message);
            }
        });
        core
    }

    pub(crate) fn settings(&self) -> &Settings {
        &self.settings
    }

    pub(crate) fn shared(&self) -> &WorkerShared {
        &self.shared
    }

    /// The `Files` of a static route on this core.
    #[cfg(feature = "static")]
    pub(crate) fn files(&self, route: u32) -> Option<&zero_static::Files> {
        self.files
            .get(usize::try_from(route).ok()?)
            .and_then(Option::as_ref)
    }

    /// Whether the server drains.
    fn draining(&self) -> bool {
        self.worker.shutdown().is_requested()
    }

    /// Why a new host request is refused, if it is: the core's host dispatch failed,
    /// no target is attached, the queue holds its bound, or the server drains.
    pub(crate) fn admit(&self) -> Option<Overload> {
        if self.failed.get() {
            self.shared
                .counters
                .refused_503
                .fetch_add(1, Ordering::Relaxed);
            return Some(Overload::Failed);
        }
        match self.dispatch.borrow().admit() {
            Admission::Admit => None,
            Admission::NoTarget => Some(Overload::NoTarget),
            Admission::Queue => Some(Overload::Queue),
            Admission::Draining => Some(Overload::Draining),
        }
    }

    /// Claim a slot, its payload's guard and the octets its reset released. With no
    /// free index, the quarantine is released up to the acknowledgment floor first,
    /// so an acknowledgment that arrived since the dispatcher's last turn frees its
    /// indexes for this request.
    pub(crate) fn allocate(
        &self,
    ) -> Result<(SlotId, MutexGuard<'_, HostExchange>, u64), Exhausted> {
        let mut alloc = self.alloc.borrow_mut();
        let arena = &self.shared.arena;
        if !self.capped(&alloc) {
            if let Ok(claimed) = alloc.allocate(arena) {
                return Ok(claimed);
            }
        }
        let freed = alloc.release(arena, self.shared.intake.acked());
        self.uncount(freed);
        if self.capped(&alloc) {
            return Err(Exhausted);
        }
        alloc.allocate(arena)
    }

    /// Whether the slot cap of the test hooks holds the core at its slots, live and
    /// quarantined together.
    #[cfg(feature = "testing")]
    fn capped(&self, alloc: &Allocator) -> bool {
        self.slot_cap
            .get()
            .is_some_and(|cap| alloc.live().saturating_add(alloc.quarantined()) >= cap)
    }

    /// Whether a cap holds the core at its slots; only the test hooks set one.
    #[cfg(not(feature = "testing"))]
    fn capped(&self, _alloc: &Allocator) -> bool {
        false
    }

    /// Count octets an exchange holds on the core's request-memory budget.
    pub(crate) fn count(&self, octets: u64) {
        self.shared
            .counters
            .retained
            .fetch_add(octets, Ordering::Relaxed);
    }

    /// Take octets an exchange no longer holds off the budget.
    pub(crate) fn uncount(&self, octets: u64) {
        saturating_sub(&self.shared.counters.retained, octets);
    }

    /// End a lease in the dispatcher's `leased` gauge.
    pub(crate) fn uncount_lease(&self) {
        saturating_sub(&self.shared.counters.leased, 1);
    }

    /// One dispatcher turn; the first turn after the shutdown signal starts the drain.
    fn turn(&self, now: Instant, stopping: bool) -> Turned {
        #[cfg(feature = "testing")]
        crate::testing::run_hooks(self);
        let shared = &*self.shared;
        let mut dispatch = self.dispatch.borrow_mut();
        if stopping && !dispatch.is_draining() {
            dispatch.set_draining();
        }
        let mut alloc = self.alloc.borrow_mut();
        let mut waiters = self.waiters.borrow_mut();
        let mut parts = Parts {
            arena: &shared.arena,
            alloc: &mut alloc,
            intake: &shared.intake,
            ring: &shared.ring,
            waiters: &mut *waiters,
        };
        dispatch.turn(&mut parts, now)
    }

    /// The dispatcher panicked: end every wait with a failure, drop the queued jobs
    /// and their read holds, and report it.
    fn host_failed(&self, message: String) {
        self.failed.set(true);
        self.shared.counters.panics.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut dispatch) = self.dispatch.try_borrow_mut() {
            let limits = dispatch.limits();
            *dispatch = Dispatcher::new(limits, Arc::clone(&self.shared.counters));
        }
        if let Ok(mut waiters) = self.waiters.try_borrow_mut() {
            waiters.fail_all();
        }
        self.worker.report(Event::HostFailed {
            core: self.worker.index(),
            message,
        });
    }

    /// The largest body the route of a request takes: a host route's `maxBody`, else
    /// the body-limit policy that covers the path.
    fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64> {
        let settings = &self.settings;
        if let (Some(method), Ok(mut scratch)) = (method, self.scratch.try_borrow_mut()) {
            if let Ok(resolved) =
                settings
                    .app
                    .router
                    .resolve_target(method.as_bytes(), path, &mut scratch)
            {
                if let Resolution::Matched { descriptor, .. } = resolved.resolution {
                    let spec = usize::try_from(descriptor.route)
                        .ok()
                        .and_then(|index| settings.app.routes.get(index));
                    if let Some(Some(RouteSpec::Host(HostSpec {
                        max_body: Some(max),
                    }))) = spec
                    {
                        return Some(*max);
                    }
                }
            }
        }
        settings.rules.body_limit(path)
    }
}

fn saturating_sub(counter: &std::sync::atomic::AtomicU64, value: u64) {
    let mut current = counter.load(Ordering::Relaxed);
    while let Err(seen) = counter.compare_exchange_weak(
        current,
        current.saturating_sub(value),
        Ordering::Relaxed,
        Ordering::Relaxed,
    ) {
        current = seen;
    }
}

/// The dispatcher task: turns until a drain leaves nothing to do.
async fn run_dispatcher(core: &CoreHost) {
    let run = zero_rt::run(
        core.worker.shutdown(),
        &core.shared.intake,
        &core.kick,
        |now, stopping| core.turn(now, stopping),
    );
    #[cfg(feature = "testing")]
    let run = crate::testing::with_hooks(core, run);
    run.await;
}

/// The handler of one core.
pub(crate) struct HostHandler {
    core: Rc<CoreHost>,
}

impl HostHandler {
    pub(crate) fn start(worker: &Worker, settings: Arc<Settings>) -> Self {
        let shared = Arc::clone(settings.worker_for(worker.index()));
        HostHandler {
            core: CoreHost::start(worker, shared, settings),
        }
    }
}

impl Handler for HostHandler {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let core = &self.core;
        let settings = core.settings();
        if core.draining() {
            overload::answer(call, settings, Overload::Draining);
            settings.rules.after(call);
            return Ok(());
        }
        if settings.rules.before(call) == Answered::Yes {
            return Ok(());
        }
        let Some(routed) = call.route_or_miss(&settings.app.router, settings.app.miss) else {
            settings.rules.after(call);
            return Ok(());
        };
        match routed.descriptor.kind {
            RouteKind::Host | RouteKind::Miss | RouteKind::WebSocket => {
                lease::dispatch(core, call, routed).await
            }
            RouteKind::Fixed | RouteKind::Redirect | RouteKind::Static | RouteKind::Health => {
                if tier0::serve(core, call, routed)? == Served::Fallthrough {
                    if let Some(miss) = settings.app.miss {
                        let fallthrough = Routed {
                            descriptor: miss,
                            head: routed.head,
                            miss: None,
                        };
                        return lease::dispatch(core, call, fallthrough).await;
                    }
                    call.problem(&Problem::new(StatusCode::NOT_FOUND, "not_found"));
                }
                settings.rules.after(call);
                Ok(())
            }
        }
    }

    fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64> {
        self.core.body_limit(method, path)
    }

    fn leased_bytes(&self) -> u64 {
        self.core.shared.counters.retained.load(Ordering::Relaxed)
    }

    fn error_shape(&self) -> ErrorShape {
        self.core.settings.shape
    }
}
