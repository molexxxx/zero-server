//! The thread-local last error: the message of the calling thread's most recent
//! refused call.
//!
//! The message lives in a fixed buffer of 256 octets per thread, with a const
//! initializer and no destructor, and a longer message is cut at a UTF-8 boundary, so
//! recording a refusal allocates nothing, takes no lock and registers nothing with the
//! thread. Only `zero_last_error_message`, which copies the message out, allocates.

use std::cell::RefCell;

/// The most octets a message keeps.
pub(crate) const CAPACITY: usize = 256;

/// One thread's message.
struct LastError {
    bytes: [u8; CAPACITY],
    len: usize,
    held: bool,
}

impl LastError {
    const fn new() -> Self {
        LastError {
            bytes: [0; CAPACITY],
            len: 0,
            held: false,
        }
    }

    /// Replace the message with `parts` written one after the other, cut at a UTF-8
    /// boundary once the buffer is full.
    fn set(&mut self, parts: &[&str]) {
        let mut len = 0usize;
        for part in parts {
            let piece = cut(part, CAPACITY.saturating_sub(len));
            let end = len.saturating_add(piece.len());
            if let Some(target) = self.bytes.get_mut(len..end) {
                target.copy_from_slice(piece.as_bytes());
                len = end;
            }
            if piece.len() < part.len() {
                break;
            }
        }
        self.len = len;
        self.held = true;
    }

    fn message(&self) -> Option<&[u8]> {
        if self.held {
            self.bytes.get(..self.len)
        } else {
            None
        }
    }
}

/// The longest prefix of `text` of at most `room` octets that ends on a character
/// boundary.
fn cut(text: &str, room: usize) -> &str {
    if text.len() <= room {
        return text;
    }
    let mut end = room;
    while end > 0 && !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    text.get(..end).unwrap_or_default()
}

thread_local! {
    /// The calling thread's message; a const initializer and no destructor.
    static LAST: RefCell<LastError> = const { RefCell::new(LastError::new()) };
}

/// Record the message of a refused call: `parts` written one after the other. A thread
/// that is exiting, or a message recorded from inside a read of the message, keeps the
/// message it had.
///
/// # Arguments
///
/// * `parts` - the pieces of the message.
pub(crate) fn record(parts: &[&str]) {
    let _ = LAST.try_with(|last| {
        if let Ok(mut last) = last.try_borrow_mut() {
            last.set(parts);
        }
    });
}

/// Read the calling thread's message.
///
/// # Arguments
///
/// * `read` - what to do with the message, `None` when the thread has none.
///
/// # Returns
///
/// What `read` returned.
pub(crate) fn with_message<R>(read: impl FnOnce(Option<&[u8]>) -> R) -> R {
    let copied = LAST
        .try_with(|last| {
            let last = last.try_borrow().ok()?;
            let message = last.message()?;
            let mut bytes = [0u8; CAPACITY];
            bytes.get_mut(..message.len())?.copy_from_slice(message);
            Some((bytes, message.len()))
        })
        .ok()
        .flatten();
    read(copied.as_ref().and_then(|(bytes, len)| bytes.get(..*len)))
}

#[cfg(test)]
mod tests {
    use super::{cut, record, with_message, CAPACITY};

    fn current() -> Option<Vec<u8>> {
        with_message(|message| message.map(<[u8]>::to_vec))
    }

    #[test]
    fn a_thread_starts_with_no_message_and_keeps_the_last_one() {
        std::thread::spawn(|| {
            assert_eq!(current(), None);
            record(&["first"]);
            record(&["second ", "message"]);
            assert_eq!(current().as_deref(), Some(&b"second message"[..]));
        })
        .join()
        .unwrap();
    }

    #[test]
    fn a_long_message_is_cut_at_a_character_boundary() {
        let long = "\u{00e9}".repeat(CAPACITY);
        record(&["x", &long]);
        let kept = current().unwrap();
        assert!(kept.len() <= CAPACITY);
        assert!(kept.len() >= CAPACITY - 1);
        assert!(std::str::from_utf8(&kept).is_ok());
        assert_eq!(cut("\u{00e9}\u{00e9}", 3), "\u{00e9}");
        assert_eq!(cut("abc", 0), "");
    }
}
