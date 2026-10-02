//! The file-opening call static file serving needs: an open that refuses to follow
//! a symbolic link in its final component and never waits for the writer of a FIFO.
//!
//! On Unix the open passes `O_NOFOLLOW` (open(2): "If the trailing component (i.e.,
//! basename) of pathname is a symbolic link, then the open fails") and `O_NONBLOCK`
//! through the standard library's `custom_flags`. POSIX `open()` on a FIFO: "If
//! O_NONBLOCK is clear, an open() for reading-only shall block the calling thread until
//! a thread opens the file for writing", so without the flag one request for a FIFO
//! under a served directory would hold a worker thread for good; with it the open
//! "shall return without delay" and the caller sees the file type on the open
//! descriptor. The flag is then cleared with `fcntl`, because Linux warns that
//! "applications should not depend upon blocking behavior when specifying this flag for
//! regular files", so a caller reads the file exactly as before. Windows has no such
//! flags; a caller there resolves the path and compares it against its root after the
//! open, which the static file crate does on every platform as its second line.
//!
//! @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html>
//! @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/fcntl.html>
//! @see <https://man7.org/linux/man-pages/man2/open.2.html>

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Open `path` for reading without following a symbolic link in its final
/// component, and without waiting when `path` names a FIFO that no process has open
/// for writing.
///
/// The returned file is in blocking mode. A FIFO, a directory or a device node opens
/// like a regular file does; a caller that serves only regular files checks the type
/// on the returned file, not on the path.
///
/// # Arguments
///
/// * `path` - the file.
///
/// # Returns
///
/// The open file.
///
/// # Errors
///
/// The operating system's error; on Unix, `ELOOP` when the final component is a
/// symbolic link, and the error of `fcntl` when the descriptor cannot be returned to
/// blocking mode.
///
/// @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html>
pub fn open_nofollow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    clear_nonblocking(&file)?;
    Ok(file)
}

/// The file status flags of the open file description `file` refers to (`F_GETFL`).
#[cfg(unix)]
#[allow(unsafe_code)]
fn status_flags(file: &File) -> io::Result<libc::c_int> {
    use std::os::fd::AsRawFd;
    // SAFETY: the descriptor belongs to `file`, which stays open for the call, and
    // F_GETFL reads no third argument.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(flags)
}

/// Clear `O_NONBLOCK` on `file`, keeping every other status flag: `F_SETFL` takes the
/// flags `F_GETFL` returned, without that bit.
#[cfg(unix)]
#[allow(unsafe_code)]
fn clear_nonblocking(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let flags = status_flags(file)?;
    if flags & libc::O_NONBLOCK == 0 {
        return Ok(());
    }
    // SAFETY: the descriptor belongs to `file`, which stays open for the call, and
    // F_SETFL takes the new flags as its int third argument.
    let code = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) };
    if code == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::open_nofollow;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zero-sys-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_regular_file_opens_and_reads() {
        let dir = scratch("plain");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let opened = open_nofollow(&file).unwrap();
        assert_eq!(opened.metadata().unwrap().len(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_symbolic_link_in_the_final_component_is_refused() {
        let dir = scratch("link");
        let target = dir.join("target.txt");
        std::fs::write(&target, b"secret").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = open_nofollow(&link).unwrap_err();
        assert_eq!(err.raw_os_error(), Some(libc::ELOOP));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// POSIX `open()`: "If O_NONBLOCK is set, an open() for reading-only shall return
    /// without delay." The open runs on a thread of its own, so an open that blocks
    /// fails the test instead of hanging it; opening the write end then releases it.
    #[cfg(unix)]
    #[test]
    #[cfg_attr(miri, ignore)]
    fn an_open_for_reading_only_of_a_fifo_with_o_nonblock_set_shall_return_without_delay() {
        use std::os::unix::fs::FileTypeExt;
        let dir = scratch("fifo");
        let fifo = dir.join("pipe");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("the mkfifo utility");
        assert!(made.success(), "mkfifo {}", fifo.display());
        let (done, opened) = std::sync::mpsc::channel();
        let path = fifo.clone();
        std::thread::spawn(move || {
            let _ = done.send(open_nofollow(&path).and_then(|file| file.metadata()));
        });
        let metadata = match opened.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(metadata) => metadata.expect("the FIFO opens"),
            Err(_) => {
                let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
                panic!("opening the FIFO waited for a writer");
            }
        };
        assert!(metadata.file_type().is_fifo());
        assert!(!metadata.is_file(), "a caller that serves files refuses it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Linux open(2) on `O_NONBLOCK`: "applications should not depend upon blocking
    /// behavior when specifying this flag for regular files", so the flag is cleared
    /// once the file is open.
    #[cfg(unix)]
    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_opened_file_is_returned_in_blocking_mode() {
        let dir = scratch("blocking");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let opened = open_nofollow(&file).unwrap();
        let flags = super::status_flags(&opened).unwrap();
        assert_eq!(flags & libc::O_NONBLOCK, 0);
        assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
