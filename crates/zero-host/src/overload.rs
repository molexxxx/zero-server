//! The 503 answers a core writes for a host request it cannot hand on, without
//! crossing to the host.
//!
//! RFC 9110 Section 15.6.4: "The 503 (Service Unavailable) status code indicates
//! that the server is currently unable to handle the request due to a temporary
//! overload or scheduled maintenance, which will likely be alleviated after some
//! delay. The server MAY send a Retry-After header field (Section 10.2.3)". This
//! server always sends it, in the `delay-seconds` form (`1*DIGIT`, Section 10.2.3),
//! with the server's error body. While the server drains, the answer carries the
//! drain's own delay and message and closes the connection: "A server that sends a
//! "close" connection option MUST initiate closure of the connection ... after it
//! sends the response" (RFC 9112 Section 9.6).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-9.6>

use zero_http::{Call, Problem};
use zero_http_types::{HeaderName, StatusCode};

use crate::server::Settings;

/// The code of an overload answer in the problem body.
pub(crate) const SERVICE_UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";

/// The message of the answer written while the server drains.
pub(crate) const SHUTTING_DOWN: &str = "Server is shutting down";

/// Why a host request is answered 503.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Overload {
    /// The core queues its bound of full batches behind the in-flight bound.
    Queue,
    /// No slot is free and the arena cannot grow.
    Arena,
    /// No target is attached to the worker index.
    NoTarget,
    /// The target was lost while the request was queued or leased.
    TargetGone,
    /// The core's host dispatch failed.
    Failed,
    /// The server drains.
    Draining,
}

/// Write the 503 for `overload`: the server's error body, `Retry-After` in
/// delay-seconds and, while draining, the drain message and `Connection: close`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3>
pub(crate) fn answer(call: &mut Call<'_>, settings: &Settings, overload: Overload) {
    let draining = overload == Overload::Draining;
    let problem = Problem {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: SERVICE_UNAVAILABLE,
        detail: draining.then(|| SHUTTING_DOWN.to_owned()),
    };
    call.problem(&problem);
    let seconds = if draining {
        settings.drain_retry_after
    } else {
        settings.retry_after
    };
    let mut digits = [0u8; 10];
    let _ = call
        .response()
        .header_id(HeaderName::RetryAfter, delay_seconds(seconds, &mut digits));
    if draining {
        call.close_after_response();
    }
}

/// `seconds` as `1*DIGIT` in `out`, without allocating.
pub(crate) fn delay_seconds(seconds: u32, out: &mut [u8; 10]) -> &[u8] {
    let mut value = seconds;
    let mut start = out.len();
    loop {
        start = start.saturating_sub(1);
        if let Some(slot) = out.get_mut(start) {
            *slot = b'0'.saturating_add(u8::try_from(value % 10).unwrap_or(0));
        }
        value /= 10;
        if value == 0 || start == 0 {
            break;
        }
    }
    out.get(start..).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::delay_seconds;

    #[test]
    fn retry_after_is_written_in_the_delay_seconds_form_1_digit_or_more_rfc_9110_10_2_3() {
        let mut out = [0u8; 10];
        assert_eq!(delay_seconds(0, &mut out), b"0");
        assert_eq!(delay_seconds(5, &mut out), b"5");
        assert_eq!(delay_seconds(120, &mut out), b"120");
        assert_eq!(delay_seconds(u32::MAX, &mut out), b"4294967295");
    }
}
