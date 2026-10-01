//! The request and response views a handler works with.
//!
//! [`Call`] wraps the request record for the handler's duration: the request side
//! reads the parsed head, the fields and the buffered body; the response side takes
//! the status, validated field lines and the body. The driver owns framing
//! (`Content-Length`, `Connection`, `Transfer-Encoding`) and the `Date` field, so a
//! handler cannot set those; every other name must be a `token` and every value a
//! `field-value` (RFC 9110 Section 5.5), checked once here, which is the
//! response-splitting boundary of `DESIGN.md` section 6.3.

use std::net::SocketAddr;

use zero_core::Error;
use zero_http1::{Field, Head, Version};
use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::tokio_rt::Core;
use zero_rt::Worker;

use crate::record::Record;

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
            },
            Response {
                status,
                fields: response_fields,
                body: response_body,
            },
        )
    }
}

/// The request as received: method, target, fields and the buffered body.
#[derive(Debug)]
pub struct Request<'a> {
    head: &'a [u8],
    fields: &'a [Field],
    parsed: Option<Head>,
    body: &'a [u8],
    trailers: &'a [u8],
    peer: Option<SocketAddr>,
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
}
