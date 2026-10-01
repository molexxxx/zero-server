//! The two entries: Realistic through the router, Platform on the raw handler.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use zero_server::core::Error;
use zero_server::http::{serve, Call, Config, Handler, Router, Workers};
use zero_server::http_types::Method;
use zero_server::json::Writer;

/// The backend and driver an entry runs on, for the start line: `io-tokio on
/// epoll`, `io-compio on io_uring`, and so on.
#[must_use]
pub fn backend() -> String {
    format!(
        "{} on {}",
        zero_server::io::rt::BACKEND,
        zero_server::io::rt::driver().unwrap_or("an unknown driver")
    )
}

/// The `Server` field value both entries send.
pub const SERVER: &str = "zero";

/// The plaintext body.
pub const PLAINTEXT: &[u8] = b"Hello, World!";

/// The object the json test instantiates per request.
#[derive(Debug)]
pub struct Message {
    /// The one member.
    pub message: &'static str,
}

/// Serialize a fresh [`Message`] into the body with the buffer-direct writer.
fn write_json(body: &mut Vec<u8>) -> Result<(), Error> {
    let message = Message {
        message: "Hello, World!",
    };
    let mut writer = Writer::new(body);
    writer
        .begin_object()?
        .key("message")?
        .string(message.message)?
        .end_object()?;
    Ok(())
}

/// The routes of the Realistic entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// `/json`.
    Json,
    /// `/plaintext`.
    Plaintext,
}

/// The Realistic entry: every request goes through the router.
#[derive(Debug)]
pub struct Realistic {
    router: Router<Route>,
}

impl Realistic {
    /// The entry with its two routes.
    ///
    /// # Errors
    ///
    /// Never; the routes are fixed.
    pub fn new() -> Result<Self, Error> {
        let mut router = Router::new();
        router.route(Method::Get, "/json", Route::Json)?;
        router.route(Method::Get, "/plaintext", Route::Plaintext)?;
        Ok(Realistic { router })
    }
}

impl Handler for Realistic {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        let mut response = call.response();
        match routed.descriptor {
            Route::Json => {
                response.content_type(b"application/json")?;
                write_json(response.body_mut())
            }
            Route::Plaintext => {
                response.content_type(b"text/plain")?;
                response.body(PLAINTEXT);
                Ok(())
            }
        }
    }
}

/// The Platform entry: the raw handler compares the path itself.
#[derive(Debug, Default)]
pub struct Platform;

impl Handler for Platform {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = call.request().path();
        let is_json = path == b"/json";
        let is_plaintext = path == b"/plaintext";
        let mut response = call.response();
        if is_json {
            response.content_type(b"application/json")?;
            write_json(response.body_mut())
        } else if is_plaintext {
            response.content_type(b"text/plain")?;
            response.body(PLAINTEXT);
            Ok(())
        } else {
            response.status(zero_server::http_types::StatusCode::NOT_FOUND);
            Ok(())
        }
    }
}

/// The driver settings both entries run with: the `zero-limits` defaults, the
/// `Server` value, the given thread count and listener strategy.
///
/// # Arguments
///
/// * `threads` - how many cores; 0 for every logical CPU.
/// * `handoff` - one listener with accept handoff instead of a listener per core.
#[must_use]
pub fn config(threads: usize, handoff: bool) -> Config {
    let mut config = Config {
        server: Some(SERVER.to_owned()),
        ..Config::default()
    };
    // The one limit the entries raise: the test rules name no keep-alive cap, and
    // a connection that closes after its thousandth request drops whatever a
    // pipelining client has already sent after it, which the load generators
    // count as errors.
    config.limits.max_requests_per_connection = u32::MAX;
    config.runtime.io.threads = threads;
    config.runtime.io.listen.handoff = handoff;
    config
}

/// Start the Realistic entry.
///
/// # Arguments
///
/// * `addr` - where to listen.
/// * `config` - the driver settings, from [`config`].
///
/// # Errors
///
/// The bind or thread error.
pub fn start_realistic(addr: SocketAddr, config: Config) -> io::Result<Workers> {
    serve(addr, config, Arc::new(|_| {}), |_| {
        Realistic::new().unwrap_or_else(|_| Realistic {
            router: Router::new(),
        })
    })
}

/// Start the Platform entry.
///
/// # Arguments
///
/// * `addr` - where to listen.
/// * `config` - the driver settings, from [`config`].
///
/// # Errors
///
/// The bind or thread error.
pub fn start_platform(addr: SocketAddr, config: Config) -> io::Result<Workers> {
    serve(addr, config, Arc::new(|_| {}), |_| Platform)
}
