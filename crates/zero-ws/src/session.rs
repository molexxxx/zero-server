//! One server-side WebSocket connection after the handshake, without I/O.
//!
//! [`Session::feed`] takes the bytes read from the socket and returns what they
//! complete: a message, a ping, a pong or a close. It unmasks in place, so an
//! unfragmented message whose frame is wholly in the read buffer is delivered as a
//! slice of that buffer; fragments, and frames that arrive in pieces, are gathered in
//! the session's message buffer. The frames the session must send in reply, and the
//! ones the application sends, collect in [`Session::output`] for the runtime to
//! write.
//!
//! The rules it keeps, from RFC 6455:
//!
//! - fragments of one message are never interleaved with another's, and control
//!   frames between fragments are processed (Section 5.4);
//! - a Ping is answered with a Pong "with identical Application data", unless a
//!   Close was already received (Sections 5.5.2 and 5.5.3);
//! - a received Close is answered with one Close carrying the same status code,
//!   once, and an empty body when the received one had none, since 1005, 1006 and
//!   1015 are never sent (Sections 5.5.1 and 7.4.1); once a Close went each way the
//!   server closes the TCP connection at once (Section 5.5.1);
//! - a text message must be UTF-8 as a whole, checked as each fragment arrives, and
//!   fails with 1007 when it is not (Sections 5.6 and 8.1);
//! - a message over the size limit fails with 1009, checked against each frame's
//!   declared length before its payload is read, and so does one spread over too
//!   many fragments (Sections 7.4.1 and 10.4); control frames past the per-second
//!   budget fail with 1008;
//! - after the session fails the connection it sends a Close with the code and
//!   processes no further input (Section 7.1.7), and nothing is sent after a Close
//!   (Section 5.5.1).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.7>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-10.4>

use alloc::vec::Vec;

use zero_core::{Error, Result};
use zero_limits::WebSocketLimits;
use zero_simd::{rotate_key, unmask, Utf8Validator};

use crate::close::{self, Close, CloseCode};
use crate::frame::{self, Header, Opcode, MAX_CONTROL_PAYLOAD};

/// The window the control-frame budget counts over, in milliseconds.
const CONTROL_WINDOW_MS: u64 = 1_000;

/// What a fed buffer completed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event<'b> {
    /// A whole text message.
    Text(&'b str),
    /// A whole binary message.
    Binary(&'b [u8]),
    /// A ping; the session already queued the pong.
    Ping(&'b [u8]),
    /// A pong.
    Pong(&'b [u8]),
    /// The peer's Close; the session already queued the answer when one is owed.
    Close(Close<'b>),
}

/// The result of one [`Session::feed`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step<'b> {
    /// How many bytes of the input were used; the caller drops them.
    pub consumed: usize,
    /// What they completed, if anything.
    pub event: Option<Event<'b>>,
}

/// Where the connection is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Messages flow both ways.
    Open,
    /// The server sent a Close and waits for the peer's.
    CloseSent,
    /// A Close went each way; the TCP connection closes once the output is written.
    Closed,
    /// The connection failed; the output holds the Close, and input is ignored.
    Failed,
}

/// The type of the message in progress.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Text,
    Binary,
}

/// A data frame whose payload is still arriving.
#[derive(Clone, Copy, Debug)]
struct Partial {
    fin: bool,
    mask: [u8; 4],
    remaining: u64,
    offset: usize,
}

/// One server-side WebSocket connection.
#[derive(Debug)]
pub struct Session {
    limits: WebSocketLimits,
    state: State,
    close_received: Option<CloseCode>,
    message: Option<Kind>,
    partial: Option<Partial>,
    buffer: Vec<u8>,
    delivered: bool,
    utf8: Utf8Validator,
    fragments: u32,
    window_start: u64,
    control_frames: u32,
    output: Vec<u8>,
}

impl Session {
    /// A session in the open state.
    ///
    /// # Arguments
    ///
    /// * `limits` - the message size, fragment and control-frame limits.
    #[must_use]
    pub fn new(limits: WebSocketLimits) -> Self {
        Session {
            limits,
            state: State::Open,
            close_received: None,
            message: None,
            partial: None,
            buffer: Vec::new(),
            delivered: false,
            utf8: Utf8Validator::new(),
            fragments: 0,
            window_start: 0,
            control_frames: 0,
            output: Vec::new(),
        }
    }

    /// Process received bytes.
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed bytes read from the socket; payloads are unmasked
    ///   in place.
    /// * `now_ms` - a monotonic clock in milliseconds, for the control-frame budget.
    ///
    /// # Returns
    ///
    /// The bytes used and the event they completed. Nothing used and no event means
    /// the session needs more input.
    ///
    /// # Errors
    ///
    /// The close code the connection failed with; the Close frame carrying it is in
    /// the output, and the runtime writes it and closes the connection.
    pub fn feed<'b>(
        &'b mut self,
        input: &'b mut [u8],
        now_ms: u64,
    ) -> core::result::Result<Step<'b>, CloseCode> {
        if self.delivered {
            self.delivered = false;
            self.buffer.clear();
        }
        if matches!(self.state, State::Closed | State::Failed) {
            return Ok(Step {
                consumed: input.len(),
                event: None,
            });
        }
        if self.partial.is_some() {
            let (used, done) = self.absorb(input)?;
            return Ok(Step {
                consumed: used,
                event: if done { self.finish_message()? } else { None },
            });
        }
        let header = match frame::decode(input, 0) {
            Ok(Some(header)) => header,
            Ok(None) => {
                return Ok(Step {
                    consumed: 0,
                    event: None,
                });
            }
            Err(code) => return Err(self.fail(code)),
        };
        if header.opcode.is_control() {
            self.control(header, input, now_ms)
        } else {
            self.data(header, input)
        }
    }

    /// A control frame: answered and reported only once it is wholly in the input.
    fn control<'b>(
        &'b mut self,
        header: Header,
        input: &'b mut [u8],
        now_ms: u64,
    ) -> core::result::Result<Step<'b>, CloseCode> {
        let len = usize::try_from(header.len).unwrap_or(usize::MAX);
        let end = header.header_len.saturating_add(len);
        let Some(payload) = input.get_mut(header.header_len..end) else {
            return Ok(Step {
                consumed: 0,
                event: None,
            });
        };
        if now_ms >= self.window_start.saturating_add(CONTROL_WINDOW_MS) {
            self.window_start = now_ms;
            self.control_frames = 0;
        }
        self.control_frames = self.control_frames.saturating_add(1);
        if self.control_frames > self.limits.max_control_frames_per_second {
            return Err(self.fail(CloseCode::POLICY_VIOLATION));
        }
        unmask(payload, header.mask);
        let payload: &'b [u8] = payload;
        let event = match header.opcode {
            Opcode::Ping => {
                if self.close_received.is_none() {
                    self.write_frame(Opcode::Pong, payload);
                }
                Event::Ping(payload)
            }
            Opcode::Pong => Event::Pong(payload),
            _ => {
                let close = match close::parse(payload) {
                    Ok(close) => close,
                    Err(code) => return Err(self.fail(code)),
                };
                self.close_received = Some(close.code);
                if self.state == State::Open {
                    let mut body = [0u8; MAX_CONTROL_PAYLOAD];
                    let len = close::body(close.code, "", &mut body).unwrap_or(0);
                    self.write_frame(Opcode::Close, body.get(..len).unwrap_or(&[]));
                }
                self.state = State::Closed;
                Event::Close(close)
            }
        };
        Ok(Step {
            consumed: end,
            event: Some(event),
        })
    }

    /// A data frame: delivered from the input when it is a whole message that fits,
    /// else gathered in the message buffer.
    fn data<'b>(
        &'b mut self,
        header: Header,
        input: &'b mut [u8],
    ) -> core::result::Result<Step<'b>, CloseCode> {
        let kind = match (header.opcode, self.message) {
            (Opcode::Continuation, Some(kind)) => kind,
            (Opcode::Text, None) => Kind::Text,
            (Opcode::Binary, None) => Kind::Binary,
            _ => return Err(self.fail(CloseCode::PROTOCOL_ERROR)),
        };
        self.fragments = self.fragments.saturating_add(1);
        let total = u64::try_from(self.buffer.len())
            .unwrap_or(u64::MAX)
            .saturating_add(header.len);
        if total > self.limits.max_message || self.fragments > self.limits.max_fragments {
            return Err(self.fail(CloseCode::MESSAGE_TOO_BIG));
        }
        let len = usize::try_from(header.len).unwrap_or(usize::MAX);
        let end = header.header_len.saturating_add(len);
        if header.fin && self.message.is_none() && input.len() >= end {
            self.fragments = 0;
            let Some(payload) = input.get_mut(header.header_len..end) else {
                return Err(self.fail(CloseCode::INTERNAL_ERROR));
            };
            unmask(payload, header.mask);
            let payload: &'b [u8] = payload;
            let event = match kind {
                Kind::Binary => Event::Binary(payload),
                Kind::Text => match core::str::from_utf8(payload) {
                    Ok(text) => Event::Text(text),
                    Err(_) => return Err(self.fail(CloseCode::INVALID_PAYLOAD)),
                },
            };
            return Ok(Step {
                consumed: end,
                event: Some(event),
            });
        }
        self.message = Some(kind);
        self.partial = Some(Partial {
            fin: header.fin,
            mask: header.mask,
            remaining: header.len,
            offset: 0,
        });
        let rest = input.get_mut(header.header_len..).unwrap_or(&mut []);
        let (used, done) = self.absorb(rest)?;
        Ok(Step {
            consumed: header.header_len.saturating_add(used),
            event: if done { self.finish_message()? } else { None },
        })
    }

    /// Take what the input holds of the frame in progress into the message buffer.
    ///
    /// # Returns
    ///
    /// The bytes used, and whether they completed the message.
    fn absorb(&mut self, input: &mut [u8]) -> core::result::Result<(usize, bool), CloseCode> {
        let Some(mut partial) = self.partial else {
            return Ok((0, false));
        };
        let take = usize::try_from(partial.remaining)
            .unwrap_or(usize::MAX)
            .min(input.len());
        let chunk = input.get_mut(..take).unwrap_or(&mut []);
        unmask(chunk, rotate_key(partial.mask, partial.offset));
        if self.message == Some(Kind::Text) && self.utf8.feed(chunk).is_err() {
            return Err(self.fail(CloseCode::INVALID_PAYLOAD));
        }
        self.buffer.extend_from_slice(chunk);
        partial.remaining = partial
            .remaining
            .saturating_sub(u64::try_from(take).unwrap_or(u64::MAX));
        partial.offset = partial.offset.wrapping_add(take);
        if partial.remaining > 0 {
            self.partial = Some(partial);
            return Ok((take, false));
        }
        self.partial = None;
        Ok((take, partial.fin))
    }

    /// The message the buffer now holds, once its final fragment is in.
    fn finish_message(&mut self) -> core::result::Result<Option<Event<'_>>, CloseCode> {
        let kind = self.message.take();
        self.fragments = 0;
        self.delivered = true;
        match kind {
            Some(Kind::Text) => {
                let complete = self.utf8.is_complete();
                self.utf8.reset();
                if !complete {
                    return Err(self.fail(CloseCode::INVALID_PAYLOAD));
                }
                Ok(core::str::from_utf8(&self.buffer).ok().map(Event::Text))
            }
            Some(Kind::Binary) => Ok(Some(Event::Binary(&self.buffer))),
            None => Ok(None),
        }
    }

    /// Fail the connection: queue a Close with `code` unless one was sent, and stop
    /// processing input.
    fn fail(&mut self, code: CloseCode) -> CloseCode {
        if self.state == State::Open {
            let mut body = [0u8; MAX_CONTROL_PAYLOAD];
            let len = close::body(code, "", &mut body).unwrap_or(0);
            self.write_frame(Opcode::Close, body.get(..len).unwrap_or(&[]));
        }
        self.state = State::Failed;
        code
    }

    /// Append one unmasked, final frame to the output.
    fn write_frame(&mut self, opcode: Opcode, payload: &[u8]) {
        let mut header = [0u8; 10];
        let len = u64::try_from(payload.len()).unwrap_or(u64::MAX);
        let written = frame::encode(true, opcode, len, &mut header);
        self.output
            .extend_from_slice(header.get(..written).unwrap_or(&[]));
        self.output.extend_from_slice(payload);
    }

    /// Refuse a send once a Close was sent or the connection is done.
    fn ensure_open(&self) -> Result<()> {
        if self.state == State::Open {
            Ok(())
        } else {
            Err(Error::Closed)
        }
    }

    /// Queue a text message.
    ///
    /// # Arguments
    ///
    /// * `text` - the message.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent or the connection failed.
    pub fn send_text(&mut self, text: &str) -> Result<()> {
        self.ensure_open()?;
        self.write_frame(Opcode::Text, text.as_bytes());
        Ok(())
    }

    /// Queue a binary message.
    ///
    /// # Arguments
    ///
    /// * `data` - the message.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent or the connection failed.
    pub fn send_binary(&mut self, data: &[u8]) -> Result<()> {
        self.ensure_open()?;
        self.write_frame(Opcode::Binary, data);
        Ok(())
    }

    /// Queue a ping.
    ///
    /// # Arguments
    ///
    /// * `data` - the application data, at most 125 bytes.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent; [`Error::Limit`] for more than 125
    /// bytes.
    pub fn ping(&mut self, data: &[u8]) -> Result<()> {
        self.ensure_open()?;
        if data.len() > MAX_CONTROL_PAYLOAD {
            return Err(Error::Limit(alloc::format!(
                "a ping carries at most {MAX_CONTROL_PAYLOAD} bytes, not {}",
                data.len()
            )));
        }
        self.write_frame(Opcode::Ping, data);
        Ok(())
    }

    /// Start the closing handshake.
    ///
    /// # Arguments
    ///
    /// * `code` - the status code, or [`CloseCode::NO_STATUS`] for an empty body.
    /// * `reason` - the reason, at most 123 bytes.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent; [`Error::Protocol`] for a code that
    /// may not be sent or a reason that does not fit.
    pub fn close(&mut self, code: CloseCode, reason: &str) -> Result<()> {
        self.ensure_open()?;
        let mut body = [0u8; MAX_CONTROL_PAYLOAD];
        let len = close::body(code, reason, &mut body).map_err(|_| {
            Error::Protocol(alloc::format!(
                "close code {} with a {}-byte reason cannot be sent",
                code.0,
                reason.len()
            ))
        })?;
        self.write_frame(Opcode::Close, body.get(..len).unwrap_or(&[]));
        self.state = State::CloseSent;
        Ok(())
    }

    /// Start the closing handshake with 1001 Going Away, as a draining server does.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent.
    pub fn going_away(&mut self) -> Result<()> {
        self.close(CloseCode::GOING_AWAY, "")
    }

    /// The bytes waiting to be written.
    #[must_use]
    pub fn output(&self) -> &[u8] {
        &self.output
    }

    /// Drop the first `written` bytes of the output once the socket took them.
    ///
    /// # Arguments
    ///
    /// * `written` - how many bytes were written.
    pub fn consume_output(&mut self, written: usize) {
        let written = written.min(self.output.len());
        self.output.drain(..written);
    }

    /// Whether the TCP connection should close once the output is written: a Close
    /// went each way, or the connection failed.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        matches!(self.state, State::Closed | State::Failed)
    }

    /// The status code of the first Close received, if any (RFC 6455 Section 7.1.5).
    #[must_use]
    pub fn close_code(&self) -> Option<CloseCode> {
        self.close_received
    }
}
