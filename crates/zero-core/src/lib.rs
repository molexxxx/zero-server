//! Core types shared by every zero-server crate.
//!
//! This crate defines the error model, the `Codec` trait shape, the owned buffer
//! types, the slot id encoding, the `Value` model shared by codecs and drivers, and
//! the `Digest`, `Mac`, `Kdf` and `Rng` traits that no_std crates take by generic or
//! function table when they need a primitive. It is protocol-agnostic and depends on
//! nothing but `core` and `alloc`.
//!
//! The primary items are:
//!
//! - [`Error`] and [`Result`] - the shared error model.
//! - [`VERSION`] - the version of the core.
//!
//! # Examples
//!
//! Every failure is one [`Error`] variant with a description:
//!
//! ```
//! use zero_core::Error;
//!
//! let error = Error::Limit("body exceeds 1 MiB".into());
//! assert_eq!(error.to_string(), "limit exceeded: body exceeds 1 MiB");
//! ```

// The core is `no_std` unless the default `std` feature is on. The owned types it
// needs (`String`, `Vec`) come from `alloc`.
#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod error;

pub use error::{Error, Result};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
