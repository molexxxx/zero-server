//! The tier 4 handler ABI: an in-process `async fn` over the request and response
//! views, polled inline by the connection task that owns the request.

use std::future::Future;

use zero_core::Error;

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
}
