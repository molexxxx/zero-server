//! The client side: reading an event stream, for the bindings' fetch client.
//!
//! The decoder follows "Interpreting an event stream" (WHATWG HTML, Section 9.2.6):
//! one leading UTF-8 byte order mark is stripped; a line ends at CRLF, at an LF not
//! preceded by CR, or at a CR not followed by LF, including across chunk boundaries;
//! a blank line dispatches the event; a line starting with `:` is ignored; otherwise
//! the field name runs to the first `:` and one leading space of the value is
//! removed. `event` sets the event type, `data` appends its value and an LF, `id`
//! sets the last event ID unless the value holds U+0000, `retry` sets the
//! reconnection time when the value is only ASCII digits, and any other field is
//! ignored. Field names compare literally. On dispatch the last event ID is kept, an
//! empty data buffer dispatches nothing, and one trailing LF is removed from the
//! data. An event the stream ends inside is never dispatched. Bytes that are not
//! UTF-8 decode to U+FFFD, as the UTF-8 decode algorithm does; lines split only at
//! ASCII CR and LF, which never occur inside a multi-byte sequence, so decoding line
//! by line gives the same text as decoding the stream.
//!
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>

use alloc::string::String;
use alloc::vec::Vec;

use zero_core::{Error, Result};
use zero_simd::find_cr_or_lf;

/// The UTF-8 byte order mark.
const BOM: &[u8; 3] = b"\xEF\xBB\xBF";

/// One dispatched event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    /// The event type: the `event` field, or `message`.
    pub event: String,
    /// The data, its lines joined with LF.
    pub data: String,
    /// The last event ID at dispatch, which persists across events.
    pub id: String,
}

/// An incremental event stream decoder.
#[derive(Clone, Debug)]
pub struct Decoder {
    max_event: usize,
    head: Vec<u8>,
    bom_done: bool,
    after_cr: bool,
    line: Vec<u8>,
    data: Vec<u8>,
    event_type: Vec<u8>,
    last_id_buffer: Vec<u8>,
    last_id: String,
    retry: Option<u64>,
}

impl Decoder {
    /// A decoder at the start of a stream.
    ///
    /// # Arguments
    ///
    /// * `max_event` - the longest line and the largest data buffer, in bytes, so a
    ///   server cannot make the client hold unbounded memory.
    #[must_use]
    pub const fn new(max_event: usize) -> Self {
        Decoder {
            max_event,
            head: Vec::new(),
            bom_done: false,
            after_cr: false,
            line: Vec::new(),
            data: Vec::new(),
            event_type: Vec::new(),
            last_id_buffer: Vec::new(),
            last_id: String::new(),
            retry: None,
        }
    }

    /// The last event ID, which a reconnect sends as `Last-Event-ID` when not empty.
    #[must_use]
    pub fn last_event_id(&self) -> &str {
        &self.last_id
    }

    /// The reconnection time the server set, in milliseconds.
    #[must_use]
    pub const fn retry(&self) -> Option<u64> {
        self.retry
    }

    /// Decode the next chunk of the stream.
    ///
    /// # Arguments
    ///
    /// * `chunk` - the bytes as they arrived; a line or an event may continue in the
    ///   next chunk.
    /// * `out` - receives every event the chunk dispatches.
    ///
    /// # Errors
    ///
    /// [`Error::Limit`] when a line or an event's data passes the limit.
    pub fn feed(&mut self, mut chunk: &[u8], out: &mut Vec<Message>) -> Result<()> {
        if !self.bom_done {
            let take = BOM.len().saturating_sub(self.head.len()).min(chunk.len());
            let (start, rest) = chunk.split_at(take);
            self.head.extend_from_slice(start);
            chunk = rest;
            if self.head.len() < BOM.len() && BOM.starts_with(&self.head) {
                return Ok(());
            }
            self.bom_done = true;
            let head = core::mem::take(&mut self.head);
            if head.as_slice() != BOM {
                self.lines(&head, out)?;
            }
        }
        self.lines(chunk, out)
    }

    /// Split bytes into lines and process each complete one.
    fn lines(&mut self, mut rest: &[u8], out: &mut Vec<Message>) -> Result<()> {
        while !rest.is_empty() {
            if self.after_cr {
                self.after_cr = false;
                if let Some(tail) = rest.strip_prefix(b"\n") {
                    rest = tail;
                    continue;
                }
            }
            let Some(at) = find_cr_or_lf(rest) else {
                return self.extend_line(rest);
            };
            let (part, tail) = rest.split_at(at);
            self.extend_line(part)?;
            self.after_cr = tail.first() == Some(&b'\r');
            rest = tail.get(1..).unwrap_or(&[]);
            let line = core::mem::take(&mut self.line);
            let outcome = self.process(&line, out);
            self.line = line;
            self.line.clear();
            outcome?;
        }
        Ok(())
    }

    /// Add to the line in progress, within the limit.
    fn extend_line(&mut self, part: &[u8]) -> Result<()> {
        if self.line.len().saturating_add(part.len()) > self.max_event {
            return Err(Error::Limit(alloc::format!(
                "an event stream line passed {} bytes",
                self.max_event
            )));
        }
        self.line.extend_from_slice(part);
        Ok(())
    }

    /// Process one complete line.
    fn process(&mut self, line: &[u8], out: &mut Vec<Message>) -> Result<()> {
        if line.is_empty() {
            self.dispatch(out);
            return Ok(());
        }
        if line.first() == Some(&b':') {
            return Ok(());
        }
        let (name, value) = match line.iter().position(|&byte| byte == b':') {
            Some(at) => {
                let (name, rest) = line.split_at(at);
                let value = rest.get(1..).unwrap_or(&[]);
                (name, value.strip_prefix(b" ").unwrap_or(value))
            }
            None => (line, &[][..]),
        };
        match name {
            b"event" => {
                self.event_type.clear();
                self.event_type.extend_from_slice(value);
            }
            b"data" => {
                if self
                    .data
                    .len()
                    .saturating_add(value.len())
                    .saturating_add(1)
                    > self.max_event
                {
                    return Err(Error::Limit(alloc::format!(
                        "an event's data passed {} bytes",
                        self.max_event
                    )));
                }
                self.data.extend_from_slice(value);
                self.data.push(b'\n');
            }
            b"id" if !value.contains(&0) => {
                self.last_id_buffer.clear();
                self.last_id_buffer.extend_from_slice(value);
            }
            b"retry" if !value.is_empty() && value.iter().all(u8::is_ascii_digit) => {
                let parsed = value.iter().fold(0u64, |total, &digit| {
                    total
                        .saturating_mul(10)
                        .saturating_add(u64::from(digit.saturating_sub(b'0')))
                });
                self.retry = Some(parsed);
            }
            _ => {}
        }
        Ok(())
    }

    /// Dispatch the event the buffers hold.
    fn dispatch(&mut self, out: &mut Vec<Message>) {
        self.last_id = String::from_utf8_lossy(&self.last_id_buffer).into_owned();
        if self.data.is_empty() {
            self.event_type.clear();
            return;
        }
        if self.data.last() == Some(&b'\n') {
            self.data.pop();
        }
        let event = if self.event_type.is_empty() {
            String::from("message")
        } else {
            String::from_utf8_lossy(&self.event_type).into_owned()
        };
        out.push(Message {
            event,
            data: String::from_utf8_lossy(&self.data).into_owned(),
            id: self.last_id.clone(),
        });
        self.data.clear();
        self.event_type.clear();
    }
}
