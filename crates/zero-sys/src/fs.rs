//! The file-opening call static file serving needs: an open that refuses to follow
//! a symbolic link in its final component.
//!
//! On Unix that is `O_NOFOLLOW` (open(2): "If the trailing component (i.e.,
//! basename) of pathname is a symbolic link, then the open fails"), passed through
//! the standard library's `custom_flags`, so no raw call is made here. Windows has
//! no such flag; a caller there resolves the path and compares it against its root
//! after the open, which the static file crate does on every platform as its
//! second line.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Open `path` for reading without following a symbolic link in its final
/// component.
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
/// symbolic link.
pub fn open_nofollow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path)
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
}
