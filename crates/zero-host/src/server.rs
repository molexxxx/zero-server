//! The server: its worker indexes, its lifecycle, its targets and its statistics.
//!
//! [`Server::new`] claims the worker indexes and builds each one's state without
//! binding, so targets attach before any traffic arrives; [`Server::start`] binds,
//! starts one core per index, and returns once listening; [`Server::shutdown`]
//! requests the drain and returns at once; a reaper thread joins the cores, detaches
//! every target, gives the indexes back, marks the server stopped and runs the stop
//! listeners; [`Server::wait`] blocks until then. The lease timeout is the driver's
//! request total, so a configuration where the two differ is refused: there is no
//! second timer.
//!
//! Every call may come from any thread. The lifecycle moves under one lock from
//! ready through starting and running to stopping and stopped, and the calls that
//! attach or detach a target, set TLS or set the status callback check it under the
//! same lock, so none of them lands once a stop began. A stop releases every target
//! the server attached, so its worker indexes go back to the pool with no target, no
//! bound thread and the statistics they counted kept for the stopped server.

use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use zero_http::{ErrorShape, ExportOptions};
use zero_io::rt::ShutdownHandle;
use zero_io::seam::Shutdown;
use zero_rt::dispatch::DispatchLimits;
use zero_rt::{Counters, StatusSink, Target, Worker, Workers};

use crate::access;
use crate::app::{App, Built};
use crate::handler::HostHandler;
use crate::registry::{self, lock, Attached, Claim, WorkerShared};
use crate::rules::Rules;
use crate::spec::ServerOptions;
use crate::target::{current_token, PullTarget};
use crate::{HostError, Status};

/// The next serial of a server or a target.
static SERIAL: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_serial() -> u64 {
    SERIAL.fetch_add(1, Ordering::Relaxed)
}

/// What every core of a server shares: the frozen application, the policies, the
/// answers' settings and the worker indexes.
#[derive(Debug)]
pub(crate) struct Settings {
    pub(crate) app: Built,
    pub(crate) rules: Rules,
    pub(crate) shape: ErrorShape,
    pub(crate) export: ExportOptions,
    pub(crate) retry_after: u32,
    pub(crate) drain_retry_after: u32,
    pub(crate) dispatch: DispatchLimits,
    workers: Box<[Arc<WorkerShared>]>,
    first: Arc<WorkerShared>,
}

impl Settings {
    /// The worker index state of core `core`.
    pub(crate) fn worker_for(&self, core: usize) -> &Arc<WorkerShared> {
        self.workers.get(core).unwrap_or(&self.first)
    }
}

/// A server's statistics, summed over its worker indexes. The counts start at zero
/// for each server; the gauges (`pinned`, `quarantined_peak`, `in_flight`, `leased`,
/// `retained`) are the worker indexes' current values. A stopped server reports
/// the values its worker indexes held when it gave them back.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Requests posted to a target in batches it took.
    pub dispatched: u64,
    /// Batches the targets took.
    pub batches: u64,
    /// Batches acknowledged.
    pub acks: u64,
    /// Slots that waited on the late list for a lock or a pin.
    pub late_readers: u64,
    /// Posts a target answered full.
    pub queue_full: u64,
    /// Host requests answered 503 before a slot was claimed.
    pub refused_503: u64,
    /// Leases closed because their target was lost.
    pub closed_leases: u64,
    /// Panics of the host dispatch.
    pub panics: u64,
    /// Pins host threads hold now.
    pub pinned: u64,
    /// The longest a quarantine has been.
    pub quarantined_peak: u64,
    /// Batches posted and not acknowledged.
    pub in_flight: u64,
    /// Slots leased to a host whose lease has not ended.
    pub leased: u64,
    /// Acknowledgments refused while their completions were applied.
    pub refused_acks: u64,
    /// Batches a target gave up on.
    pub abandoned_batches: u64,
    /// Octets of exchanges held outside the connection records.
    pub retained: u64,
}

/// The counters a server reports from zero.
const COUNTS: usize = 10;

fn counts(counters: &Counters) -> [u64; COUNTS] {
    let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
    [
        load(&counters.dispatched),
        load(&counters.batches),
        load(&counters.acks),
        load(&counters.late_readers),
        load(&counters.queue_full),
        load(&counters.refused_503),
        load(&counters.closed_leases),
        load(&counters.panics),
        load(&counters.refused_acks),
        load(&counters.abandoned_batches),
    ]
}

enum Lifecycle {
    Ready,
    /// A start binds; `stop` records a shutdown asked for meanwhile, which the start
    /// applies when it ends.
    Starting {
        stop: bool,
    },
    Running {
        address: SocketAddr,
        shutdown: ShutdownHandle,
    },
    /// A stop began: no target attaches or detaches any more.
    Stopping,
    Stopped,
}

#[cfg(feature = "tls")]
type Tls = (Arc<zero_tls::Identities>, zero_tls::TlsOptions);

struct State {
    lifecycle: Lifecycle,
    listeners: Vec<Box<dyn FnOnce() + Send>>,
    status: Option<StatusSink>,
    #[cfg(feature = "tls")]
    tls: Option<Tls>,
}

/// What a start reads from the state before it binds.
struct Launch {
    status: StatusSink,
    #[cfg(feature = "tls")]
    tls: Option<Tls>,
}

/// The worker indexes while the server holds them, and the statistics they counted
/// once it gave them back.
struct Holding {
    claim: Option<Claim>,
    last: Option<Stats>,
}

struct Inner {
    settings: Arc<Settings>,
    options: ServerOptions,
    indexes: Vec<u8>,
    claim: Mutex<Holding>,
    state: Mutex<State>,
    stopped: Condvar,
    baseline: Vec<[u64; COUNTS]>,
    table: Vec<u8>,
    #[cfg(feature = "testing")]
    serial: u64,
}

impl Inner {
    #[cfg(feature = "testing")]
    fn reach(&self, stage: crate::testing::Stage) {
        crate::testing::reach(crate::testing::Point::Stage(self.serial, stage));
    }

    /// Release every target, give the worker indexes back with the statistics they
    /// counted, mark the server stopped and run the stop listeners once. The caller
    /// marked the server stopping.
    fn finish(&self) {
        #[cfg(feature = "testing")]
        self.reach(crate::testing::Stage::Stop);
        for shared in self.settings.workers.iter() {
            if shared.release_target(None).is_none() {
                shared.intake.detach();
            }
        }
        #[cfg(feature = "testing")]
        self.reach(crate::testing::Stage::Release);
        {
            let mut holding = lock(&self.claim);
            holding.last = Some(self.counted());
            drop(holding.claim.take());
        }
        let listeners = {
            let mut state = lock(&self.state);
            state.lifecycle = Lifecycle::Stopped;
            std::mem::take(&mut state.listeners)
        };
        self.stopped.notify_all();
        for listener in listeners {
            listener();
        }
    }

    /// Wait for the cores to end, then mark the server stopping and finish.
    fn reap(&self, workers: Workers) {
        let _ = workers.join();
        lock(&self.state).lifecycle = Lifecycle::Stopping;
        self.finish();
    }

    fn shared(&self, worker: u8) -> Result<&Arc<WorkerShared>, HostError> {
        self.settings
            .workers
            .iter()
            .find(|shared| shared.index == worker)
            .ok_or_else(|| {
                HostError::invalid(format!("worker {worker} is not one of this server's"))
            })
    }

    /// Request the drain of a running server, record the request for one that is
    /// starting, or stop one that never started.
    fn request_stop(&self) {
        let mut state = lock(&self.state);
        let now = match &mut state.lifecycle {
            Lifecycle::Ready => true,
            Lifecycle::Starting { stop } => {
                *stop = true;
                false
            }
            Lifecycle::Running { shutdown, .. } => {
                shutdown.request();
                false
            }
            Lifecycle::Stopping | Lifecycle::Stopped => false,
        };
        if now {
            state.lifecycle = Lifecycle::Stopping;
            drop(state);
            self.finish();
        }
    }

    /// The cores of a start are listening: the server runs, and drains at once when a
    /// shutdown came while it started; the reaper takes the cores.
    fn started(&self, workers: Workers, reaper: mpsc::Sender<Workers>) {
        let shutdown = workers.shutdown_handle();
        let stop = {
            let mut state = lock(&self.state);
            let stop = matches!(state.lifecycle, Lifecycle::Starting { stop: true });
            state.lifecycle = Lifecycle::Running {
                address: workers.local_addr(),
                shutdown: shutdown.clone(),
            };
            stop
        };
        if stop {
            shutdown.request();
        }
        if let Err(mpsc::SendError(workers)) = reaper.send(workers) {
            shutdown.request();
            self.reap(workers);
        }
    }

    /// A start failed: the server is ready again, with its targets handed to the
    /// workers once more since a core that ran may have taken them, or it stops when
    /// a shutdown came while it started.
    fn not_started(&self) {
        let mut state = lock(&self.state);
        if matches!(state.lifecycle, Lifecycle::Starting { stop: true }) {
            state.lifecycle = Lifecycle::Stopping;
            drop(state);
            self.finish();
            return;
        }
        for shared in self.settings.workers.iter() {
            shared.requeue_target();
        }
        state.lifecycle = Lifecycle::Ready;
    }

    /// The statistics the worker indexes counted since the server claimed them.
    fn counted(&self) -> Stats {
        let mut stats = Stats::default();
        for (shared, baseline) in self.settings.workers.iter().zip(&self.baseline) {
            let counters = &shared.counters;
            let now = counts(counters);
            let since = |at: usize| {
                now.get(at)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(baseline.get(at).copied().unwrap_or(0))
            };
            let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
            stats.dispatched = stats.dispatched.saturating_add(since(0));
            stats.batches = stats.batches.saturating_add(since(1));
            stats.acks = stats.acks.saturating_add(since(2));
            stats.late_readers = stats.late_readers.saturating_add(since(3));
            stats.queue_full = stats.queue_full.saturating_add(since(4));
            stats.refused_503 = stats.refused_503.saturating_add(since(5));
            stats.closed_leases = stats.closed_leases.saturating_add(since(6));
            stats.panics = stats.panics.saturating_add(since(7));
            stats.refused_acks = stats.refused_acks.saturating_add(since(8));
            stats.abandoned_batches = stats.abandoned_batches.saturating_add(since(9));
            stats.pinned = stats.pinned.saturating_add(load(&counters.pinned));
            stats.quarantined_peak = stats.quarantined_peak.max(load(&counters.quarantined_peak));
            stats.in_flight = stats.in_flight.saturating_add(load(&counters.in_flight));
            stats.leased = stats.leased.saturating_add(load(&counters.leased));
            stats.retained = stats.retained.saturating_add(load(&counters.retained));
        }
        stats
    }
}

/// Refuse a change of target once a stop began.
fn check_open(lifecycle: &Lifecycle) -> Result<(), HostError> {
    match lifecycle {
        Lifecycle::Stopping | Lifecycle::Stopped => Err(HostError::closed("the server is stopped")),
        Lifecycle::Ready | Lifecycle::Starting { .. } | Lifecycle::Running { .. } => Ok(()),
    }
}

/// Start the reaper thread.
fn spawn_reaper(reap: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
    #[cfg(feature = "testing")]
    if crate::testing::reaper_refused() {
        return Err(std::io::Error::other("the reaper thread was refused"));
    }
    std::thread::Builder::new()
        .name("zero-host-reaper".to_owned())
        .spawn(reap)
        .map(drop)
}

/// Bind and start the cores.
fn serve(
    address: SocketAddr,
    config: zero_http::Config,
    make: impl Fn(&Worker) -> HostHandler + Send + Sync + 'static,
    launch: Launch,
) -> std::io::Result<Workers> {
    let workers = listen(address, config, make, launch)?;
    #[cfg(feature = "testing")]
    if crate::testing::serve_refused() {
        let _ = workers.stop();
        return Err(std::io::Error::other("a core thread was refused"));
    }
    Ok(workers)
}

#[cfg(feature = "tls")]
fn listen(
    address: SocketAddr,
    config: zero_http::Config,
    make: impl Fn(&Worker) -> HostHandler + Send + Sync + 'static,
    launch: Launch,
) -> std::io::Result<Workers> {
    match launch.tls {
        Some((identities, options)) => {
            zero_tls::serve(address, config, identities, options, launch.status, make)
        }
        None => zero_http::serve(address, config, launch.status, make),
    }
}

#[cfg(not(feature = "tls"))]
fn listen(
    address: SocketAddr,
    config: zero_http::Config,
    make: impl Fn(&Worker) -> HostHandler + Send + Sync + 'static,
    launch: Launch,
) -> std::io::Result<Workers> {
    zero_http::serve(address, config, launch.status, make)
}

/// Shuts the server down when the last handle drops.
struct Owner(std::sync::Weak<Inner>);

impl Drop for Owner {
    fn drop(&mut self) {
        if let Some(inner) = self.0.upgrade() {
            inner.request_stop();
        }
    }
}

/// A server: a handle that may be cloned and shared across threads. Dropping the
/// last handle shuts the server down: a running server drains on its reaper thread,
/// and one that never started gives its worker indexes back.
#[derive(Clone)]
pub struct Server {
    _owner: Arc<Owner>,
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("workers", &self.inner.indexes)
            .field("running", &self.is_running())
            .finish_non_exhaustive()
    }
}

impl Server {
    /// A server for `app`: claims `options.threads` worker indexes and builds their
    /// state without binding, so targets can attach before traffic arrives.
    ///
    /// # Arguments
    ///
    /// * `app` - the application; it is frozen, and later changes to it do not
    ///   reach this server.
    /// * `options` - the server's options.
    ///
    /// # Returns
    ///
    /// The server, not yet listening.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] when the lease timeout differs from the request
    /// total or the limits contradict each other, [`Status::Codec`] for a `Server`
    /// value or a trailer name that is not valid, and [`Status::Limit`] when fewer
    /// worker indexes are free than `threads` asks for.
    pub fn new(app: &App, options: ServerOptions) -> Result<Server, HostError> {
        let limits = &options.limits;
        if limits.memory.lease_timeout != limits.http1.request_total {
            return Err(HostError::invalid(format!(
                "the lease timeout ({:?}) must equal the request total ({:?}), which ends a lease",
                limits.memory.lease_timeout, limits.http1.request_total
            )));
        }
        limits
            .check()
            .map_err(|invalid| HostError::invalid(invalid.to_string()))?;
        if let Some(server) = &options.server {
            zero_http_types::field::validate_field_value(server.as_bytes())
                .map_err(|_| HostError::codec("the Server value is not a field value"))?;
        }
        for name in &options.trailers {
            zero_http_types::field::validate_field_name(name.as_bytes()).map_err(|_| {
                HostError::codec(format!("the trailer name {name:?} is not a token"))
            })?;
        }
        let built = app.build();
        let rules = Rules::new(&built.policies, limits.http1.max_body);
        let export = ExportOptions {
            trailers: options
                .trailers
                .iter()
                .map(|name| Box::from(name.as_bytes()))
                .collect(),
            client: rules.client_rule(),
        };
        let claim = registry::claim(options.threads)?;
        let workers: Vec<Arc<WorkerShared>> = claim
            .indexes()
            .iter()
            .filter_map(|&index| registry::worker(index).cloned())
            .collect();
        let first = workers
            .first()
            .cloned()
            .ok_or_else(|| HostError::limit("no worker index could be claimed"))?;
        for &index in claim.indexes() {
            access::configure(index, options.error_shape, options.max_response_body);
        }
        let baseline = workers
            .iter()
            .map(|shared| counts(&shared.counters))
            .collect();
        let table = built.table.clone();
        let settings = Arc::new(Settings {
            app: built,
            rules,
            shape: options.error_shape,
            export,
            retry_after: options.retry_after_secs,
            drain_retry_after: options.drain_retry_after_secs,
            dispatch: DispatchLimits::from_memory(&limits.memory),
            workers: workers.into_boxed_slice(),
            first,
        });
        let inner = Arc::new(Inner {
            indexes: claim.indexes().to_vec(),
            claim: Mutex::new(Holding {
                claim: Some(claim),
                last: None,
            }),
            settings,
            options,
            state: Mutex::new(State {
                lifecycle: Lifecycle::Ready,
                listeners: Vec::new(),
                status: None,
                #[cfg(feature = "tls")]
                tls: None,
            }),
            stopped: Condvar::new(),
            baseline,
            table,
            #[cfg(feature = "testing")]
            serial: next_serial(),
        });
        Ok(Server {
            _owner: Arc::new(Owner(Arc::downgrade(&inner))),
            inner,
        })
    }

    /// The state of one of this server's worker indexes.
    #[cfg(feature = "testing")]
    pub(crate) fn worker_shared(&self, worker: u8) -> Result<&Arc<WorkerShared>, HostError> {
        self.inner.shared(worker)
    }

    /// The serial that names this server's points for the test hooks.
    #[cfg(feature = "testing")]
    pub(crate) fn serial(&self) -> u64 {
        self.inner.serial
    }

    /// The worker indexes this server claimed, in core order.
    ///
    /// # Returns
    ///
    /// The global indexes, one per core.
    #[must_use]
    pub fn workers(&self) -> &[u8] {
        &self.inner.indexes
    }

    /// Serve over TLS: the certificate chain and the private key as PEM, and a TLS
    /// option document with `alpn`, `minVersion`, `maxVersion` (TLS 1.3 is always
    /// offered), `requireEms` and `names`, the hosts the certificate serves. The key
    /// is copied into memory that is zeroized when the identity is built.
    ///
    /// # Arguments
    ///
    /// * `chain_pem` - the certificate chain.
    /// * `key_pem` - the private key.
    /// * `options` - the UTF-8 JSON option document.
    ///
    /// # Errors
    ///
    /// [`Status::Codec`] for a malformed option document, [`Status::Io`] for
    /// material that cannot be read as a certificate and a key,
    /// [`Status::InvalidArgument`] once the server started or while it starts, and
    /// [`Status::Unsupported`] when the `tls` capability is compiled out.
    #[cfg_attr(not(feature = "tls"), allow(unused_variables))]
    pub fn tls(&self, chain_pem: &[u8], key_pem: &[u8], options: &[u8]) -> Result<(), HostError> {
        #[cfg(feature = "tls")]
        {
            const STARTED: &str = "TLS is set before the server starts";
            let spec = crate::spec::TlsSpec::parse(options)?;
            if !matches!(lock(&self.inner.state).lifecycle, Lifecycle::Ready) {
                return Err(HostError::invalid(STARTED));
            }
            let key = zero_server_crypto::SecretBytes::from_slice(key_pem);
            let names: Vec<&str> = spec.names.iter().map(String::as_str).collect();
            let identity = zero_tls::Identity::from_pem(chain_pem, key.expose(), &names)
                .map_err(|err| HostError::io(format!("the TLS material: {err}")))?;
            drop(key);
            let identities = Arc::new(zero_tls::Identities::new(
                std::slice::from_ref(&identity),
                Some(identity.clone()),
            ));
            let tls = zero_tls::TlsOptions {
                alpn: spec.alpn,
                tls12: spec.tls12,
                require_ems: spec.require_ems,
                ..zero_tls::TlsOptions::default()
            };
            #[cfg(feature = "testing")]
            self.inner.reach(crate::testing::Stage::Tls);
            let mut state = lock(&self.inner.state);
            if !matches!(state.lifecycle, Lifecycle::Ready) {
                return Err(HostError::invalid(STARTED));
            }
            state.tls = Some((identities, tls));
            Ok(())
        }
        #[cfg(not(feature = "tls"))]
        Err(HostError::unsupported(
            "TLS needs the `tls` capability, which this build leaves out",
        ))
    }

    /// Receive the cores' status events (started, stopped, a contained panic, a
    /// failed host dispatch), on the cores' threads.
    ///
    /// # Arguments
    ///
    /// * `sink` - the callback.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] once the server started or while it starts.
    pub fn on_event(&self, sink: StatusSink) -> Result<(), HostError> {
        let mut state = lock(&self.inner.state);
        if !matches!(state.lifecycle, Lifecycle::Ready) {
            return Err(HostError::invalid(
                "the status callback is set before the server starts",
            ));
        }
        state.status = Some(sink);
        Ok(())
    }

    /// Run `listener` once the server stopped, or now when it already has.
    ///
    /// # Arguments
    ///
    /// * `listener` - the callback; it runs on the thread that stops the server,
    ///   the reaper thread for a server that ran.
    pub fn on_stop(&self, listener: Box<dyn FnOnce() + Send>) {
        let mut state = lock(&self.inner.state);
        if matches!(state.lifecycle, Lifecycle::Stopped) {
            drop(state);
            listener();
        } else {
            state.listeners.push(listener);
        }
    }

    /// Compare this server's canonical table with an application's, as a host that
    /// built the application on another thread or isolate checks that every route
    /// id means the same route.
    ///
    /// # Arguments
    ///
    /// * `app` - the other registration.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] naming the first line that differs.
    pub fn check_table(&self, app: &App) -> Result<(), HostError> {
        let other = app.table();
        if other == self.inner.table {
            return Ok(());
        }
        let ours = String::from_utf8_lossy(&self.inner.table).into_owned();
        let theirs = String::from_utf8_lossy(&other).into_owned();
        let mut lines = ours.lines().zip(theirs.lines()).enumerate();
        let difference = lines
            .find(|(_, (a, b))| a != b)
            .map(|(line, (a, b))| (line, a.to_owned(), b.to_owned()))
            .unwrap_or_else(|| {
                let line = ours.lines().count().min(theirs.lines().count());
                (
                    line,
                    ours.lines().nth(line).unwrap_or("(end)").to_owned(),
                    theirs.lines().nth(line).unwrap_or("(end)").to_owned(),
                )
            });
        Err(HostError::invalid(format!(
            "the route tables differ at line {}: the server has `{}` where the application has `{}`",
            difference.0.saturating_add(1),
            difference.1,
            difference.2
        )))
    }

    /// Bind and start one core per worker index; returns once listening.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] when the server already started or is starting,
    /// [`Status::Closed`] once a stop began, and [`Status::Io`] when the address does
    /// not resolve, cannot be bound, or a thread cannot be started. A start that
    /// fails leaves the server ready, with the targets attached before it, or stops
    /// it when a shutdown was requested while it started.
    pub fn start(&self) -> Result<(), HostError> {
        let inner = &self.inner;
        let launch = {
            let mut state = lock(&inner.state);
            match state.lifecycle {
                Lifecycle::Ready => {}
                Lifecycle::Starting { .. } => {
                    return Err(HostError::invalid("the server is starting"))
                }
                Lifecycle::Running { .. } => {
                    return Err(HostError::invalid("the server is running"))
                }
                Lifecycle::Stopping | Lifecycle::Stopped => {
                    return Err(HostError::closed("the server is stopped"))
                }
            }
            state.lifecycle = Lifecycle::Starting { stop: false };
            Launch {
                status: state
                    .status
                    .clone()
                    .unwrap_or_else(|| Arc::new(|_: zero_rt::Event| {})),
                #[cfg(feature = "tls")]
                tls: state.tls.clone(),
            }
        };
        match self.launch(launch) {
            Ok((workers, reaper)) => {
                inner.started(workers, reaper);
                Ok(())
            }
            Err(err) => {
                inner.not_started();
                Err(err)
            }
        }
    }

    /// Resolve the address, start the reaper thread, then bind and start the cores;
    /// the reaper waits for the cores the returned sender hands it.
    fn launch(&self, launch: Launch) -> Result<(Workers, mpsc::Sender<Workers>), HostError> {
        let inner = &self.inner;
        let options = &inner.options;
        let address = (options.host.as_str(), options.port)
            .to_socket_addrs()
            .map_err(|err| HostError::io(format!("the address {}: {err}", options.host)))?
            .next()
            .ok_or_else(|| {
                HostError::io(format!("the address {} resolves to nothing", options.host))
            })?;
        let config = zero_http::Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads: inner.indexes.len(),
                    drain: options.drain,
                    memory_budget: options.limits.memory.request_memory_per_core,
                    receive_block: options.limits.http1.receive_block,
                    ..zero_io::rt::Config::default()
                },
            },
            limits: options.limits.http1,
            server: options.server.clone(),
        };
        let (hand, taken) = mpsc::channel::<Workers>();
        let reaper = Arc::clone(inner);
        spawn_reaper(move || {
            if let Ok(workers) = taken.recv() {
                reaper.reap(workers);
            }
        })
        .map_err(|err| HostError::io(format!("cannot start the reaper thread: {err}")))?;
        let settings = Arc::clone(&inner.settings);
        let make = move |worker: &Worker| HostHandler::start(worker, Arc::clone(&settings));
        let workers = serve(address, config, make, launch)
            .map_err(|err| HostError::io(format!("cannot serve on {address}: {err}")))?;
        Ok((workers, hand))
    }

    /// The address the server listens on.
    ///
    /// # Returns
    ///
    /// The bound address while running, `None` before the start and after the stop.
    #[must_use]
    pub fn address(&self) -> Option<SocketAddr> {
        match lock(&self.inner.state).lifecycle {
            Lifecycle::Running { address, .. } => Some(address),
            Lifecycle::Ready
            | Lifecycle::Starting { .. }
            | Lifecycle::Stopping
            | Lifecycle::Stopped => None,
        }
    }

    /// Whether the server started and has not stopped.
    ///
    /// # Returns
    ///
    /// `true` while running, the drain included.
    #[must_use]
    pub fn is_running(&self) -> bool {
        matches!(lock(&self.inner.state).lifecycle, Lifecycle::Running { .. })
    }

    /// Request the drain and return at once: the cores stop accepting, finish their
    /// in-flight requests within the drain deadline, and the server stops. A server
    /// that never started stops now, and one that is starting drains once its start
    /// ends.
    pub fn shutdown(&self) {
        self.inner.request_stop();
    }

    /// Block until the server stopped.
    ///
    /// # Arguments
    ///
    /// * `timeout` - the longest wait; `None` waits as long as it takes.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] on an I/O worker thread and, until a stop of the
    /// server began, on a thread bound to one of this server's targets, since the
    /// drain needs that thread's acknowledgments and a wait there could only time
    /// out; [`Status::Timeout`] when the server is still running when the timeout
    /// passes.
    pub fn wait(&self, timeout: Option<Duration>) -> Result<(), HostError> {
        if zero_rt::is_worker_thread() {
            return Err(HostError::invalid(
                "a server cannot be waited for on an I/O worker thread",
            ));
        }
        let deadline = timeout.and_then(|timeout| Instant::now().checked_add(timeout));
        let mut state = lock(&self.inner.state);
        let token = current_token();
        if token != 0
            && check_open(&state.lifecycle).is_ok()
            && self
                .inner
                .settings
                .workers
                .iter()
                .any(|shared| shared.intake.bound_thread() == token)
        {
            return Err(HostError::invalid(
                "a thread bound to one of the server's targets cannot wait for it",
            ));
        }
        while !matches!(state.lifecycle, Lifecycle::Stopped) {
            state = match deadline {
                None => self
                    .inner
                    .stopped
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
                Some(at) => {
                    let left = at.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(HostError::new(
                            Status::Timeout,
                            "the server is still running",
                        ));
                    }
                    self.inner
                        .stopped
                        .wait_timeout(state, left)
                        .map_or_else(|poisoned| poisoned.into_inner().0, |(state, _)| state)
                }
            };
        }
        Ok(())
    }

    /// The server's statistics, summed over its worker indexes.
    ///
    /// # Returns
    ///
    /// The statistics; once the server stopped, those it had when it gave its
    /// worker indexes back.
    #[must_use]
    pub fn stats(&self) -> Stats {
        let holding = lock(&self.inner.claim);
        holding.last.unwrap_or_else(|| self.inner.counted())
    }

    /// Attach a pull target for one of this server's worker indexes, or for every
    /// one of them.
    ///
    /// # Arguments
    ///
    /// * `worker` - the global worker index, or `None` for every worker index of the
    ///   server, served from one queue.
    ///
    /// # Returns
    ///
    /// The target; the first thread to poll it is bound to it.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] for a worker index of another server,
    /// [`Status::Limit`] when a worker index already has a target, and
    /// [`Status::Closed`] once a stop of the server began.
    pub fn attach_pull(&self, worker: Option<u8>) -> Result<Arc<PullTarget>, HostError> {
        let state = lock(&self.inner.state);
        check_open(&state.lifecycle)?;
        let workers: Vec<Arc<WorkerShared>> = match worker {
            Some(index) => vec![Arc::clone(self.inner.shared(index)?)],
            None => self.inner.settings.workers.to_vec(),
        };
        for shared in &workers {
            shared.check_free()?;
        }
        let settings = &self.inner.settings;
        let target = Arc::new(PullTarget::new(
            next_serial(),
            workers.clone(),
            settings.dispatch.batch,
            settings.dispatch.in_flight,
        ));
        for (position, shared) in workers.iter().enumerate() {
            if let Err(err) = shared.claim_target(Attached::Pull(Arc::clone(&target))) {
                for claimed in workers.iter().take(position) {
                    claimed.release_target(Some(target.serial()));
                }
                return Err(err);
            }
        }
        drop(state);
        Ok(target)
    }

    /// Attach a binding's own target to one of this server's worker indexes. The
    /// binding binds its host thread with [`bind_thread`](crate::bind_thread) and
    /// reads each batch with [`read_batch`](crate::read_batch).
    ///
    /// # Arguments
    ///
    /// * `worker` - the global worker index.
    /// * `target` - the target.
    ///
    /// # Errors
    ///
    /// As [`attach_pull`](Self::attach_pull).
    pub fn attach(&self, worker: u8, target: Arc<dyn Target>) -> Result<(), HostError> {
        let state = lock(&self.inner.state);
        check_open(&state.lifecycle)?;
        self.inner
            .shared(worker)?
            .claim_target(Attached::Own(next_serial(), target))?;
        drop(state);
        Ok(())
    }

    /// Detach the target of one of this server's worker indexes: its leases are
    /// closed and answered 503, its queued requests fail the same way, and the
    /// indexes it held are released.
    ///
    /// # Arguments
    ///
    /// * `worker` - the global worker index.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] for a worker index of another server and
    /// [`Status::Closed`] when the index has no target or once a stop of the server
    /// began.
    pub fn detach(&self, worker: u8) -> Result<(), HostError> {
        let state = lock(&self.inner.state);
        check_open(&state.lifecycle)?;
        let released = self
            .inner
            .shared(worker)?
            .release_target(None)
            .ok_or_else(|| HostError::closed(format!("worker {worker} has no target")))?;
        if let Attached::Pull(target) = released {
            target.detach();
        }
        drop(state);
        Ok(())
    }
}
