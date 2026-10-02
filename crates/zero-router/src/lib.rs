//! Method and path dispatch for zero-server.
//!
//! A [`Router`] is a value: routes are registered with a method, a pattern and a
//! descriptor the caller chooses, and [`Router::resolve`] answers with the
//! descriptor of the route that matches, the parameters it captured, or the
//! status the request deserves instead (404, 405 with `Allow`, 501 for a method
//! token the server does not implement, the automatic answers to HEAD and OPTIONS).
//! No closure is stored and nothing runs inside the matcher, so a tier 0 route
//! completes inside the caller without a handler frame.
//!
//! Patterns are paths whose segments are static, a parameter (`:name`) or, last, a
//! catch-all (`*` or `*name`). Paths are normalized before matching with
//! `zero-uri` (RFC 3986 Section 6.2.2: unreserved octets decoded, hexadecimal
//! digits uppercased, dot-segments removed), so `%41` matches `A`, `%2f` and `%2F`
//! are the same encoded slash and never a separator, and `/a/../admin` is
//! `/admin`. The query is split off at the first `?` and never matched (Section
//! 3.4). Mounted routers own their prefix: a mount is tried before the parent's
//! catch-all routes, and a request under a mount that the child does not know is
//! the child's 404, which is what keeps an application-level `/*` from hiding a
//! mounted router.
//!
//! Method tokens are compared case-sensitively (RFC 9110 Section 9.1), a GET route
//! answers HEAD with the same descriptor and the `head` flag set (Section 9.3.2),
//! and a path with routes but no OPTIONS handler gets an automatic OPTIONS answer
//! carrying `Allow` (Sections 9.3.7 and 10.2.1).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;
use core::ops::Range;

use zero_core::Error;
use zero_http_types::Method;
use zero_uri::{normalize_path, split_query, UriError};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The most parameters one route captures, catch-all included.
pub const MAX_PARAMS: usize = 16;

/// The most segments a path is matched over; a longer path is not found.
pub const MAX_SEGMENTS: usize = 64;

/// Why a route or mount was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteError {
    /// The pattern does not start with `/`.
    NoLeadingSlash,
    /// The pattern holds a byte a path cannot, or a bad percent-encoding.
    InvalidPattern,
    /// A `:` segment has no name after it.
    EmptyParameterName,
    /// A catch-all segment is not the last segment.
    CatchAllNotLast,
    /// The pattern captures more than [`MAX_PARAMS`] parameters.
    TooManyParameters,
    /// Another route names the parameter at this position differently.
    ParameterConflict,
    /// The method already has a route on this pattern.
    Duplicate,
    /// A mount prefix is `/`, which would shadow the whole router.
    RootMount,
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoLeadingSlash => "the pattern does not start with /",
            Self::InvalidPattern => "the pattern is not a valid path",
            Self::EmptyParameterName => "a parameter segment has no name",
            Self::CatchAllNotLast => "a catch-all segment is not last",
            Self::TooManyParameters => "the pattern captures too many parameters",
            Self::ParameterConflict => "another route names this parameter differently",
            Self::Duplicate => "the method already has a route on this pattern",
            Self::RootMount => "a mount cannot take the root",
        })
    }
}

impl From<RouteError> for Error {
    fn from(error: RouteError) -> Self {
        Error::Protocol(alloc::format!("router: {error}"))
    }
}

/// Whether a trailing `/` distinguishes a path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TrailingSlash {
    /// `/users/` matches the route for `/users`.
    #[default]
    Ignore,
    /// `/users/` and `/users` are different paths.
    Strict,
}

/// The set of methods a resource supports, for `Allow` (RFC 9110 Section 10.2.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Allow(u8);

impl Allow {
    /// Add a method.
    pub fn insert(&mut self, method: Method) {
        self.0 |= 1u8.wrapping_shl(u32::from(method.id()));
    }

    /// Whether the set holds `method`.
    #[must_use]
    pub const fn contains(self, method: Method) -> bool {
        self.0 & 1u8.wrapping_shl(method.id() as u32) != 0
    }

    /// Whether no method is allowed.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The methods, in id order.
    pub fn iter(self) -> impl Iterator<Item = Method> {
        Method::ALL
            .into_iter()
            .filter(move |method| self.contains(*method))
    }

    /// Append the field value: the method names separated by `, `.
    ///
    /// # Arguments
    ///
    /// * `out` - where the value goes.
    pub fn write(self, out: &mut Vec<u8>) {
        let mut first = true;
        for method in self.iter() {
            if !first {
                out.extend_from_slice(b", ");
            }
            first = false;
            out.extend_from_slice(method.as_bytes());
        }
    }
}

/// The parameters a match captured: names from the route, ranges into the path
/// the match was resolved over.
#[derive(Clone, Copy, Debug)]
pub struct Params<'r> {
    names: [&'r [u8]; MAX_PARAMS],
    ranges: [(usize, usize); MAX_PARAMS],
    len: usize,
}

impl<'r> Params<'r> {
    const fn new() -> Self {
        Params {
            names: [&[]; MAX_PARAMS],
            ranges: [(0, 0); MAX_PARAMS],
            len: 0,
        }
    }

    fn push(&mut self, name: &'r [u8], range: Range<usize>) -> bool {
        let Some(slot) = self.names.get_mut(self.len) else {
            return false;
        };
        *slot = name;
        if let Some(slot) = self.ranges.get_mut(self.len) {
            *slot = (range.start, range.end);
        }
        self.len = self.len.saturating_add(1);
        true
    }

    fn pop(&mut self) {
        self.len = self.len.saturating_sub(1);
    }

    /// How many parameters were captured.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Whether none was.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The name and range of the `index`th parameter, in pattern order.
    #[must_use]
    pub fn get(&self, index: usize) -> Option<(&'r [u8], Range<usize>)> {
        if index >= self.len {
            return None;
        }
        let name = *self.names.get(index)?;
        let (start, end) = *self.ranges.get(index)?;
        Some((name, start..end))
    }

    /// The range of the parameter called `name`.
    #[must_use]
    pub fn by_name(&self, name: &[u8]) -> Option<Range<usize>> {
        (0..self.len)
            .filter_map(|index| self.get(index))
            .find(|(found, _)| *found == name)
            .map(|(_, range)| range)
    }

    /// Every parameter in pattern order.
    pub fn iter(&self) -> impl Iterator<Item = (&'r [u8], Range<usize>)> + '_ {
        (0..self.len).filter_map(|index| self.get(index))
    }
}

/// What a request resolves to.
// A match carries its parameters by value: built once per request on the stack and
// read at once, where a box would add an allocation to every request.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Copy, Debug)]
pub enum Resolution<'r, T> {
    /// A route matched.
    Matched {
        /// The route's descriptor.
        descriptor: T,
        /// The captured parameters.
        params: Params<'r>,
        /// The request is HEAD served by the GET route: the response carries no
        /// body (RFC 9110 Section 9.3.2).
        head: bool,
    },
    /// No route has this path: 404.
    NotFound,
    /// Routes exist for the path, none for this method: 405 with `Allow`
    /// (RFC 9110 Section 15.5.6).
    MethodNotAllowed {
        /// The methods the path supports.
        allow: Allow,
    },
    /// OPTIONS on a path with routes and no OPTIONS handler: a successful response
    /// with `Allow` and no content (RFC 9110 Section 9.3.7).
    Options {
        /// The methods the path supports.
        allow: Allow,
    },
    /// The method token is not one the server implements: 501 (RFC 9110 Section
    /// 15.6.2).
    NotImplemented,
}

/// A target resolved: the resolution, the normalized path the parameter ranges
/// index, and the query.
#[derive(Clone, Copy, Debug)]
pub struct Resolved<'r, 's, T> {
    /// What the target resolves to.
    pub resolution: Resolution<'r, T>,
    /// The path as matched, with parameter ranges into it.
    pub path: &'s [u8],
    /// The query, without its `?`, when the target had one.
    pub query: Option<&'s [u8]>,
}

/// One registered route, for introspection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteInfo<T> {
    /// The method.
    pub method: Method,
    /// The pattern, with any mount prefix.
    pub pattern: String,
    /// The descriptor.
    pub descriptor: T,
}

/// A routing table: a trie over path segments plus mounted child routers.
#[derive(Clone, Debug)]
pub struct Router<T> {
    root: Node<T>,
    mounts: Vec<Mount<T>>,
    trailing_slash: TrailingSlash,
}

#[derive(Clone, Debug)]
struct Mount<T> {
    /// The normalized prefix, starting with `/` and not ending in one.
    prefix: Vec<u8>,
    router: Router<T>,
}

#[derive(Clone, Debug)]
struct Node<T> {
    /// Static children, sorted by segment.
    statics: Vec<(Vec<u8>, Node<T>)>,
    /// The parameter child, with the parameter name.
    param: Option<Box<(Vec<u8>, Node<T>)>>,
    /// The catch-all leaf, with the parameter name.
    catch_all: Option<Box<(Vec<u8>, Leaf<T>)>>,
    leaf: Option<Leaf<T>>,
}

impl<T> Node<T> {
    const fn new() -> Self {
        Node {
            statics: Vec::new(),
            param: None,
            catch_all: None,
            leaf: None,
        }
    }
}

#[derive(Clone, Debug)]
struct Leaf<T> {
    handlers: [Option<T>; 8],
    pattern: String,
}

impl<T: Copy> Leaf<T> {
    fn new(pattern: &str) -> Self {
        Leaf {
            handlers: [None; 8],
            pattern: String::from(pattern),
        }
    }

    fn handler(&self, method: Method) -> Option<T> {
        self.handlers
            .get(usize::from(method.id()))
            .copied()
            .flatten()
    }

    fn allow(&self) -> Allow {
        let mut allow = Allow::default();
        for method in Method::ALL {
            if self.handler(method).is_some() {
                allow.insert(method);
            }
        }
        if allow.contains(Method::Get) {
            allow.insert(Method::Head);
        }
        allow.insert(Method::Options);
        allow
    }
}

/// One segment of a pattern.
enum Segment<'a> {
    Static(&'a [u8]),
    Param(&'a [u8]),
    CatchAll(&'a [u8]),
}

impl<T: Copy> Default for Router<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Copy> Router<T> {
    /// An empty router that ignores a trailing slash.
    #[must_use]
    pub const fn new() -> Self {
        Router {
            root: Node::new(),
            mounts: Vec::new(),
            trailing_slash: TrailingSlash::Ignore,
        }
    }

    /// Set whether a trailing slash distinguishes a path.
    ///
    /// # Arguments
    ///
    /// * `trailing_slash` - the rule.
    #[must_use]
    pub const fn with_trailing_slash(mut self, trailing_slash: TrailingSlash) -> Self {
        self.trailing_slash = trailing_slash;
        self
    }

    /// Register a route.
    ///
    /// # Arguments
    ///
    /// * `method` - the method.
    /// * `pattern` - the path pattern: `/` followed by static segments, `:name`
    ///   parameters, and at most one final `*` or `*name` catch-all.
    /// * `descriptor` - what the match returns.
    ///
    /// # Errors
    ///
    /// [`RouteError`] for a pattern outside the syntax, a parameter named
    /// differently at the same position by another route, or a duplicate.
    pub fn route(
        &mut self,
        method: Method,
        pattern: &str,
        descriptor: T,
    ) -> Result<(), RouteError> {
        let mut scratch = Vec::new();
        let normalized = normalize_pattern(pattern, &mut scratch)?;
        let normalized = match self.trailing_slash {
            TrailingSlash::Ignore if normalized.len() > 1 => {
                normalized.strip_suffix(b"/").unwrap_or(normalized)
            }
            _ => normalized,
        };
        let segments = parse_pattern(normalized)?;
        let leaf = Self::leaf_for(&mut self.root, &segments, pattern)?;
        let slot = leaf
            .handlers
            .get_mut(usize::from(method.id()))
            .ok_or(RouteError::Duplicate)?;
        if slot.is_some() {
            return Err(RouteError::Duplicate);
        }
        *slot = Some(descriptor);
        Ok(())
    }

    /// The leaf for a pattern, creating the nodes on the way.
    fn leaf_for<'n>(
        root: &'n mut Node<T>,
        segments: &[Segment<'_>],
        pattern: &str,
    ) -> Result<&'n mut Leaf<T>, RouteError> {
        let mut node = root;
        let mut params = 0usize;
        for (index, segment) in segments.iter().enumerate() {
            match segment {
                Segment::Static(bytes) => {
                    let position = match node
                        .statics
                        .binary_search_by(|(known, _)| known.as_slice().cmp(bytes))
                    {
                        Ok(position) => position,
                        Err(position) => {
                            node.statics.insert(position, (bytes.to_vec(), Node::new()));
                            position
                        }
                    };
                    node = &mut node
                        .statics
                        .get_mut(position)
                        .ok_or(RouteError::InvalidPattern)?
                        .1;
                }
                Segment::Param(name) => {
                    params = params.saturating_add(1);
                    if params > MAX_PARAMS {
                        return Err(RouteError::TooManyParameters);
                    }
                    let child = node
                        .param
                        .get_or_insert_with(|| Box::new((name.to_vec(), Node::new())));
                    if child.0.as_slice() != *name {
                        return Err(RouteError::ParameterConflict);
                    }
                    node = &mut child.1;
                }
                Segment::CatchAll(name) => {
                    if index.saturating_add(1) != segments.len() {
                        return Err(RouteError::CatchAllNotLast);
                    }
                    params = params.saturating_add(1);
                    if params > MAX_PARAMS {
                        return Err(RouteError::TooManyParameters);
                    }
                    let child = node
                        .catch_all
                        .get_or_insert_with(|| Box::new((name.to_vec(), Leaf::new(pattern))));
                    if child.0.as_slice() != *name {
                        return Err(RouteError::ParameterConflict);
                    }
                    return Ok(&mut child.1);
                }
            }
        }
        Ok(node.leaf.get_or_insert_with(|| Leaf::new(pattern)))
    }

    /// Mount a child router under a prefix.
    ///
    /// # Arguments
    ///
    /// * `prefix` - the path prefix, `/` plus static segments; a trailing `/` is
    ///   dropped.
    /// * `router` - the child, whose patterns are relative to the prefix.
    ///
    /// # Errors
    ///
    /// [`RouteError`] for a prefix outside the syntax or the bare root.
    pub fn mount(&mut self, prefix: &str, router: Router<T>) -> Result<(), RouteError> {
        let mut scratch = Vec::new();
        let normalized = normalize_pattern(prefix, &mut scratch)?;
        let trimmed = normalized.strip_suffix(b"/").unwrap_or(normalized);
        if trimmed.is_empty() {
            return Err(RouteError::RootMount);
        }
        if trimmed.iter().any(|&byte| byte == b':' || byte == b'*') {
            return Err(RouteError::InvalidPattern);
        }
        self.mounts.push(Mount {
            prefix: trimmed.to_vec(),
            router,
        });
        // Longest prefix first, so the most specific mount is tried first.
        self.mounts.sort_by(|a, b| {
            b.prefix
                .len()
                .cmp(&a.prefix.len())
                .then_with(|| a.prefix.cmp(&b.prefix))
        });
        Ok(())
    }

    /// Resolve a request target: split the query, normalize the path, match.
    ///
    /// # Arguments
    ///
    /// * `method` - the method token as received.
    /// * `target` - the origin-form request target.
    /// * `scratch` - space for the normalized path when the target is not already
    ///   normal; on a warm caller it holds its capacity and allocates nothing.
    ///
    /// # Errors
    ///
    /// [`UriError`] for a path with a bad percent-encoding or a byte a path cannot
    /// hold, which the caller answers 400.
    pub fn resolve_target<'r, 's>(
        &'r self,
        method: &[u8],
        target: &'s [u8],
        scratch: &'s mut Vec<u8>,
    ) -> Result<Resolved<'r, 's, T>, UriError> {
        let (path, query) = split_query(target);
        let path = normalize_path(path, scratch)?;
        Ok(Resolved {
            resolution: self.resolve(method, path),
            path,
            query,
        })
    }

    /// Resolve a method token and a normalized path.
    ///
    /// # Arguments
    ///
    /// * `method` - the method token as received; compared case-sensitively.
    /// * `path` - the path, already normalized and without a query.
    #[must_use]
    pub fn resolve<'r>(&'r self, method: &[u8], path: &[u8]) -> Resolution<'r, T> {
        let Some(method) = Method::parse(method) else {
            return Resolution::NotImplemented;
        };
        self.resolve_method(method, path)
    }

    fn resolve_method<'r>(&'r self, method: Method, path: &[u8]) -> Resolution<'r, T> {
        let path = match self.trailing_slash {
            TrailingSlash::Ignore if path.len() > 1 => path.strip_suffix(b"/").unwrap_or(path),
            _ => path,
        };
        let Some(rest) = path.strip_prefix(b"/") else {
            return Resolution::NotFound;
        };
        // The root path has no segment; any other path has one per "/"-separated
        // piece after the leading "/", empty pieces included.
        let mut segments = [(0usize, 0usize); MAX_SEGMENTS];
        let mut count = 0usize;
        if !rest.is_empty() {
            let mut start = 1usize;
            for (offset, &byte) in rest.iter().enumerate() {
                if byte == b'/' {
                    let Some(slot) = segments.get_mut(count) else {
                        return Resolution::NotFound;
                    };
                    *slot = (start, offset.saturating_add(1));
                    count = count.saturating_add(1);
                    start = offset.saturating_add(2);
                }
            }
            let Some(slot) = segments.get_mut(count) else {
                return Resolution::NotFound;
            };
            *slot = (start, path.len());
            count = count.saturating_add(1);
        }
        let segments = segments.get(..count).unwrap_or(&[]);

        let mut params = Params::new();
        if let Some(leaf) = self.root.find(path, segments, &mut params, false) {
            return dispatch(leaf, method, params);
        }
        for mount in &self.mounts {
            let Some(remainder) = path.strip_prefix(mount.prefix.as_slice()) else {
                continue;
            };
            if !remainder.is_empty() && remainder.first() != Some(&b'/') {
                continue;
            }
            let child_path: &[u8] = if remainder.is_empty() {
                b"/"
            } else {
                remainder
            };
            return match mount.router.resolve_method(method, child_path) {
                Resolution::Matched {
                    descriptor,
                    params: child_params,
                    head,
                } => Resolution::Matched {
                    descriptor,
                    params: shift_params(child_params, mount.prefix.len()),
                    head,
                },
                other => other,
            };
        }
        let mut params = Params::new();
        match self.root.find(path, segments, &mut params, true) {
            Some(leaf) => dispatch(leaf, method, params),
            None => Resolution::NotFound,
        }
    }

    /// Every route, mounted ones with their prefix, in no particular order.
    #[must_use]
    pub fn routes(&self) -> Vec<RouteInfo<T>> {
        let mut out = Vec::new();
        self.root.collect("", &mut out);
        for mount in &self.mounts {
            let prefix = String::from_utf8_lossy(&mount.prefix);
            for route in mount.router.routes() {
                let mut pattern = String::from(prefix.as_ref());
                pattern.push_str(&route.pattern);
                out.push(RouteInfo { pattern, ..route });
            }
        }
        out
    }
}

/// Parameter ranges of a child resolution, moved past the mount prefix.
fn shift_params(params: Params<'_>, by: usize) -> Params<'_> {
    let mut shifted = Params::new();
    for (name, range) in params.iter() {
        shifted.push(
            name,
            range.start.saturating_add(by)..range.end.saturating_add(by),
        );
    }
    shifted
}

/// The resolution of a matched leaf for a method.
fn dispatch<'r, T: Copy>(
    leaf: &'r Leaf<T>,
    method: Method,
    params: Params<'r>,
) -> Resolution<'r, T> {
    if let Some(descriptor) = leaf.handler(method) {
        return Resolution::Matched {
            descriptor,
            params,
            head: false,
        };
    }
    if method == Method::Head {
        if let Some(descriptor) = leaf.handler(Method::Get) {
            return Resolution::Matched {
                descriptor,
                params,
                head: true,
            };
        }
    }
    let allow = leaf.allow();
    if method == Method::Options {
        return Resolution::Options { allow };
    }
    Resolution::MethodNotAllowed { allow }
}

impl<T: Copy> Node<T> {
    /// The leaf for the segments, parameters pushed on the way.
    fn find<'r>(
        &'r self,
        path: &[u8],
        segments: &[(usize, usize)],
        params: &mut Params<'r>,
        catch_all: bool,
    ) -> Option<&'r Leaf<T>> {
        let Some((&(start, end), rest)) = segments.split_first() else {
            if let Some(leaf) = self.leaf.as_ref() {
                return Some(leaf);
            }
            // A catch-all also takes the path that ends at its node, capturing
            // nothing.
            if catch_all {
                if let Some(child) = &self.catch_all {
                    if params.push(&child.0, path.len()..path.len()) {
                        return Some(&child.1);
                    }
                }
            }
            return None;
        };
        let segment = path.get(start..end).unwrap_or(&[]);
        if let Ok(position) = self
            .statics
            .binary_search_by(|(known, _)| known.as_slice().cmp(segment))
        {
            if let Some(leaf) = self
                .statics
                .get(position)
                .and_then(|(_, child)| child.find(path, rest, params, catch_all))
            {
                return Some(leaf);
            }
        }
        if let Some(child) = &self.param {
            if !segment.is_empty() && params.push(&child.0, start..end) {
                if let Some(leaf) = child.1.find(path, rest, params, catch_all) {
                    return Some(leaf);
                }
                params.pop();
            }
        }
        if catch_all {
            if let Some(child) = &self.catch_all {
                if params.push(&child.0, start..path.len()) {
                    return Some(&child.1);
                }
            }
        }
        None
    }

    fn collect(&self, prefix: &str, out: &mut Vec<RouteInfo<T>>) {
        let leaves = self
            .leaf
            .iter()
            .chain(self.catch_all.iter().map(|child| &child.1));
        for leaf in leaves {
            for method in Method::ALL {
                if let Some(descriptor) = leaf.handler(method) {
                    let mut pattern = String::from(prefix);
                    pattern.push_str(&leaf.pattern);
                    out.push(RouteInfo {
                        method,
                        pattern,
                        descriptor,
                    });
                }
            }
        }
        for (_, child) in &self.statics {
            child.collect(prefix, out);
        }
        if let Some(child) = &self.param {
            child.1.collect(prefix, out);
        }
    }
}

/// Normalize a pattern path the way request paths are normalized.
fn normalize_pattern<'a>(
    pattern: &'a str,
    scratch: &'a mut Vec<u8>,
) -> Result<&'a [u8], RouteError> {
    if !pattern.starts_with('/') {
        return Err(RouteError::NoLeadingSlash);
    }
    let (path, _) = split_query(pattern.as_bytes());
    normalize_path(path, scratch).map_err(|_| RouteError::InvalidPattern)
}

/// Split a normalized pattern into segments.
fn parse_pattern(normalized: &[u8]) -> Result<Vec<Segment<'_>>, RouteError> {
    let rest = normalized
        .strip_prefix(b"/")
        .ok_or(RouteError::NoLeadingSlash)?;
    if rest.is_empty() {
        return Ok(Vec::new());
    }
    let mut segments = Vec::new();
    for segment in rest.split(|&byte| byte == b'/') {
        segments.push(match segment.split_first() {
            Some((b':', name)) => {
                if name.is_empty() {
                    return Err(RouteError::EmptyParameterName);
                }
                Segment::Param(name)
            }
            Some((b'*', name)) => Segment::CatchAll(if name.is_empty() { b"*" } else { name }),
            _ => Segment::Static(segment),
        });
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec::Vec;

    use super::{Allow, Resolution, RouteError, Router, TrailingSlash};
    use zero_http_types::Method;
    use zero_uri::UriError;

    fn app() -> Router<u32> {
        let mut router = Router::new();
        router.route(Method::Get, "/", 1).ok();
        router.route(Method::Get, "/users", 2).ok();
        router.route(Method::Post, "/users", 3).ok();
        router.route(Method::Get, "/users/me", 4).ok();
        router.route(Method::Get, "/users/:id", 5).ok();
        router.route(Method::Delete, "/users/:id", 6).ok();
        router.route(Method::Get, "/users/:id/posts/:post", 7).ok();
        router.route(Method::Get, "/files/:name", 8).ok();
        router.route(Method::Get, "/static/*path", 9).ok();
        router.route(Method::Get, "/*", 10).ok();
        let mut admin = Router::new();
        admin.route(Method::Get, "/", 20).ok();
        admin.route(Method::Get, "/list", 21).ok();
        admin.route(Method::Get, "/users/:id", 22).ok();
        router.mount("/admin", admin).ok();
        router
    }

    fn descriptor(resolution: Resolution<'_, u32>) -> Option<u32> {
        match resolution {
            Resolution::Matched { descriptor, .. } => Some(descriptor),
            _ => None,
        }
    }

    fn resolve(
        router: &Router<u32>,
        method: &str,
        target: &str,
    ) -> (Option<u32>, Vec<(String, String)>) {
        let mut scratch = Vec::new();
        let Ok(resolved) =
            router.resolve_target(method.as_bytes(), target.as_bytes(), &mut scratch)
        else {
            return (None, Vec::new());
        };
        let params = match resolved.resolution {
            Resolution::Matched { params, .. } => params
                .iter()
                .map(|(name, range)| {
                    (
                        String::from_utf8_lossy(name).into_owned(),
                        String::from_utf8_lossy(resolved.path.get(range).unwrap_or(&[]))
                            .into_owned(),
                    )
                })
                .collect(),
            _ => Vec::new(),
        };
        (descriptor(resolved.resolution), params)
    }

    fn pair(name: &str, value: &str) -> (String, String) {
        (String::from(name), String::from(value))
    }

    #[test]
    fn static_segments_win_over_parameters_and_parameters_over_catch_alls() {
        let router = app();
        assert_eq!(resolve(&router, "GET", "/"), (Some(1), Vec::new()));
        assert_eq!(resolve(&router, "GET", "/users"), (Some(2), Vec::new()));
        assert_eq!(resolve(&router, "GET", "/users/me"), (Some(4), Vec::new()));
        assert_eq!(
            resolve(&router, "GET", "/users/42"),
            (Some(5), alloc::vec![pair("id", "42")])
        );
        assert_eq!(
            resolve(&router, "DELETE", "/users/42"),
            (Some(6), alloc::vec![pair("id", "42")])
        );
        assert_eq!(
            resolve(&router, "GET", "/users/42/posts/7"),
            (Some(7), alloc::vec![pair("id", "42"), pair("post", "7")])
        );
        assert_eq!(
            resolve(&router, "GET", "/static/css/site.css"),
            (Some(9), alloc::vec![pair("path", "css/site.css")])
        );
        assert_eq!(
            resolve(&router, "GET", "/static/"),
            (Some(9), alloc::vec![pair("path", "")])
        );
        assert_eq!(
            resolve(&router, "GET", "/anything/else"),
            (Some(10), alloc::vec![pair("*", "anything/else")])
        );
        assert_eq!(
            resolve(&router, "GET", "/users/"),
            (Some(2), Vec::new()),
            "a trailing slash is ignored"
        );
        let strict = app().with_trailing_slash(TrailingSlash::Strict);
        assert_eq!(
            resolve(&strict, "GET", "/users/"),
            (Some(10), alloc::vec![pair("*", "users/")])
        );
        assert_eq!(
            resolve(&router, "GET", "/users//x"),
            (Some(10), alloc::vec![pair("*", "users//x")]),
            "an empty segment is not a parameter"
        );
    }

    #[test]
    fn mounts_own_their_prefix_and_come_before_the_parent_catch_all() {
        let router = app();
        assert_eq!(resolve(&router, "GET", "/admin"), (Some(20), Vec::new()));
        assert_eq!(resolve(&router, "GET", "/admin/"), (Some(20), Vec::new()));
        assert_eq!(
            resolve(&router, "GET", "/admin/list"),
            (Some(21), Vec::new())
        );
        assert_eq!(
            resolve(&router, "GET", "/admin/users/9"),
            (Some(22), alloc::vec![pair("id", "9")])
        );
        assert_eq!(
            resolve(&router, "GET", "/admin/unknown"),
            (None, Vec::new()),
            "the child's 404, not the parent's /*"
        );
        assert_eq!(
            resolve(&router, "GET", "/administrator"),
            (Some(10), alloc::vec![pair("*", "administrator")])
        );
        let mut scratch = Vec::new();
        let resolved = router.resolve_target(b"GET", b"/admin/list?page=2", &mut scratch);
        assert_eq!(
            resolved.as_ref().map(|r| r.query),
            Ok(Some(&b"page=2"[..])),
            "the query survives a mount"
        );
        assert_eq!(resolved.map(|r| descriptor(r.resolution)), Ok(Some(21)));
        let listed = router.routes();
        assert!(listed
            .iter()
            .any(|route| route.pattern == "/admin/users/:id" && route.descriptor == 22));
        assert!(listed
            .iter()
            .any(|route| route.pattern == "/static/*path" && route.method == Method::Get));
        assert_eq!(listed.len(), 13);
    }

    /// Standards rows `routing-01` and `routing-04`: RFC 9110 Section 9.1.
    #[test]
    fn an_unrecognized_or_unimplemented_method_is_answered_with_501_not_implemented() {
        let router = app();
        assert!(matches!(
            router.resolve(b"PATCH", b"/users"),
            Resolution::NotImplemented
        ));
        assert!(matches!(
            router.resolve(b"BREW", b"/users"),
            Resolution::NotImplemented
        ));
        assert!(matches!(
            router.resolve(b"", b"/users"),
            Resolution::NotImplemented
        ));
    }

    /// Standards row `routing-04`.
    #[test]
    fn method_tokens_are_matched_case_sensitively_so_get_does_not_dispatch_to_a_get_handler() {
        let router = app();
        assert!(matches!(
            router.resolve(b"get", b"/users"),
            Resolution::NotImplemented
        ));
        assert!(matches!(
            router.resolve(b"Get", b"/users"),
            Resolution::NotImplemented
        ));
        assert_eq!(descriptor(router.resolve(b"GET", b"/users")), Some(2));
    }

    /// Standards rows `routing-02` and `routing-03`: RFC 9110 Sections 15.5.6 and 10.2.1.
    #[test]
    fn a_recognized_method_that_the_route_does_not_allow_is_answered_with_405() {
        let router = app();
        let Resolution::MethodNotAllowed { allow } = router.resolve(b"PUT", b"/users") else {
            unreachable!("a known path with other methods");
        };
        assert!(allow.contains(Method::Get) && allow.contains(Method::Post));
        assert!(!allow.contains(Method::Put));
        assert!(
            matches!(router.resolve(b"PUT", b"/nothing/here/at/all"), Resolution::MethodNotAllowed { allow } if allow.contains(Method::Get)),
            "the catch-all is a GET route, so PUT is 405 there"
        );
        assert!(matches!(
            router.resolve(b"GET", b"/nothing/here/at/all"),
            Resolution::Matched { descriptor: 10, .. }
        ));
        let mut bare = Router::new();
        bare.route(Method::Post, "/only", 1).ok();
        assert!(matches!(
            bare.resolve(b"GET", b"/only"),
            Resolution::MethodNotAllowed { .. }
        ));
        assert!(matches!(
            bare.resolve(b"GET", b"/none"),
            Resolution::NotFound
        ));
    }

    /// Standards row `routing-03`.
    #[test]
    fn a_405_response_carries_an_allow_header_field_listing_the_methods_the_target_resource_supports(
    ) {
        let router = app();
        let Resolution::MethodNotAllowed { allow } = router.resolve(b"PUT", b"/users/42") else {
            unreachable!("GET and DELETE exist");
        };
        let mut value = Vec::new();
        allow.write(&mut value);
        assert_eq!(
            value, b"GET, HEAD, DELETE, OPTIONS",
            "GET brings HEAD, and OPTIONS is always answered"
        );
        let mut empty = Vec::new();
        Allow::default().write(&mut empty);
        assert!(empty.is_empty());
    }

    #[test]
    fn head_is_served_by_get_and_options_is_answered_with_allow_unless_registered() {
        let router = app();
        assert!(matches!(
            router.resolve(b"HEAD", b"/users"),
            Resolution::Matched {
                descriptor: 2,
                head: true,
                ..
            }
        ));
        assert!(matches!(
            router.resolve(b"GET", b"/users"),
            Resolution::Matched {
                descriptor: 2,
                head: false,
                ..
            }
        ));
        let Resolution::Options { allow } = router.resolve(b"OPTIONS", b"/users") else {
            unreachable!("no OPTIONS route");
        };
        let mut value = Vec::new();
        allow.write(&mut value);
        assert_eq!(value, b"GET, HEAD, POST, OPTIONS");
        let mut explicit = Router::new();
        explicit.route(Method::Options, "/x", 7).ok();
        assert!(matches!(
            explicit.resolve(b"OPTIONS", b"/x"),
            Resolution::Matched { descriptor: 7, .. }
        ));
        assert!(
            matches!(
                explicit.resolve(b"HEAD", b"/x"),
                Resolution::MethodNotAllowed { .. }
            ),
            "HEAD needs GET"
        );
    }

    /// Standards row `routing-19`: RFC 3986 Section 2.2.
    #[test]
    fn route_matching_compares_an_encoded_2f_as_data_never_as_a_path_separator() {
        let router = app();
        assert_eq!(
            resolve(&router, "GET", "/files/a%2Fb"),
            (Some(8), alloc::vec![pair("name", "a%2Fb")])
        );
        assert_eq!(
            resolve(&router, "GET", "/files/a%2fb"),
            (Some(8), alloc::vec![pair("name", "a%2Fb")])
        );
        assert_eq!(
            resolve(&router, "GET", "/files/a/b"),
            (Some(10), alloc::vec![pair("*", "files/a/b")])
        );
        assert_eq!(
            resolve(&router, "GET", "/users%2Fme"),
            (Some(10), alloc::vec![pair("*", "users%2Fme")])
        );
    }

    /// Standards row `routing-20`: RFC 3986 Sections 2.1 and 2.3.
    #[test]
    fn percent_encoded_unreserved_characters_match_their_decoded_form_and_hex_digits_compare_without_case(
    ) {
        let router = app();
        assert_eq!(
            resolve(&router, "GET", "/%75sers/m%65"),
            (Some(4), Vec::new())
        );
        assert_eq!(
            resolve(&router, "GET", "/users/%34%32"),
            (Some(5), alloc::vec![pair("id", "42")])
        );
        assert_eq!(
            resolve(&router, "GET", "/files/%7e%7E"),
            (Some(8), alloc::vec![pair("name", "~~")])
        );
        let mut encoded = Router::new();
        encoded.route(Method::Get, "/caf%c3%a9", 1).ok();
        assert_eq!(
            resolve(&encoded, "GET", "/caf%C3%A9"),
            (Some(1), Vec::new()),
            "a pattern is normalized the same way"
        );
    }

    /// Standards row `routing-21`: RFC 3986 Section 5.2.4.
    #[test]
    fn dot_segments_and_are_resolved_with_remove_dot_segments_before_routing_so_a_mount_is_not_bypassed(
    ) {
        let router = app();
        assert_eq!(
            resolve(&router, "GET", "/public/../admin/list"),
            (Some(21), Vec::new())
        );
        assert_eq!(
            resolve(&router, "GET", "/admin/./list"),
            (Some(21), Vec::new())
        );
        assert_eq!(
            resolve(&router, "GET", "/admin/%2e%2E/users/me"),
            (Some(4), Vec::new())
        );
        assert_eq!(resolve(&router, "GET", "/../users"), (Some(2), Vec::new()));
    }

    /// Standards row `routing-22`: RFC 3986 Section 3.4.
    #[test]
    fn the_query_component_is_split_from_the_path_at_the_first_and_never_participates_in_path_matching(
    ) {
        let router = app();
        let mut scratch = Vec::new();
        let resolved = router.resolve_target(b"GET", b"/users/42?x=/users/me?y", &mut scratch);
        assert_eq!(resolved.as_ref().map(|r| r.path), Ok(&b"/users/42"[..]));
        assert_eq!(
            resolved.as_ref().map(|r| r.query),
            Ok(Some(&b"x=/users/me?y"[..]))
        );
        assert_eq!(resolved.map(|r| descriptor(r.resolution)), Ok(Some(5)));
        assert_eq!(resolve(&router, "GET", "/users?"), (Some(2), Vec::new()));
    }

    #[test]
    fn bad_targets_and_bad_patterns_are_refused() {
        let router = app();
        let mut scratch = Vec::new();
        assert!(matches!(
            router
                .resolve_target(b"GET", b"/users/%zz", &mut scratch)
                .map(|_| ()),
            Err(UriError::InvalidPercent(7))
        ));
        assert!(matches!(
            router
                .resolve_target(b"GET", b"/a b", &mut scratch)
                .map(|_| ()),
            Err(UriError::InvalidByte(2))
        ));
        assert!(matches!(router.resolve(b"GET", b"*"), Resolution::NotFound));
        let mut bad = Router::new();
        assert_eq!(
            bad.route(Method::Get, "users", 1),
            Err(RouteError::NoLeadingSlash)
        );
        assert_eq!(
            bad.route(Method::Get, "/a/:", 1),
            Err(RouteError::EmptyParameterName)
        );
        assert_eq!(
            bad.route(Method::Get, "/a/*rest/b", 1),
            Err(RouteError::CatchAllNotLast)
        );
        assert_eq!(
            bad.route(Method::Get, "/a b", 1),
            Err(RouteError::InvalidPattern)
        );
        assert_eq!(bad.route(Method::Get, "/a/:id", 1), Ok(()));
        assert_eq!(
            bad.route(Method::Get, "/a/:other", 2),
            Err(RouteError::ParameterConflict)
        );
        assert_eq!(
            bad.route(Method::Get, "/a/:id", 3),
            Err(RouteError::Duplicate)
        );
        assert_eq!(bad.route(Method::Post, "/a/:id", 3), Ok(()));
        assert_eq!(bad.mount("/", Router::new()), Err(RouteError::RootMount));
        assert_eq!(
            bad.mount("/x/:y", Router::new()),
            Err(RouteError::InvalidPattern)
        );
        let many: String = (0..super::MAX_PARAMS.saturating_add(1))
            .map(|i| alloc::format!("/:p{i}"))
            .collect();
        assert_eq!(
            bad.route(Method::Get, &many, 1),
            Err(RouteError::TooManyParameters)
        );
        let deep: String = "/x".repeat(super::MAX_SEGMENTS.saturating_add(1));
        assert!(matches!(
            router.resolve(b"GET", deep.as_bytes()),
            Resolution::NotFound
        ));
    }
}
