//! Static file serving for zero-server.
//!
//! Files and directories with a path policy on every segment, resolution that keeps a
//! symlink inside the root, ETag and Last-Modified validators, 304, byte ranges,
//! Cache-Control per route, precomputed header blocks per asset, a bounded per-core
//! small-file cache, and the platform file-send path when the backend offers one.
//!
//! [`cond`] holds the validators and the conditional-request evaluation of RFC 9110
//! Sections 8.8 and 13, [`range`] the byte ranges of Section 14, and [`headers`]
//! the `Cache-Control`, `Content-Disposition` and `Last-Modified` rules, each a pure
//! function over bytes; the file layer sits on top of them.

pub mod cond;
pub mod files;
pub mod headers;
pub mod range;

pub use cond::{evaluate, EntityTag, Outcome, Preconditions, Validators};
pub use files::{Files, Options, Refusal};
pub use headers::{last_modified_for, write_attachment, CachePolicy};
pub use range::{resolve, Ranges, MAX_RANGES};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use zero_core::Error;
    use zero_http::{serve, Call, Config, Handler, Workers};
    use zero_http_types::Method;

    use super::files::{Files, Options, Refusal};

    use super::cond::{evaluate, EntityTag, Outcome, Preconditions, Validators};
    use super::headers::{last_modified_for, write_attachment, CachePolicy};
    use super::range::{
        resolve, write_content_range, write_multipart, write_unsatisfied_range, Ranges, MAX_RANGES,
    };

    /// Sun, 06 Nov 1994 08:49:37 GMT.
    const MODIFIED: u64 = 784_111_777;
    const NOW: u64 = 1_780_000_000;

    fn tag(bytes: &[u8]) -> EntityTag<'_> {
        EntityTag::parse(bytes).expect("a well-formed entity tag")
    }

    fn current() -> Validators<'static> {
        Validators {
            etag: EntityTag::parse(b"\"1\""),
            last_modified: Some(MODIFIED),
        }
    }

    fn value(policy: CachePolicy) -> String {
        let mut out = Vec::new();
        policy.write(&mut out);
        String::from_utf8(out).expect("ascii")
    }

    /// A fresh root with `index.html`, `docs/guide.txt` and, beside the root, a
    /// file no request may reach.
    fn root(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("zero-static-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        std::fs::create_dir_all(root.join("docs")).expect("a scratch directory");
        std::fs::write(root.join("index.html"), b"<p>home</p>").expect("write");
        std::fs::write(root.join("docs/guide.txt"), b"0123456789").expect("write");
        std::fs::write(base.join("secret.txt"), b"outside").expect("write");
        root
    }

    struct App {
        files: Files,
    }

    impl Handler for App {
        async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
            self.files.serve(call)
        }
    }

    fn start(root: PathBuf, options: Options) -> (Workers, SocketAddr) {
        let mut config = Config::default();
        config.runtime.io.threads = 1;
        config.runtime.io.drain = Duration::from_secs(1);
        let workers = serve(
            "127.0.0.1:0".parse().expect("an address"),
            config,
            Arc::new(|_| {}),
            move |_| App {
                files: Files::new(root.clone(), options.clone()).expect("the root exists"),
            },
        )
        .expect("the server starts");
        let addr = workers.local_addr();
        (workers, addr)
    }

    /// One request on a fresh connection: the status, the lowercased field lines
    /// and the body.
    fn fetch(addr: SocketAddr, request: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut conn = TcpStream::connect(addr).expect("connect");
        conn.set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        conn.write_all(request.as_bytes()).expect("write");
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(conn.read(&mut byte).expect("read"), 1, "the head ends");
            head.push(byte[0]);
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

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn if_match_uses_the_strong_comparison_function_and_if_none_match_uses_the_weak_one() {
        // RFC 9110 Section 8.8.3.2, Table 3.
        assert!(!tag(b"W/\"1\"").strong_eq(tag(b"W/\"1\"")));
        assert!(tag(b"W/\"1\"").weak_eq(tag(b"W/\"1\"")));
        assert!(!tag(b"W/\"1\"").weak_eq(tag(b"W/\"2\"")));
        assert!(!tag(b"W/\"1\"").strong_eq(tag(b"\"1\"")));
        assert!(tag(b"W/\"1\"").weak_eq(tag(b"\"1\"")));
        assert!(tag(b"\"1\"").strong_eq(tag(b"\"1\"")));
        // Sections 13.1.1 and 13.1.2: a weak tag never satisfies If-Match, and does
        // satisfy If-None-Match.
        let weak = Validators {
            etag: EntityTag::parse(b"W/\"1\""),
            last_modified: None,
        };
        let if_match = Preconditions {
            if_match: Some(b"\"1\""),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), if_match, weak, NOW),
            Outcome::PreconditionFailed
        );
        let if_none_match = Preconditions {
            if_none_match: Some(b"\"1\""),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), if_none_match, weak, NOW),
            Outcome::NotModified
        );
        assert_eq!(EntityTag::parse(b"w/\"1\""), None);
        assert_eq!(EntityTag::parse(b"\"a\"b\""), None);
    }

    #[test]
    fn a_get_or_head_whose_if_none_match_matches_the_current_etag_yields_304() {
        let matching = Preconditions {
            if_none_match: Some(b"\"0\", \"1\""),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), matching, current(), NOW),
            Outcome::NotModified
        );
        assert_eq!(
            evaluate(Some(Method::Head), matching, current(), NOW),
            Outcome::NotModified
        );
        // Any other method answers 412 (Section 13.1.2).
        assert_eq!(
            evaluate(Some(Method::Put), matching, current(), NOW),
            Outcome::PreconditionFailed
        );
        let star = Preconditions {
            if_none_match: Some(b"*"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), star, current(), NOW),
            Outcome::NotModified
        );
        let other = Preconditions {
            if_none_match: Some(b"\"2\""),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), other, current(), NOW),
            Outcome::Proceed { range: None }
        );
    }

    #[test]
    fn if_modified_since_is_ignored_when_if_none_match_is_present_and_for_other_methods() {
        let unchanged = b"Sun, 06 Nov 1994 08:49:37 GMT";
        let alone = Preconditions {
            if_modified_since: Some(unchanged),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), alone, current(), NOW),
            Outcome::NotModified
        );
        // With a non-matching If-None-Match the date is not consulted.
        let with_tag = Preconditions {
            if_none_match: Some(b"\"other\""),
            if_modified_since: Some(unchanged),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), with_tag, current(), NOW),
            Outcome::Proceed { range: None }
        );
        // A method other than GET or HEAD ignores it.
        assert_eq!(
            evaluate(Some(Method::Post), alone, current(), NOW),
            Outcome::Proceed { range: None }
        );
        // An invalid date is ignored, and so is one when no modification date exists.
        let invalid = Preconditions {
            if_modified_since: Some(b"yesterday"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), invalid, current(), NOW),
            Outcome::Proceed { range: None }
        );
        let undated = Validators {
            etag: current().etag,
            last_modified: None,
        };
        assert_eq!(
            evaluate(Some(Method::Get), alone, undated, NOW),
            Outcome::Proceed { range: None }
        );
    }

    #[test]
    fn preconditions_are_evaluated_in_the_order_if_match_if_unmodified_since_if_none_match_if_modified_since_if_range(
    ) {
        let later = b"Mon, 07 Nov 1994 00:00:00 GMT";
        let earlier = b"Sat, 05 Nov 1994 00:00:00 GMT";
        // If-Match fails first, whatever follows it.
        let all = Preconditions {
            if_match: Some(b"\"other\""),
            if_unmodified_since: Some(later),
            if_none_match: Some(b"\"1\""),
            if_modified_since: Some(earlier),
            if_range: Some(b"\"1\""),
            range: Some(b"bytes=0-0"),
        };
        assert_eq!(
            evaluate(Some(Method::Get), all, current(), NOW),
            Outcome::PreconditionFailed
        );
        // If-Unmodified-Since is read only without If-Match; it fails when the
        // representation changed after the date.
        let unmodified = Preconditions {
            if_unmodified_since: Some(earlier),
            if_none_match: Some(b"\"1\""),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), unmodified, current(), NOW),
            Outcome::PreconditionFailed
        );
        let unmodified_with_match = Preconditions {
            if_match: Some(b"\"1\""),
            if_unmodified_since: Some(earlier),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), unmodified_with_match, current(), NOW),
            Outcome::Proceed { range: None }
        );
        // If-None-Match comes before If-Modified-Since, then If-Range decides the
        // Range.
        let passing = Preconditions {
            if_match: Some(b"\"1\""),
            if_unmodified_since: Some(earlier),
            if_none_match: Some(b"\"other\""),
            if_modified_since: Some(later),
            if_range: Some(b"\"1\""),
            range: Some(b"bytes=0-0"),
        };
        assert_eq!(
            evaluate(Some(Method::Get), passing, current(), NOW),
            Outcome::Proceed {
                range: Some(b"bytes=0-0")
            }
        );
    }

    #[test]
    fn last_modified_is_never_later_than_the_date_of_the_same_response() {
        assert_eq!(last_modified_for(MODIFIED, NOW), MODIFIED);
        assert_eq!(last_modified_for(NOW + 60, NOW), NOW);
        assert_eq!(last_modified_for(NOW, NOW), NOW);
    }

    #[test]
    fn a_satisfiable_single_byte_range_yields_206_with_content_range_bytes_first_last_complete_length(
    ) {
        assert_eq!(
            resolve(b"bytes=0-499", 10_000),
            Ranges::Satisfiable(vec![(0, 499)])
        );
        assert_eq!(
            resolve(b"bytes=500-999", 10_000),
            Ranges::Satisfiable(vec![(500, 999)])
        );
        // A last-pos past the end, or absent, means the remainder.
        assert_eq!(
            resolve(b"bytes=9500-", 10_000),
            Ranges::Satisfiable(vec![(9500, 9999)])
        );
        assert_eq!(
            resolve(b"bytes=9500-20000", 10_000),
            Ranges::Satisfiable(vec![(9500, 9999)])
        );
        // The final 500 bytes.
        assert_eq!(
            resolve(b"bytes=-500", 10_000),
            Ranges::Satisfiable(vec![(9500, 9999)])
        );
        // A suffix longer than the representation is the whole of it.
        assert_eq!(
            resolve(b"bytes=-20000", 10_000),
            Ranges::Satisfiable(vec![(0, 9999)])
        );
        let mut out = Vec::new();
        write_content_range(&mut out, (21_010, 47_021), 47_022);
        assert_eq!(out, b"bytes 21010-47021/47022");
    }

    #[test]
    fn an_unsatisfiable_range_yields_416_with_content_range_bytes_complete_length() {
        assert_eq!(resolve(b"bytes=10000-", 10_000), Ranges::Unsatisfiable);
        assert_eq!(resolve(b"bytes=-0", 10_000), Ranges::Unsatisfiable);
        let mut out = Vec::new();
        write_unsatisfied_range(&mut out, 47_022);
        assert_eq!(out, b"bytes */47022");
    }

    #[test]
    fn multiple_ranges_yield_multipart_byteranges_or_coalesced_ranges_and_many_overlapping_or_unordered_small_ranges_may_be_refused(
    ) {
        assert_eq!(
            resolve(b"bytes=0-0,-1", 10_000),
            Ranges::Satisfiable(vec![(0, 0), (9999, 9999)])
        );
        assert_eq!(
            resolve(b"bytes= 0-999, 4500-5499, -1000", 10_000),
            Ranges::Satisfiable(vec![(0, 999), (4500, 5499), (9000, 9999)])
        );
        // Overlapping or adjacent ranges in order are coalesced.
        assert_eq!(
            resolve(b"bytes=500-700,601-999", 10_000),
            Ranges::Satisfiable(vec![(500, 999)])
        );
        assert_eq!(
            resolve(b"bytes=500-600,601-999", 10_000),
            Ranges::Satisfiable(vec![(500, 999)])
        );
        // Ranges running backwards, or too many of them, are refused.
        assert_eq!(resolve(b"bytes=500-600,0-10", 10_000), Ranges::Refused);
        let many = (0..=MAX_RANGES)
            .map(|index| format!("{}-{}", index * 2, index * 2))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            resolve(format!("bytes={many}").as_bytes(), 10_000),
            Ranges::Refused
        );
        let mut out = Vec::new();
        write_multipart(
            &mut out,
            b"0123456789",
            &[(0, 1), (8, 9)],
            b"text/plain",
            b"THIS_STRING_SEPARATES",
        );
        let text = String::from_utf8(out).expect("ascii");
        assert_eq!(
            text,
            "\r\n--THIS_STRING_SEPARATES\r\nContent-Type: text/plain\r\nContent-Range: bytes 0-1/10\r\n\r\n01\r\n--THIS_STRING_SEPARATES\r\nContent-Type: text/plain\r\nContent-Range: bytes 8-9/10\r\n\r\n89\r\n--THIS_STRING_SEPARATES--\r\n"
        );
    }

    #[test]
    fn range_is_ignored_on_any_method_other_than_get() {
        let ranged = Preconditions {
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), ranged, current(), NOW),
            Outcome::Proceed {
                range: Some(b"bytes=0-0")
            }
        );
        for method in [Method::Head, Method::Post, Method::Put, Method::Delete] {
            assert_eq!(
                evaluate(Some(method), ranged, current(), NOW),
                Outcome::Proceed { range: None }
            );
        }
        // An unknown unit, an invalid specifier and an empty representation are
        // ignored too.
        assert_eq!(resolve(b"pages=1-2", 10_000), Ranges::Ignore);
        assert_eq!(resolve(b"bytes=5-2", 10_000), Ranges::Ignore);
        assert_eq!(resolve(b"bytes=a-b", 10_000), Ranges::Ignore);
        assert_eq!(resolve(b"bytes=0-0", 0), Ranges::Ignore);
    }

    #[test]
    fn if_range_with_a_non_matching_or_weak_validator_returns_the_full_200_representation() {
        let other = Preconditions {
            if_range: Some(b"\"other\""),
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), other, current(), NOW),
            Outcome::Proceed { range: None }
        );
        let weak = Preconditions {
            if_range: Some(b"W/\"1\""),
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), weak, current(), NOW),
            Outcome::Proceed { range: None }
        );
        let matching = Preconditions {
            if_range: Some(b"\"1\""),
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), matching, current(), NOW),
            Outcome::Proceed {
                range: Some(b"bytes=0-0")
            }
        );
        // A date matches exactly, and only once its second has passed.
        let dated = Preconditions {
            if_range: Some(b"Sun, 06 Nov 1994 08:49:37 GMT"),
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), dated, current(), NOW),
            Outcome::Proceed {
                range: Some(b"bytes=0-0")
            }
        );
        assert_eq!(
            evaluate(Some(Method::Get), dated, current(), MODIFIED),
            Outcome::Proceed { range: None }
        );
        let earlier = Preconditions {
            if_range: Some(b"Sat, 05 Nov 1994 00:00:00 GMT"),
            range: Some(b"bytes=0-0"),
            ..Preconditions::default()
        };
        assert_eq!(
            evaluate(Some(Method::Get), earlier, current(), NOW),
            Outcome::Proceed { range: None }
        );
    }

    #[test]
    fn the_maxage_option_emits_cache_control_max_age_n_and_no_store_is_available_for_sensitive_paths(
    ) {
        assert_eq!(
            value(CachePolicy {
                max_age: Some(3600),
                ..CachePolicy::default()
            }),
            "max-age=3600"
        );
        assert_eq!(
            value(CachePolicy {
                no_store: true,
                ..CachePolicy::default()
            }),
            "no-store"
        );
        assert_eq!(
            value(CachePolicy {
                max_age: Some(31_536_000),
                public: true,
                immutable: true,
                ..CachePolicy::default()
            }),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(value(CachePolicy::default()), "");
        assert!(!CachePolicy::default().is_set());
    }

    #[test]
    fn private_is_used_whenever_a_response_is_user_specific_so_shared_caches_do_not_store_it() {
        assert_eq!(
            value(CachePolicy {
                private: true,
                max_age: Some(60),
                ..CachePolicy::default()
            }),
            "private, max-age=60"
        );
    }

    #[test]
    fn downloads_send_content_disposition_attachment_with_an_ascii_filename_fallback_and_a_utf_8_filename_ext_value(
    ) {
        let mut out = Vec::new();
        write_attachment(&mut out, "example.html");
        assert_eq!(out, b"attachment; filename=\"example.html\"");
        // RFC 6266 Section 5: the euro sign in the ext-value, a fallback beside it.
        let mut out = Vec::new();
        write_attachment(&mut out, "\u{20ac} rates");
        assert_eq!(
            out,
            b"attachment; filename=\"_ rates\"; filename*=UTF-8''%E2%82%AC%20rates"
        );
        // Only the last path segment, under either separator, with the quote
        // escaped in the quoted-string form.
        let mut out = Vec::new();
        write_attachment(&mut out, "/tmp/a\"b.txt");
        assert_eq!(out, b"attachment; filename=\"a\\\"b.txt\"");
        let mut out = Vec::new();
        write_attachment(&mut out, "C:\\dir\\name.txt");
        assert_eq!(out, b"attachment; filename=\"name.txt\"");
    }

    #[test]
    fn a_304_carries_the_etag_cache_control_date_expires_and_vary_fields_a_200_would_have_sent() {
        let options = Options {
            cache: CachePolicy {
                max_age: Some(60),
                ..CachePolicy::default()
            },
            ..Options::default()
        };
        let (workers, addr) = start(root("notmodified"), options);
        let (status, headers, body) =
            fetch(addr, "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\n\r\n");
        assert_eq!((status, body.as_slice()), (200, &b"0123456789"[..]));
        let etag = header(&headers, "etag").expect("an etag").to_owned();
        assert!(etag.starts_with('"') && etag.ends_with('"'));
        assert_eq!(header(&headers, "cache-control"), Some("max-age=60"));
        assert!(header(&headers, "last-modified").is_some());
        let (status, headers, body) = fetch(
            addr,
            &format!("GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\nIf-None-Match: {etag}\r\n\r\n"),
        );
        assert_eq!(status, 304);
        assert!(body.is_empty());
        assert_eq!(header(&headers, "etag"), Some(etag.as_str()));
        assert_eq!(header(&headers, "cache-control"), Some("max-age=60"));
        assert!(header(&headers, "date").is_some());
        assert_eq!(header(&headers, "content-type"), None);
        // A directory path serves its index; a method other than GET or HEAD is 405.
        let (status, _, body) = fetch(addr, "GET / HTTP/1.1\r\nHost: t\r\n\r\n");
        assert_eq!((status, body.as_slice()), (200, &b"<p>home</p>"[..]));
        let (status, headers, _) = fetch(
            addr,
            "POST /index.html HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n",
        );
        assert_eq!(
            (status, header(&headers, "allow")),
            (405, Some("GET, HEAD"))
        );
        workers.stop().expect("stop");
    }

    #[test]
    fn responses_advertise_accept_ranges_bytes_when_range_support_is_enabled() {
        let (workers, addr) = start(root("ranges"), Options::default());
        let (status, headers, _) = fetch(addr, "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\n\r\n");
        assert_eq!(
            (status, header(&headers, "accept-ranges")),
            (200, Some("bytes"))
        );
        let (status, headers, body) = fetch(
            addr,
            "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\nRange: bytes=2-4\r\n\r\n",
        );
        assert_eq!((status, body.as_slice()), (206, &b"234"[..]));
        assert_eq!(header(&headers, "content-range"), Some("bytes 2-4/10"));
        let (status, headers, _) = fetch(
            addr,
            "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\nRange: bytes=10-\r\n\r\n",
        );
        assert_eq!(
            (status, header(&headers, "content-range")),
            (416, Some("bytes */10"))
        );
        let (status, headers, body) = fetch(
            addr,
            "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\nRange: bytes=0-0,-1\r\n\r\n",
        );
        assert_eq!(status, 206);
        assert!(header(&headers, "content-type")
            .is_some_and(|value| value.starts_with("multipart/byteranges; boundary=")));
        assert!(body.windows(16).any(|w| w == b"bytes 0-0/10\r\n\r\n"));
        workers.stop().expect("stop");
        let (workers, addr) = start(
            root("noranges"),
            Options {
                ranges: false,
                ..Options::default()
            },
        );
        let (status, headers, body) = fetch(
            addr,
            "GET /docs/guide.txt HTTP/1.1\r\nHost: t\r\nRange: bytes=2-4\r\n\r\n",
        );
        assert_eq!((status, body.len()), (200, 10));
        assert_eq!(header(&headers, "accept-ranges"), None);
        workers.stop().expect("stop");
    }

    #[test]
    fn encoded_traversal_such_as_2e_2e_or_2f_never_resolves_outside_the_configured_root() {
        let root = root("traversal");
        let files = Files::new(root.clone(), Options::default()).expect("the root");
        let under: PathBuf = ["docs", "guide.txt"].iter().collect();
        assert_eq!(files.locate(b"/docs/guide.txt"), Ok(under.clone()));
        assert_eq!(files.locate(b"/docs/%67uide.txt"), Ok(under.clone()));
        assert_eq!(files.locate(b"/docs/../docs/guide.txt"), Ok(under));
        assert_eq!(files.locate(b"/"), Ok(PathBuf::from("index.html")));
        // Dot segments, encoded or not, are removed before the root is joined, so
        // nothing above it is named; an encoded slash never becomes a separator.
        for target in [
            &b"/../secret.txt"[..],
            b"/%2e%2e/secret.txt",
            b"/docs/%2e%2e/%2e%2e/secret.txt",
            b"/..%2fsecret.txt",
            b"/docs%2f..%2f..%2fsecret.txt",
            b"/docs/..%5c..%5csecret.txt",
            b"/%00secret.txt",
            b"/docs/%zz",
        ] {
            match files.locate(target) {
                Ok(path) => assert!(
                    !root.join(&path).join("..").exists() || !path.to_string_lossy().contains(".."),
                    "{} resolved to {}",
                    String::from_utf8_lossy(target),
                    path.display()
                ),
                Err(Refusal::Policy | Refusal::Directory) => {}
            }
        }
        assert_eq!(files.locate(b"/..%2fsecret.txt"), Err(Refusal::Policy));
        assert_eq!(files.locate(b"/%00secret.txt"), Err(Refusal::Policy));
        let (workers, addr) = start(root.clone(), Options::default());
        for target in ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"] {
            let (status, _, body) =
                fetch(addr, &format!("GET {target} HTTP/1.1\r\nHost: t\r\n\r\n"));
            assert_ne!(
                body.as_slice(),
                b"outside",
                "{target} served the file outside the root"
            );
            assert!(
                status == 404 || status == 400 || status == 200,
                "{target}: {status}"
            );
        }
        workers.stop().expect("stop");
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_inside_the_root_never_serves_a_file_outside_it() {
        let root = root("symlink");
        let outside = root.join("..").join("secret.txt");
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).expect("a link");
        std::os::unix::fs::symlink(root.join(".."), root.join("up")).expect("a directory link");
        let (workers, addr) = start(root, Options::default());
        let (status, _, body) = fetch(addr, "GET /link.txt HTTP/1.1\r\nHost: t\r\n\r\n");
        assert_eq!((status, body.as_slice()), (404, &[][..]));
        let (status, _, body) = fetch(addr, "GET /up/secret.txt HTTP/1.1\r\nHost: t\r\n\r\n");
        assert_eq!((status, body.as_slice()), (404, &[][..]));
        workers.stop().expect("stop");
    }
}
