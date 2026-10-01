//! Close frames and their status codes.
//!
//! A Close body is empty, or "the first two bytes of the body MUST be a 2-byte
//! unsigned integer (in network byte order) representing a status code", followed by
//! an optional UTF-8 reason (RFC 6455 Section 5.5.1), all within the 125 bytes of a
//! control frame (Section 5.5). 1005, 1006 and 1015 "MUST NOT be set as a status code
//! in a Close control frame by an endpoint" (Section 7.4.1); 0 to 999 "are not used";
//! and the rest of 1000 to 2999 is for this protocol and its extensions (Section
//! 7.4.2). A code is accepted on a received frame and allowed on a sent one when the
//! IANA WebSocket Close Code Number Registry assigns it to a closure an endpoint may
//! signal (1000 to 1003 and 1007 to 1014) or when it falls in 3000 to 4999, which
//! libraries, frameworks, applications and private agreements use.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.1>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4>
//! @see <https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number>

/// The largest Close reason: a control frame's 125 bytes less the status code.
pub const MAX_REASON: usize = 123;

/// A close status code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CloseCode(pub u16);

impl CloseCode {
    /// 1000: the purpose of the connection is fulfilled.
    pub const NORMAL: Self = Self(1000);
    /// 1001: the endpoint is going away, such as a server shutting down.
    pub const GOING_AWAY: Self = Self(1001);
    /// 1002: a protocol error.
    pub const PROTOCOL_ERROR: Self = Self(1002);
    /// 1003: a type of data the endpoint cannot accept.
    pub const UNSUPPORTED_DATA: Self = Self(1003);
    /// 1005: no status code was present; never sent.
    pub const NO_STATUS: Self = Self(1005);
    /// 1006: the connection closed without a Close frame; never sent.
    pub const ABNORMAL: Self = Self(1006);
    /// 1007: data inconsistent with the message type, such as text that is not UTF-8.
    pub const INVALID_PAYLOAD: Self = Self(1007);
    /// 1008: a message that violates the endpoint's policy.
    pub const POLICY_VIOLATION: Self = Self(1008);
    /// 1009: a message too big to process.
    pub const MESSAGE_TOO_BIG: Self = Self(1009);
    /// 1010: an extension the client needed was not negotiated.
    pub const MANDATORY_EXTENSION: Self = Self(1010);
    /// 1011: the server met an unexpected condition.
    pub const INTERNAL_ERROR: Self = Self(1011);
    /// 1012: the service is restarting.
    pub const SERVICE_RESTART: Self = Self(1012);
    /// 1013: try again later.
    pub const TRY_AGAIN_LATER: Self = Self(1013);
    /// 1014: a gateway or proxy received an invalid upstream response.
    pub const BAD_GATEWAY: Self = Self(1014);
    /// 1015: the TLS handshake failed; never sent.
    pub const TLS_HANDSHAKE: Self = Self(1015);

    /// Whether the code may stand in a Close frame, sent or received.
    ///
    /// # Returns
    ///
    /// `true` for 1000 to 1003, 1007 to 1014, and 3000 to 4999.
    #[must_use]
    pub const fn is_valid(self) -> bool {
        matches!(self.0, 1000..=1003 | 1007..=1014 | 3000..=4999)
    }
}

/// What a received Close frame carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Close<'a> {
    /// The status code, or [`CloseCode::NO_STATUS`] for an empty body.
    pub code: CloseCode,
    /// The reason, empty when none was sent.
    pub reason: &'a str,
}

/// Read a received Close body.
///
/// # Arguments
///
/// * `payload` - the unmasked application data of the Close frame.
///
/// # Returns
///
/// The code and reason.
///
/// # Errors
///
/// [`CloseCode::PROTOCOL_ERROR`] for a one-byte body or a code that may not be
/// sent; [`CloseCode::INVALID_PAYLOAD`] for a reason that is not UTF-8.
pub fn parse(payload: &[u8]) -> Result<Close<'_>, CloseCode> {
    let Some((code, reason)) = payload.split_first_chunk::<2>() else {
        return if payload.is_empty() {
            Ok(Close {
                code: CloseCode::NO_STATUS,
                reason: "",
            })
        } else {
            Err(CloseCode::PROTOCOL_ERROR)
        };
    };
    let code = CloseCode(u16::from_be_bytes(*code));
    if !code.is_valid() {
        return Err(CloseCode::PROTOCOL_ERROR);
    }
    let reason = core::str::from_utf8(reason).map_err(|_| CloseCode::INVALID_PAYLOAD)?;
    Ok(Close { code, reason })
}

/// Build a Close body.
///
/// # Arguments
///
/// * `code` - the status code; [`CloseCode::NO_STATUS`] for an empty body.
/// * `reason` - the reason, at most [`MAX_REASON`] bytes; ignored without a code.
/// * `out` - receives the body; cleared first.
///
/// # Errors
///
/// [`CloseCode::INTERNAL_ERROR`] for a code that may not be sent or a reason that
/// does not fit; nothing is written then.
pub fn body(code: CloseCode, reason: &str, out: &mut [u8; 125]) -> Result<usize, CloseCode> {
    if code == CloseCode::NO_STATUS {
        return Ok(0);
    }
    if !code.is_valid() || reason.len() > MAX_REASON {
        return Err(CloseCode::INTERNAL_ERROR);
    }
    let (head, tail) = out.split_at_mut(2);
    head.copy_from_slice(&code.0.to_be_bytes());
    if let Some(slot) = tail.get_mut(..reason.len()) {
        slot.copy_from_slice(reason.as_bytes());
    }
    Ok(2usize.saturating_add(reason.len()))
}
