//! Post-completion file actions end to end over loopback, with a test target that
//! hands each request to the test thread: the file after the status and fields the
//! host set, the refusals with the server's error body in both shapes, the roots a
//! core keeps and the one it drops with its cache, and the error body of a static
//! route's dotfile refusal (RFC 9110 Sections 15.5.4 and 17.3).

#![cfg(all(feature = "static", feature = "testing"))]

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use support::{ids, start, stop, Client, Reply, TestTarget};
use zero_host::actions::{self, FILE_ROOTS_KEPT};
use zero_host::{access, bind_thread, complete, testing, App, Method, RouteKind, Server, Status};
use zero_http::Exchange;
use zero_http_types::StatusCode;

/// How many field lines of `name` a reply carries.
fn lines(reply: &Reply, name: &str) -> usize {
    reply
        .headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .count()
}

/// A directory named for the test, emptied first.
fn directory(test: &str, name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "zero-host-actions-{test}-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn bytes(path: &Path) -> Vec<u8> {
    path.to_str().unwrap().as_bytes().to_vec()
}

/// A server whose host route `/file` takes every method, with a test target bound to
/// the calling thread.
struct Host {
    server: Server,
    worker: u8,
    target: Arc<TestTarget>,
}

impl Host {
    fn start(options: &str) -> Host {
        let mut app = App::new();
        app.route(RouteKind::Host, None, "/file", b"").unwrap();
        let server = start(&app, options);
        let worker = server.workers()[0];
        let target = TestTarget::new(8);
        server.attach(worker, target.clone()).unwrap();
        bind_thread(worker).unwrap();
        Host {
            server,
            worker,
            target,
        }
    }

    /// Send `request`, answer its lease with `respond`, and read the response.
    fn answer(&self, request: &str, respond: impl FnOnce(&mut Exchange)) -> Reply {
        let mut client = Client::connect(&self.server);
        client.send(request.as_bytes());
        let batch = self.target.take();
        let slot = ids(batch)[0];
        testing::respond(slot, respond).unwrap();
        complete(self.worker, &[slot], batch.epoch, None).unwrap();
        client.read().unwrap()
    }

    /// Answer a GET of `/file` with a file action for `path` under `root`.
    fn file(&self, root: &[u8], path: &[u8]) -> Reply {
        self.answer("GET /file HTTP/1.1\r\nHost: t\r\n\r\n", |exchange| {
            actions::file(exchange, root, path).unwrap();
        })
    }
}

#[test]
fn the_file_action_serves_the_file_after_the_status_and_fields_the_host_set() {
    let root = directory("fields", "root");
    fs::write(root.join("report.txt"), b"quarterly").unwrap();
    let host = Host::start(r#"{"threads":1}"#);
    let root_bytes = bytes(&root);
    let reply = host.answer("GET /file HTTP/1.1\r\nHost: t\r\n\r\n", |exchange| {
        let mut response = exchange.response();
        response
            .header(
                b"Content-Disposition",
                b"attachment; filename=\"report.txt\"",
            )
            .unwrap();
        response.header(b"X-Host", b"kept").unwrap();
        response.body(b"replaced by the file");
        actions::file(exchange, &root_bytes, b"/report.txt").unwrap();
    });
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "quarterly", "the file is the body");
    assert_eq!(
        reply.header("content-disposition"),
        Some("attachment; filename=\"report.txt\"")
    );
    assert_eq!(reply.header("x-host"), Some("kept"));
    assert!(
        reply
            .header("content-type")
            .is_some_and(|value| value.starts_with("text/plain")),
        "{:?}",
        reply.headers
    );
    assert!(reply.header("etag").is_some());

    let address = host.server.address().unwrap();
    let probe = std::thread::spawn(move || {
        let stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .unwrap();
        Client { stream }.head("/file")
    });
    let batch = host.target.take();
    let slot = ids(batch)[0];
    testing::respond(slot, |exchange| {
        actions::file(exchange, &root_bytes, b"/report.txt").unwrap();
    })
    .unwrap();
    complete(host.worker, &[slot], batch.epoch, None).unwrap();
    let head = probe.join().unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(
        head.header("content-length"),
        Some("9"),
        "HEAD answers the length GET would send"
    );
    stop(&host.server);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_file_action_refusal_carries_the_servers_error_body_and_a_405_its_allow_field() {
    let root = directory("refusals", "root");
    fs::write(root.join("here.txt"), b"here").unwrap();
    let root_bytes = bytes(&root);
    let missing_root = bytes(&root.join("absent"));
    let host = Host::start(r#"{"threads":1}"#);

    for (root, path) in [
        (root_bytes.as_slice(), b"/absent.txt".as_slice()),
        (missing_root.as_slice(), b"/here.txt".as_slice()),
        (root_bytes.as_slice(), b"/here%00.txt".as_slice()),
    ] {
        let reply = host.file(root, path);
        assert_eq!(reply.status, 404, "{}", String::from_utf8_lossy(path));
        assert_eq!(
            reply.header("content-type"),
            Some("application/problem+json")
        );
        assert_eq!(
            reply.text(),
            r#"{"type":"about:blank","title":"Not Found","status":404,"code":"not_found"}"#
        );
    }

    let refused = host.answer(
        "POST /file HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n",
        |exchange| actions::file(exchange, &root_bytes, b"/here.txt").unwrap(),
    );
    assert_eq!(refused.status, 405);
    assert_eq!(refused.header("allow"), Some("GET, HEAD"));
    assert!(
        refused.text().contains(r#""code":"method_not_allowed""#),
        "{}",
        refused.text()
    );
    stop(&host.server);

    let legacy = Host::start(r#"{"threads":1,"errorShape":"legacy"}"#);
    let reply = legacy.file(&root_bytes, b"/absent.txt");
    assert_eq!(reply.status, 404);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    assert_eq!(reply.text(), r#"{"error":"Not Found"}"#);
    stop(&legacy.server);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_file_action_is_refused_for_an_empty_root_and_on_a_sealed_response() {
    let root = directory("sealed", "root");
    fs::write(root.join("a.txt"), b"a").unwrap();
    let root_bytes = bytes(&root);
    let host = Host::start(r#"{"threads":1}"#);
    let reply = host.answer("GET /file HTTP/1.1\r\nHost: t\r\n\r\n", |exchange| {
        assert_eq!(
            actions::file(exchange, b"", b"/a.txt")
                .unwrap_err()
                .status(),
            Status::InvalidArgument
        );
        assert_eq!(
            actions::file(exchange, &[0xff, 0xfe], b"/a.txt")
                .unwrap_err()
                .status(),
            Status::InvalidArgument
        );
        assert!(!exchange.sealed(), "a refusal changes nothing");
        actions::file(exchange, &root_bytes, b"/a.txt").unwrap();
        assert_eq!(
            actions::file(exchange, &root_bytes, b"/a.txt")
                .unwrap_err()
                .status(),
            Status::Closed,
            "one action per response"
        );
    });
    assert_eq!((reply.status, reply.text().as_str()), (200, "a"));
    stop(&host.server);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_core_keeps_file_roots_kept_roots_and_drops_the_least_recently_used_with_its_cache() {
    let first = directory("roots", "first");
    let file = first.join("x.txt");
    fs::write(&file, b"one").unwrap();
    let others: Vec<PathBuf> = (0..FILE_ROOTS_KEPT)
        .map(|index| directory("roots", &index.to_string()))
        .collect();
    let host = Host::start(r#"{"threads":1}"#);
    let first_bytes = bytes(&first);

    // Rewrite the file to the same length and modification time: a root still kept
    // serves its cached copy, one built again reads the file.
    let rewrite = |text: &[u8]| {
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, text).unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    };
    assert_eq!(host.file(&first_bytes, b"/x.txt").text(), "one");
    rewrite(b"two");
    assert_eq!(
        host.file(&first_bytes, b"/x.txt").text(),
        "one",
        "the kept root answers from its cache"
    );

    for other in &others {
        assert_eq!(host.file(&bytes(other), b"/absent").status, 404);
    }
    assert_eq!(
        host.file(&first_bytes, b"/x.txt").text(),
        "two",
        "the least recently used root was dropped with its cache and built again"
    );
    stop(&host.server);
    let _ = fs::remove_dir_all(&first);
    for other in &others {
        let _ = fs::remove_dir_all(other);
    }
}

#[test]
fn a_file_under_a_status_the_host_set_evaluates_preconditions_and_range_only_where_9110_13_2_1_allows(
) {
    let root = directory("status", "root");
    fs::write(root.join("404.html"), b"<h1>Not here</h1>").unwrap();
    fs::write(root.join("made.txt"), b"created").unwrap();
    let root_bytes = bytes(&root);
    let host = Host::start(r#"{"threads":1}"#);
    let get = |fields: &str| format!("GET /file HTTP/1.1\r\nHost: t\r\n{fields}\r\n");

    for fields in [
        "",
        "Range: bytes=0-3\r\n",
        "If-None-Match: *\r\n",
        "If-Match: \"other\"\r\n",
    ] {
        let reply = host.answer(&get(fields), |exchange| {
            exchange.response().status(StatusCode::NOT_FOUND);
            actions::file(exchange, &root_bytes, b"/404.html").unwrap();
        });
        assert_eq!(
            (reply.status, reply.text().as_str()),
            (404, "<h1>Not here</h1>"),
            "a 404 ignores the preconditions and Range: {fields:?}"
        );
        assert!(
            reply
                .header("content-type")
                .is_some_and(|value| value.starts_with("text/html")),
            "{:?}",
            reply.headers
        );
        for name in ["content-range", "accept-ranges", "etag", "last-modified"] {
            assert_eq!(
                reply.header(name),
                None,
                "the content of a 404 is no representation of the target: {name}"
            );
        }
    }

    let created = host.answer(&get("Range: bytes=0-1\r\n"), |exchange| {
        exchange.response().status(StatusCode::CREATED);
        actions::file(exchange, &root_bytes, b"/made.txt").unwrap();
    });
    assert_eq!(
        (created.status, created.text().as_str()),
        (201, "created"),
        "Range applies only where the response would be 200 (Section 14.2)"
    );
    assert_eq!(created.header("content-range"), None);
    assert!(created.header("etag").is_some());
    let revalidated = host.answer(&get("If-None-Match: *\r\n"), |exchange| {
        exchange.response().status(StatusCode::CREATED);
        actions::file(exchange, &root_bytes, b"/made.txt").unwrap();
    });
    assert_eq!(revalidated.status, 304, "a 2xx keeps its preconditions");

    let ranged = host.answer(&get("Range: bytes=0-1\r\n"), |exchange| {
        actions::file(exchange, &root_bytes, b"/made.txt").unwrap();
    });
    assert_eq!((ranged.status, ranged.text().as_str()), (206, "cr"));
    assert_eq!(ranged.header("content-range"), Some("bytes 0-1/7"));
    stop(&host.server);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_file_action_sends_one_line_of_each_field_it_writes_about_the_file_9110_5_3() {
    let root = directory("singletons", "root");
    fs::write(root.join("page.html"), b"<p>hi</p>").unwrap();
    let root_bytes = bytes(&root);
    let host = Host::start(r#"{"threads":1}"#);
    let host_fields = |exchange: &mut Exchange| {
        let mut response = exchange.response();
        response.header(b"Content-Type", b"text/plain").unwrap();
        response.header(b"ETag", b"\"host\"").unwrap();
        response
            .header(b"Last-Modified", b"Thu, 01 Jan 1970 00:00:00 GMT")
            .unwrap();
        response.header(b"Accept-Ranges", b"none").unwrap();
        response.header(b"Content-Range", b"bytes 0-0/1").unwrap();
        response.header(b"X-Host", b"kept").unwrap();
    };

    let whole = host.answer("GET /file HTTP/1.1\r\nHost: t\r\n\r\n", |exchange| {
        host_fields(exchange);
        actions::file(exchange, &root_bytes, b"/page.html").unwrap();
    });
    assert_eq!((whole.status, whole.text().as_str()), (200, "<p>hi</p>"));
    for name in ["content-type", "etag", "last-modified", "accept-ranges"] {
        assert_eq!(lines(&whole, name), 1, "{name}: {:?}", whole.headers);
    }
    assert_eq!(lines(&whole, "content-range"), 0);
    assert!(whole
        .header("content-type")
        .is_some_and(|value| value.starts_with("text/html")));
    assert_ne!(
        whole.header("etag"),
        Some("\"host\""),
        "the file's own validator, which its preconditions compare"
    );
    assert_eq!(whole.header("x-host"), Some("kept"));

    let part = host.answer(
        "GET /file HTTP/1.1\r\nHost: t\r\nRange: bytes=0-2\r\n\r\n",
        |exchange| {
            host_fields(exchange);
            actions::file(exchange, &root_bytes, b"/page.html").unwrap();
        },
    );
    assert_eq!((part.status, part.text().as_str()), (206, "<p>"));
    for name in ["content-type", "etag", "content-range"] {
        assert_eq!(lines(&part, name), 1, "{name}: {:?}", part.headers);
    }
    assert_eq!(part.header("content-range"), Some("bytes 0-2/9"));
    stop(&host.server);
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn a_kept_file_root_reached_through_a_symbolic_link_follows_the_link_when_it_moves() {
    let base = directory("links", "base");
    let (one, two) = (base.join("one"), base.join("two"));
    fs::create_dir_all(&one).unwrap();
    fs::create_dir_all(&two).unwrap();
    fs::write(one.join("a.txt"), b"one").unwrap();
    fs::write(two.join("a.txt"), b"two!").unwrap();
    let current = base.join("current");
    std::os::unix::fs::symlink(&one, &current).unwrap();
    let host = Host::start(r#"{"threads":1}"#);
    let root = bytes(&current);
    assert_eq!(host.file(&root, b"/a.txt").text(), "one");

    let next = base.join("next");
    std::os::unix::fs::symlink(&two, &next).unwrap();
    fs::rename(&next, &current).unwrap();
    let moved = host.file(&root, b"/a.txt");
    assert_eq!(
        (moved.status, moved.text().as_str()),
        (200, "two!"),
        "the kept root is resolved again"
    );
    stop(&host.server);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn the_file_action_by_slot_id_serves_the_file_and_refuses_a_stale_id_a_sealed_response_and_an_open_region(
) {
    let root = directory("by-id", "root");
    fs::write(root.join("a.txt"), b"by id").unwrap();
    let root_bytes = bytes(&root);
    let host = Host::start(r#"{"threads":1}"#);
    let lease = || {
        let mut client = Client::connect(&host.server);
        client.send(b"GET /file HTTP/1.1\r\nHost: t\r\n\r\n");
        let batch = host.target.take();
        (client, ids(batch)[0], batch.epoch)
    };

    let (mut client, slot, epoch) = lease();
    access::file(slot, &root_bytes, b"/a.txt").unwrap();
    complete(host.worker, &[slot], epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (200, "by id"));
    assert_eq!(
        access::file(slot, &root_bytes, b"/a.txt")
            .unwrap_err()
            .status(),
        Status::Closed,
        "an id whose request was answered is stale"
    );

    let (mut client, slot, epoch) = lease();
    access::send(slot).unwrap();
    assert_eq!(
        access::file(slot, &root_bytes, b"/a.txt")
            .unwrap_err()
            .status(),
        Status::Closed,
        "a sealed response takes no action"
    );
    complete(host.worker, &[slot], epoch, None).unwrap();
    assert_eq!(
        client.read().unwrap().text(),
        "",
        "the sealed response went out"
    );

    let (mut client, slot, epoch) = lease();
    access::pin(slot).unwrap();
    access::body_alloc(slot, 4).unwrap();
    assert_eq!(
        access::file(slot, &root_bytes, b"/a.txt")
            .unwrap_err()
            .status(),
        Status::InvalidArgument,
        "an open body region takes no action"
    );
    access::send(slot).unwrap();
    access::unpin(slot).unwrap();
    complete(host.worker, &[slot], epoch, None).unwrap();
    assert_eq!(
        client.read().unwrap().body,
        [0; 4],
        "the region is the body"
    );
    stop(&host.server);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_static_routes_dotfile_403_carries_the_servers_error_body_9110_15_5_4() {
    let root = directory("dotfiles", "root");
    fs::write(root.join(".env"), b"SECRET=1").unwrap();
    fs::write(root.join("public.txt"), b"public").unwrap();
    let escaped = root.display().to_string().replace('\\', "\\\\");
    let mut app = App::new();
    app.route(
        RouteKind::Static,
        Some(Method::Get),
        "/files/*path",
        format!(r#"{{"root":"{escaped}","dotfiles":"deny","fallthrough":false}}"#).as_bytes(),
    )
    .unwrap();

    let server = start(&app, r#"{"threads":1}"#);
    let mut client = Client::connect(&server);
    for target in ["/files/.env", "/files/.absent"] {
        let refused = client.get(target);
        assert_eq!(refused.status, 403, "{target}");
        assert_eq!(
            refused.header("content-type"),
            Some("application/problem+json"),
            "{target}"
        );
        assert_eq!(
            refused.text(),
            r#"{"type":"about:blank","title":"Forbidden","status":403,"code":"forbidden"}"#,
            "{target}"
        );
    }
    assert_eq!(client.get("/files/public.txt").text(), "public");
    stop(&server);

    let legacy = start(&app, r#"{"threads":1,"errorShape":"legacy"}"#);
    let refused = Client::connect(&legacy).get("/files/.env");
    assert_eq!(refused.status, 403);
    assert_eq!(refused.header("content-type"), Some("application/json"));
    assert_eq!(refused.text(), r#"{"error":"Forbidden"}"#);
    stop(&legacy);
    let _ = fs::remove_dir_all(&root);
}
