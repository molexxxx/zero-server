//! The per-request record: the head as received, its field table, the buffered
//! body, and the response as the handler builds it.
//!
//! A record is reused across requests on its core: [`Reset`] clears it and keeps the
//! capacity it grew to, so a request on a warm core allocates nothing. The connection
//! driver copies the head out of the receive block into the record, which lets the
//! block go back to the pool while the request is in flight.

use std::net::SocketAddr;

use zero_http1::{Field, Head, Version};
use zero_http_types::{Method, StatusCode};
use zero_rt::Reset;

/// The response head capacity a record starts with; grown when a head needs more.
pub(crate) const RESPONSE_HEAD_CAPACITY: usize = 4_096;

/// A body buffer kept past this capacity is shrunk when the record is reused, so one
/// large upload does not pin a megabyte to the record for the rest of the core's life.
pub(crate) const BODY_KEEP: usize = 65_536;

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
    /// The status the handler set; `200` when it set none.
    pub(crate) status: Option<StatusCode>,
    /// The handler's field lines, each validated and ending in CRLF.
    pub(crate) response_fields: Vec<u8>,
    /// The response body.
    pub(crate) response_body: Vec<u8>,
    /// The serialized response head, from the status line through the empty line.
    pub(crate) response_head: Vec<u8>,
    /// Whether this response ends the connection.
    pub(crate) close: bool,
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

    /// Discard everything the handler wrote, for a response the driver writes instead.
    pub(crate) fn clear_response(&mut self) {
        self.status = None;
        self.response_fields.clear();
        self.response_body.clear();
        self.response_head.clear();
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
        self.clear_response();
        self.response_body.shrink_to(BODY_KEEP);
        self.close = false;
    }
}

#[cfg(test)]
mod tests {
    use super::{Record, BODY_KEEP};
    use zero_rt::Reset;

    #[test]
    fn a_reset_record_keeps_its_small_capacities_and_shrinks_a_large_body() {
        let mut record = Record::new(4);
        record.head.extend_from_slice(b"GET / HTTP/1.1\r\n\r\n");
        record.body.resize(BODY_KEEP * 4, 0);
        record.response_fields.extend_from_slice(b"X: y\r\n");
        record.close = true;
        let head_capacity = record.head.capacity();
        record.reset();
        assert!(record.head.is_empty() && record.body.is_empty());
        assert!(record.response_fields.is_empty() && !record.close);
        assert_eq!(record.head.capacity(), head_capacity);
        assert!(record.body.capacity() <= BODY_KEEP);
        assert_eq!(record.fields.len(), 4);
    }
}
