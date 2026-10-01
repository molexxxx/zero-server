//! The request and response views a handler works with.
//!
//! [`Call`] wraps the request record for the handler's duration: the request side
//! reads the parsed head, the fields, the buffered body and the route match; the
//! response side takes the status, validated field lines and the body. The driver
//! owns framing (`Content-Length`, `Connection`, `Transfer-Encoding`) and the `Date`
//! field, so a handler cannot set those; every other name must be a `token` and
//! every value a `field-value` (RFC 9110 Section 5.5), checked once here, which is
//! the response-splitting boundary of `DESIGN.md` section 6.3. [`Call::route`]
//! resolves the request against a `zero-router` table and answers the misses itself:
//! 404, 405 with `Allow`, 501, the automatic OPTIONS, and 400 for a target that is
//! not a path.

use std::net::SocketAddr;

use zero_core::Error;
use zero_http1::{Field, Head, TargetForm, Version};
use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::rt::Core;
use zero_router::{Allow, Resolution, Router};
use zero_rt::Worker;
use zero_uri::{percent_decode, split_query};

use crate::error::Problem;
use crate::record::Record;
use crate::takeover::{Claim, TakeOver};

/// Field names the driver writes itself; a handler setting one is refused.
const RESERVED: [HeaderName; 4] = [
    HeaderName::ContentLength,
    HeaderName::Connection,
    HeaderName::TransferEncoding,
    HeaderName::Date,
];

/// One request and its response, for the handler's duration.
#[derive(Debug)]
pub struct Call<'a> {
    record: &'a mut Record,
    worker: &'a Worker,
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
}

/// What a resolution leaves to do, computed while the record is borrowed in parts.
enum Outcome<T> {
    Run(T, bool),
    Problem(Problem),
    Allowed(StatusCode, Allow, bool),
    Empty(StatusCode),
}

impl<'a> Call<'a> {
    pub(crate) fn new(record: &'a mut Record, worker: &'a Worker) -> Self {
        Call { record, worker }
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
            route_path,
            params,
            param_count,
            status,
            response_fields,
            response_body,
            ..
        } = &mut *self.record;
        let count = parsed.map_or(0, |head| head.field_count);
        (
            Request {
                head,
                fields: fields.get(..count).unwrap_or(&[]),
                parsed: *parsed,
                body,
                trailers,
                peer: *peer,
                route_path,
                params: params.get(..*param_count).unwrap_or(&[]),
            },
            Response {
                status,
                fields: response_fields,
                body: response_body,
            },
        )
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
    /// `OPTIONS *`, and 400 for a target whose path is not a path.
    pub fn route<T: Copy>(&mut self, router: &Router<T>) -> Option<Routed<T>> {
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
            let target = parsed.path.of(head);
            if parsed.form == TargetForm::Asterisk {
                // RFC 9110 Section 9.3.7: "OPTIONS *" asks about the server as a
                // whole; no other method has a meaning for it.
                Some(match parsed.method {
                    Some(Method::Options) => Outcome::Empty(StatusCode::OK),
                    _ => Outcome::Problem(Problem::new(StatusCode::BAD_REQUEST, "target")),
                })
            } else {
                match router.resolve_target(token, target, scratch) {
                    Ok(resolved) => match resolved.resolution {
                        Resolution::Matched {
                            descriptor,
                            params: found,
                            head: is_head,
                        } => {
                            route_path.clear();
                            route_path.extend_from_slice(resolved.path);
                            *param_count = 0;
                            for (slot, (_, range)) in params.iter_mut().zip(found.iter()) {
                                *slot = (
                                    u32::try_from(range.start).unwrap_or(u32::MAX),
                                    u32::try_from(range.end).unwrap_or(u32::MAX),
                                );
                                *param_count = param_count.saturating_add(1);
                            }
                            Some(Outcome::Run(descriptor, is_head))
                        }
                        Resolution::NotFound => Some(Outcome::Problem(Problem::new(
                            StatusCode::NOT_FOUND,
                            "not_found",
                        ))),
                        Resolution::MethodNotAllowed { allow } => Some(Outcome::Allowed(
                            StatusCode::METHOD_NOT_ALLOWED,
                            allow,
                            true,
                        )),
                        Resolution::Options { allow } => {
                            Some(Outcome::Allowed(StatusCode::OK, allow, false))
                        }
                        Resolution::NotImplemented => Some(Outcome::Problem(Problem::new(
                            StatusCode::NOT_IMPLEMENTED,
                            "not_implemented",
                        ))),
                    },
                    Err(error) => Some(Outcome::Problem(Problem {
                        status: StatusCode::BAD_REQUEST,
                        code: "uri",
                        detail: Some(error.to_string()),
                    })),
                }
            }
        };
        match outcome? {
            Outcome::Run(descriptor, head) => Some(Routed { descriptor, head }),
            Outcome::Problem(problem) => {
                self.record.problem(&problem);
                None
            }
            Outcome::Allowed(status, allow, problem) => {
                if problem {
                    let code = if status == StatusCode::METHOD_NOT_ALLOWED {
                        "method_not_allowed"
                    } else {
                        "allowed"
                    };
                    self.record.problem(&Problem::new(status, code));
                } else {
                    self.record.clear_response();
                    self.record.status = Some(status);
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
}

/// The request as received: method, target, fields, the buffered body and the
/// route match.
#[derive(Debug)]
pub struct Request<'a> {
    head: &'a [u8],
    fields: &'a [Field],
    parsed: Option<Head>,
    body: &'a [u8],
    trailers: &'a [u8],
    peer: Option<SocketAddr>,
    route_path: &'a [u8],
    params: &'a [(u32, u32)],
}

impl<'a> Request<'a> {
    pub(crate) fn of(record: &'a Record) -> Self {
        Request {
            head: &record.head,
            fields: record.live_fields(),
            parsed: record.parsed,
            body: &record.body,
            trailers: &record.trailers,
            peer: record.peer,
            route_path: &record.route_path,
            params: record.live_params(),
        }
    }

    /// The method, when it is one of the eight RFC 9110 methods.
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
        let (start, end) = *self.params.get(index)?;
        self.route_path.get(start as usize..end as usize)
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
        self.fields
            .iter()
            .find(|field| field.name(self.head).eq_ignore_ascii_case(name))
            .map(|field| field.value(self.head))
    }

    /// The first field with this interned name.
    ///
    /// # Arguments
    ///
    /// * `name` - the interned name.
    #[must_use]
    pub fn header_id(&self, name: HeaderName) -> Option<&'a [u8]> {
        self.fields
            .iter()
            .find(|field| field.id == Some(name))
            .map(|field| field.value(self.head))
    }

    /// Every field in order, as name and value.
    pub fn headers(&self) -> impl Iterator<Item = (&'a [u8], &'a [u8])> + 'a {
        let head = self.head;
        self.fields
            .iter()
            .map(move |field| (field.name(head), field.value(head)))
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
}

/// The response under construction: status, validated fields and the body.
#[derive(Debug)]
pub struct Response<'a> {
    status: &'a mut Option<StatusCode>,
    fields: &'a mut Vec<u8>,
    body: &'a mut Vec<u8>,
}

impl<'a> Response<'a> {
    pub(crate) fn of(record: &'a mut Record) -> Self {
        Response {
            status: &mut record.status,
            fields: &mut record.response_fields,
            body: &mut record.response_body,
        }
    }

    /// Set the status; `200 OK` when never set.
    ///
    /// # Arguments
    ///
    /// * `status` - the status code.
    pub fn status(&mut self, status: StatusCode) -> &mut Self {
        *self.status = Some(status);
        self
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
        validate_field_name(name).map_err(|_| Error::Codec("invalid field name".to_owned()))?;
        if RESERVED
            .iter()
            .any(|reserved| reserved.as_bytes().eq_ignore_ascii_case(name))
        {
            return Err(Error::Codec(format!(
                "the driver writes {} itself",
                String::from_utf8_lossy(name)
            )));
        }
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
        if RESERVED.contains(&name) {
            return Err(Error::Codec(format!(
                "the driver writes {} itself",
                name.canonical()
            )));
        }
        self.push_line(name.canonical().as_bytes(), value)
    }

    fn push_line(&mut self, name: &[u8], value: &[u8]) -> Result<&mut Self, Error> {
        validate_field_value(value).map_err(|_| Error::Codec("invalid field value".to_owned()))?;
        self.fields.extend_from_slice(name);
        self.fields.extend_from_slice(b": ");
        self.fields.extend_from_slice(value);
        self.fields.extend_from_slice(b"\r\n");
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

    /// Append to the body.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the bytes to append.
    pub fn body(&mut self, bytes: &[u8]) -> &mut Self {
        self.body.extend_from_slice(bytes);
        self
    }

    /// The body buffer, for a writer that serializes straight into it.
    pub fn body_mut(&mut self) -> &mut Vec<u8> {
        self.body
    }
}

#[cfg(test)]
mod tests {
    use super::Response;
    use crate::record::Record;
    use zero_http_types::{HeaderName, StatusCode};

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
        assert_eq!(record.response_body, b"hi");
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
