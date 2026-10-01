//! The HTTP types shared by every zero-server protocol crate.
//!
//! `Method` as integer ids, `StatusCode` with its classes and prebuilt status
//! lines, the interned `HeaderName` table shared with the C header, `Fields`
//! as a bounded list of name and value pairs with linear scan, the
//! protocol-neutral `RequestHead` and `ResponseHead` that every front-end
//! codec produces, trailers, body chunks, the `Early` marker for requests that
//! arrived in TLS early data, and HTML escaping. Every grammar is the one its
//! RFC states, cited on the item that implements it.
//!
//! The primary items are:
//!
//! - [`Method`] - the eight standardized request methods.
//! - [`StatusCode`] and [`StatusClass`] - status codes and their classes.
//! - [`HeaderName`] - the interned field names.
//! - [`Fields`], [`Name`] and [`FieldError`] - the bounded field list and the
//!   name and value grammars.
//! - [`RequestHead`], [`ResponseHead`], [`Trailers`], [`BodyChunk`],
//!   [`Scheme`] and [`Early`] - the message abstraction.
//! - [`escape_html`] - HTML entity encoding for untrusted text.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! ```
//! use zero_http_types::{Fields, HeaderName, Method, StatusCode};
//!
//! assert_eq!(Method::parse(b"GET"), Some(Method::Get));
//! assert_eq!(StatusCode::NOT_FOUND.status_line(), Some(&b"HTTP/1.1 404 Not Found\r\n"[..]));
//!
//! let mut fields = Fields::with_max(8);
//! fields.insert_bytes(b"Content-Type", b"text/plain")?;
//! assert_eq!(fields.get_known(HeaderName::ContentType), Some(&b"text/plain"[..]));
//! assert_eq!(fields.get(b"CONTENT-TYPE"), Some(&b"text/plain"[..]));
//! # Ok::<(), zero_http_types::FieldError>(())
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod escape;
pub mod field;
pub mod head;
pub mod header;
pub mod method;
pub mod status;

pub use escape::{escape_html, escape_html_into, html_entity, is_html_safe};
pub use field::{
    is_field_vchar, is_tchar, is_token, validate_field_name, validate_field_value, FieldError,
    Fields, Name,
};
pub use head::{BodyChunk, Early, RequestHead, ResponseHead, Scheme, Trailers};
pub use header::{HeaderName, MAX_HEADER_NAME_LEN};
pub use method::Method;
pub use status::{StatusClass, StatusCode, BARE_STATUS_LINE_LEN, MAX_STATUS_LINE_LEN};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
