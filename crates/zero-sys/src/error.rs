//! Reading the operating system's error codes where `std::io::ErrorKind` does not name
//! them, with the constants of the pinned libc and windows-sys crates.

use std::io;

/// Whether an error says the process or the system is out of descriptors or buffer
/// space (`EMFILE`, `ENFILE`, `ENOBUFS`; `WSAEMFILE`, `WSAENOBUFS` on Windows): a
/// condition that passes with time, so an accept loop pauses rather than ends.
///
/// # Arguments
///
/// * `err` - the error a socket call returned.
///
/// # Returns
///
/// `true` for one of those codes.
#[must_use]
pub fn out_of_resources(err: &io::Error) -> bool {
    let Some(code) = err.raw_os_error() else {
        return false;
    };
    #[cfg(unix)]
    {
        code == libc::EMFILE || code == libc::ENFILE || code == libc::ENOBUFS
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Networking::WinSock::{WSAEMFILE, WSAENOBUFS};
        code == WSAEMFILE || code == WSAENOBUFS
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::out_of_resources;

    #[test]
    fn the_descriptor_codes_are_recognized_and_others_are_not() {
        assert!(out_of_resources(&std::io::Error::from_raw_os_error(
            libc::EMFILE
        )));
        assert!(out_of_resources(&std::io::Error::from_raw_os_error(
            libc::ENFILE
        )));
        assert!(out_of_resources(&std::io::Error::from_raw_os_error(
            libc::ENOBUFS
        )));
        assert!(!out_of_resources(&std::io::Error::from_raw_os_error(
            libc::ECONNRESET
        )));
        assert!(!out_of_resources(&std::io::Error::other("no code")));
    }
}
