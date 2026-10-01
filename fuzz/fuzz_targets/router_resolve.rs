//! The router on arbitrary method tokens and targets: resolution never panics,
//! every parameter range lies inside the matched path, and a normal target
//! resolves the same whether given whole or already split and normalized.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_http_types::Method;
use zero_router::{Resolution, Router};

fn table() -> Router<u32> {
    let mut router = Router::new();
    router.route(Method::Get, "/", 1).unwrap();
    router.route(Method::Get, "/users", 2).unwrap();
    router.route(Method::Post, "/users", 3).unwrap();
    router.route(Method::Get, "/users/:id", 4).unwrap();
    router.route(Method::Delete, "/users/:id", 5).unwrap();
    router.route(Method::Get, "/users/:id/posts/:post", 6).unwrap();
    router.route(Method::Get, "/files/*path", 7).unwrap();
    router.route(Method::Get, "/*", 8).unwrap();
    let mut admin = Router::new();
    admin.route(Method::Get, "/", 9).unwrap();
    admin.route(Method::Put, "/settings/:key", 10).unwrap();
    router.mount("/admin", admin).unwrap();
    router
}

fuzz_target!(|data: &[u8]| {
    let router = table();
    let (method, target) = match data.iter().position(|&b| b == b' ') {
        Some(at) => (&data[..at], &data[at + 1..]),
        None => (&b"GET"[..], data),
    };
    let mut scratch = Vec::new();
    let Ok(resolved) = router.resolve_target(method, target, &mut scratch) else {
        return;
    };
    if let Resolution::Matched { params, .. } = resolved.resolution {
        for (name, range) in params.iter() {
            assert!(!name.is_empty());
            assert!(range.start <= range.end && range.end <= resolved.path.len());
        }
    }
    let path = resolved.path.to_vec();
    let direct = router.resolve(method, &path);
    let same = match (&resolved.resolution, &direct) {
        (Resolution::Matched { descriptor: a, .. }, Resolution::Matched { descriptor: b, .. }) => a == b,
        (Resolution::NotFound, Resolution::NotFound)
        | (Resolution::NotImplemented, Resolution::NotImplemented) => true,
        (Resolution::MethodNotAllowed { allow: a }, Resolution::MethodNotAllowed { allow: b })
        | (Resolution::Options { allow: a }, Resolution::Options { allow: b }) => a == b,
        _ => false,
    };
    assert!(same, "the split and normalized path resolves the same");
});
