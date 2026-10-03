//! The file layer's dotfile policies, the extensions tried for a path that names
//! no file, and the miss outcome that lets a host fall through instead of
//! answering 404, each over loopback.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use zero_core::Error;
use zero_http::{serve, Call, Config, Handler, Workers};
use zero_static::{Dotfiles, Files, Options, Refusal, Served};

/// The body a falling-through host writes after a miss.
const FALLBACK: &[u8] = b"fell through";

fn write(root: &Path, name: &str, contents: &str) {
    std::fs::write(root.join(name), contents.as_bytes()).expect("write");
}

/// A fresh root with dotfiles, files with and without extensions, a directory
/// without an index file and, beside the root, a file no request may reach.
fn root(name: &str) -> PathBuf {
    let base =
        std::env::temp_dir().join(format!("zero-static-options-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let root = base.join("root");
    std::fs::create_dir_all(root.join("docs")).expect("a scratch directory");
    std::fs::create_dir_all(root.join(".well-known")).expect("a scratch directory");
    write(&root, "index.html", "<p>home</p>");
    write(&root, ".env", "SECRET=1");
    write(&root, ".hidden.txt", "hidden");
    write(&root, ".well-known/security.txt", "Contact: x");
    write(&root, "about.html", "<p>about</p>");
    write(&root, "about.htm", "<p>old about</p>");
    write(&root, "guide", "plain guide");
    write(&root, "guide.html", "<p>guide</p>");
    write(&root, "notes.txt", "notes");
    write(&root, "docs/index.html.txt", "not an index");
    std::fs::write(base.join("outside.txt"), b"outside").expect("write");
    root
}

/// Serves the root, answering a miss with 404, or, when `fall_through` is on,
/// writing [`FALLBACK`] after a miss as a host's next route would.
struct App {
    files: Files,
    fall_through: bool,
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        if !self.fall_through {
            return self.files.serve(call);
        }
        if self.files.try_serve(call)? == Served::Miss {
            call.response().body(FALLBACK);
        }
        Ok(())
    }
}

fn start(root: PathBuf, options: Options, fall_through: bool) -> (Workers, SocketAddr) {
    let mut config = Config::default();
    config.runtime.io.threads = 1;
    config.runtime.io.drain = Duration::from_secs(1);
    let workers = serve(
        "127.0.0.1:0".parse().expect("an address"),
        config,
        Arc::new(|_| {}),
        move |_| App {
            files: Files::new(root.clone(), options.clone()).expect("the root exists"),
            fall_through,
        },
    )
    .expect("the server starts");
    let addr = workers.local_addr();
    (workers, addr)
}

/// One request on a fresh connection: the status, the lowercased field lines and
/// the body.
fn fetch(addr: SocketAddr, request: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let mut conn = TcpStream::connect(addr).expect("connect");
    conn.set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    conn.write_all(request.as_bytes()).expect("write");
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(conn.read(&mut byte).expect("read"), 1, "the head ends");
        head.extend_from_slice(&byte);
    }
    let text = String::from_utf8(head).expect("ascii");
    let mut lines = text.trim_end().split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .expect("a status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 && !request.starts_with("HEAD") {
        conn.read_exact(&mut body).expect("the body");
    }
    (status, headers, body)
}

fn get(addr: SocketAddr, target: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    fetch(addr, &format!("GET {target} HTTP/1.1\r\nHost: t\r\n\r\n"))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

const DOTFILE_TARGETS: [&str; 5] = [
    "/.env",
    "/.missing",
    "/%2eenv",
    "/.well-known/security.txt",
    "/.well-known/",
];

#[test]
fn with_dotfiles_ignored_a_dotfile_path_is_a_miss_whether_or_not_the_file_exists() {
    let root = root("ignore");
    assert_eq!(Options::default().dotfiles, Dotfiles::Ignore);
    let files = Files::new(root.clone(), Options::default()).expect("the root");
    assert_eq!(files.locate(b"/.env"), Err(Refusal::Policy));
    let (workers, addr) = start(root.clone(), Options::default(), false);
    for target in DOTFILE_TARGETS {
        let (status, _, body) = get(addr, target);
        assert_eq!((status, body.as_slice()), (404, &[][..]), "{target}");
    }
    workers.stop().expect("stop");
    let (workers, addr) = start(root, Options::default(), true);
    for target in DOTFILE_TARGETS {
        let (status, headers, body) = get(addr, target);
        assert_eq!((status, body.as_slice()), (200, FALLBACK), "{target}");
        assert_eq!(header(&headers, "etag"), None, "{target}");
    }
    workers.stop().expect("stop");
}

#[test]
fn dotfiles_deny_answers_a_dotfile_path_with_rfc_9110_section_15_5_4_403_forbidden_whether_or_not_it_exists(
) {
    let root = root("deny");
    let options = Options {
        dotfiles: Dotfiles::Deny,
        ..Options::default()
    };
    let files = Files::new(root.clone(), options.clone()).expect("the root");
    assert_eq!(files.locate(b"/.env"), Err(Refusal::Policy));
    let (workers, addr) = start(root, options, true);
    for target in DOTFILE_TARGETS {
        let (status, headers, body) = get(addr, target);
        assert_eq!((status, body.as_slice()), (403, &[][..]), "{target}");
        assert_eq!(header(&headers, "etag"), None, "{target}");
    }
    let (status, _, _) = fetch(addr, "HEAD /.env HTTP/1.1\r\nHost: t\r\n\r\n");
    assert_eq!(status, 403);
    let (status, _, body) = get(addr, "/index.html");
    assert_eq!((status, body.as_slice()), (200, &b"<p>home</p>"[..]));
    let (status, _, body) = get(addr, "/missing.txt");
    assert_eq!((status, body.as_slice()), (200, FALLBACK));
    workers.stop().expect("stop");
}

#[test]
fn with_dotfiles_allowed_a_dotfile_is_served_like_any_other_path() {
    let root = root("allow");
    let options = Options {
        dotfiles: Dotfiles::Allow,
        ..Options::default()
    };
    let (workers, addr) = start(root, options, true);
    let (status, _, body) = get(addr, "/.well-known/security.txt");
    assert_eq!((status, body.as_slice()), (200, &b"Contact: x"[..]));
    let (status, _, body) = get(addr, "/.env");
    assert_eq!((status, body.as_slice()), (200, &b"SECRET=1"[..]));
    let (status, _, body) = get(addr, "/.missing");
    assert_eq!((status, body.as_slice()), (200, FALLBACK));
    workers.stop().expect("stop");
}

#[test]
fn extensions_are_tried_in_order_when_a_path_names_no_file() {
    let root = root("extensions");
    let (workers, addr) = start(
        root.clone(),
        Options {
            extensions: vec!["htm".to_owned(), ".html".to_owned()],
            ..Options::default()
        },
        false,
    );
    let (status, _, body) = get(addr, "/about");
    assert_eq!((status, body.as_slice()), (200, &b"<p>old about</p>"[..]));
    workers.stop().expect("stop");
    let (workers, addr) = start(
        root,
        Options {
            extensions: vec![".html".to_owned(), "htm".to_owned()],
            ..Options::default()
        },
        false,
    );
    let (status, headers, body) = get(addr, "/about");
    assert_eq!((status, body.as_slice()), (200, &b"<p>about</p>"[..]));
    assert!(
        header(&headers, "content-type").is_some_and(|value| value.starts_with("text/html")),
        "{headers:?}"
    );
    let (status, _, body) = get(addr, "/guide");
    assert_eq!((status, body.as_slice()), (200, &b"plain guide"[..]));
    let (status, _, body) = get(addr, "/about.htm");
    assert_eq!((status, body.as_slice()), (200, &b"<p>old about</p>"[..]));
    let (status, _, body) = get(addr, "/missing");
    assert_eq!((status, body.as_slice()), (404, &[][..]));
    workers.stop().expect("stop");
}

#[test]
fn an_extension_is_never_tried_for_a_directory_path() {
    let root = root("directory");
    let (workers, addr) = start(
        root,
        Options {
            extensions: vec!["txt".to_owned()],
            ..Options::default()
        },
        true,
    );
    let (status, _, body) = get(addr, "/docs/");
    assert_eq!((status, body.as_slice()), (200, FALLBACK));
    let (status, _, body) = get(addr, "/notes");
    assert_eq!((status, body.as_slice()), (200, &b"notes"[..]));
    workers.stop().expect("stop");
}

#[test]
fn an_extension_candidate_keeps_the_dotfile_policy_and_the_root_checks() {
    let root = root("candidate");
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("..").join("outside.txt"), root.join("link.txt"))
        .expect("a link");
    let extensions = vec!["txt".to_owned()];
    let (workers, addr) = start(
        root.clone(),
        Options {
            extensions: extensions.clone(),
            ..Options::default()
        },
        false,
    );
    let (status, _, body) = get(addr, "/.hidden");
    assert_eq!((status, body.as_slice()), (404, &[][..]));
    let (status, _, body) = get(addr, "/link");
    assert_eq!((status, body.as_slice()), (404, &[][..]));
    let (status, _, body) = get(addr, "/../outside");
    assert_ne!(body.as_slice(), b"outside", "{status}");
    workers.stop().expect("stop");
    let (workers, addr) = start(
        root,
        Options {
            extensions,
            dotfiles: Dotfiles::Deny,
            ..Options::default()
        },
        false,
    );
    let (status, _, body) = get(addr, "/.hidden");
    assert_eq!((status, body.as_slice()), (403, &[][..]));
    workers.stop().expect("stop");
}

#[test]
fn an_extension_that_cannot_end_a_path_segment_is_refused_at_construction() {
    let root = root("refused");
    for bad in ["", ".", "..", "...", "a/b", "a\\b", "a\0b", "a\nb"] {
        let options = Options {
            extensions: vec!["html".to_owned(), bad.to_owned()],
            ..Options::default()
        };
        let refused = Files::new(root.clone(), options).expect_err(bad);
        assert_eq!(refused.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
    }
    for good in ["html", ".html", "tar.gz"] {
        let options = Options {
            extensions: vec![good.to_owned()],
            ..Options::default()
        };
        Files::new(root.clone(), options).expect(good);
    }
}

#[test]
fn a_miss_writes_nothing_so_the_host_can_fall_through_instead_of_answering_404() {
    let root = root("miss");
    let (workers, addr) = start(root.clone(), Options::default(), true);
    for target in ["/missing.txt", "/docs/a%2Fb", "/docs/", "/docs"] {
        let (status, headers, body) = get(addr, target);
        assert_eq!((status, body.as_slice()), (200, FALLBACK), "{target}");
        for name in ["etag", "accept-ranges", "last-modified"] {
            assert_eq!(header(&headers, name), None, "{target} {name}");
        }
    }
    let (status, headers, _) = fetch(
        addr,
        "POST /index.html HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n",
    );
    assert_eq!(status, 405);
    assert_eq!(header(&headers, "allow"), Some("GET, HEAD"));
    let (status, _, body) = get(addr, "/index.html");
    assert_eq!((status, body.as_slice()), (200, &b"<p>home</p>"[..]));
    workers.stop().expect("stop");
    let (workers, addr) = start(root, Options::default(), false);
    let (status, _, body) = get(addr, "/missing.txt");
    assert_eq!((status, body.as_slice()), (404, &[][..]));
    workers.stop().expect("stop");
}
