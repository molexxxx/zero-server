//! Servers: built from an app without binding, so targets attach before any traffic;
//! started, drained and stopped; and freed once stopped.
//!
//! `zero_server_new` claims the server's worker indexes and builds their state;
//! `zero_server_start` binds and returns once listening; `zero_server_shutdown` requests
//! the drain and returns at once; a reaper thread joins the cores, detaches every target
//! and marks the server stopped; `zero_server_wait` blocks until then; `zero_server_free`
//! releases the id. The library installs no signal handler.

use std::mem::size_of;
use std::time::Duration;

use zero_host::{Server, ServerOptions};

use crate::abi::app::APPS;
use crate::abi::names::ZERO_NONE;
use crate::abi::{ZeroStats, ZeroStatus};
use crate::guard::{guard, Fail};
use crate::handles::ZeroString;
use crate::ids::Table;
use crate::ptr as host;

/// A server a host built, and the drain deadline its options set.
#[derive(Clone)]
pub(crate) struct ServerRecord {
    pub(crate) server: Server,
    drain: Duration,
}

/// Every server a host built and has not freed.
pub(crate) static SERVERS: Table<ServerRecord> = Table::new(
    "the server id is unknown or was freed",
    "a panic poisoned the server table",
);

const NOT_LISTENING: Fail =
    Fail::closed("the server is not listening: it has not started, or it stopped");
const SHORT_CAP: Fail = Fail::limit("the workers array is shorter than the count");
const RUNNING: Fail = Fail::limit("the server is running; shut it down and wait for it first");
const SHORT_DRAIN: Fail = Fail::unsupported(
    "a drain shorter than the server's drainMs option is not supported; pass ZERO_NONE or at least drainMs",
);

/// The server of an id, used once the table's lock is released.
pub(crate) fn server(id: u64) -> Result<Server, Fail> {
    SERVERS.with(id, |record| record.server.clone())
}

/// The zero-host server behind a server id, for a Rust caller that drives one server
/// through both this ABI and zero-host's own API.
///
/// # Arguments
///
/// * `id` - the server's id.
///
/// # Returns
///
/// A handle to the server; the server stays registered under its id.
///
/// # Errors
///
/// `ZeroStatus::Closed` for an unknown or freed id, `ZeroStatus::InvalidArgument` for an
/// id above `ZERO_ID_MAX`, `ZeroStatus::Panic` for a poisoned table.
pub fn server_of(id: u64) -> Result<Server, ZeroStatus> {
    server(id).map_err(|fail| fail.status())
}

/// A wait in milliseconds, `ZERO_NONE` for no bound.
pub(crate) fn wait_for(milliseconds: u64) -> Option<Duration> {
    (milliseconds != ZERO_NONE).then(|| Duration::from_millis(milliseconds))
}

/// Builds a server from an app: claims its worker indexes and builds their state without
/// binding. The app is frozen into the server; later changes to it do not reach it.
///
/// The option document holds `host`, `port` (0 lets the system pick one), `threads` (0
/// for the smaller of the available parallelism and the free worker indexes, at least
/// 1), `drainMs`, `retryAfterSecs`, `drainRetryAfterSecs`, `maxResponseBody`,
/// `maxBatchSize` (1 to 256), `maxBatchesInFlight` (1 to 8), `maxQueuedBatches`,
/// `server`, `trailers` (the trailer names a host may read), `errorShape` (`"problem"` or
/// `"legacy"`) and `limits` (`maxBody`, `requestTotalMs`, which is also the lease
/// timeout, and the HTTP/1.1 limits). An empty document takes every default.
///
/// # Arguments
///
/// * `app` - the app's id.
/// * `options` - the UTF-8 JSON option document.
/// * `options_len` - its length in octets.
/// * `server_out` - receives the server's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Codec` for a malformed option document, naming the key; `InvalidArgument` for a
/// lease timeout that differs from the request total or limits that contradict each
/// other; `Limit` when fewer worker indexes are free than `threads` asks for; `Closed`
/// for an unknown app.
///
/// # Safety
///
/// `options` must be a readable range of `options_len` octets, and `server_out` NULL or a
/// writable `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_server_new(
    app: u64,
    options: *const u8,
    options_len: usize,
    server_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(server_out)?;
        // SAFETY: input ranges: `options` is `options_len` readable octets for the call.
        let options = unsafe { host::read_bytes(options, options_len) }?;
        let options = ServerOptions::parse(options)?;
        let drain = options.drain;
        let server = APPS.with(app, |app| Server::new(app, options))??;
        let id = SERVERS.insert(ServerRecord { server, drain })?;
        // SAFETY: outputs: `server_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(server_out, size_of::<u64>(), &[id]) }
    })
}

/// Serves over TLS: the certificate chain and the private key as PEM, never inside the
/// JSON, and a TLS option document with `alpn`, `minVersion`, `maxVersion` (`"1.2"` or
/// `"1.3"`; TLS 1.3 is always offered), `requireEms` and `names`, the hosts the
/// certificate serves. The key is copied into memory that is zeroized once the identity
/// is built.
///
/// # Arguments
///
/// * `server` - the server's id; it has not started.
/// * `cert_chain_pem` - the certificate chain.
/// * `cert_len` - its length in octets.
/// * `key_pem` - the private key.
/// * `key_len` - its length in octets.
/// * `options` - the UTF-8 JSON option document.
/// * `options_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Codec` for a malformed option document; `Io` for material that cannot be read as a
/// certificate and a key; `InvalidArgument` once the server started or while it starts;
/// `Unsupported` when the `tls` capability is compiled out; `Closed` for an unknown
/// server.
///
/// # Safety
///
/// `cert_chain_pem`, `key_pem` and `options` must be readable ranges of their lengths.
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_server_tls(
    server: u64,
    cert_chain_pem: *const u8,
    cert_len: usize,
    key_pem: *const u8,
    key_len: usize,
    options: *const u8,
    options_len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `cert_chain_pem` is `cert_len` readable octets for the call.
        let chain = unsafe { host::read_bytes(cert_chain_pem, cert_len) }?;
        // SAFETY: input ranges: `key_pem` is `key_len` readable octets for the call.
        let key = unsafe { host::read_bytes(key_pem, key_len) }?;
        // SAFETY: input ranges: `options` is `options_len` readable octets for the call.
        let options = unsafe { host::read_bytes(options, options_len) }?;
        crate::abi::server::server(server)?
            .tls(chain, key, options)
            .map_err(Fail::from)
    })
}

/// Compares a server's canonical table with an app's, as a host that built the app on
/// another thread checks that every route id means the same route.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `app` - the app's id.
///
/// # Returns
///
/// `ZeroStatus_Ok` when the tables are identical, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` naming the first line that differs in the last error; `Closed` for
/// an unknown server or app.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_server_check_table(server: u64, app: u64) -> ZeroStatus {
    guard(|| {
        let server = crate::abi::server::server(server)?;
        APPS.with(app, |app| server.check_table(app))?
            .map_err(Fail::from)
    })
}

/// Binds and starts one core per worker index, and returns once listening.
///
/// # Arguments
///
/// * `server` - the server's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Io` when the address does not resolve or cannot be bound or a thread cannot start;
/// `InvalidArgument` when the server already started or is starting; `Closed` once a
/// stop began or for an unknown server. A start that fails leaves the server ready with
/// its targets attached.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_server_start(server: u64) -> ZeroStatus {
    guard(|| {
        crate::abi::server::server(server)?
            .start()
            .map_err(Fail::from)
    })
}

/// Writes the address the server listens on, as `host:port` with an IPv6 host in
/// brackets.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `address_out` - receives the address, an owned string the caller releases with
///   `zero_string_free`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` before the start, after the stop, or for an unknown server;
/// `InvalidArgument` for a NULL or misaligned `address_out`.
///
/// # Safety
///
/// `address_out` must be NULL or point to a writable `ZeroString *`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_server_address(
    server: u64,
    address_out: *mut *mut ZeroString,
) -> ZeroStatus {
    guard(|| {
        host::check_out(address_out)?;
        let address = crate::abi::server::server(server)?
            .address()
            .ok_or(NOT_LISTENING)?;
        let string = ZeroString::into_raw(address.to_string().as_bytes());
        // SAFETY: outputs: `address_out` was checked and points to a writable pointer.
        unsafe { host::write_elements(address_out, size_of::<*mut ZeroString>(), &[string]) }
    })
}

/// Writes the global worker indexes the server claimed, one per core in core order; a
/// target attaches to one of them.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `workers_out` - receives the indexes; NULL is accepted when `cap` is 0.
/// * `cap` - how many indexes `workers_out` holds.
/// * `count_out` - receives the number of indexes, also when `cap` is too small.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Limit` when `cap` is smaller than the count, after writing `count_out`;
/// `InvalidArgument` for a NULL or misaligned output; `Closed` for an unknown server.
///
/// # Safety
///
/// `workers_out` must be NULL or point to `cap` writable octets, and `count_out` NULL or
/// a writable `uintptr_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_server_workers(
    server: u64,
    workers_out: *mut u8,
    cap: usize,
    count_out: *mut usize,
) -> ZeroStatus {
    guard(|| {
        host::check_out(count_out)?;
        if cap > 0 {
            host::check_out(workers_out)?;
        }
        let server = crate::abi::server::server(server)?;
        let workers = server.workers();
        let count = workers.len();
        let fits = count <= cap;
        if fits && count > 0 {
            // SAFETY: outputs: `workers_out` was checked and holds `cap` writable octets,
            // at least `count`.
            unsafe { host::write_elements(workers_out, 1, workers) }?;
        }
        // SAFETY: outputs: `count_out` was checked and points to a writable `uintptr_t`.
        unsafe { host::write_elements(count_out, size_of::<usize>(), &[count]) }?;
        if fits {
            Ok(())
        } else {
            Err(SHORT_CAP)
        }
    })
}

/// Requests the drain and returns at once: the cores stop accepting, finish their
/// in-flight requests within the drain deadline, and the server stops. A server that
/// never started stops now.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `drain_ms` - the longest the drain may take: `ZERO_NONE`, or at least the server's
///   `drainMs` option, which is the deadline the cores apply.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Unsupported` for a drain shorter than the server's `drainMs` option, which this
/// version cannot apply; `Closed` for an unknown server.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_server_shutdown(server: u64, drain_ms: u64) -> ZeroStatus {
    guard(|| {
        let record = SERVERS.get(server)?;
        if wait_for(drain_ms).is_some_and(|drain| drain < record.drain) {
            return Err(SHORT_DRAIN);
        }
        record.server.shutdown();
        Ok(())
    })
}

/// Blocks until the server stopped.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `timeout_ms` - the longest wait in milliseconds; `ZERO_NONE` waits as long as it
///   takes.
///
/// # Returns
///
/// `ZeroStatus_Ok` once the server stopped, or a refusal.
///
/// # Errors
///
/// `Timeout` when the server is still running when the timeout passes;
/// `InvalidArgument` on an I/O worker thread and, until a stop began, on a thread bound
/// to one of the server's targets, since the drain needs that thread's
/// acknowledgments; `Closed` for an unknown server.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_server_wait(server: u64, timeout_ms: u64) -> ZeroStatus {
    guard(|| {
        crate::abi::server::server(server)?
            .wait(wait_for(timeout_ms))
            .map_err(Fail::from)
    })
}

/// Writes a server's statistics, summed over its worker indexes; once it stopped, those
/// it had when it gave its indexes back.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `stats_out` - receives the statistics; its `size` is set before the call.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a NULL or misaligned `stats_out` or a `size` below the version 1
/// size; `Closed` for an unknown server.
///
/// # Safety
///
/// `stats_out` must be NULL or point to a writable struct of at least its `size` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_server_stats(server: u64, stats_out: *mut ZeroStats) -> ZeroStatus {
    guard(|| {
        // SAFETY: sized structs: `stats_out` is NULL or a writable struct whose size the
        // host set.
        let written = unsafe { host::out_size(stats_out) }?;
        let stats = ZeroStats::of(crate::abi::server::server(server)?.stats());
        // SAFETY: sized structs: `written` came from `out_size` for this `stats_out`.
        unsafe { host::write_sized(stats_out, written, stats) }
    })
}

/// Releases a server's id once the server is not running. A server that never started
/// gives its worker indexes back.
///
/// # Arguments
///
/// * `server` - the server's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Limit` while the server runs, its drain included; `Closed` for an unknown or freed
/// server.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_server_free(server: u64) -> ZeroStatus {
    guard(|| {
        let record = SERVERS.remove_if(server, |record| {
            if record.server.is_running() {
                Err(RUNNING)
            } else {
                Ok(())
            }
        })?;
        drop(record);
        Ok(())
    })
}
