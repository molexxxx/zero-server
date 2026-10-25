//! Post-completion actions: work a host asks for in its response that runs on the
//! core once the response is back, because it needs the connection.
//!
//! A host records at most one action, which seals the response:
//!
//! - [`file`](fn@file) serves a file from a root directory. The field lines the host set stay
//!   in the response, so a `Content-Disposition` the host set for a download reaches
//!   the client, but for the fields the file answer writes about the file
//!   (`Content-Type`, `ETag`, `Last-Modified`, `Accept-Ranges` and `Content-Range`),
//!   which replace the host's, so the response carries one line of each (RFC 9110
//!   Section 5.3). The status the host set stays too, unless the file answer sets
//!   one (206, 304, 412, 416 or a refusal): with none or 200 the request's
//!   preconditions and `Range` apply, with another 2xx its preconditions alone, and
//!   with any other status neither, the file then going out as that status's
//!   content without validators (Sections 13.2.1 and 14.2). The core keeps the
//!   [`FILE_ROOTS_KEPT`] roots it served most recently, each with its own cache of
//!   small files of at most [`FILE_CACHE_BUDGET`] octets, resolves a kept root again
//!   on every action so a root reached through a symbolic link follows the link,
//!   and drops the least recently used root with its cache. A path the root does
//!   not serve, or a root that does not exist, is answered 404; a method other than
//!   GET and HEAD is answered 405 with `Allow: GET, HEAD`; each refusal carries the
//!   server's error body.
//! - [`sse_open`] opens a server-sent event stream with the status and fields the
//!   host set; [`ws_accept`] accepts a WebSocket route's upgrade request. Each
//!   returns the connection's id at once, and what the host sends on it before the
//!   response head is written waits in its outbox ([`realtime`](crate::realtime)).
//!
//! These calls take the exchange the caller holds under the slot's lock; the
//! calls a binding makes by slot id wrap them.

use zero_http::{Action, Exchange};
#[cfg(any(feature = "static", feature = "realtime"))]
use zero_http::{Call, ErrorShape, Problem};
#[cfg(any(feature = "static", feature = "realtime"))]
use zero_http_types::{HeaderName, StatusCode};

#[cfg(feature = "realtime")]
use crate::realtime::conns::{self, Kind, Table};
use crate::HostError;

/// How many roots a core keeps for file actions; the least recently used is dropped
/// with its cache past this.
pub const FILE_ROOTS_KEPT: usize = 16;

/// The cache of small files each kept root holds, in octets.
pub const FILE_CACHE_BUDGET: usize = 512 * 1024;

/// The code of the answer to a forbidden target.
#[cfg(any(feature = "static", feature = "realtime"))]
pub(crate) const FORBIDDEN: &str = "forbidden";

/// Serve a file as the response once the host completes it, under the status the
/// host set, as the module documentation describes.
///
/// # Arguments
///
/// * `exchange` - the exchange of a leased slot, under its lock.
/// * `root` - the root directory, UTF-8; it is resolved when the action runs, and a
///   root that does not exist then answers 404.
/// * `path` - the path of the file under the root, written as a request path is
///   (percent-encoded); every segment goes through the static file policy.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for an empty root or
/// one that is not UTF-8, [`Status::Closed`](crate::Status::Closed) for a sealed
/// response, and [`Status::Unsupported`](crate::Status::Unsupported) when the
/// `static` capability is compiled out. Nothing changes then.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
pub fn file(exchange: &mut Exchange, root: &[u8], path: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "static")]
    {
        if exchange.sealed() {
            return Err(sealed());
        }
        if root.is_empty() || std::str::from_utf8(root).is_err() {
            return Err(HostError::invalid(
                "a file action's root is a non-empty UTF-8 path",
            ));
        }
        exchange
            .set_action(Action::File {
                root: root.to_vec(),
                path: path.to_vec(),
            })
            .map_err(|_| sealed())
    }
    #[cfg(not(feature = "static"))]
    {
        let _ = (exchange, root, path);
        Err(HostError::unsupported(
            "file actions need the `static` capability, which this build leaves out",
        ))
    }
}

/// Answer with a server-sent event stream once the host completes the response; the
/// status and fields the host set go into the stream head.
///
/// # Arguments
///
/// * `slot` - the slot id, which names the core the stream runs on.
/// * `exchange` - that slot's exchange, under its lock; the action of an exchange
///   whose request another core serves is answered 500 when it runs.
/// * `keep_alive_ms` - the interval of the keep-alive comment written while nothing
///   else is; 0 writes none.
///
/// # Returns
///
/// The connection's id, valid at once; sends before the stream head is written wait
/// in its outbox.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a slot id above
/// 2^53 - 1 or a HEAD request, whose response carries no body;
/// [`Status::Closed`](crate::Status::Closed) for a sealed response or a lease that
/// ended while the connection was reserved;
/// [`Status::Limit`](crate::Status::Limit) when the core holds its bound of
/// connections; [`Status::Unsupported`](crate::Status::Unsupported) when the
/// `realtime` capability is compiled out. Nothing changes then.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>
pub fn sse_open(slot: u64, exchange: &mut Exchange, keep_alive_ms: u32) -> Result<u64, HostError> {
    #[cfg(feature = "realtime")]
    {
        let slot = slot_id(slot)?;
        if exchange.sealed() {
            return Err(sealed());
        }
        if exchange.request().method() == Some(zero_http_types::Method::Head) {
            return Err(HostError::invalid(
                "a response to HEAD carries no body, so no event stream",
            ));
        }
        let table = core_table(slot)?;
        let conn = table.reserve(Kind::EventStream, exchange.route(), slot, || {
            still_leased(slot)
        })?;
        record(
            exchange,
            table,
            conn,
            Action::Sse {
                conn,
                keep_alive_ms,
            },
        )
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (slot, exchange, keep_alive_ms);
        Err(crate::realtime::unsupported())
    }
}

/// Accept a WebSocket route's upgrade request once the host completes the
/// response: `101 Switching Protocols` with the accept value and the chosen
/// subprotocol. A host that declines answers with an error status of its own
/// instead, and no upgrade happens.
///
/// # Arguments
///
/// * `slot` - the slot id, which names the core the connection runs on.
/// * `exchange` - that slot's exchange, under its lock; the action of an exchange
///   whose request another core serves is answered 500 when it runs.
/// * `protocol` - the subprotocol: one the client offered in
///   `Sec-WebSocket-Protocol` and the route allows (any it offered when the route
///   lists none), since "The value chosen MUST be derived from the client's
///   handshake" (RFC 6455 Section 4.2.2); empty for none, which sends no
///   `Sec-WebSocket-Protocol`.
///
/// # Returns
///
/// The connection's id, valid at once; sends before the `101` is written wait in its
/// outbox, and the host learns the connection opened from its open event.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a slot id above
/// 2^53 - 1, a request that is not a WebSocket route's, or a protocol the client did
/// not offer or the route does not allow; [`Status::Closed`](crate::Status::Closed)
/// for a sealed response or a lease that ended while the connection was reserved;
/// [`Status::Limit`](crate::Status::Limit) when the core
/// holds its bound of connections; [`Status::Unsupported`](crate::Status::Unsupported)
/// when the `realtime` capability is compiled out. Nothing changes then.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
pub fn ws_accept(slot: u64, exchange: &mut Exchange, protocol: &[u8]) -> Result<u64, HostError> {
    #[cfg(feature = "realtime")]
    {
        let slot = slot_id(slot)?;
        if exchange.sealed() {
            return Err(sealed());
        }
        let table = core_table(slot)?;
        let routes = table
            .routes()
            .ok_or_else(|| HostError::closed("no server holds the slot's worker"))?;
        let route = exchange.route();
        let allowed = routes.protocols(route).ok_or_else(|| {
            HostError::invalid(format!(
                "route {route} is not a WebSocket route, whose upgrade requests alone are accepted"
            ))
        })?;
        if !protocol.is_empty() {
            if !offered(exchange, protocol) {
                return Err(HostError::invalid(format!(
                    "the client did not offer the subprotocol {:?}",
                    String::from_utf8_lossy(protocol)
                )));
            }
            if !allowed.is_empty() && !allowed.iter().any(|kept| kept.as_ref() == protocol) {
                return Err(HostError::invalid(format!(
                    "route {route} does not allow the subprotocol {:?}",
                    String::from_utf8_lossy(protocol)
                )));
            }
        }
        let conn = table.reserve(Kind::WebSocket, route, slot, || still_leased(slot))?;
        record(
            exchange,
            table,
            conn,
            Action::Ws {
                conn,
                protocol: protocol.to_vec(),
            },
        )
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (slot, exchange, protocol);
        Err(crate::realtime::unsupported())
    }
}

#[cfg(any(feature = "static", feature = "realtime"))]
fn sealed() -> HostError {
    HostError::closed("the response is sealed")
}

#[cfg(feature = "realtime")]
fn slot_id(raw: u64) -> Result<zero_core::SlotId, HostError> {
    if raw > zero_core::slot::MAX_ENCODED {
        return Err(HostError::invalid(format!(
            "the slot id {raw} is out of range"
        )));
    }
    zero_core::SlotId::from_raw(raw)
        .ok_or_else(|| HostError::invalid(format!("the slot id {raw} is out of range")))
}

/// Whether `slot` is still leased at its generation, checked again once its
/// connection's entry is open: a caller's own check may predate a stop of the server
/// and the start of the next one on the index.
#[cfg(feature = "realtime")]
fn still_leased(slot: zero_core::SlotId) -> bool {
    crate::registry::slot(slot.as_u64()).is_ok_and(|(_, id, found)| {
        found
            .word()
            .check(id.generation(), &[zero_rt::SlotState::Leased])
            .is_ok()
    })
}

/// The connection table of the worker index a slot belongs to.
#[cfg(feature = "realtime")]
fn core_table(slot: zero_core::SlotId) -> Result<&'static Table, HostError> {
    conns::table(slot.worker())
        .ok_or_else(|| HostError::closed(format!("worker {} is unknown", slot.worker())))
}

/// Record an action that set up connection `conn`, which closes again if the
/// response cannot take it.
#[cfg(feature = "realtime")]
fn record(
    exchange: &mut Exchange,
    table: &Table,
    conn: u64,
    action: Action,
) -> Result<u64, HostError> {
    if exchange.set_action(action).is_ok() {
        return Ok(conn);
    }
    if let Ok(id) = conns::parse(conn) {
        table.close(id);
    }
    Err(sealed())
}

/// Whether a request's `Sec-WebSocket-Protocol` fields list `protocol`, compared as
/// the handshake compares them.
#[cfg(feature = "realtime")]
fn offered(exchange: &Exchange, protocol: &[u8]) -> bool {
    exchange
        .request()
        .headers()
        .filter(|(name, _)| name.eq_ignore_ascii_case(b"sec-websocket-protocol"))
        .flat_map(|(_, value)| value.split(|&byte| byte == b','))
        .any(|element| element.trim_ascii() == protocol)
}

/// Run the action a host recorded, once its response is back; a response with no
/// action is sent as it is.
///
/// # Errors
///
/// The error of a response writer, answered from the error registry.
pub(crate) fn apply(
    core: &crate::handler::CoreHost,
    call: &mut zero_http::Call<'_>,
    route: u32,
    action: Action,
) -> Result<(), zero_core::Error> {
    match action {
        Action::None => Ok(()),
        #[cfg(feature = "static")]
        Action::File { root, path } => serve_file(core, call, &root, &path),
        #[cfg(not(feature = "static"))]
        Action::File { .. } => unsupported(core, call),
        #[cfg(feature = "realtime")]
        Action::Sse {
            conn,
            keep_alive_ms,
        } => crate::realtime::open_event_stream(core, call, conn, keep_alive_ms),
        #[cfg(feature = "realtime")]
        Action::Ws { conn, protocol } => {
            crate::realtime::open_websocket(core, call, route, conn, &protocol)
        }
        #[cfg(not(feature = "realtime"))]
        Action::Sse { .. } | Action::Ws { .. } => {
            let _ = route;
            unsupported(core, call)
        }
    }
}

/// Answer an action whose capability is compiled out with 501.
#[cfg(not(all(feature = "static", feature = "realtime")))]
fn unsupported(
    core: &crate::handler::CoreHost,
    call: &mut zero_http::Call<'_>,
) -> Result<(), zero_core::Error> {
    call.problem(&zero_http::Problem::new(
        zero_http_types::StatusCode::NOT_IMPLEMENTED,
        "unsupported",
    ));
    core.settings().rules.after(call);
    Ok(())
}

/// The fields a file answer writes about the file, which replace any line of them
/// the host set, so the response carries one of each (RFC 9110 Section 5.3).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
#[cfg(feature = "static")]
const FILE_FIELDS: [HeaderName; 5] = [
    HeaderName::ContentType,
    HeaderName::ETag,
    HeaderName::LastModified,
    HeaderName::AcceptRanges,
    HeaderName::ContentRange,
];

/// Serve a file action: the file is the body, under the status and beside the
/// fields the host set, but for the fields the file answer writes itself; a path
/// the root does not serve, or a root that does not exist, is a 404.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2>
#[cfg(feature = "static")]
fn serve_file(
    core: &crate::handler::CoreHost,
    call: &mut Call<'_>,
    root: &[u8],
    path: &[u8],
) -> Result<(), zero_core::Error> {
    {
        let mut response = call.response();
        response.body_mut().clear();
        for name in FILE_FIELDS {
            response.remove_header(name.as_bytes());
        }
    }
    let served = match core.file_roots.try_borrow_mut() {
        Ok(mut roots) => match roots.get(root) {
            Some(files) => files.try_serve_path_keeping_status(call, path)?,
            None => zero_static::Served::Miss,
        },
        Err(_) => zero_static::Served::Miss,
    };
    if served == zero_static::Served::Miss {
        call.response().status(StatusCode::NOT_FOUND);
    }
    refusal_body(call, core.settings().shape);
    Ok(())
}

/// Give a client error answered without content the server's error body: the
/// status and the field lines already written stay, `Allow` on a 405 included, and
/// the body states the status in the server's shape. RFC 9110 Section 15.5.4 lets a
/// server that refuses a target "describe that reason in the response content".
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4>
/// @see <https://www.rfc-editor.org/rfc/rfc9457.html#section-3>
#[cfg(any(feature = "static", feature = "realtime"))]
pub(crate) fn refusal_body(call: &mut Call<'_>, shape: ErrorShape) {
    let mut response = call.response();
    let Some(status) = response.current_status() else {
        return;
    };
    if !status.is_client_error() || response.body_len() != 0 {
        return;
    }
    if response
        .set_header_id(HeaderName::ContentType, shape.media_type())
        .is_err()
    {
        return;
    }
    Problem::new(status, refusal_code(status)).write_body(shape, response.body_mut());
}

/// The code of a client error a layer answered without content.
#[cfg(any(feature = "static", feature = "realtime"))]
fn refusal_code(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "protocol",
        403 => FORBIDDEN,
        404 => "not_found",
        405 => "method_not_allowed",
        412 => "precondition_failed",
        416 => "range_not_satisfiable",
        426 => "upgrade_required",
        _ => "client_error",
    }
}

/// The roots a core serves file actions from, the most recently used last.
#[cfg(feature = "static")]
#[derive(Debug, Default)]
pub(crate) struct FileRoots {
    kept: std::collections::VecDeque<(Vec<u8>, zero_static::Files)>,
}

#[cfg(feature = "static")]
impl FileRoots {
    /// The files of `root`, kept from an earlier action or built now; building the
    /// root's files drops the least recently used root once [`FILE_ROOTS_KEPT`] are
    /// kept. A kept root is resolved again first, and built again with an empty
    /// cache when it resolves elsewhere now, as a root reached through a symbolic
    /// link that was moved does.
    ///
    /// # Returns
    ///
    /// The files, or `None` for a root that cannot be opened, which is no longer
    /// kept.
    pub(crate) fn get(&mut self, root: &[u8]) -> Option<&zero_static::Files> {
        let path = std::str::from_utf8(root).ok()?;
        let kept = self
            .kept
            .iter()
            .position(|(kept, _)| kept.as_slice() == root)
            .and_then(|position| self.kept.remove(position));
        let resolved = std::fs::canonicalize(path).ok()?;
        match kept {
            Some(used) if used.1.canonical_root() == resolved => self.kept.push_back(used),
            _ => {
                let options = zero_static::Options {
                    cache_budget: FILE_CACHE_BUDGET,
                    ..zero_static::Options::default()
                };
                let files = zero_static::Files::new(path, options).ok()?;
                while self.kept.len() >= FILE_ROOTS_KEPT {
                    self.kept.pop_front();
                }
                self.kept.push_back((root.to_vec(), files));
            }
        }
        self.kept.back().map(|(_, files)| files)
    }

    /// The roots kept, the least recently used first.
    #[cfg(test)]
    fn roots(&self) -> Vec<&[u8]> {
        self.kept.iter().map(|(root, _)| root.as_slice()).collect()
    }
}

#[cfg(all(test, not(feature = "static")))]
mod unsupported_tests {
    use zero_http::Exchange;

    use crate::Status;

    #[test]
    fn a_file_action_answers_unsupported_without_the_static_capability() {
        let mut exchange = Exchange::default();
        assert_eq!(
            super::file(&mut exchange, b"/srv", b"/a.txt")
                .unwrap_err()
                .status(),
            Status::Unsupported
        );
        assert!(!exchange.sealed(), "a refused action records nothing");
    }
}

#[cfg(all(test, feature = "static"))]
mod tests {
    use super::{FileRoots, FILE_ROOTS_KEPT};

    #[test]
    fn a_core_keeps_the_most_recently_used_file_roots_and_drops_the_least_recently_used() {
        let base = std::env::temp_dir().join(format!("zero-host-roots-{}", std::process::id()));
        let roots: Vec<Vec<u8>> = (0..=FILE_ROOTS_KEPT + 1)
            .map(|index| {
                let root = base.join(index.to_string());
                std::fs::create_dir_all(&root).unwrap();
                root.to_str().unwrap().as_bytes().to_vec()
            })
            .collect();
        let mut kept = FileRoots::default();
        for root in roots.iter().take(FILE_ROOTS_KEPT) {
            assert!(kept.get(root).is_some());
        }
        assert_eq!(kept.roots().len(), FILE_ROOTS_KEPT);
        assert!(kept.get(&roots[0]).is_some(), "a kept root is used again");
        assert!(kept.get(&roots[FILE_ROOTS_KEPT]).is_some());
        let now = kept.roots();
        assert_eq!(now.len(), FILE_ROOTS_KEPT, "one root more drops one");
        assert!(
            !now.contains(&roots[1].as_slice()),
            "the least recently used root is dropped"
        );
        assert!(
            now.contains(&roots[0].as_slice()),
            "the one used again stays"
        );
        assert_eq!(now.last(), Some(&roots[FILE_ROOTS_KEPT].as_slice()));
        let missing = base.join("missing");
        assert!(kept.get(missing.to_str().unwrap().as_bytes()).is_none());
        assert_eq!(
            kept.roots().len(),
            FILE_ROOTS_KEPT,
            "a root that cannot open is not kept"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
