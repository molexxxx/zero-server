//! An HTTP/1.1 server in Rust: `GET /users/:id` answers with the id, and the router
//! answers every other path and method with 404, 405 or 501 on its own.
//!
//! Run it with `cargo run -p zero-examples --example users`, then
//! `curl http://127.0.0.1:3000/users/42`.

use std::net::SocketAddr;
use std::sync::Arc;

use zero_server::core::Error;
use zero_server::http::{serve, Call, Config, Handler, Router};
use zero_server::http_types::Method;

#[derive(Clone, Copy)]
enum Route {
    User,
}

struct App {
    router: Router<Route>,
}

impl App {
    fn new() -> Self {
        let mut router = Router::new();
        router
            .route(Method::Get, "/users/:id", Route::User)
            .expect("the pattern is valid");
        App { router }
    }
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        match routed.descriptor {
            Route::User => {
                let (request, mut response) = call.parts();
                response.content_type(b"text/plain")?;
                response.body(request.param(0).unwrap_or_default());
            }
        }
        Ok(())
    }
}

fn main() -> std::io::Result<()> {
    let workers = serve(
        SocketAddr::from(([127, 0, 0, 1], 3000)),
        Config::default(),
        Arc::new(|_| {}),
        |_| App::new(),
    )?;
    println!("listening on {}", workers.local_addr());
    workers.join()
}
