//! The tier 4 handler ABI: an in-process `async fn` over the request and response
//! views, polled inline by the connection task that owns the request.

use std::future::Future;

use zero_core::Error;
use zero_http_types::Method;
use zero_io::seam::Stream;

use crate::call::Call;
use crate::error::ErrorShape;
use crate::takeover::Taken;

/// A tier 4 handler: one instance per core, called for every request on that core.
///
/// The body is buffered before the call (release 1 ships buffered bodies). The future
/// is `!Send`: it runs on the core that parsed the request and never moves. A handler
/// that returns `Err` is answered from the error registry
/// ([`status_for`](crate::error::status_for)); a handler that panics is answered 500,
/// and the connection and the core serve on.
pub trait Handler: 'static {
    /// Handle one request.
    ///
    /// # Arguments
    ///
    /// * `call` - the request and the response under construction.
    ///
    /// # Returns
    ///
    /// Nothing; the response is what `call` holds when the future completes.
    ///
    /// # Errors
    ///
    /// The error the registry maps to a status; whatever the handler wrote to the
    /// response is replaced by the problem response.
    fn handle(&self, call: &mut Call<'_>) -> impl Future<Output = Result<(), Error>>;

    /// The largest body this handler takes for one request, asked once when a head
    /// that announces content arrives and before any of the content is read.
    ///
    /// A declared `Content-Length` above the answer is refused with 413 at once, and
    /// a chunked body is refused when its decoded size passes it (RFC 9110 Section
    /// 15.5.14). The answer replaces the server's `max_body` for this request in either
    /// direction, so an upload route can take more than the default and a JSON route
    /// less.
    ///
    /// # Arguments
    ///
    /// * `method` - the request method, or `None` for a method outside the registry.
    /// * `path` - the path and query as received, before any normalization; empty for
    ///   the authority and asterisk forms.
    ///
    /// # Returns
    ///
    /// The limit in octets, or `None` for the server's `max_body`.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.14>
    fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64> {
        let _ = (method, path);
        None
    }

    /// Serve a connection this handler claimed with [`Call::upgrade`] or
    /// [`Call::stream`], once the response head is written.
    ///
    /// The future owns the connection until it completes; the connection closes
    /// then. The default closes it at once.
    ///
    /// # Arguments
    ///
    /// * `taken` - the connection, the request that claimed it, and the bytes that
    ///   arrived after that request's head.
    ///
    /// # Returns
    ///
    /// Nothing; the connection closes when the future completes.
    fn taken<S: Stream + 'static>(&self, taken: Taken<S>) -> impl Future<Output = ()> {
        drop(taken);
        async {}
    }

    /// A connection this handler claimed with [`Call::upgrade`] or [`Call::stream`]
    /// ended before its response head was written, so it never reaches
    /// [`taken`](Self::taken): a handler that set up state for the claim can release
    /// it now. Called on the core's thread when the driver lets go of the claimed
    /// request. The default does nothing.
    ///
    /// # Arguments
    ///
    /// * `token` - the token given with the claim.
    fn dropped(&self, token: u64) {
        let _ = token;
    }

    /// The octets this handler holds outside the request records, such as request
    /// bodies moved into an [`Exchange`](crate::Exchange) and queued outbound
    /// frames, which the core's request-memory budget counts beside the leased
    /// receive blocks and the buffered bodies. While the sum passes the budget, the
    /// core accepts no connection.
    ///
    /// Asked on every accept and every budget check of the core's accept loop, so
    /// the answer is a counter read, not a computation. The default holds nothing.
    ///
    /// # Returns
    ///
    /// The octets held.
    fn leased_bytes(&self) -> u64 {
        0
    }

    /// The body shape of the answers the core writes for errors on this handler's
    /// requests: the router's 404, 405 and 501, the driver's 413 and 503, a
    /// handler's error, and [`Call::problem`].
    ///
    /// # Returns
    ///
    /// [`ErrorShape::Problem`], the RFC 9457 body, unless the handler answers
    /// otherwise.
    fn error_shape(&self) -> ErrorShape {
        ErrorShape::Problem
    }
}
