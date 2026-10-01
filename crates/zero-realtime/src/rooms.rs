//! Rooms: named groups of WebSocket connections that a message is broadcast to, on
//! every core.
//!
//! A [`Rooms`] table is shared by every core. Each connection that joins a room gets
//! an inbox; a broadcast encodes the frame once, puts a shared reference to it in
//! the inbox of every member, and wakes each member's connection task on whatever
//! core it runs, through the task's [`Waker`], which is `Send` and `Sync` for exactly
//! this. The connection writes the frames from its inbox in the order they arrived,
//! after anything it queued itself, and writes none once its Close went out. An inbox
//! holds at most [`INBOX_BYTES`] by default; a member that falls that far behind is
//! closed with 1013 Try Again Later rather than holding unbounded memory on the
//! server (RFC 6455 Section 10.4 asks an endpoint to protect itself from exceeding
//! its limits).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-10.4>
//! @see <https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number>

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::task::{Context, Poll, Waker};

use zero_ws::frame::{self, Opcode};

/// The most bytes of broadcast frames a connection may have waiting.
pub const INBOX_BYTES: usize = 16 * 1024 * 1024;

/// The id of one connection in the rooms it joined.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MemberId(u64);

/// What a connection's inbox holds.
#[derive(Debug, Default)]
struct Queue {
    frames: VecDeque<Arc<[u8]>>,
    bytes: usize,
    overflowed: bool,
    waker: Option<Waker>,
}

/// The frames other connections broadcast to one connection.
#[derive(Debug, Default)]
pub(crate) struct Inbox {
    queue: Mutex<Queue>,
}

impl Inbox {
    fn push(&self, frame: &Arc<[u8]>, limit: usize) {
        let waker = {
            let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
            if queue.overflowed {
                return;
            }
            let bytes = queue.bytes.saturating_add(frame.len());
            if bytes > limit {
                queue.overflowed = true;
                queue.frames.clear();
                queue.bytes = 0;
            } else {
                queue.bytes = bytes;
                queue.frames.push_back(Arc::clone(frame));
            }
            queue.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Ready once a frame waits or the inbox overflowed; registers the task otherwise.
    pub(crate) fn poll_ready(&self, cx: &Context<'_>) -> Poll<()> {
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        if queue.overflowed || !queue.frames.is_empty() {
            return Poll::Ready(());
        }
        queue.waker = Some(cx.waker().clone());
        Poll::Pending
    }

    /// Take the waiting frames, and whether the inbox overflowed.
    pub(crate) fn take(&self) -> (VecDeque<Arc<[u8]>>, bool) {
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        queue.bytes = 0;
        (std::mem::take(&mut queue.frames), queue.overflowed)
    }
}

/// One member of a room.
#[derive(Debug, Clone)]
struct Member {
    id: MemberId,
    inbox: Arc<Inbox>,
}

/// The rooms of a server, shared by every core.
#[derive(Debug)]
pub struct Rooms {
    rooms: RwLock<HashMap<String, Vec<Member>>>,
    next: AtomicU64,
    inbox_limit: usize,
}

impl Default for Rooms {
    fn default() -> Self {
        Rooms::with_inbox_limit(INBOX_BYTES)
    }
}

impl Rooms {
    /// No rooms yet, with inboxes of [`INBOX_BYTES`].
    #[must_use]
    pub fn new() -> Self {
        Rooms::default()
    }

    /// No rooms yet, with inboxes of `bytes`.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the most bytes of broadcast frames a connection may have
    ///   waiting before it is closed with 1013.
    #[must_use]
    pub fn with_inbox_limit(bytes: usize) -> Self {
        Rooms {
            rooms: RwLock::new(HashMap::new()),
            next: AtomicU64::new(0),
            inbox_limit: bytes,
        }
    }

    /// How many connections are in a room.
    ///
    /// # Arguments
    ///
    /// * `room` - the room's name.
    #[must_use]
    pub fn members(&self, room: &str) -> usize {
        self.rooms
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(room)
            .map_or(0, Vec::len)
    }

    /// Send a text message to every member of a room.
    ///
    /// # Arguments
    ///
    /// * `room` - the room's name.
    /// * `text` - the message.
    /// * `except` - a member to leave out, usually the sender.
    ///
    /// # Returns
    ///
    /// How many members it was queued for.
    pub fn broadcast_text(&self, room: &str, text: &str, except: Option<MemberId>) -> usize {
        self.broadcast(room, Opcode::Text, text.as_bytes(), except)
    }

    /// Send a binary message to every member of a room.
    ///
    /// # Arguments
    ///
    /// * `room` - the room's name.
    /// * `data` - the message.
    /// * `except` - a member to leave out, usually the sender.
    ///
    /// # Returns
    ///
    /// How many members it was queued for.
    pub fn broadcast_binary(&self, room: &str, data: &[u8], except: Option<MemberId>) -> usize {
        self.broadcast(room, Opcode::Binary, data, except)
    }

    fn broadcast(
        &self,
        room: &str,
        opcode: Opcode,
        payload: &[u8],
        except: Option<MemberId>,
    ) -> usize {
        let members: Vec<Member> = {
            let rooms = self.rooms.read().unwrap_or_else(PoisonError::into_inner);
            let Some(members) = rooms.get(room) else {
                return 0;
            };
            members
                .iter()
                .filter(|member| Some(member.id) != except)
                .cloned()
                .collect()
        };
        if members.is_empty() {
            return 0;
        }
        let mut encoded = Vec::with_capacity(payload.len().saturating_add(10));
        frame::write(opcode, payload, &mut encoded);
        let encoded: Arc<[u8]> = Arc::from(encoded);
        for member in &members {
            member.inbox.push(&encoded, self.inbox_limit);
        }
        members.len()
    }

    fn enter(&self, room: &str, member: Member) {
        let mut rooms = self.rooms.write().unwrap_or_else(PoisonError::into_inner);
        let members = rooms.entry(room.to_owned()).or_default();
        if !members.iter().any(|existing| existing.id == member.id) {
            members.push(member);
        }
    }

    fn exit(&self, room: &str, id: MemberId) {
        let mut rooms = self.rooms.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(members) = rooms.get_mut(room) {
            members.retain(|member| member.id != id);
            if members.is_empty() {
                rooms.remove(room);
            }
        }
    }
}

/// One connection's place in the rooms: its inbox and the rooms it joined, left
/// when the connection ends.
#[derive(Debug)]
pub(crate) struct Membership {
    pub(crate) id: MemberId,
    pub(crate) inbox: Arc<Inbox>,
    rooms: Arc<Rooms>,
    joined: Vec<String>,
}

impl Membership {
    pub(crate) fn new(rooms: &Arc<Rooms>) -> Self {
        let id = MemberId(rooms.next.fetch_add(1, Ordering::Relaxed));
        Membership {
            id,
            inbox: Arc::new(Inbox::default()),
            rooms: Arc::clone(rooms),
            joined: Vec::new(),
        }
    }

    /// Whether this membership belongs to `rooms`.
    pub(crate) fn is_in(&self, rooms: &Arc<Rooms>) -> bool {
        Arc::ptr_eq(&self.rooms, rooms)
    }

    pub(crate) fn join(&mut self, room: &str) {
        self.rooms.enter(
            room,
            Member {
                id: self.id,
                inbox: Arc::clone(&self.inbox),
            },
        );
        if !self.joined.iter().any(|joined| joined == room) {
            self.joined.push(room.to_owned());
        }
    }

    pub(crate) fn leave(&mut self, room: &str) {
        self.rooms.exit(room, self.id);
        self.joined.retain(|joined| joined != room);
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        for room in std::mem::take(&mut self.joined) {
            self.rooms.exit(&room, self.id);
        }
    }
}
