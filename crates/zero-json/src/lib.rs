//! The JSON codec of zero-server (RFC 8259).
//!
//! [`Writer`] serializes straight into a byte buffer: objects, keys, strings with
//! the escapes Section 7 requires, integers, floats, arrays, booleans and null,
//! with no intermediate tree, which is what the json benchmark route and the
//! tier 2 serializers need. [`parse`] is the strict parser: it accepts every text
//! of the Section 2 grammar and nothing else, into the [`Value`] model of
//! `zero-core`, under a size cap and a nesting cap (Section 9), decoding strings as
//! UTF-8 (Section 8.1) with an unpaired surrogate escape refused.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod parse;
pub mod write;

pub use parse::{parse, parse_with, BigIntegers, ErrorKind, Options, ParseError, TopLevel};
pub use write::{to_vec, WriteError, Writer};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The largest integer a binary64 holds exactly: `2^53 - 1` (RFC 8259 Section
/// 6). Integers past it or past its negation are lossy in JavaScript, which
/// [`BigIntegers::Strings`] is for.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
