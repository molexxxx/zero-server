//! The audited leaf crate that owns every raw operating-system call the zero-server
//! workspace makes.
//!
//! Safe, bounds-checked wrappers over socket options ([`sockopt`]), `sendmsg` and
//! `recvmsg` with control-message construction and parsing ([`msg`], [`cmsg`]), and
//! thread affinity ([`affinity`]). Every other crate stays at `unsafe_code = "forbid"`
//! because the raw calls live here; each `unsafe` block carries the reason it is sound.
//! Where socket2 already exposes an option as a safe method, the wrapper delegates to it
//! and adds nothing. The [`alloc`] module holds the counting wrapper over the system
//! allocator that the allocation-free claims of the workspace are tested with.
//!
//! The wrappers take any socket the standard library can borrow (`AsFd` on Unix,
//! `AsSocket` on Windows) through the [`Sock`] bound, so a `std::net` socket, a tokio
//! socket and a socket2 socket all qualify.

pub mod affinity;
pub mod alloc;
#[cfg(unix)]
pub mod cmsg;
pub mod error;
#[cfg(unix)]
pub mod msg;
#[cfg(unix)]
pub mod packet;
pub mod sockopt;

/// A socket the wrappers can borrow for one call.
///
/// Implemented for every type that is `AsFd` on Unix and `AsSocket` on Windows.
#[cfg(unix)]
pub trait Sock: std::os::fd::AsFd {}

#[cfg(unix)]
impl<S: std::os::fd::AsFd> Sock for S {}

/// A socket the wrappers can borrow for one call.
///
/// Implemented for every type that is `AsFd` on Unix and `AsSocket` on Windows.
#[cfg(windows)]
pub trait Sock: std::os::windows::io::AsSocket {}

#[cfg(windows)]
impl<S: std::os::windows::io::AsSocket> Sock for S {}

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
