//! The whole zero-server core in one crate.
//!
//! Every capability crate is re-exported behind a feature named as the crate
//! without its `zero-` prefix (the crypto crate as `crypto`, the static file crate
//! as [`files`]), all on by default, so an application depends on this crate alone
//! and compiles only what it turns on. The core types are always present as
//! [`core`].
//!
//! # Examples
//!
//! ```
//! assert_eq!(zero_server::core::VERSION, zero_server::VERSION);
//! ```

pub use zero_core as core;

#[cfg(feature = "base64")]
pub use zero_base64 as base64;
#[cfg(feature = "date")]
pub use zero_date as date;
#[cfg(feature = "h3")]
pub use zero_h3 as h3;
#[cfg(feature = "http")]
pub use zero_http as http;
#[cfg(feature = "http1")]
pub use zero_http1 as http1;
#[cfg(feature = "http-types")]
pub use zero_http_types as http_types;
#[cfg(feature = "io")]
pub use zero_io as io;
#[cfg(feature = "json")]
pub use zero_json as json;
#[cfg(feature = "limits")]
pub use zero_limits as limits;
#[cfg(feature = "mime")]
pub use zero_mime as mime;
#[cfg(feature = "policy")]
pub use zero_policy as policy;
#[cfg(feature = "qpack")]
pub use zero_qpack as qpack;
#[cfg(feature = "qs")]
pub use zero_qs as qs;
#[cfg(feature = "realtime")]
pub use zero_realtime as realtime;
#[cfg(feature = "router")]
pub use zero_router as router;
#[cfg(feature = "rt")]
pub use zero_rt as rt;
#[cfg(feature = "crypto")]
pub use zero_server_crypto as crypto;
#[cfg(feature = "simd")]
pub use zero_simd as simd;
#[cfg(feature = "sse")]
pub use zero_sse as sse;
#[cfg(feature = "static")]
pub use zero_static as files;
#[cfg(feature = "sys")]
pub use zero_sys as sys;
#[cfg(feature = "tls")]
pub use zero_tls as tls;
#[cfg(feature = "uri")]
pub use zero_uri as uri;
#[cfg(feature = "ws")]
pub use zero_ws as ws;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
