//! Core types shared by every zero-server crate.
//!
//! This crate defines the error model, the `Codec` trait, the owned buffer that
//! crosses the I/O seam by value, the slot id that names a request in a worker's
//! arena, the `Value` model shared by codecs and drivers, and the `Digest`, `Mac`,
//! `Kdf` and `Rng` traits that no_std crates take by generic or by reference when
//! they need a primitive. It is protocol-agnostic and depends on nothing but
//! `core` and `alloc`.
//!
//! The primary items are:
//!
//! - [`Error`] and [`Result`] - the shared error model.
//! - [`Codec`] - one encoder and decoder pair per wire format.
//! - [`OwnedBuf`] - a fixed-capacity byte buffer with a filled prefix.
//! - [`SlotId`] - the 53-bit handle of a request slot, with its generation check.
//! - [`Value`] - the dynamic value model.
//! - [`Digest`], [`Mac`], [`Kdf`] and [`Rng`] - the injected primitives.
//! - [`VERSION`] - the version of the core.
//!
//! # Examples
//!
//! A slot id packs a worker, a generation and an arena index into 53 bits, and
//! an accessor refuses it once the slot has been recycled:
//!
//! ```
//! use zero_core::{Error, SlotId};
//!
//! let id = SlotId::new(3, 41, 1_024).expect("the fields are in range");
//! assert_eq!((id.worker(), id.generation(), id.index()), (3, 41, 1_024));
//! assert!(id.verify(41).is_ok());
//! assert!(matches!(id.verify(42), Err(Error::Closed)));
//! ```
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

pub mod buf;
pub mod codec;
pub mod error;
pub mod primitive;
pub mod slot;
pub mod value;

pub use buf::OwnedBuf;
pub use codec::Codec;
pub use error::{Error, Result};
pub use primitive::{Digest, Kdf, Mac, Rng};
pub use slot::SlotId;
pub use value::Value;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
