//! The request and response views a handler works with.
//!
//! [`Call`] wraps the request record for the handler's duration: the request side
//! reads the parsed head, the fields, the buffered body and the route match; the
//! response side takes the status, validated field lines and the body. The driver
//! owns framing (`Content-Length`, `Connection`, `Transfer-Encoding`) and the `Date`
//! field ([`DRIVER_FIELDS`]), so a handler cannot set those; every other name must
//! be a `token` and every value a `field-value` (RFC 9110 Section 5.5), checked once
//! here, so no handler can inject a line break into the response framing (response
//! splitting, RFC 9112 Section 11.1). [`Call::route`] resolves the request against a
//! `zero-router` table, after [`target_route`] answers `OPTIONS *` itself, and
//! answers the misses itself: 404, 405 with `Allow`, 501, the automatic OPTIONS, and
//! 400 for a target that is not a path. [`Call::route_or_miss`] sends those misses
//! to a route of the caller's instead, with the status and `Allow` set the core
//! would have answered.
//!
//! A request can also be handed to a host on another thread: [`Call::export`] moves
//! it into an [`Exchange`] and [`Call::import`] moves the host's response back, and
//! [`Call::hold_reads`] stops reading the connection while such work is queued.

use std::cell::Cell;
use std::fmt;
use std::net::SocketAddr;
use std::ops::Range;
use std::rc::Rc;
use std::task::Waker;

use zero_core::Error;
use zero_http1::{Field, Head, TargetForm, Version};
use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::rt::Core;
use zero_router::{Allow, Resolution, Router};
use zero_rt::Worker;
use zero_uri::{percent_decode, split_query};

use crate::error::{ErrorShape, Problem};
use crate::exchange::{Exchange, ExportOptions, HostField, HostSpan, PublishedView, ResponseBody};
use crate::record::Record;
use crate::takeover::{Claim, TakeOver};

/// The field names the driver writes on a response itself, so no handler or host
/// may set them: the framing fields `Content-Length` and `Transfer-Encoding`, which
/// must agree with the body the driver sends (RFC 9112 Sections 6.1 to 6.3), the
/// `Connection` field that carries the `close` option the driver acts on (RFC 9110
/// Section 7.6.1, RFC 9112 Section 9.6), and `Date` (RFC 9110 Section 6.6.1). A
/// handler that set one could contradict the framing the driver writes, and a
/// message whose framing fields conflict "might indicate an attempt to perform
/// request smuggling or response splitting" (RFC 9112 Section 6.3).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-6.2>
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3>
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-11.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-6.6.1>
pub const DRIVER_FIELDS: [HeaderName; 4] = [
    HeaderName::ContentLength,
    HeaderName::Connection,
    HeaderName::TransferEncoding,
    HeaderName::Date,
];

/// Whether the driver writes a field of this name itself, the name compared without
/// regard to case, as field names are (RFC 9110 Section 5.1).
///
/// # Arguments
///
/// * `name` - the field name.
///
/// # Returns
///
/// `true` for a name of [`DRIVER_FIELDS`] in any case, and `false` for every other
/// name, a name that only starts like one included.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
#[must_use]
pub fn is_driver_field(name: &[u8]) -> bool {
    HeaderName::parse(name).is_some_and(|id| DRIVER_FIELDS.contains(&id))
}

/// How the core treats a request's target before a routing table sees it.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.7>
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRoute<'a> {
    /// Resolve this path and query against the table: the whole origin-form target,
    /// or what follows the authority of an absolute-form target, which a server must
    /// accept (RFC 9112 Section 3.2.2); empty for an authority-form target.
    Path(&'a [u8]),
    /// `OPTIONS *`, which applies to the server in general rather than to a specific
    /// resource (RFC 9110 Section 9.3.7): answered with this status, 200, and no
    /// content.
    Server(StatusCode),
    /// An asterisk-form target with any other method, which names no resource:
    /// answered with this status, 400.
    NotAPath(StatusCode),
}

/// Decide how the core routes a parsed request, as [`Call::route`] and
/// [`Call::route_or_miss`] do: an asterisk-form target is answered without a route,
/// and every other form routes its path and query.
///
/// # Arguments
///
/// * `head` - the parsed request head.
/// * `input` - the bytes the head was parsed from.
///
/// # Returns
///
/// The path to resolve, or the answer the core gives itself.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.7>
/// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2.4>
#[must_use]
pub fn target_route<'a>(head: &Head, input: &'a [u8]) -> TargetRoute<'a> {
    if head.form == TargetForm::Asterisk {
        return match head.method {
            Some(Method::Options) => TargetRoute::Server(StatusCode::OK),
            _ => TargetRoute::NotAPath(StatusCode::BAD_REQUEST),
        };
    }
    TargetRoute::Path(head.path.of(input))
}

/// One request and its response, for the handler's duration.
#[derive(Debug)]
pub struct Call<'a> {
    record: &'a mut Record,
    worker: &'a Worker,
    shape: ErrorShape,
    bodies: &'a Cell<u64>,
}

/// A route that matched: what to run, and whether the request is HEAD served by
/// the GET route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Routed<T> {
    /// The route's descriptor.
    pub descriptor: T,
    /// The request is HEAD: the response carries the headers GET would send and no
    /// body (RFC 9110 Section 9.3.2), which the driver enforces.
    pub head: bool,
    /// For a request [`Call::route_or_miss`] sent to the miss route, what the core
    /// would have answered; `None` for a route that matched.
    pub miss: Option<Miss>,
}

/// A request no route matched, as the core would have answered it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Miss {
    /// 404 for a path with no route, 405 for a method the path lacks, 501 for a
    /// method token the server does not implement, and 200 for OPTIONS on a path
    /// without an OPTIONS route.
    pub status: StatusCode,
    /// The methods the path supports, for the `Allow` field of a 405 or an OPTIONS
    /// answer (RFC 9110 Section 10.2.1); empty otherwise. An origin server "MUST
    /// generate an Allow header field in a 405 response" (Section 15.5.6), so a miss
    /// route that answers 405 sends this set.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6>
    pub allow: Allow,
}

impl Miss {
    /// The `Allow` set as a mask, bit `i` for the method whose id is `i`.
    ///
    /// # Returns
    ///
    /// The mask.
    #[must_use]
    pub fn allow_mask(self) -> u16 {
        self.allow.iter().fold(0u16, |mask, method| {
            mask | 1u16.checked_shl(u32::from(method.id())).unwrap_or(0)
        })
    }
}

/// What a resolution leaves to do, computed while the record is borrowed in parts.
enum Outcome<T> {
    Run(T, bool),
    Miss(T, Miss),
    Problem(Problem),
    /// An answer with `Allow`: the 405 problem, or `200` with no content when
    /// there is no problem.
    Allowed(Allow, Option<Problem>),
    Empty(StatusCode),
}

/// The kinds of resolution the core answers itself.
#[derive(Clone, Copy)]
enum Missed {
    NotFound,
    MethodNotAllowed(Allow),
    Options(Allow),
    NotImplemented,
}

impl Missed {
    fn miss(self) -> Miss {
        match self {
            Missed::NotFound => Miss {
                status: StatusCode::NOT_FOUND,
                allow: Allow::default(),
            },
            Missed::MethodNotAllowed(allow) => Miss {
                status: StatusCode::METHOD_NOT_ALLOWED,
                allow,
            },
            Missed::Options(allow) => Miss {
                status: StatusCode::OK,
                allow,
            },
            Missed::NotImplemented => Miss {
                status: StatusCode::NOT_IMPLEMENTED,
                allow: Allow::default(),
            },
        }
    }

    /// The core's own answer.
    fn answer<T>(self) -> Outcome<T> {
        match self {
            Missed::NotFound => Outcome::Problem(Problem::new(StatusCode::NOT_FOUND, "not_found")),
            Missed::MethodNotAllowed(allow) => Outcome::Allowed(
                allow,
                Some(Problem::new(
                    StatusCode::METHOD_NOT_ALLOWED,
                    "method_not_allowed",
                )),
            ),
            Missed::Options(allow) => Outcome::Allowed(allow, None),
            Missed::NotImplemented => {
                Outcome::Problem(Problem::new(StatusCode::NOT_IMPLEMENTED, "not_implemented"))
            }
        }
    }
}

impl<'a> Call<'a> {
    pub(crate) fn new(
        record: &'a mut Record,
        worker: &'a Worker,
        shape: ErrorShape,
        bodies: &'a Cell<u64>,
    ) -> Self {
        Call {
            record,
            worker,
            shape,
            bodies,
        }
    }

    /// The core this request runs on: its timer, date block, pool and shutdown signal.
    #[must_use]
    pub const fn core(&self) -> &Core {
        self.worker.core()
    }

    /// The worker serving this request, for detached work through
    /// [`Worker::spawn`].
    #[must_use]
    pub const fn worker(&self) -> &Worker {
        self.worker
    }

    /// Switch the connection to another protocol after this response: `101
    /// Switching Protocols` with `Upgrade: <protocol>` and the `upgrade` connection
    /// option, then [`Handler::taken`](crate::Handler::taken) serves the connection.
    ///
    /// # Arguments
    ///
    /// * `protocol` - the protocol switched to; it must be one the request's
    ///   `Upgrade` field lists, compared ASCII case-insensitively (RFC 9110 Section
    ///   7.8).
    /// * `token` - a value handed back with the connection, to tell claims apart.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] when the request did not ask to upgrade (an HTTP/1.1
    /// request with an `Upgrade` field and the `upgrade` connection option) or did
    /// not offer `protocol`; nothing is set then.
    pub fn upgrade(&mut self, protocol: &[u8], token: u64) -> Result<(), Error> {
        let asked = self.record.parsed.is_some_and(|head| head.upgrade);
        let offered = asked
            && self.request().headers().any(|(name, value)| {
                name.eq_ignore_ascii_case(b"upgrade")
                    && value
                        .split(|&byte| byte == b',')
                        .any(|element| element.trim_ascii().eq_ignore_ascii_case(protocol))
            });
        if !offered {
            return Err(Error::Protocol(format!(
                "the request did not offer to upgrade to {}",
                String::from_utf8_lossy(protocol)
            )));
        }
        self.response()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header_id(HeaderName::Upgrade, protocol)?;
        self.record.claim = Some(Claim {
            kind: TakeOver::Upgrade,
            token,
        });
        Ok(())
    }

    /// Refuse a request that must switch protocols first: `426 Upgrade Required` with
    /// `Upgrade: <protocol>` and the `upgrade` connection option, as RFC 9110
    /// Section 7.8 asks of a server that sends 426 and of any sender of `Upgrade`.
    ///
    /// # Arguments
    ///
    /// * `protocol` - the acceptable protocol, such as `websocket`.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for a protocol that is not a field value; nothing is set
    /// then.
    pub fn upgrade_required(&mut self, protocol: &[u8]) -> Result<(), Error> {
        self.response().header_id(HeaderName::Upgrade, protocol)?;
        self.response().status(StatusCode::UPGRADE_REQUIRED);
        self.record.advertise_upgrade = true;
        Ok(())
    }

    /// Stream the response body: the head goes out without `Content-Length` and with
    /// `Connection: close`, the body set so far follows it, and
    /// [`Handler::taken`](crate::Handler::taken) writes the rest until it closes the
    /// connection (RFC 9112 Section 6.3, item 8).
    ///
    /// # Arguments
    ///
    /// * `token` - a value handed back with the connection, to tell claims apart.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] for a HEAD request, whose response carries no body.
    pub fn stream(&mut self, token: u64) -> Result<(), Error> {
        if self.record.head_request() {
            return Err(Error::Protocol(
                "a response to HEAD carries no body to stream".to_owned(),
            ));
        }
        self.record.claim = Some(Claim {
            kind: TakeOver::Stream,
            token,
        });
        Ok(())
    }

    /// The request side.
    #[must_use]
    pub fn request(&self) -> Request<'_> {
        Request::of(self.record)
    }

    /// The response side.
    #[must_use]
    pub fn response(&mut self) -> Response<'_> {
        Response::of(self.record)
    }

    /// Both sides at once, for a handler that reads the request while it writes the
    /// response.
    #[must_use]
    pub fn parts(&mut self) -> (Request<'_>, Response<'_>) {
        let Record {
            head,
            fields,
            parsed,
            body,
            trailers,
            peer,
            secure,
            route_path,
            params,
            param_count,
            status,
            response_fields,
            response_body,
            touched,
            ..
        } = &mut *self.record;
        let count = parsed.map_or(0, |head| head.field_count);
        (
            Request {
                head,
                fields: FieldTable::Parsed(fields.get(..count).unwrap_or(&[])),
                parsed: *parsed,
                body,
                trailers,
                peer: *peer,
                secure: *secure,
                route_path,
                params: params.get(..*param_count).unwrap_or(&[]),
            },
            Response {
                status,
                fields: response_fields,
                body: response_body,
                touched,
            },
        )
    }

    /// Replace whatever the response holds with a problem, in the body shape the
    /// handler's [`error_shape`](crate::Handler::error_shape) names.
    ///
    /// # Arguments
    ///
    /// * `problem` - the status, the registry code and the detail.
    pub fn problem(&mut self, problem: &Problem) {
        self.record.problem(problem, self.shape);
    }

    /// Resolve the request against a router.
    ///
    /// # Arguments
    ///
    /// * `router` - the routing table.
    ///
    /// # Returns
    ///
    /// The route to run, with its parameters readable through
    /// [`Request::param`]; or `None` when the call was answered here: 404 for a
    /// path with no route, 405 with `Allow` for a method the path lacks, 501 for a
    /// method token the server does not implement, 200 with `Allow` and no content
    /// for OPTIONS on a path without an OPTIONS route, 200 with no content for
    /// `OPTIONS *`, and 400 for a target whose path is not a path. The 404, 405 and
    /// 501 bodies take the handler's [`error_shape`](crate::Handler::error_shape).
    pub fn route<T: Copy>(&mut self, router: &Router<T>) -> Option<Routed<T>> {
        self.resolve(router, None)
    }

    /// Resolve the request against a router, sending what [`route`](Self::route)
    /// would answer as a miss (404, 405, 501, and OPTIONS on a path without an
    /// OPTIONS route) to `miss` instead.
    ///
    /// # Arguments
    ///
    /// * `router` - the routing table.
    /// * `miss` - the route unmatched requests go to; `None` answers them as
    ///   [`route`](Self::route) does.
    ///
    /// # Returns
    ///
    /// The route to run; for a miss, `miss` with [`Routed::miss`] holding the status
    /// and `Allow` set the core would have answered, and the normalized path in
    /// [`Request::route_path`]. `None` when the call was answered here, as for
    /// [`route`](Self::route): `OPTIONS *` and a target that is not a path.
    pub fn route_or_miss<T: Copy>(
        &mut self,
        router: &Router<T>,
        miss: Option<T>,
    ) -> Option<Routed<T>> {
        self.resolve(router, miss)
    }

    /// Mark a request a route matched as a miss, for a route that declines it and
    /// hands it to the miss route, such as a static route whose root does not hold
    /// the path: as for a request [`route_or_miss`](Self::route_or_miss) sends to the
    /// miss route, the route's parameters are dropped, the normalized path stays in
    /// [`Request::route_path`], and an [`export`](Self::export) carries `miss`
    /// ([`Exchange::miss`]) and publishes its status and `Allow` mask. The mark lasts
    /// until the next resolution or the end of the request.
    ///
    /// # Arguments
    ///
    /// * `miss` - what the route would have answered: the status, and for a 405 the
    ///   methods the target supports.
    pub fn mark_miss(&mut self, miss: Miss) {
        self.record.miss = Some(miss);
        self.record.param_count = 0;
    }

    fn resolve<T: Copy>(&mut self, router: &Router<T>, miss: Option<T>) -> Option<Routed<T>> {
        self.record.miss = None;
        let outcome = {
            let Record {
                head,
                parsed,
                scratch,
                route_path,
                params,
                param_count,
                ..
            } = &mut *self.record;
            let Some(parsed) = parsed else {
                return None;
            };
            let token = parsed.method_token.of(head);
            match target_route(parsed, head) {
                TargetRoute::Server(status) => Some(Outcome::Empty(status)),
                TargetRoute::NotAPath(_) => Some(Outcome::Problem(Problem::new(
                    StatusCode::BAD_REQUEST,
                    "target",
                ))),
                TargetRoute::Path(target) => match router.resolve_target(token, target, scratch) {
                    Ok(resolved) => {
                        let missed = match resolved.resolution {
                            Resolution::Matched {
                                descriptor,
                                params: found,
                                head: is_head,
                            } => {
                                route_path.clear();
                                route_path.extend_from_slice(resolved.path);
                                *param_count = 0;
                                for (slot, (_, range)) in params.iter_mut().zip(found.iter()) {
                                    *slot = HostSpan::from_offsets(range.start, range.end);
                                    *param_count = param_count.saturating_add(1);
                                }
                                return self.routed(Outcome::Run(descriptor, is_head));
                            }
                            Resolution::NotFound => Missed::NotFound,
                            Resolution::MethodNotAllowed { allow } => {
                                Missed::MethodNotAllowed(allow)
                            }
                            Resolution::Options { allow } => Missed::Options(allow),
                            Resolution::NotImplemented => Missed::NotImplemented,
                        };
                        Some(match miss {
                            Some(descriptor) => {
                                route_path.clear();
                                route_path.extend_from_slice(resolved.path);
                                *param_count = 0;
                                Outcome::Miss(descriptor, missed.miss())
                            }
                            None => missed.answer(),
                        })
                    }
                    Err(error) => Some(Outcome::Problem(Problem {
                        detail: Some(error.to_string()),
                        ..Problem::new(StatusCode::BAD_REQUEST, "uri")
                    })),
                },
            }
        };
        self.routed(outcome?)
    }

    /// Apply a resolution: hand back the route to run, or write the core's answer.
    fn routed<T>(&mut self, outcome: Outcome<T>) -> Option<Routed<T>> {
        match outcome {
            Outcome::Run(descriptor, head) => Some(Routed {
                descriptor,
                head,
                miss: None,
            }),
            Outcome::Miss(descriptor, miss) => {
                self.record.miss = Some(miss);
                Some(Routed {
                    descriptor,
                    head: false,
                    miss: Some(miss),
                })
            }
            Outcome::Problem(problem) => {
                self.record.problem(&problem, self.shape);
                None
            }
            Outcome::Allowed(allow, problem) => {
                if let Some(problem) = problem {
                    self.record.problem(&problem, self.shape);
                } else {
                    self.record.clear_response();
                    self.record.status = Some(StatusCode::OK);
                }
                self.record.response_fields.extend_from_slice(b"Allow: ");
                allow.write(&mut self.record.response_fields);
                self.record.response_fields.extend_from_slice(b"\r\n");
                None
            }
            Outcome::Empty(status) => {
                self.record.clear_response();
                self.record.status = Some(status);
                None
            }
        }
    }

    /// Move what a host may read into an exchange and publish its view.
    ///
    /// The head, the body, the trailers and the route path move by buffer swaps (the
    /// record receives the exchange's cleared buffers), the field table and the
    /// parameters are copied, and the body's charge on the core's request-memory
    /// budget moves to the exchange ([`Exchange::counted`]), which the handler then
    /// reports through [`leased_bytes`](crate::Handler::leased_bytes). The record
    /// keeps its parsed head and framing, so the driver still serializes the
    /// response for this request's method, version and connection; its own head
    /// bytes are gone until [`import`](Self::import) brings them back for an action.
    ///
    /// # Arguments
    ///
    /// * `into` - an exchange whose request side is empty, as after a reset.
    /// * `view` - the view published over it, stored with release ordering.
    /// * `route` - the route id the host dispatches on.
    /// * `head` - whether the request is HEAD served by the GET route.
    /// * `options` - the trailer allow list and the trust-proxy rule.
    pub fn export(
        &mut self,
        into: &mut Exchange,
        view: &PublishedView,
        route: u32,
        head: bool,
        options: &ExportOptions,
    ) {
        let moved = into.take_request(self.record, route, head, options);
        self.bodies.set(self.bodies.get().saturating_sub(moved));
        view.publish(into);
    }

    /// Move the host's response back; the driver serializes it as any handler's.
    ///
    /// The status replaces the record's when the host set one, the host's field lines
    /// follow any the record already held, and the body replaces the record's; the
    /// response octets the exchange counted through [`Exchange::count`] leave
    /// [`Exchange::counted`] with them, and this call returns them so the caller
    /// takes them off the budget it added them to. The request body's charge stays
    /// on the exchange until [`Exchange::release`].
    /// When the exchange holds an [`Action`](crate::Action), the head and the route
    /// path are copied back, so the action reads the request through this call.
    ///
    /// # Arguments
    ///
    /// * `from` - the exchange the request was exported into.
    /// * `after` - runs once the response is back, with the exchange's request and
    ///   the record's response, to add the fields of the policies that read the
    ///   request (CORS, security headers, the request id).
    ///
    /// # Returns
    ///
    /// The response octets the exchange had counted, which no longer count on it.
    pub fn import(
        &mut self,
        from: &mut Exchange,
        after: impl FnOnce(Request<'_>, &mut Response<'_>),
    ) -> u64 {
        let moved = from.give_response(self.record);
        after(from.request(), &mut Response::of(self.record));
        from.restore_head(self.record);
        moved
    }

    /// End the connection with this response: the response carries the `close`
    /// connection option, the requests pipelined behind it are dropped unanswered,
    /// and the connection closes once the response is written, as RFC 9112 Section
    /// 9.6 requires of a server that sends `close`. A handler uses it for a final
    /// answer, such as the one it gives while the server drains; `Connection` is a
    /// field the driver writes itself, so a handler cannot set the option directly.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-9.6>
    pub fn close_after_response(&mut self) {
        self.record.close = true;
    }

    /// Stop reading this connection until the hold drops: no further bytes are read
    /// from the socket and no further request is parsed from what was already read.
    /// Requests already parsed still run and their responses are written. The
    /// header read timeout and the body idle timeout do not run while the
    /// connection is held and start over when reading resumes, since the server, not
    /// the client, is the one waiting.
    ///
    /// # Returns
    ///
    /// The hold; holds stack, and reading resumes when the last one drops.
    #[must_use]
    pub fn hold_reads(&self) -> ReadHold {
        let cell = self.record.hold.clone();
        if let Some(cell) = &cell {
            cell.count.set(cell.count.get().saturating_add(1));
        }
        ReadHold { cell }
    }
}

/// What the connection keeps for the holds its requests take.
#[derive(Default)]
pub(crate) struct HoldCell {
    count: Cell<u32>,
    waker: Cell<Option<Waker>>,
}

impl fmt::Debug for HoldCell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HoldCell")
            .field("count", &self.count.get())
            .finish_non_exhaustive()
    }
}

impl HoldCell {
    /// Whether a hold is in place.
    pub(crate) fn held(&self) -> bool {
        self.count.get() > 0
    }

    /// Wake `waker` when the last hold drops.
    pub(crate) fn wake_on_release(&self, waker: &Waker) {
        let current = self.waker.take();
        self.waker.set(Some(match current {
            Some(stored) if stored.will_wake(waker) => stored,
            _ => waker.clone(),
        }));
    }
}

/// A hold on a connection's reads from [`Call::hold_reads`]; reading resumes when
/// the last hold drops. It stays on the connection's core.
pub struct ReadHold {
    cell: Option<Rc<HoldCell>>,
}

impl fmt::Debug for ReadHold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReadHold").finish_non_exhaustive()
    }
}

impl Drop for ReadHold {
    fn drop(&mut self) {
        let Some(cell) = self.cell.take() else {
            return;
        };
        let count = cell.count.get().saturating_sub(1);
        cell.count.set(count);
        if count == 0 {
            if let Some(waker) = cell.waker.take() {
                waker.wake();
            }
        }
    }
}

/// A field table: the parser's fields over a record's head, or an exchange's.
#[derive(Clone, Copy, Debug)]
pub(crate) enum FieldTable<'a> {
    Parsed(&'a [Field]),
    Host(&'a [HostField]),
}

impl<'a> FieldTable<'a> {
    /// The name range, the value range and the interned name of every entry.
    fn entries(
        self,
    ) -> impl Iterator<Item = (Range<usize>, Range<usize>, Option<HeaderName>)> + 'a {
        let (parsed, host) = match self {
            FieldTable::Parsed(fields) => (fields, &[][..]),
            FieldTable::Host(fields) => (&[][..], fields),
        };
        parsed
            .iter()
            .map(|field| (field.name.as_range(), field.value.as_range(), field.id))
            .chain(
                host.iter()
                    .map(|field| (field.name.range(), field.value.range(), field.header())),
            )
    }
}

/// The request as received: method, target, fields, the buffered body and the
/// route match.
#[derive(Debug)]
pub struct Request<'a> {
    pub(crate) head: &'a [u8],
    pub(crate) fields: FieldTable<'a>,
    pub(crate) parsed: Option<Head>,
    pub(crate) body: &'a [u8],
    pub(crate) trailers: &'a [u8],
    pub(crate) peer: Option<SocketAddr>,
    pub(crate) secure: bool,
    pub(crate) route_path: &'a [u8],
    pub(crate) params: &'a [HostSpan],
}

impl<'a> Request<'a> {
    pub(crate) fn of(record: &'a Record) -> Self {
        Request {
            head: &record.head,
            fields: FieldTable::Parsed(record.live_fields()),
            parsed: record.parsed,
            body: &record.body,
            trailers: &record.trailers,
            peer: record.peer,
            secure: record.secure,
            route_path: &record.route_path,
            params: record.live_params(),
        }
    }

    /// The method, when it is one of the eight RFC 9110 methods or PATCH.
    #[must_use]
    pub fn method(&self) -> Option<Method> {
        self.parsed.and_then(|head| head.method)
    }

    /// The method token as received, standardized or not.
    #[must_use]
    pub fn method_token(&self) -> &'a [u8] {
        self.parsed
            .map_or(&[][..], |head| head.method_token.of(self.head))
    }

    /// The request target as received.
    #[must_use]
    pub fn target(&self) -> &'a [u8] {
        self.parsed
            .map_or(&[][..], |head| head.target.of(self.head))
    }

    /// The path and query of the target (the whole origin-form target).
    #[must_use]
    pub fn path(&self) -> &'a [u8] {
        self.parsed.map_or(&[][..], |head| head.path.of(self.head))
    }

    /// The query, without its `?`, when the target has one (RFC 3986 Section 3.4).
    #[must_use]
    pub fn query(&self) -> Option<&'a [u8]> {
        split_query(self.path()).1
    }

    /// The normalized path the route matched; empty before [`Call::route`].
    #[must_use]
    pub fn route_path(&self) -> &'a [u8] {
        self.route_path
    }

    /// The `index`th route parameter in pattern order, as the normalized path
    /// holds it: reserved characters stay percent-encoded.
    ///
    /// # Arguments
    ///
    /// * `index` - the parameter's position in the pattern.
    #[must_use]
    pub fn param(&self, index: usize) -> Option<&'a [u8]> {
        let span = *self.params.get(index)?;
        self.route_path.get(span.range())
    }

    /// The `index`th route parameter, percent-decoded into `out`.
    ///
    /// # Arguments
    ///
    /// * `index` - the parameter's position in the pattern.
    /// * `out` - where the decoded bytes are appended.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] when the route has no such parameter; a bad
    /// percent-encoding cannot reach here, since normalization refused it.
    pub fn param_decoded(&self, index: usize, out: &mut Vec<u8>) -> Result<(), Error> {
        let raw = self
            .param(index)
            .ok_or_else(|| Error::Codec(format!("the route has no parameter {index}")))?;
        percent_decode(raw, out).map_err(Error::from)
    }

    /// Every route parameter in pattern order.
    pub fn params(&self) -> impl Iterator<Item = &'a [u8]> + '_ {
        (0..self.params.len()).filter_map(|index| self.param(index))
    }

    /// The authority: the `Host` value or the absolute-form target's host and port.
    #[must_use]
    pub fn authority(&self) -> Option<&'a [u8]> {
        self.parsed
            .and_then(|head| head.authority)
            .map(|span| span.of(self.head))
    }

    /// The protocol version.
    #[must_use]
    pub fn version(&self) -> Version {
        self.parsed.map_or(Version::Http11, |head| head.version)
    }

    /// The first field with this name, compared without regard to case.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name.
    #[must_use]
    pub fn header(&self, name: &[u8]) -> Option<&'a [u8]> {
        self.headers()
            .find(|(field, _)| field.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
    }

    /// The first field with this interned name.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned name.
    #[must_use]
    pub fn header_id(&self, name: HeaderName) -> Option<&'a [u8]> {
        let head = self.head;
        self.fields
            .entries()
            .find(|(_, _, id)| *id == Some(name))
            .map(|(_, value, _)| head.get(value).unwrap_or(&[]))
    }

    /// Every field in order, as name and value.
    pub fn headers(&self) -> impl Iterator<Item = (&'a [u8], &'a [u8])> + 'a {
        let head = self.head;
        self.fields.entries().map(move |(name, value, _)| {
            (
                head.get(name).unwrap_or(&[]),
                head.get(value).unwrap_or(&[]),
            )
        })
    }

    /// The buffered body; empty when the request had none.
    #[must_use]
    pub fn body(&self) -> &'a [u8] {
        self.body
    }

    /// The trailer section of a chunked body, as received and already validated.
    #[must_use]
    pub fn trailers(&self) -> &'a [u8] {
        self.trailers
    }

    /// The peer's address.
    #[must_use]
    pub fn peer(&self) -> Option<SocketAddr> {
        self.peer
    }

    /// Whether the request arrived over a secure connection, such as TLS, which
    /// decides for example whether `Strict-Transport-Security` may be sent.
    #[must_use]
    pub const fn is_secure(&self) -> bool {
        self.secure
    }
}

/// The response under construction: status, validated fields and the body.
#[derive(Debug)]
pub struct Response<'a> {
    pub(crate) status: &'a mut Option<StatusCode>,
    pub(crate) fields: &'a mut Vec<u8>,
    pub(crate) body: &'a mut ResponseBody,
    pub(crate) touched: &'a mut bool,
}

impl<'a> Response<'a> {
    pub(crate) fn of(record: &'a mut Record) -> Self {
        Response {
            status: &mut record.status,
            fields: &mut record.response_fields,
            body: &mut record.response_body,
            touched: &mut record.touched,
        }
    }

    /// Set the status; `200 OK` when never set.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code.
    pub fn status(&mut self, status: StatusCode) -> &mut Self {
        *self.status = Some(status);
        *self.touched = true;
        self
    }

    /// The status set so far, for a layer that completes what an earlier one wrote,
    /// such as an error body for a refusal answered without content.
    ///
    /// # Returns
    ///
    /// The status, or `None` when none was set and the response goes out as
    /// `200 OK`.
    #[must_use]
    pub fn current_status(&self) -> Option<StatusCode> {
        *self.status
    }

    /// The length of the body set so far.
    ///
    /// # Returns
    ///
    /// The octets the body holds, an external buffer's included.
    #[must_use]
    pub fn body_len(&self) -> usize {
        self.body.len()
    }

    /// Add a field line.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, an RFC 9110 `token`.
    /// * `value` - the field value, with no CR, LF or NUL and no surrounding
    ///   whitespace.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for an invalid name or value, or a name the driver reserves
    /// (`Content-Length`, `Connection`, `Transfer-Encoding`, `Date`); nothing is
    /// written then.
    pub fn header(&mut self, name: &[u8], value: &[u8]) -> Result<&mut Self, Error> {
        check_name(name)?;
        self.push_line(name, value)
    }

    /// Add a field line under an interned name.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned name.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for an invalid value or a reserved name.
    pub fn header_id(&mut self, name: HeaderName, value: &[u8]) -> Result<&mut Self, Error> {
        check_id(name)?;
        self.push_line(name.canonical().as_bytes(), value)
    }

    /// Replace every field line of a name with one line.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, an RFC 9110 `token`, compared without regard to
    ///   case.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// As [`header`](Self::header); nothing changes then.
    pub fn set_header(&mut self, name: &[u8], value: &[u8]) -> Result<&mut Self, Error> {
        check_name(name)?;
        check_value(value)?;
        remove_lines(self.fields, name);
        self.push_line(name, value)
    }

    /// Replace every field line of an interned name with one line.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned name.
    /// * `value` - the field value.
    ///
    /// # Errors
    ///
    /// As [`header_id`](Self::header_id); nothing changes then.
    pub fn set_header_id(&mut self, name: HeaderName, value: &[u8]) -> Result<&mut Self, Error> {
        check_id(name)?;
        check_value(value)?;
        let name = name.canonical().as_bytes();
        remove_lines(self.fields, name);
        self.push_line(name, value)
    }

    /// Remove every field line of a name, for a layer that writes a field the
    /// response may carry once and that it alone decides, so the message holds one
    /// line of it (RFC 9110 Section 5.3).
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, compared without regard to case.
    ///
    /// # Returns
    ///
    /// The response, for chaining.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
    pub fn remove_header(&mut self, name: &[u8]) -> &mut Self {
        remove_lines(self.fields, name);
        self
    }

    fn push_line(&mut self, name: &[u8], value: &[u8]) -> Result<&mut Self, Error> {
        check_value(value)?;
        self.fields.extend_from_slice(name);
        self.fields.extend_from_slice(b": ");
        self.fields.extend_from_slice(value);
        self.fields.extend_from_slice(b"\r\n");
        *self.touched = true;
        Ok(self)
    }

    /// Set `Content-Type`.
    ///
    /// # Arguments
    ///
    /// * `value` - the media type.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for an invalid value.
    pub fn content_type(&mut self, value: &[u8]) -> Result<&mut Self, Error> {
        self.header_id(HeaderName::ContentType, value)
    }

    /// Redirect: set one of the redirection statuses that take a `Location`
    /// (RFC 9110 Section 10.2.2) and the `Location` field.
    ///
    /// # Arguments
    ///
    /// * `status` - 301, 302, 303, 307 or 308.
    /// * `location` - the URI reference to redirect to.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for another status or a value that is not a field value;
    /// nothing is set then.
    pub fn redirect(&mut self, status: StatusCode, location: &[u8]) -> Result<&mut Self, Error> {
        if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err(Error::Codec(format!("{status} is not a redirect status")));
        }
        validate_field_value(location)
            .map_err(|_| Error::Codec("invalid Location value".to_owned()))?;
        self.status(status);
        self.header_id(HeaderName::Location, location)
    }

    /// Redirect while keeping the request method and content: 308 when permanent
    /// (RFC 9110 Section 15.4.9), 307 otherwise (Section 15.4.8).
    ///
    /// # Arguments
    ///
    /// * `permanent` - whether the resource moved for good.
    /// * `location` - the URI reference to redirect to.
    ///
    /// # Errors
    ///
    /// [`Error::Codec`] for a value that is not a field value.
    pub fn redirect_preserving(
        &mut self,
        permanent: bool,
        location: &[u8],
    ) -> Result<&mut Self, Error> {
        let status = if permanent {
            StatusCode::PERMANENT_REDIRECT
        } else {
            StatusCode::TEMPORARY_REDIRECT
        };
        self.redirect(status, location)
    }

    /// Append to the body; a body set as an external buffer is replaced.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the bytes to append.
    pub fn body(&mut self, bytes: &[u8]) -> &mut Self {
        self.body.owned_mut().extend_from_slice(bytes);
        *self.touched = true;
        self
    }

    /// The body buffer, for a writer that serializes straight into it; a body set
    /// as an external buffer is replaced by an empty one first.
    ///
    /// # Returns
    ///
    /// The owned body bytes.
    pub fn body_mut(&mut self) -> &mut Vec<u8> {
        *self.touched = true;
        self.body.owned_mut()
    }
}

/// Refuse a field name that is not a `token` or that the driver writes itself.
fn check_name(name: &[u8]) -> Result<(), Error> {
    validate_field_name(name).map_err(|_| Error::Codec("invalid field name".to_owned()))?;
    if is_driver_field(name) {
        return Err(Error::Codec(format!(
            "the driver writes {} itself",
            String::from_utf8_lossy(name)
        )));
    }
    Ok(())
}

/// Refuse an interned name the driver writes itself.
fn check_id(name: HeaderName) -> Result<(), Error> {
    if DRIVER_FIELDS.contains(&name) {
        return Err(Error::Codec(format!(
            "the driver writes {} itself",
            name.canonical()
        )));
    }
    Ok(())
}

/// Refuse a value that is not a `field-value` (RFC 9110 Section 5.5).
fn check_value(value: &[u8]) -> Result<(), Error> {
    validate_field_value(value).map_err(|_| Error::Codec("invalid field value".to_owned()))
}

/// Remove every line of `name` from validated field lines, in place. A value holds
/// no CR or LF, so each line ends at the first CRLF after its start.
fn remove_lines(fields: &mut Vec<u8>, name: &[u8]) {
    let mut read = 0usize;
    let mut write = 0usize;
    while let Some(rest) = fields.get(read..).filter(|rest| !rest.is_empty()) {
        let len = rest
            .windows(2)
            .position(|pair| pair == b"\r\n")
            .map_or(rest.len(), |end| end.saturating_add(2));
        let line_name = rest
            .get(..len)
            .and_then(|line| line.split(|&byte| byte == b':').next())
            .unwrap_or(&[]);
        let end = read.saturating_add(len);
        if !line_name.eq_ignore_ascii_case(name) {
            fields.copy_within(read..end, write);
            write = write.saturating_add(len);
        }
        read = end;
    }
    fields.truncate(write);
}

#[cfg(test)]
mod tests {
    use super::{is_driver_field, target_route, Miss, Response, TargetRoute, DRIVER_FIELDS};
    use crate::error::REGISTRY;
    use crate::record::Record;
    use zero_http1::{parse_request, Field, Head, Status};
    use zero_http_types::{HeaderName, Method, StatusCode};
    use zero_limits::http1::Http1Limits;
    use zero_router::Allow;

    #[test]
    fn the_driver_written_names_are_recognized_in_any_case_and_no_other_name_is_rfc_9110_section_5_1(
    ) {
        assert_eq!(
            DRIVER_FIELDS.map(HeaderName::canonical),
            ["Content-Length", "Connection", "Transfer-Encoding", "Date"]
        );
        for name in [
            &b"Content-Length"[..],
            b"content-length",
            b"CONNECTION",
            b"Transfer-Encoding",
            b"transfer-encoding",
            b"Date",
            b"dAtE",
        ] {
            assert!(is_driver_field(name), "{}", String::from_utf8_lossy(name));
        }
        for name in [
            &b"Content-Length-X"[..],
            b"X-Content-Length",
            b"Content-Type",
            b"Dates",
            b"Keep-Alive",
            b"Content Length",
            b"",
        ] {
            assert!(!is_driver_field(name), "{}", String::from_utf8_lossy(name));
        }
    }

    /// The target route of a request the parser accepts.
    fn routed(request: &'static [u8]) -> TargetRoute<'static> {
        let mut table = [Field::EMPTY; 8];
        match parse_request(request, &mut table, &Http1Limits::DEFAULT) {
            Status::Complete(head) => target_route(&head, request),
            other => panic!("the parser accepts the request: {other:?}"),
        }
    }

    #[test]
    fn options_asterisk_is_answered_for_the_server_and_every_other_target_routes_its_path_rfc_9110_section_9_3_7_and_rfc_9112_section_3_2_2(
    ) {
        assert_eq!(
            routed(b"OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n"),
            TargetRoute::Server(StatusCode::OK),
            "OPTIONS * applies to the server in general (RFC 9110 Section 9.3.7)"
        );
        assert_eq!(
            routed(b"GET /users?x=1 HTTP/1.1\r\nHost: a\r\n\r\n"),
            TargetRoute::Path(b"/users?x=1")
        );
        assert_eq!(
            routed(b"GET http://www.example.org/users/42?x=1 HTTP/1.1\r\nHost: a\r\n\r\n"),
            TargetRoute::Path(b"/users/42?x=1"),
            "a server must accept the absolute form (RFC 9112 Section 3.2.2)"
        );
        assert_eq!(
            routed(b"CONNECT www.example.org:443 HTTP/1.1\r\nHost: www.example.org:443\r\n\r\n"),
            TargetRoute::Path(b"")
        );
        let request = b"OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n";
        let mut table = [Field::EMPTY; 8];
        let Status::Complete(head) = parse_request(request, &mut table, &Http1Limits::DEFAULT)
        else {
            panic!("the parser accepts OPTIONS *");
        };
        for method in [Some(Method::Get), None] {
            let other = Head { method, ..head };
            assert_eq!(
                target_route(&other, request),
                TargetRoute::NotAPath(StatusCode::BAD_REQUEST)
            );
        }
        assert_eq!(
            REGISTRY
                .iter()
                .find(|(code, _)| *code == "target")
                .map(|&(_, status)| status),
            Some(StatusCode::BAD_REQUEST),
            "the problem the core answers an asterisk-form target with carries that status"
        );
    }

    #[test]
    fn set_header_replaces_every_line_of_the_name_and_leaves_the_others() {
        let mut record = Record::new(4);
        let mut response = Response::of(&mut record);
        response.header(b"Set-Cookie", b"a=1").unwrap();
        response.header(b"X-Keep", b"k").unwrap();
        response.header(b"set-cookie", b"b=2").unwrap();
        response.set_header(b"SET-COOKIE", b"c=3").unwrap();
        assert!(response.set_header(b"X-Keep", b"bad\r\nvalue").is_err());
        assert!(response.set_header_id(HeaderName::Date, b"x").is_err());
        response
            .set_header_id(HeaderName::ContentType, b"text/plain")
            .unwrap();
        response
            .set_header_id(HeaderName::ContentType, b"text/html")
            .unwrap();
        assert_eq!(
            record.response_fields,
            b"X-Keep: k\r\nSET-COOKIE: c=3\r\nContent-Type: text/html\r\n"
        );
        assert!(record.touched);
    }

    #[test]
    fn the_allow_mask_sets_the_bit_of_each_method_id() {
        let mut allow = Allow::default();
        allow.insert(Method::Get);
        allow.insert(Method::Delete);
        let miss = Miss {
            status: StatusCode::METHOD_NOT_ALLOWED,
            allow,
        };
        assert_eq!(
            miss.allow_mask(),
            1 << Method::Get.id() | 1 << Method::Delete.id()
        );
    }

    #[test]
    fn fields_are_validated_once_and_the_framing_names_are_refused() {
        let mut record = Record::new(4);
        let mut response = Response::of(&mut record);
        response.status(StatusCode::CREATED);
        response.header(b"X-Trace", b"abc").unwrap();
        assert!(response.header(b"Bad Name", b"x").is_err());
        assert!(response.header(b"X-Split", b"a\r\nInjected: yes").is_err());
        assert!(response.header(b"content-length", b"3").is_err());
        assert!(response
            .header_id(HeaderName::Connection, b"close")
            .is_err());
        assert!(response.header_id(HeaderName::Date, b"x").is_err());
        response.content_type(b"text/plain").unwrap();
        response.body(b"hi");
        assert_eq!(record.status, Some(StatusCode::CREATED));
        assert_eq!(
            record.response_fields,
            b"X-Trace: abc\r\nContent-Type: text/plain\r\n"
        );
        assert_eq!(record.response_body.as_bytes(), b"hi");
        assert!(record.touched);
    }

    #[test]
    fn remove_header_drops_every_line_of_the_name_in_any_case_and_leaves_the_others() {
        let mut record = Record::new(4);
        let mut response = Response::of(&mut record);
        response.header(b"ETag", b"\"a\"").unwrap();
        response.header(b"X-Kept", b"1").unwrap();
        response.header(b"etag", b"\"b\"").unwrap();
        response.remove_header(b"ETAG").remove_header(b"x-absent");
        assert_eq!(record.response_fields, b"X-Kept: 1\r\n");
    }

    #[test]
    fn the_status_and_body_length_set_so_far_read_back_without_touching_the_response() {
        let mut record = Record::new(4);
        let response = Response::of(&mut record);
        assert_eq!((response.current_status(), response.body_len()), (None, 0));
        assert!(!record.touched, "reading changes nothing");
        let mut response = Response::of(&mut record);
        response.status(StatusCode::FORBIDDEN);
        assert_eq!(
            (response.current_status(), response.body_len()),
            (Some(StatusCode::FORBIDDEN), 0)
        );
        response.body(b"denied");
        assert_eq!(response.body_len(), 6);
        assert_eq!(record.status, Some(StatusCode::FORBIDDEN));
    }

    #[test]
    fn redirects_take_the_five_location_statuses_only() {
        let mut record = Record::new(4);
        let mut response = Response::of(&mut record);
        assert!(response.redirect(StatusCode::OK, b"/x").is_err());
        assert!(response.redirect(StatusCode::NOT_FOUND, b"/x").is_err());
        assert!(response
            .redirect(StatusCode::MOVED_PERMANENTLY, b"/x\r\n")
            .is_err());
        assert_eq!(record.status, None, "a refused redirect sets nothing");
        let mut response = Response::of(&mut record);
        response.redirect(StatusCode::SEE_OTHER, b"/next").unwrap();
        assert_eq!(record.status, Some(StatusCode::SEE_OTHER));
        assert_eq!(record.response_fields, b"Location: /next\r\n");
        let mut other = Record::new(4);
        Response::of(&mut other)
            .redirect_preserving(true, b"/p")
            .unwrap();
        assert_eq!(other.status, Some(StatusCode::PERMANENT_REDIRECT));
        Response::of(&mut other)
            .redirect_preserving(false, b"/t")
            .unwrap();
        assert_eq!(other.status, Some(StatusCode::TEMPORARY_REDIRECT));
    }
}
