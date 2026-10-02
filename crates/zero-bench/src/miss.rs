//! The route-miss cost: a table in the shape of an
//! application, `/api/v1/<resource>/:id` under four methods for a hundred
//! resources, resolved for a target no route matches, timed per resolution.
//!
//! The Node router this replaces scanned its 400 routes linearly in 10.9
//! microseconds per miss; the trie answers a miss after the segments it shares
//! with the table, whatever the route count.

use std::time::{Duration, Instant};

use zero_server::http_types::Method;
use zero_server::router::{Resolution, RouteError, Router};

/// A target in the table's shape that matches no route.
pub const MISS: &[u8] = b"/api/v1/nothing/0";

/// What the measurement found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Miss {
    /// How many routes the table held.
    pub routes: usize,
    /// How many resolutions each batch ran.
    pub iterations: u32,
    /// The median over the batches of the time one miss took.
    pub per_miss: Duration,
}

/// A table of `routes` routes: `/api/v1/resource<n>/:id` under `GET`, `POST`,
/// `PUT` and `DELETE`, filled in that order until the count is reached.
///
/// # Arguments
///
/// * `routes` - how many routes to register.
///
/// # Errors
///
/// [`RouteError`] when a pattern is refused, which no pattern of this shape is.
pub fn table(routes: usize) -> Result<Router<u32>, RouteError> {
    const METHODS: [Method; 4] = [Method::Get, Method::Post, Method::Put, Method::Delete];
    let mut router = Router::new();
    for index in 0..routes {
        let resource = index / METHODS.len();
        let method = METHODS[index % METHODS.len()];
        let pattern = format!("/api/v1/resource{resource}/:id");
        router.route(method, &pattern, index as u32)?;
    }
    Ok(router)
}

/// Time a miss against a table of `routes` routes: `batches` batches of
/// `iterations` resolutions each, the median batch reported per resolution.
///
/// # Arguments
///
/// * `routes` - the table size; the Node router figure in the module documentation
///   is for 400.
/// * `iterations` - resolutions per batch.
/// * `batches` - batches; the median is taken, so an odd count is best.
///
/// # Errors
///
/// [`RouteError`] from building the table.
pub fn measure(routes: usize, iterations: u32, batches: usize) -> Result<Miss, RouteError> {
    let router = table(routes)?;
    let mut scratch = Vec::with_capacity(256);
    let mut times: Vec<Duration> = Vec::with_capacity(batches.max(1));
    for _ in 0..batches.max(1) {
        let started = Instant::now();
        for _ in 0..iterations {
            let target = std::hint::black_box(MISS);
            let resolved = router.resolve_target(b"GET", target, &mut scratch);
            let missed = matches!(
                resolved,
                Ok(ref resolved) if matches!(resolved.resolution, Resolution::NotFound)
            );
            std::hint::black_box(missed);
        }
        times.push(started.elapsed() / iterations.max(1));
    }
    times.sort_unstable();
    let per_miss = times.get(times.len() / 2).copied().unwrap_or_default();
    Ok(Miss {
        routes,
        iterations,
        per_miss,
    })
}

#[cfg(test)]
mod tests {
    use zero_server::router::Resolution;

    use super::{measure, table, MISS};

    #[test]
    fn the_table_holds_every_route_and_the_target_misses_it() {
        let router = table(400).unwrap();
        assert_eq!(router.routes().len(), 400);
        let mut scratch = Vec::new();
        let hit = router
            .resolve_target(b"DELETE", b"/api/v1/resource99/7", &mut scratch)
            .unwrap();
        assert!(matches!(
            hit.resolution,
            Resolution::Matched {
                descriptor: 399,
                ..
            }
        ));
        let miss = router.resolve_target(b"GET", MISS, &mut scratch).unwrap();
        assert!(matches!(miss.resolution, Resolution::NotFound));
    }

    #[test]
    fn the_measurement_reports_its_shape() {
        let miss = measure(400, 1_000, 3).unwrap();
        assert_eq!((miss.routes, miss.iterations), (400, 1_000));
        assert!(!miss.per_miss.is_zero());
    }
}
