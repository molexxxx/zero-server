//! Servers: creation from an application, TLS, the table check, start, shutdown,
//! the wait, the worker indexes and the statistics.
//!
//! The registry is process-wide, since a server created in the main isolate is
//! attached to by the isolates of its workers. Ids are handed out once per process
//! and never reused, so a stale id reads as unknown. A server's handle leaves the
//! registry when the server stops, and the statistics it ended with stay behind, so
//! a stopped server keeps answering `serverStats` and `serverWorkers` without
//! holding its frozen application.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{BufferSlice, Object};
use napi::{Env, JsDeferred};
use napi_derive::napi;
use zero_host::{Server, ServerOptions, Stats};

use crate::app::with_app;
use crate::guard::{contained, lock, node_guard, Code, Fail};
use crate::ids;

/// What the binding counts for a server beside the core's statistics.
#[derive(Debug, Default)]
pub(crate) struct Counters {
    /// Deliveries skipped because their batch was no longer in the ring.
    pub(crate) stale_deliveries: AtomicU64,
    /// Status events the core reported.
    pub(crate) status_events: AtomicU64,
    /// Status events dropped because 16 were already queued for the isolate.
    pub(crate) status_dropped: AtomicU64,
    /// Targets detached because their isolate was torn down without detaching them.
    pub(crate) teardown_detaches: AtomicU64,
}

/// One server of the registry.
struct ServerSlot {
    /// The handle while the server has not stopped.
    server: Option<Server>,
    /// The statistics it ended with, once stopped.
    last: Option<Stats>,
    counters: Arc<Counters>,
    workers: Vec<u8>,
    drain_ms: u64,
}

/// The next server id.
static NEXT_SERVER: AtomicU64 = AtomicU64::new(1);

/// Every server of the process, by id.
static SERVERS: Mutex<BTreeMap<u64, ServerSlot>> = Mutex::new(BTreeMap::new());

/// The handle of a server that has not stopped.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown or stopped server.
pub(crate) fn running(id: u64) -> Result<Server, Fail> {
    let servers = lock(&SERVERS);
    let slot = servers
        .get(&id)
        .ok_or_else(|| Fail::closed(format!("no server {id}")))?;
    slot.server
        .clone()
        .ok_or_else(|| Fail::closed(format!("server {id} is stopped")))
}

/// The handle of the server a number names, while it has not stopped.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not an id, `ZERO_CLOSED` for an
/// unknown or stopped server.
pub(crate) fn running_arg(server: f64) -> Result<(u64, Server), Fail> {
    let id = ids::id(server, "the server id")?;
    Ok((id, running(id)?))
}

/// The binding's counters of a server, stopped or not.
pub(crate) fn counters(id: u64) -> Option<Arc<Counters>> {
    lock(&SERVERS)
        .get(&id)
        .map(|slot| Arc::clone(&slot.counters))
}

/// Take a stopped server's handle out of the registry and keep its statistics.
/// The handle drops outside the registry's lock.
fn retire(id: u64) {
    let handle = {
        let mut servers = lock(&SERVERS);
        servers.get_mut(&id).and_then(|slot| {
            let server = slot.server.take()?;
            slot.last = Some(server.stats());
            Some(server)
        })
    };
    drop(handle);
}

/// Create a server for an application of this isolate: claims the worker indexes
/// and builds their state without binding, so targets attach before traffic
/// arrives.
///
/// The option document's keys: `host`, `port`, `threads` (0 for the smaller of the
/// available parallelism and the free worker indexes), `drainMs`, `retryAfterSecs`,
/// `drainRetryAfterSecs`, `maxResponseBody`, `maxBatchSize`, `maxBatchesInFlight`,
/// `maxQueuedBatches`, `server`, `trailers`, `errorShape` (`"problem"` or
/// `"legacy"`) and `limits`.
///
/// # Arguments
///
/// * `app` - the application id; the server freezes it.
/// * `options` - the JSON option document; empty for the defaults.
///
/// # Returns
///
/// The server's id, valid in every isolate of the process.
///
/// # Errors
///
/// `ZERO_CODEC` for a malformed option document, `ZERO_INVALID_ARGUMENT` for
/// contradicting limits, `ZERO_LIMIT` when fewer worker indexes are free than
/// `threads` asks for, and `ZERO_CLOSED` for an unknown application.
#[napi(catch_unwind)]
pub fn server_new(app: f64, options: String) -> napi::Result<f64, Code> {
    node_guard(|| {
        let options = ServerOptions::parse(options.as_bytes())?;
        let drain_ms = u64::try_from(options.drain.as_millis()).unwrap_or(u64::MAX);
        let server = with_app(app, |app| Server::new(app, options).map_err(Fail::from))?;
        let id = NEXT_SERVER.fetch_add(1, Ordering::Relaxed);
        if id > ids::ID_MAX {
            server.shutdown();
            return Err(Fail::new(
                Code::LIMIT,
                "the process handed out every server id",
            ));
        }
        let slot = ServerSlot {
            server: Some(server.clone()),
            last: None,
            counters: Arc::new(Counters::default()),
            workers: server.workers().to_vec(),
            drain_ms,
        };
        lock(&SERVERS).insert(id, slot);
        server.on_stop(Box::new(move || contained(|| retire(id))));
        Ok(ids::number(id))
    })
}

/// Serve over TLS with a certificate chain and a private key, both PEM. The key is
/// copied into memory that is zeroized once the identity is built.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `cert` - the certificate chain.
/// * `key` - the private key.
/// * `options` - the JSON TLS option document: `alpn`, `minVersion`, `maxVersion`,
///   `requireEms`, `names`.
///
/// # Errors
///
/// `ZERO_CODEC` for a malformed option document, `ZERO_IO` for material that is not
/// a certificate chain and a key, `ZERO_INVALID_ARGUMENT` once the server started,
/// `ZERO_UNSUPPORTED` when TLS is left out of the build, and `ZERO_CLOSED` for an
/// unknown or stopped server.
#[napi(catch_unwind)]
pub fn server_tls(
    server: f64,
    cert: BufferSlice<'_>,
    key: BufferSlice<'_>,
    options: String,
) -> napi::Result<(), Code> {
    node_guard(|| {
        let (_, server) = running_arg(server)?;
        server
            .tls(&cert, &key, options.as_bytes())
            .map_err(Fail::from)
    })
}

/// Check that an application of this isolate registered the same routes and policies
/// as the server's, as a worker isolate does before it attaches.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `app` - the application id.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` naming the first line of the canonical tables that
/// differs, and `ZERO_CLOSED` for an unknown application or an unknown or stopped
/// server.
#[napi(catch_unwind)]
pub fn server_check_table(server: f64, app: f64) -> napi::Result<(), Code> {
    node_guard(|| {
        let (_, server) = running_arg(server)?;
        with_app(app, |app| server.check_table(app).map_err(Fail::from))
    })
}

/// Bind and start one core per worker index; returns once listening.
///
/// # Arguments
///
/// * `server` - the server id.
///
/// # Returns
///
/// The address the server listens on, as `host:port` (`[host]:port` for IPv6).
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` when the server already started, `ZERO_IO` when the
/// address cannot be bound, and `ZERO_CLOSED` for an unknown or stopped server.
#[napi(catch_unwind)]
pub fn server_start(server: f64) -> napi::Result<String, Code> {
    node_guard(|| {
        let (id, server) = running_arg(server)?;
        server.start()?;
        server
            .address()
            .map(|address| address.to_string())
            .ok_or_else(|| Fail::closed(format!("server {id} stopped while it started")))
    })
}

/// The worker indexes the server claimed, one per core, in core order.
///
/// # Arguments
///
/// * `server` - the server id.
///
/// # Returns
///
/// The global worker indexes.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown server.
#[napi(catch_unwind, ts_return_type = "number[]")]
pub fn server_workers(server: f64) -> napi::Result<Vec<u32>, Code> {
    node_guard(|| {
        let id = ids::id(server, "the server id")?;
        let servers = lock(&SERVERS);
        let slot = servers
            .get(&id)
            .ok_or_else(|| Fail::closed(format!("no server {id}")))?;
        Ok(slot.workers.iter().map(|&index| u32::from(index)).collect())
    })
}

/// Request the drain and return at once: the cores stop accepting, finish their
/// in-flight requests and the server stops. A server that never started stops now.
/// The drain deadline is the `drainMs` the server was created with, since the cores
/// take it when they start.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `drainMs` - 0, or the `drainMs` option the server was created with.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for another deadline, and `ZERO_CLOSED` for an unknown
/// server. Shutting down a stopped server does nothing.
#[napi(catch_unwind)]
pub fn server_shutdown(server: f64, drain_ms: f64) -> napi::Result<(), Code> {
    node_guard(|| {
        let id = ids::id(server, "the server id")?;
        let drain = ids::id(drain_ms, "the drain deadline")?;
        let handle = {
            let servers = lock(&SERVERS);
            let slot = servers
                .get(&id)
                .ok_or_else(|| Fail::closed(format!("no server {id}")))?;
            if drain != 0 && drain != slot.drain_ms {
                return Err(Fail::invalid(format!(
                    "server {id} drains within the {} ms it was created with; pass 0 or {}",
                    slot.drain_ms, slot.drain_ms
                )));
            }
            slot.server.clone()
        };
        if let Some(server) = handle {
            server.shutdown();
        }
        Ok(())
    })
}

/// The value a settled wait resolves with.
fn settled(_: Env) -> napi::Result<()> {
    Ok(())
}

/// Wait until the server stopped, without occupying a libuv pool thread: the
/// Promise is settled through a one-shot threadsafe function that the server's stop
/// calls from its reaper thread, and it keeps the event loop alive until then.
///
/// # Arguments
///
/// * `server` - the server id.
///
/// # Returns
///
/// A Promise that resolves once the server stopped; at once for a stopped server.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown server, and `ZERO_LIMIT` when Node-API cannot create
/// the Promise.
#[napi(catch_unwind, ts_return_type = "Promise<void>")]
pub fn server_wait(env: &Env, server: f64) -> napi::Result<Object<'_>, Code> {
    node_guard(|| {
        let id = ids::id(server, "the server id")?;
        let handle = {
            let servers = lock(&SERVERS);
            let slot = servers
                .get(&id)
                .ok_or_else(|| Fail::closed(format!("no server {id}")))?;
            slot.server.clone()
        };
        let (deferred, promise) = env
            .create_deferred::<(), fn(Env) -> napi::Result<()>>()
            .map_err(|error| Fail::napi(&error))?;
        let settle = move || contained(move || resolve(deferred));
        match handle {
            Some(server) => server.on_stop(Box::new(settle)),
            None => settle(),
        }
        Ok(promise)
    })
}

/// Settle a wait.
fn resolve(deferred: JsDeferred<(), fn(Env) -> napi::Result<()>>) {
    deferred.resolve(settled);
}

/// The server's statistics: the core's counts summed over its worker indexes, and
/// the binding's own. Keys: `dispatched`, `batches`, `acks`, `late_readers`,
/// `queue_full`, `refused_503`, `closed_leases`, `panics`, `pinned`,
/// `quarantined_peak`, `in_flight`, `leased`, `refused_acks`, `abandoned_batches`,
/// `retained`, `stale_deliveries`, `status_events`, `status_dropped` and
/// `teardown_detaches`.
///
/// # Arguments
///
/// * `server` - the server id.
///
/// # Returns
///
/// The statistics; once the server stopped, those it ended with.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown server, and `ZERO_LIMIT` when Node-API cannot create
/// the object.
#[napi(catch_unwind, ts_return_type = "Record<string, number>")]
pub fn server_stats(env: &Env, server: f64) -> napi::Result<Object<'_>, Code> {
    node_guard(|| {
        let id = ids::id(server, "the server id")?;
        let (handle, last, counters) = {
            let servers = lock(&SERVERS);
            let slot = servers
                .get(&id)
                .ok_or_else(|| Fail::closed(format!("no server {id}")))?;
            (slot.server.clone(), slot.last, Arc::clone(&slot.counters))
        };
        let stats = match handle {
            Some(server) => server.stats(),
            None => last.unwrap_or_default(),
        };
        let load = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        let fields = [
            ("dispatched", stats.dispatched),
            ("batches", stats.batches),
            ("acks", stats.acks),
            ("late_readers", stats.late_readers),
            ("queue_full", stats.queue_full),
            ("refused_503", stats.refused_503),
            ("closed_leases", stats.closed_leases),
            ("panics", stats.panics),
            ("pinned", stats.pinned),
            ("quarantined_peak", stats.quarantined_peak),
            ("in_flight", stats.in_flight),
            ("leased", stats.leased),
            ("refused_acks", stats.refused_acks),
            ("abandoned_batches", stats.abandoned_batches),
            ("retained", stats.retained),
            ("stale_deliveries", load(&counters.stale_deliveries)),
            ("status_events", load(&counters.status_events)),
            ("status_dropped", load(&counters.status_dropped)),
            ("teardown_detaches", load(&counters.teardown_detaches)),
        ];
        let mut object = Object::new(env).map_err(|error| Fail::napi(&error))?;
        for (name, value) in fields {
            object
                .set(name, ids::number(value))
                .map_err(|error| Fail::napi(&error))?;
        }
        Ok(object)
    })
}
