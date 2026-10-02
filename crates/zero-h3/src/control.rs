//! The rules that need state across the frames of a control stream: GOAWAY,
//! MAX_PUSH_ID and CANCEL_PUSH.
//!
//! - A client treats a GOAWAY whose stream ID is not a client-initiated
//!   bidirectional stream as H3_ID_ERROR (RFC 9114 Section 7.2.6); a server
//!   receives push IDs, which have no such check.
//! - A GOAWAY larger than the previous one received is H3_ID_ERROR, and the
//!   identifiers an endpoint sends never grow (Section 5.2).
//! - A MAX_PUSH_ID smaller than the previous one is H3_ID_ERROR (Section
//!   7.2.7).
//! - A CANCEL_PUSH above the maximum push ID is H3_ID_ERROR, and a server
//!   that never promised the push answers H3_ID_ERROR too (Section 7.2.3).
//!   This server never sends PUSH_PROMISE, so every CANCEL_PUSH it accepts
//!   at the header is one of the two.
//!
//! The stream and role rules of single frames are the frame decoder's; this
//! module sees only frames that passed them.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-5.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.6>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.7>

use crate::decoder::Role;
use crate::error::Error;
use crate::frame::Frame;
use crate::settings::Settings;
use crate::varint;

/// The state of the peer's control stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerControl {
    local: Role,
    settings: Option<Settings>,
    goaway: Option<u64>,
    max_push_id: Option<u64>,
    local_max_push_id: Option<u64>,
}

impl PeerControl {
    /// Starts before the peer's SETTINGS frame, with no GOAWAY and the
    /// maximum push ID unset.
    ///
    /// # Arguments
    ///
    /// * `local` - the role of the local endpoint.
    #[must_use]
    pub const fn new(local: Role) -> Self {
        Self {
            local,
            settings: None,
            goaway: None,
            max_push_id: None,
            local_max_push_id: None,
        }
    }

    /// Applies one frame of the peer's control stream, as the frame decoder
    /// returned it.
    ///
    /// # Arguments
    ///
    /// * `frame` - the frame.
    ///
    /// # Errors
    ///
    /// [`Error::GoawayStreamType`] for a GOAWAY a client receives that is not
    /// a client-initiated bidirectional stream ID, [`Error::GoawayIncreased`]
    /// for a GOAWAY larger than the previous one, [`Error::MaxPushIdDecreased`]
    /// for a MAX_PUSH_ID smaller than the previous one,
    /// [`Error::PushIdAboveMaximum`] for a CANCEL_PUSH above the maximum push
    /// ID, and [`Error::PushIdNotPromised`] for a CANCEL_PUSH a server
    /// receives within it. The state is unchanged by a failed call.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-5.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.3>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.6>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.7>
    pub fn receive(&mut self, frame: &Frame<'_>) -> Result<(), Error> {
        match *frame {
            Frame::Settings(settings) => self.settings = Some(settings),
            Frame::Goaway { id } => {
                if matches!(self.local, Role::Client) && id & 0x03 != 0 {
                    return Err(Error::GoawayStreamType { id });
                }
                if let Some(previous) = self.goaway {
                    if id > previous {
                        return Err(Error::GoawayIncreased { id, previous });
                    }
                }
                self.goaway = Some(id);
            }
            Frame::MaxPushId { push_id } => {
                if let Some(previous) = self.max_push_id {
                    if push_id < previous {
                        return Err(Error::MaxPushIdDecreased { push_id, previous });
                    }
                }
                self.max_push_id = Some(push_id);
            }
            Frame::CancelPush { push_id } => {
                let maximum = match self.local {
                    Role::Server => self.max_push_id,
                    Role::Client => self.local_max_push_id,
                };
                if maximum.is_none_or(|maximum| push_id > maximum) {
                    return Err(Error::PushIdAboveMaximum { push_id });
                }
                if matches!(self.local, Role::Server) {
                    return Err(Error::PushIdNotPromised { push_id });
                }
            }
            Frame::Headers { .. } | Frame::PushPromise { .. } => {}
        }
        Ok(())
    }

    /// Records a MAX_PUSH_ID this client sent, the maximum a CANCEL_PUSH it
    /// receives is checked against.
    ///
    /// # Arguments
    ///
    /// * `push_id` - the push ID the frame carried.
    pub const fn sent_max_push_id(&mut self, push_id: u64) {
        self.local_max_push_id = Some(push_id);
    }

    /// The peer's settings.
    ///
    /// Before the peer's SETTINGS frame arrives every value is at its
    /// default, which RFC 9114 Section 7.2.4.2 makes the initial value for a
    /// server ("For servers, the initial value of each client setting is the
    /// default value.") and for a client on a 1-RTT connection ("For clients
    /// using a 1-RTT QUIC connection, the initial value of each server setting
    /// is the default value."). It is not the initial value for a client
    /// attempting 0-RTT: "When a 0-RTT QUIC connection is being used, the
    /// initial value of each server setting is the value used in the previous
    /// session", and such a client applies its stored settings itself until
    /// this method returns the server's.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.4.2>
    ///
    /// # Returns
    ///
    /// The settings received, or [`Settings::EMPTY`] before they arrive.
    #[must_use]
    pub fn settings(&self) -> Settings {
        self.settings.unwrap_or(Settings::EMPTY)
    }

    /// The identifier of the last GOAWAY received, if any.
    #[must_use]
    pub const fn goaway(&self) -> Option<u64> {
        self.goaway
    }

    /// The maximum push ID the peer allowed, or `None` while it is unset.
    #[must_use]
    pub const fn max_push_id(&self) -> Option<u64> {
        self.max_push_id
    }
}

/// The GOAWAY identifiers this endpoint sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GoawaySender {
    local: Role,
    last: Option<u64>,
}

impl GoawaySender {
    /// 2^62-4: the largest client-initiated bidirectional stream ID, a
    /// server's first GOAWAY in a graceful shutdown.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-5.2>
    pub const GRACEFUL_SERVER: u64 = 0x3FFF_FFFF_FFFF_FFFC;
    /// 2^62-1: a client's first GOAWAY in a graceful shutdown.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-5.2>
    pub const GRACEFUL_CLIENT: u64 = varint::MAX;

    /// Starts with no GOAWAY sent.
    ///
    /// # Arguments
    ///
    /// * `local` - the role of the local endpoint.
    #[must_use]
    pub const fn new(local: Role) -> Self {
        Self { local, last: None }
    }

    /// Accepts `id` for a GOAWAY and records it.
    ///
    /// # Arguments
    ///
    /// * `id` - a client-initiated bidirectional stream ID for a server, a
    ///   push ID for a client.
    ///
    /// # Returns
    ///
    /// `id`, or `None` when it is larger than a previous GOAWAY's ("the
    /// identifier in each frame MUST NOT be greater than the identifier in
    /// any previous frame", RFC 9114 Section 5.2), above 2^62-1, or, for a
    /// server, not a client-initiated bidirectional stream ID.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-5.2>
    pub fn send(&mut self, id: u64) -> Option<u64> {
        if id > varint::MAX || (matches!(self.local, Role::Server) && id & 0x03 != 0) {
            return None;
        }
        if self.last.is_some_and(|last| id > last) {
            return None;
        }
        self.last = Some(id);
        Some(id)
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{GoawaySender, PeerControl};
    use crate::decoder::Role;
    use crate::error::{Error, ErrorCode};
    use crate::frame::Frame;
    use crate::settings::Settings;
    use crate::xorshift::{iterations, unhex, Rng};
    use zero_limits::Http3Limits;

    /// RFC 9114 Section 7.2.3: "If a CANCEL_PUSH frame is received that
    /// references a push ID greater than currently allowed on the connection,
    /// this MUST be treated as a connection error of type H3_ID_ERROR."
    #[test]
    fn a_cancel_push_above_the_maximum_push_id_is_h3_id_error() {
        let mut server = PeerControl::new(Role::Server);
        let unset = server.receive(&Frame::CancelPush { push_id: 0 });
        assert_eq!(unset, Err(Error::PushIdAboveMaximum { push_id: 0 }));
        assert_eq!(
            unset.map_err(|error| error.code()),
            Err(ErrorCode::H3_ID_ERROR)
        );
        assert_eq!(server.receive(&Frame::MaxPushId { push_id: 5 }), Ok(()));
        assert_eq!(
            server.receive(&Frame::CancelPush { push_id: 6 }),
            Err(Error::PushIdAboveMaximum { push_id: 6 })
        );
        let mut client = PeerControl::new(Role::Client);
        assert_eq!(
            client.receive(&Frame::CancelPush { push_id: 0 }),
            Err(Error::PushIdAboveMaximum { push_id: 0 })
        );
        client.sent_max_push_id(5);
        assert_eq!(
            client.receive(&Frame::CancelPush { push_id: 6 }),
            Err(Error::PushIdAboveMaximum { push_id: 6 })
        );
        assert_eq!(client.receive(&Frame::CancelPush { push_id: 5 }), Ok(()));
    }

    /// RFC 9114 Section 7.2.3: "If a server receives a CANCEL_PUSH frame for a
    /// push ID that has not yet been mentioned by a PUSH_PROMISE frame, this
    /// MUST be treated as a connection error of type H3_ID_ERROR."
    #[test]
    fn a_server_receiving_cancel_push_for_a_push_never_promised_is_h3_id_error() {
        let mut server = PeerControl::new(Role::Server);
        assert_eq!(server.receive(&Frame::MaxPushId { push_id: 5 }), Ok(()));
        for push_id in 0..=5u64 {
            let error = server.receive(&Frame::CancelPush { push_id });
            assert_eq!(error, Err(Error::PushIdNotPromised { push_id }));
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_ID_ERROR)
            );
        }
        let mut client = PeerControl::new(Role::Client);
        client.sent_max_push_id(5);
        for push_id in 0..=5u64 {
            assert_eq!(client.receive(&Frame::CancelPush { push_id }), Ok(()));
        }
    }

    /// RFC 9114 Section 7.2.6: "A client MUST treat receipt of a GOAWAY frame
    /// containing a stream ID of any other type as a connection error of type
    /// H3_ID_ERROR."
    #[test]
    fn a_client_receiving_goaway_with_a_stream_id_not_client_bidirectional_is_h3_id_error() {
        for id in [1u64, 2, 3, 5, 6, 7, 0x3FFF_FFFF_FFFF_FFFF] {
            let mut client = PeerControl::new(Role::Client);
            let error = client.receive(&Frame::Goaway { id });
            assert_eq!(error, Err(Error::GoawayStreamType { id }));
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_ID_ERROR)
            );
            assert_eq!(client.goaway(), None);
        }
        for id in [0u64, 4, 8, GoawaySender::GRACEFUL_SERVER] {
            let mut client = PeerControl::new(Role::Client);
            assert_eq!(client.receive(&Frame::Goaway { id }), Ok(()));
            assert_eq!(client.goaway(), Some(id));
        }
        let mut server = PeerControl::new(Role::Server);
        assert_eq!(server.receive(&Frame::Goaway { id: 3 }), Ok(()));
        assert_eq!(server.goaway(), Some(3));
    }

    /// RFC 9114 Section 5.2: "Receiving a GOAWAY containing a larger identifier
    /// than previously received MUST be treated as a connection error of type
    /// H3_ID_ERROR."
    #[test]
    fn a_goaway_with_a_larger_identifier_than_before_is_h3_id_error() {
        let mut client = PeerControl::new(Role::Client);
        for id in [8u64, 4, 4] {
            assert_eq!(client.receive(&Frame::Goaway { id }), Ok(()));
        }
        let error = client.receive(&Frame::Goaway { id: 8 });
        assert_eq!(error, Err(Error::GoawayIncreased { id: 8, previous: 4 }));
        assert_eq!(
            error.map_err(|error| error.code()),
            Err(ErrorCode::H3_ID_ERROR)
        );
        assert_eq!(client.goaway(), Some(4));
        let mut server = PeerControl::new(Role::Server);
        assert_eq!(server.receive(&Frame::Goaway { id: 3 }), Ok(()));
        assert_eq!(
            server.receive(&Frame::Goaway { id: 5 }),
            Err(Error::GoawayIncreased { id: 5, previous: 3 })
        );
    }

    /// RFC 9114 Section 5.2: "An endpoint MAY send multiple GOAWAY frames
    /// indicating different identifiers, but the identifier in each frame MUST
    /// NOT be greater than the identifier in any previous frame" and "An
    /// endpoint that is attempting to gracefully shut down a connection can
    /// send a GOAWAY frame with a value set to the maximum possible value
    /// (2^62-4 for servers, 2^62-1 for clients)."
    #[test]
    fn goaway_identifiers_sent_never_increase_and_the_graceful_server_value_is_2_62_minus_4() {
        assert_eq!(GoawaySender::GRACEFUL_SERVER, 4_611_686_018_427_387_900);
        assert_eq!(GoawaySender::GRACEFUL_CLIENT, 4_611_686_018_427_387_903);
        let mut server = GoawaySender::new(Role::Server);
        assert_eq!(
            server.send(GoawaySender::GRACEFUL_SERVER),
            Some(GoawaySender::GRACEFUL_SERVER)
        );
        let mut frame = Vec::new();
        assert_eq!(
            Frame::Goaway {
                id: GoawaySender::GRACEFUL_SERVER
            }
            .encode(&mut frame),
            Some(())
        );
        assert_eq!(frame, unhex("0708fffffffffffffffc"));
        assert_eq!(server.send(8), Some(8));
        assert_eq!(server.send(8), Some(8));
        assert_eq!(server.send(12), None);
        assert_eq!(server.send(5), None);
        assert_eq!(server.send(4), Some(4));
        let mut fresh = GoawaySender::new(Role::Server);
        assert_eq!(fresh.send(GoawaySender::GRACEFUL_CLIENT), None);
        let mut client = GoawaySender::new(Role::Client);
        assert_eq!(
            client.send(GoawaySender::GRACEFUL_CLIENT),
            Some(GoawaySender::GRACEFUL_CLIENT)
        );
        assert_eq!(
            client.send(GoawaySender::GRACEFUL_CLIENT.saturating_add(1)),
            None
        );
        assert_eq!(client.send(3), Some(3));
        assert_eq!(client.send(4), None);
    }

    /// RFC 9114 Section 7.2.7: "A MAX_PUSH_ID frame cannot reduce the maximum
    /// push ID; receipt of a MAX_PUSH_ID frame that contains a smaller value
    /// than previously received MUST be treated as a connection error of type
    /// H3_ID_ERROR."
    #[test]
    fn a_max_push_id_smaller_than_previously_received_is_h3_id_error() {
        let mut server = PeerControl::new(Role::Server);
        assert_eq!(server.max_push_id(), None);
        assert_eq!(server.receive(&Frame::MaxPushId { push_id: 0 }), Ok(()));
        assert_eq!(server.max_push_id(), Some(0));
        assert_eq!(server.receive(&Frame::MaxPushId { push_id: 5 }), Ok(()));
        assert_eq!(server.receive(&Frame::MaxPushId { push_id: 5 }), Ok(()));
        let error = server.receive(&Frame::MaxPushId { push_id: 4 });
        assert_eq!(
            error,
            Err(Error::MaxPushIdDecreased {
                push_id: 4,
                previous: 5
            })
        );
        assert_eq!(
            error.map_err(|error| error.code()),
            Err(ErrorCode::H3_ID_ERROR)
        );
        assert_eq!(server.max_push_id(), Some(5));
    }

    /// RFC 9114 Section 7.2.4.2: "For servers, the initial value of each
    /// client setting is the default value." and "For clients using a 1-RTT
    /// QUIC connection, the initial value of each server setting is the
    /// default value."
    #[test]
    fn the_peer_settings_are_the_defaults_until_its_settings_frame_arrives() {
        assert_eq!(PeerControl::new(Role::Client).settings(), Settings::EMPTY);
        let mut server = PeerControl::new(Role::Server);
        assert_eq!(server.settings(), Settings::EMPTY);
        assert_eq!(server.settings().max_field_section_size_or_default(), None);
        let received = Settings::server(&Http3Limits::DEFAULT);
        assert_eq!(server.receive(&Frame::Settings(received)), Ok(()));
        assert_eq!(server.settings(), received);
        assert_eq!(
            server.receive(&Frame::Headers { field_section: &[] }),
            Ok(())
        );
        assert_eq!(server.goaway(), None);
    }

    /// RFC 9114 Section 5.2: "Receiving a GOAWAY containing a larger
    /// identifier than previously received MUST be treated as a connection
    /// error of type H3_ID_ERROR.", and Section 7.2.7: "A MAX_PUSH_ID frame
    /// cannot reduce the maximum push ID"; across random
    /// control frames the received values only move in those directions, and
    /// a refused frame leaves the state unchanged.
    #[test]
    fn random_control_frames_keep_goaway_and_max_push_id_monotonic() {
        let mut rng = Rng::new(0x5EED_000E);
        for _ in 0..iterations(500) {
            let local = if rng.below(2) == 0 {
                Role::Server
            } else {
                Role::Client
            };
            let mut control = PeerControl::new(local);
            for _ in 0..16 {
                let value = rng.below(64);
                let frame = match rng.below(3) {
                    0 => Frame::Goaway { id: value },
                    1 => Frame::MaxPushId { push_id: value },
                    _ => Frame::CancelPush { push_id: value },
                };
                let before = control;
                if control.receive(&frame).is_err() {
                    assert_eq!(control, before);
                }
                if let (Some(old), Some(new)) = (before.goaway(), control.goaway()) {
                    assert!(new <= old);
                }
                if let (Some(old), Some(new)) = (before.max_push_id(), control.max_push_id()) {
                    assert!(new >= old);
                }
            }
        }
    }
}
