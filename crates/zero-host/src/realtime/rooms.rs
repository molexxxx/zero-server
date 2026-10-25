//! The rooms of a server: joining and leaving, which a connection applies in order
//! with what is sent on it, and broadcasts, which reach every member on every core
//! but the one left out.

use zero_core::slot::MAX_ENCODED;
use zero_realtime::{Command, MemberId, Rooms};

use super::ws::{push, websocket};
use super::{OPCODE_BINARY, OPCODE_TEXT};
use crate::HostError;

/// A room's name: UTF-8.
fn name(room: &[u8]) -> Result<&str, HostError> {
    std::str::from_utf8(room).map_err(|_| HostError::invalid("a room's name is UTF-8"))
}

pub(super) fn join(conn: u64, room: &[u8]) -> Result<(), HostError> {
    let room = name(room)?;
    let live = websocket(conn)?;
    push(&live, conn, Command::Join(room.to_owned()))
}

pub(super) fn leave(conn: u64, room: &[u8]) -> Result<(), HostError> {
    let room = name(room)?;
    let live = websocket(conn)?;
    push(&live, conn, Command::Leave(room.to_owned()))
}

/// Send a message to every member of a room but `except`.
///
/// # Returns
///
/// How many members it was queued for.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a name or a text
/// that is not UTF-8, another opcode, or an `except` above 2^53 - 1.
pub(crate) fn broadcast(
    rooms: &Rooms,
    room: &[u8],
    opcode: u8,
    data: &[u8],
    except: Option<u64>,
) -> Result<u64, HostError> {
    let room = name(room)?;
    let except = match except {
        Some(conn) if conn > MAX_ENCODED => {
            return Err(HostError::invalid(format!(
                "the connection id {conn} is out of range"
            )))
        }
        Some(conn) => Some(MemberId::of_connection(conn)),
        None => None,
    };
    let delivered = match opcode {
        OPCODE_TEXT => {
            let text = std::str::from_utf8(data).map_err(|_| {
                HostError::invalid("a text message is UTF-8 (RFC 6455 Section 5.6)")
            })?;
            rooms.broadcast_text(room, text, except)
        }
        OPCODE_BINARY => rooms.broadcast_binary(room, data, except),
        other => {
            return Err(HostError::invalid(format!(
                "a message is sent as text (1) or binary (2), not opcode {other}"
            )))
        }
    };
    Ok(u64::try_from(delivered).unwrap_or(u64::MAX))
}

/// How many connections are in a room.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a name that is
/// not UTF-8.
pub(crate) fn size(rooms: &Rooms, room: &[u8]) -> Result<u64, HostError> {
    Ok(u64::try_from(rooms.members(name(room)?)).unwrap_or(u64::MAX))
}
