//! The per-request record: the head as received, its field table, the buffered
//! body, the route match, and the response as the handler builds it.
//!
//! A record is reused across requests on its core: [`Reset`] clears it and keeps the
//! capacity it grew to, so a request on a warm core allocates nothing. The connection
//! driver copies the head out of the receive block into the record, which lets the
//! block go back to the pool while the request is in flight.

use std::net::SocketAddr;
use std::rc::Rc;

use zero_http1::{Field, Head, Version};
use zero_http_types::{Method, StatusCode};
use zero_router::MAX_PARAMS;
use zero_rt::Reset;

use crate::call::{HoldCell, Miss};
use crate::error::{ErrorShape, Problem};
use crate::exchange::{HostSpan, ResponseBody, BODY_KEEP};
use crate::takeover::Claim;

/// The response head capacity a record starts with; grown when a head needs more.
pub(crate) const RESPONSE_HEAD_CAPACITY: usize = 4_096;

/// The most trailer fields a request keeps: the driver validates a chunked body's
/// trailer section into a table of this size, and an exchange parses the section
/// it was handed into one of the same size, so every section the driver accepted
/// fits.
pub(crate) const TRAILER_TABLE: usize = 16;

/// One request from head to final write.
#[derive(Debug, Default)]
pub struct Record {
    /// The head bytes as received, which the parsed spans point into.
    pub(crate) head: Vec<u8>,
    /// The field table the parser fills; `parsed.field_count` entries are live.
    pub(crate) fields: Vec<Field>,
    /// The parsed head.
    pub(crate) parsed: Option<Head>,
    /// The buffered body, complete before the handler runs.
    pub(crate) body: Vec<u8>,
    /// The trailer section of a chunked body, as received.
    pub(crate) trailers: Vec<u8>,
    /// The peer's address.
    pub(crate) peer: Option<SocketAddr>,
    /// The request arrived over a secure connection, such as TLS.
    pub(crate) secure: bool,
    /// The request's host is not one its connection serves, so it is answered 421.
    pub(crate) misdirected: bool,
    /// Working space for path normalization.
    pub(crate) scratch: Vec<u8>,
    /// The normalized path the route matched, which the parameter ranges index.
    pub(crate) route_path: Vec<u8>,
    /// The parameter spans into `route_path`, in pattern order.
    pub(crate) params: [HostSpan; MAX_PARAMS],
    /// How many parameters the route captured.
    pub(crate) param_count: usize,
    /// For a request the router sent to the miss route, what the core would have
    /// answered.
    pub(crate) miss: Option<Miss>,
    /// The body octets this record holds on the core's request-memory budget while
    /// its handler runs: the driver moves its entry's charge here when the handler
    /// starts and back onto the entry when it completes, less what the handler
    /// exported.
    pub(crate) charge: u64,
    /// The status the handler set; `200` when it set none.
    pub(crate) status: Option<StatusCode>,
    /// The handler's field lines, each validated and ending in CRLF.
    pub(crate) response_fields: Vec<u8>,
    /// The response body.
    pub(crate) response_body: ResponseBody,
    /// A status, field, body or action was written to the response.
    pub(crate) touched: bool,
    /// The serialized response head, from the status line through the empty line.
    pub(crate) response_head: Vec<u8>,
    /// Whether this response ends the connection: an answer of the driver's own, or
    /// a handler's through [`Call::close_after_response`](crate::Call::close_after_response).
    pub(crate) close: bool,
    /// The handler claimed the connection after this response.
    pub(crate) claim: Option<Claim>,
    /// A `100 Continue` was written for this request.
    pub(crate) continued: bool,
    /// The response carries `Upgrade`, so `Connection` lists the `upgrade` option.
    pub(crate) advertise_upgrade: bool,
    /// The read hold of the connection the request arrived on.
    pub(crate) hold: Option<Rc<HoldCell>>,
}

impl Record {
    /// A record with a field table of `table` entries.
    pub(crate) fn new(table: usize) -> Self {
        Record {
            fields: vec![Field::EMPTY; table.max(1)],
            ..Record::default()
        }
    }

    /// The method, when standardized.
    pub(crate) fn method(&self) -> Option<Method> {
        self.parsed.and_then(|head| head.method)
    }

    /// Whether the request method was `HEAD`, whose response carries no body.
    pub(crate) fn head_request(&self) -> bool {
        self.method() == Some(Method::Head)
    }

    /// Whether the method is safe (RFC 9110 Section 9.2.1); an unrecognized method is
    /// not.
    pub(crate) fn safe(&self) -> bool {
        self.method().is_some_and(Method::is_safe)
    }

    /// The protocol version, `HTTP/1.1` when no head was parsed.
    pub(crate) fn version(&self) -> Version {
        self.parsed.map_or(Version::Http11, |head| head.version)
    }

    /// Whether the request asked to persist the connection.
    pub(crate) fn keep_alive(&self) -> bool {
        self.parsed.is_some_and(|head| head.keep_alive)
    }

    /// The live fields of the table.
    pub(crate) fn live_fields(&self) -> &[Field] {
        let count = self.parsed.map_or(0, |head| head.field_count);
        self.fields.get(..count).unwrap_or(&[])
    }

    /// The captured parameter spans.
    pub(crate) fn live_params(&self) -> &[HostSpan] {
        self.params.get(..self.param_count).unwrap_or(&[])
    }

    /// Discard everything the handler wrote, for a response the driver writes instead.
    pub(crate) fn clear_response(&mut self) {
        self.status = None;
        self.response_fields.clear();
        self.response_body.clear();
        self.touched = false;
        self.response_head.clear();
        self.claim = None;
        self.advertise_upgrade = false;
    }

    /// Replace whatever the handler wrote with a problem, in the server's error shape.
    pub(crate) fn problem(&mut self, problem: &Problem, shape: ErrorShape) {
        self.clear_response();
        self.status = Some(problem.status);
        self.response_fields
            .extend_from_slice(shape.content_type_line());
        problem.write_body(shape, self.response_body.owned_mut());
        self.touched = true;
    }

    /// Replace whatever the handler wrote with an answer of the driver's own: a 413
    /// or a 503 carries the error body in the server's shape, any other status goes
    /// without a body.
    pub(crate) fn answer(&mut self, status: StatusCode, shape: ErrorShape) {
        if status == StatusCode::CONTENT_TOO_LARGE {
            self.problem(&Problem::new(StatusCode::CONTENT_TOO_LARGE, "limit"), shape);
        } else if status == StatusCode::SERVICE_UNAVAILABLE {
            self.problem(
                &Problem::new(StatusCode::SERVICE_UNAVAILABLE, "timeout"),
                shape,
            );
        } else {
            self.clear_response();
            self.status = Some(status);
        }
    }
}

impl Reset for Record {
    fn reset(&mut self) {
        self.head.clear();
        self.parsed = None;
        self.body.clear();
        self.body.shrink_to(BODY_KEEP);
        self.trailers.clear();
        self.peer = None;
        self.secure = false;
        self.misdirected = false;
        self.scratch.clear();
        self.route_path.clear();
        self.param_count = 0;
        self.miss = None;
        self.charge = 0;
        self.clear_response();
        self.response_body.shrink_to(BODY_KEEP);
        self.close = false;
        self.continued = false;
        self.hold = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{Record, BODY_KEEP};
    use crate::error::ErrorShape;
    use zero_http_types::StatusCode;
    use zero_rt::Reset;

    #[test]
    fn a_reset_record_keeps_its_small_capacities_and_shrinks_a_large_body() {
        let mut record = Record::new(4);
        record.head.extend_from_slice(b"GET / HTTP/1.1\r\n\r\n");
        record.body.resize(BODY_KEEP * 4, 0);
        record.response_fields.extend_from_slice(b"X: y\r\n");
        record.route_path.extend_from_slice(b"/x");
        record.param_count = 1;
        record.close = true;
        record.charge = 9;
        let head_capacity = record.head.capacity();
        record.reset();
        assert!(record.head.is_empty() && record.body.is_empty());
        assert!(record.response_fields.is_empty() && !record.close);
        assert!(record.route_path.is_empty() && record.param_count == 0);
        assert_eq!(record.charge, 0);
        assert_eq!(record.head.capacity(), head_capacity);
        assert!(record.body.capacity() <= BODY_KEEP);
        assert_eq!(record.fields.len(), 4);
    }

    #[test]
    fn the_driver_answers_413_and_503_in_the_error_shape_and_other_statuses_bare() {
        let mut record = Record::new(1);
        record.answer(StatusCode::CONTENT_TOO_LARGE, ErrorShape::Legacy);
        assert_eq!(
            record.response_body.as_bytes(),
            br#"{"error":"Content Too Large"}"#
        );
        assert_eq!(
            record.response_fields,
            b"Content-Type: application/json\r\n"
        );
        record.answer(StatusCode::SERVICE_UNAVAILABLE, ErrorShape::Problem);
        assert_eq!(
            record.response_body.as_bytes(),
            br#"{"type":"about:blank","title":"Service Unavailable","status":503,"code":"timeout"}"#
        );
        record.answer(StatusCode::REQUEST_TIMEOUT, ErrorShape::Problem);
        assert!(record.response_body.is_empty() && record.response_fields.is_empty());
        assert_eq!(record.status, Some(StatusCode::REQUEST_TIMEOUT));
    }
}
