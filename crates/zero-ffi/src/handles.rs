//! The owned handles: strings and buffers the library allocates and hands to a host,
//! released only by their free functions.
//!
//! A handle is a box given out with `Box::into_raw`. The library frees what it
//! allocated and never frees host memory (ANSSI FFI-MEM-OWNER), so a handle goes back
//! only through [`reclaim`], in its free function, and its accessors read it through
//! [`peek`]. Both take NULL as no handle. A handle is an owned pointer, not a checked
//! id: using one after its free is a host error, as with `free(3)`.
//!
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#memory-and-resource-management>

use std::ffi::c_char;

/// An owned UTF-8 string the library allocated, terminated by NUL. Released only by
/// `zero_string_free`.
#[derive(Debug)]
pub struct ZeroString {
    /// The text and its terminating NUL.
    bytes: Box<[u8]>,
}

impl ZeroString {
    /// Hand out a copy of `text` as a new string.
    pub(crate) fn into_raw(text: &[u8]) -> *mut ZeroString {
        let mut bytes = Vec::with_capacity(text.len().saturating_add(1));
        bytes.extend_from_slice(text);
        bytes.push(0);
        Box::into_raw(Box::new(ZeroString {
            bytes: bytes.into_boxed_slice(),
        }))
    }

    /// The text, terminated by NUL.
    pub(crate) fn data(&self) -> *const c_char {
        self.bytes.as_ptr().cast()
    }

    /// The length of the text in octets, without the terminator.
    pub(crate) fn text_len(&self) -> usize {
        self.bytes.len().saturating_sub(1)
    }
}

/// Owned bytes the library allocated. Released only by `zero_buffer_free`.
#[derive(Debug)]
pub struct ZeroBuffer {
    bytes: Box<[u8]>,
}

impl ZeroBuffer {
    /// Hand out `bytes` as a new buffer.
    pub(crate) fn into_raw(bytes: Vec<u8>) -> *mut ZeroBuffer {
        Box::into_raw(Box::new(ZeroBuffer {
            bytes: bytes.into_boxed_slice(),
        }))
    }

    /// The first byte; not NULL, also for an empty buffer.
    pub(crate) fn data(&self) -> *const u8 {
        self.bytes.as_ptr()
    }

    /// The number of bytes.
    pub(crate) fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

/// A type handed out as an owned handle.
pub(crate) trait Handle {}

impl Handle for ZeroString {}

impl Handle for ZeroBuffer {}

/// Borrow a handle for the call.
///
/// # Arguments
///
/// * `handle` - the handle, or NULL.
///
/// # Returns
///
/// The handle, or `None` for NULL.
///
/// # Safety
///
/// `handle` must be NULL or a handle this library returned and that has not been freed.
#[allow(unsafe_code)]
pub(crate) unsafe fn peek<'a, T: Handle>(handle: *const T) -> Option<&'a T> {
    // SAFETY: the caller guarantees `handle` is NULL, which `as_ref` maps to `None`, or a
    // live box this library handed out, which nothing frees while the call borrows it.
    unsafe { handle.as_ref() }
}

/// Take a handle back and drop it.
///
/// # Arguments
///
/// * `handle` - the handle, or NULL, which does nothing.
///
/// # Safety
///
/// `handle` must be NULL or a handle this library returned and that has not been freed;
/// it must not be used again.
#[allow(unsafe_code)]
pub(crate) unsafe fn reclaim<T: Handle>(handle: *mut T) {
    if handle.is_null() {
        return;
    }
    // SAFETY: `handle` is not NULL, so the caller guarantees it came from `Box::into_raw`
    // here and was not freed before, and the free hands its ownership back.
    drop(unsafe { Box::from_raw(handle) });
}

#[cfg(test)]
#[allow(unsafe_code)]
mod tests {
    use std::ffi::CStr;
    use std::ptr;

    use super::{peek, reclaim, ZeroBuffer, ZeroString};

    #[test]
    fn a_string_is_terminated_and_reads_back_until_it_is_reclaimed() {
        let handle = ZeroString::into_raw(b"text");
        // SAFETY: `handle` was just handed out.
        let string = unsafe { peek(handle.cast_const()) }.unwrap();
        assert_eq!(string.text_len(), 4);
        // SAFETY: the data is the text and a terminating NUL.
        let text = unsafe { CStr::from_ptr(string.data()) };
        assert_eq!(text.to_bytes(), b"text");
        // SAFETY: `handle` is live and is not used again.
        unsafe { reclaim(handle) };
    }

    #[test]
    fn a_buffer_reads_back_and_null_is_no_handle() {
        let handle = ZeroBuffer::into_raw(vec![1, 2, 3]);
        // SAFETY: `handle` was just handed out.
        let buffer = unsafe { peek(handle.cast_const()) }.unwrap();
        assert_eq!(buffer.byte_len(), 3);
        assert!(!buffer.data().is_null());
        // SAFETY: `handle` is live and is not used again.
        unsafe { reclaim(handle) };
        let empty = ZeroBuffer::into_raw(Vec::new());
        // SAFETY: `empty` was just handed out.
        assert!(!unsafe { peek(empty.cast_const()) }
            .unwrap()
            .data()
            .is_null());
        // SAFETY: `empty` is live and is not used again.
        unsafe { reclaim(empty) };
        // SAFETY: NULL is no handle.
        assert!(unsafe { peek::<ZeroString>(ptr::null()) }.is_none());
        // SAFETY: NULL is no handle.
        unsafe { reclaim::<ZeroBuffer>(ptr::null_mut()) };
    }
}
