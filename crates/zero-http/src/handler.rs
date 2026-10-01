//! The tier 4 handler ABI: an in-process `async fn` over the request and response
//! views, polled inline by the connection task that owns the request.

use std::future::Future;

use zero_core::Error;
use zero_http_types::Method;

use crate::call::Call;

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
}
