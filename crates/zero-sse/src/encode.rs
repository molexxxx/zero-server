//! The server side: writing an event stream.
//!
//! An event is optional `event`, `id` and `retry` fields, one `data` line per line of
//! the payload, and a blank line, which is what makes the client dispatch it (WHATWG
//! HTML, Section 9.2.6). A line ends at CRLF, LF or CR (Section 9.2.5), so a payload
//! is split at all three and each piece becomes its own `data:` line, which the
//! client rejoins with LF. A value that would end its own line is refused: `event`
//! and `id` may not hold CR or LF, and an `id` holding U+0000 is ignored by clients,
//! so it is refused too (Section 9.2.6, the `id` field). `retry` is an integer, so it
//! is written only as ASCII digits. The stream is UTF-8 because every value is a
//! `str`; `Content-Type: text/event-stream; charset=utf-8` states it, the only
//! charset the media type allows (Section 17.7). A comment line starts with `:` and
//! is ignored by the client; one about every 15 seconds keeps idle proxies from
//! dropping the connection (Section 9.2.7).
//!
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes>
//! @see <https://html.spec.whatwg.org/multipage/iana.html#text/event-stream>

use alloc::vec::Vec;

use zero_core::{Error, Result};

/// The media type of an event stream, with the one charset it allows.
pub const CONTENT_TYPE: &[u8] = b"text/event-stream; charset=utf-8";

/// The fields of an event stream response: the media type, and no caching.
pub const RESPONSE_FIELDS: [(&[u8], &[u8]); 2] = [
    (b"Content-Type", CONTENT_TYPE),
    (b"Cache-Control", b"no-store"),
];

/// The keep-alive interval the authoring notes suggest, in milliseconds.
pub const KEEP_ALIVE_MS: u64 = 15_000;

/// The comment line written as a keep-alive.
pub const KEEP_ALIVE_COMMENT: &[u8] = b":\n";

/// One event to send.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Event<'a> {
    /// The event type; the client uses `message` when there is none.
    pub event: Option<&'a str>,
    /// The id the client reports in `Last-Event-ID` after a reconnect.
    pub id: Option<&'a str>,
    /// The reconnection time the client should use, in milliseconds.
    pub retry: Option<u64>,
    /// The data; `None` writes no `data` line, so the client updates the id or the
    /// reconnection time without dispatching an event.
    pub data: Option<&'a str>,
}

/// Refuse a value that holds a line break, or, for `id`, U+0000.
fn check(field: &str, value: &str, nul_allowed: bool) -> Result<()> {
    let bad = value
        .bytes()
        .any(|byte| byte == b'\r' || byte == b'\n' || (!nul_allowed && byte == 0));
    if bad {
        return Err(Error::Protocol(alloc::format!(
            "an SSE `{field}` value may not hold CR or LF{}",
            if nul_allowed { "" } else { " or U+0000" }
        )));
    }
    Ok(())
}

/// The lines of a payload, split at CRLF, LF and CR.
fn lines(data: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(data);
    core::iter::from_fn(move || {
        let text = rest?;
        match text.find(['\r', '\n']) {
            Some(at) => {
                let line = text.get(..at).unwrap_or("");
                let skip = if text.get(at..).is_some_and(|tail| tail.starts_with("\r\n")) {
                    2
                } else {
                    1
                };
                rest = text.get(at.saturating_add(skip)..);
                Some(line)
            }
            None => {
                rest = None;
                Some(text)
            }
        }
    })
}

/// Append one field line.
fn field(out: &mut Vec<u8>, name: &[u8], value: &[u8]) {
    out.extend_from_slice(name);
    out.extend_from_slice(b": ");
    out.extend_from_slice(value);
    out.push(b'\n');
}

/// Write one event.
///
/// # Arguments
///
/// * `event` - the event.
/// * `out` - the stream buffer the event is appended to.
///
/// # Errors
///
/// [`Error::Protocol`] for an `event` or `id` holding CR or LF, or an `id` holding
/// U+0000; nothing is written then.
pub fn encode(event: &Event<'_>, out: &mut Vec<u8>) -> Result<()> {
    if let Some(name) = event.event {
        check("event", name, true)?;
    }
    if let Some(id) = event.id {
        check("id", id, false)?;
    }
    if let Some(name) = event.event {
        field(out, b"event", name.as_bytes());
    }
    if let Some(id) = event.id {
        field(out, b"id", id.as_bytes());
    }
    if let Some(retry) = event.retry {
        let mut digits = [0u8; 20];
        field(out, b"retry", decimal(retry, &mut digits));
    }
    if let Some(data) = event.data {
        for line in lines(data) {
            field(out, b"data", line.as_bytes());
        }
    }
    out.push(b'\n');
    Ok(())
}

/// Write a comment line, which the client ignores.
///
/// # Arguments
///
/// * `text` - the comment, without line breaks.
/// * `out` - the stream buffer.
///
/// # Errors
///
/// [`Error::Protocol`] for a comment holding CR or LF.
pub fn comment(text: &str, out: &mut Vec<u8>) -> Result<()> {
    check("comment", text, true)?;
    out.push(b':');
    out.extend_from_slice(text.as_bytes());
    out.push(b'\n');
    Ok(())
}

/// The ASCII decimal digits of `value`.
fn decimal(mut value: u64, digits: &mut [u8; 20]) -> &[u8] {
    let mut start = digits.len();
    loop {
        start = start.saturating_sub(1);
        if let Some(slot) = digits.get_mut(start) {
            *slot = b'0'.saturating_add(u8::try_from(value % 10).unwrap_or(0));
        }
        value /= 10;
        if value == 0 || start == 0 {
            break;
        }
    }
    digits.get(start..).unwrap_or(&[])
}

/// When the next keep-alive comment is due: one interval after the last write of
/// anything, an event or a comment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeepAlive {
    interval_ms: u64,
    last_ms: u64,
}

impl KeepAlive {
    /// A schedule that starts now.
    ///
    /// # Arguments
    ///
    /// * `interval_ms` - the interval, [`KEEP_ALIVE_MS`] by default.
    /// * `now_ms` - the current time on a monotonic clock.
    #[must_use]
    pub const fn new(interval_ms: u64, now_ms: u64) -> Self {
        KeepAlive {
            interval_ms,
            last_ms: now_ms,
        }
    }

    /// Note that something was written, which pushes the next comment back.
    ///
    /// # Arguments
    ///
    /// * `now_ms` - the time of the write.
    pub fn wrote(&mut self, now_ms: u64) {
        self.last_ms = self.last_ms.max(now_ms);
    }

    /// When the next comment is due.
    #[must_use]
    pub const fn deadline(&self) -> u64 {
        self.last_ms.saturating_add(self.interval_ms)
    }

    /// Whether a comment is due now.
    ///
    /// # Arguments
    ///
    /// * `now_ms` - the current time.
    #[must_use]
    pub const fn is_due(&self, now_ms: u64) -> bool {
        now_ms >= self.deadline()
    }
}
