//! The smallest zero-server program: every request is answered with `hello`.
//!
//! Run it with `cargo run -p zero-examples --example hello`, then
//! `curl http://127.0.0.1:3000/`.

use std::net::SocketAddr;
use std::sync::Arc;

use zero_server::core::Error;
use zero_server::http::{serve, Call, Config, Handler};

struct Hello;

impl Handler for Hello {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        call.response().content_type(b"text/plain")?.body(b"hello");
        Ok(())
    }
}

fn main() -> std::io::Result<()> {
    let address = SocketAddr::from(([127, 0, 0, 1], 3000));
    let workers = serve(address, Config::default(), Arc::new(|_| {}), |_| Hello)?;
    println!("listening on {}", workers.local_addr());
    workers.join()
}
