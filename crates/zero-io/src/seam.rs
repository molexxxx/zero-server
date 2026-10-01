//! The seam: the traits every backend implements and every crate above programs against.
//!
//! Every future a backend returns is `!Send`: a connection lives on the core that
//! accepted it for its whole lifetime, so nothing here is sent between threads. Every
//! buffer that crosses an await is owned: a read takes an [`OwnedBuf`] and hands it back
//! with the count, a write takes one and hands it back with how much of it went out. A
//! readiness backend performs the operation when the socket is ready; a completion
//! backend hands the buffer to the kernel and gets it back with the completion. Both
//! satisfy the same signatures, which is why the signatures are the contract.
//!
//! Errors are `std::io::Error`, so the operating system's code reaches the caller and a
//! peer reset, a would-block and a refused address stay distinguishable.

use std::future::Future;
use std::io::{self, IoSlice};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use zero_core::OwnedBuf;

use crate::pool::Pool;

/// What [`Stream::read_leased`] produced.
#[derive(Debug)]
pub enum Leased {
    /// Bytes arrived, in a buffer leased from the pool; the caller returns it.
    Data(OwnedBuf),
    /// The peer closed its side; nothing was leased.
    Eof,
    /// The pool's budget is spent; nothing was read or leased.
    NoBudget,
}

/// This core's executor.
pub trait Runtime {
    /// Run `future` to completion on this core, beside the task that spawned it.
    ///
    /// # Arguments
    ///
    /// * `future` - the work; it never leaves this thread, so it need not be `Send`.
    fn spawn_local<F>(&self, future: F)
    where
        F: Future<Output = ()> + 'static;
}

/// A listening socket that yields streams.
pub trait Listener {
    /// The stream type an accepted connection becomes.
    type Stream: Stream;

    /// The next connection.
    ///
    /// # Returns
    ///
    /// The stream and the peer's address.
    ///
    /// # Errors
    ///
    /// The operating system's error, or the listener being closed.
    fn accept(&self) -> impl Future<Output = io::Result<(Self::Stream, SocketAddr)>>;

    /// The address the listener is bound to.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn local_addr(&self) -> io::Result<SocketAddr>;
}

/// A connected byte stream.
pub trait Stream {
    /// Wait until a read would return something, without leasing a buffer for it.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn readable(&self) -> impl Future<Output = io::Result<()>>;

    /// Read into a buffer leased from `pool` only once there is something to read: the
    /// lazy lease of `DESIGN.md` section 5.6. A readiness backend waits for readiness,
    /// leases, and reads at once, returning the block to the pool when the readiness
    /// was spurious, so a connection that is waiting holds no buffer; a completion
    /// backend takes the block from the kernel's buffer ring with the completion.
    ///
    /// # Arguments
    ///
    /// * `pool` - this core's pool.
    ///
    /// # Returns
    ///
    /// The buffer with the bytes read, the end of the stream, or that the pool has no
    /// budget right now (nothing was read; the caller pauses).
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn read_leased(&self, pool: &Pool) -> impl Future<Output = io::Result<Leased>>;

    /// Read into the unfilled part of `buf`, a buffer the caller already holds (a
    /// partial head that needs the rest).
    ///
    /// # Arguments
    ///
    /// * `buf` - the buffer; the bytes read are appended to its filled region.
    ///
    /// # Returns
    ///
    /// How many bytes were read (0 at the end of the stream) and the buffer, in every
    /// case.
    fn read_into(&self, buf: OwnedBuf) -> impl Future<Output = (io::Result<usize>, OwnedBuf)>;

    /// Write the filled part of `buf`.
    ///
    /// # Arguments
    ///
    /// * `buf` - the buffer; it comes back as it went, and the count says how much of
    ///   its filled region was written, which can be less than all of it.
    ///
    /// # Returns
    ///
    /// How many bytes were written and the buffer, in every case.
    fn write(&self, buf: OwnedBuf) -> impl Future<Output = (io::Result<usize>, OwnedBuf)>;

    /// Write several slices in one call.
    ///
    /// # Arguments
    ///
    /// * `bufs` - the slices, in order; the per-core iovec array of the caller.
    ///
    /// # Returns
    ///
    /// How many bytes were written, which can be fewer than the slices hold.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn writev(&self, bufs: &[IoSlice<'_>]) -> impl Future<Output = io::Result<usize>>;

    /// Close the write side, so the peer reads the end of the stream.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn shutdown_write(&self) -> io::Result<()>;

    /// The peer's address.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn peer_addr(&self) -> io::Result<SocketAddr>;
}

/// The ECN codepoint of a datagram (RFC 3168), the low two bits of the traffic class.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Ecn {
    /// Not ECN-capable transport.
    #[default]
    NotCapable,
    /// ECN-capable transport, codepoint ECT(1).
    Ect1,
    /// ECN-capable transport, codepoint ECT(0).
    Ect0,
    /// Congestion experienced.
    Ce,
}

impl Ecn {
    /// The codepoint carried by a traffic class byte.
    ///
    /// # Arguments
    ///
    /// * `tos` - the type of service or traffic class byte.
    ///
    /// # Returns
    ///
    /// Its low two bits as a codepoint.
    #[must_use]
    pub const fn from_tos(tos: u8) -> Self {
        match tos & 0b11 {
            0b01 => Self::Ect1,
            0b10 => Self::Ect0,
            0b11 => Self::Ce,
            _ => Self::NotCapable,
        }
    }

    /// The two bits of this codepoint.
    #[must_use]
    pub const fn bits(self) -> u8 {
        match self {
            Self::NotCapable => 0b00,
            Self::Ect1 => 0b01,
            Self::Ect0 => 0b10,
            Self::Ce => 0b11,
        }
    }
}

/// What travels with one datagram besides its bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DatagramMeta {
    /// The peer: who sent it, or who it goes to.
    pub peer: Option<SocketAddr>,
    /// The local address it arrived on, or the source to send it from.
    pub local: Option<IpAddr>,
    /// The ECN codepoint it carried, or the one to send it with.
    pub ecn: Ecn,
    /// The segment size: on receive, the size the kernel coalesced consecutive datagrams
    /// at, so the buffer holds several; on send, the size to split the buffer at, so one
    /// buffer becomes several datagrams. `None` for one datagram per buffer.
    pub segment_size: Option<u16>,
    /// On receive: the datagram was longer than the buffer and the rest is gone.
    pub truncated: bool,
}

/// A datagram socket that receives and sends in batches.
pub trait Datagram {
    /// Receive up to `bufs.len()` datagrams, one per buffer, with their metadata.
    ///
    /// # Arguments
    ///
    /// * `bufs` - the buffers, each filled from its filled length onward.
    /// * `meta` - one entry per buffer, written for each datagram received.
    ///
    /// # Returns
    ///
    /// How many datagrams were received; at least one.
    ///
    /// # Errors
    ///
    /// The operating system's error, or `InvalidInput` when `meta` is shorter than
    /// `bufs`.
    fn recv_batch(
        &self,
        bufs: &mut [OwnedBuf],
        meta: &mut [DatagramMeta],
    ) -> impl Future<Output = io::Result<usize>>;

    /// Send the filled part of each buffer as a datagram with its metadata.
    ///
    /// # Arguments
    ///
    /// * `bufs` - the buffers, in order.
    /// * `meta` - one entry per buffer; `peer` is required on an unconnected socket.
    ///
    /// # Returns
    ///
    /// How many datagrams were sent; at least one.
    ///
    /// # Errors
    ///
    /// The operating system's error, or `InvalidInput` when `meta` is shorter than
    /// `bufs`.
    fn send_batch(
        &self,
        bufs: &[OwnedBuf],
        meta: &[DatagramMeta],
    ) -> impl Future<Output = io::Result<usize>>;

    /// The address the socket is bound to.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    fn local_addr(&self) -> io::Result<SocketAddr>;
}

/// The error of [`Timer::timeout`]: the future did not finish in time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Elapsed;

impl std::fmt::Display for Elapsed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the deadline passed")
    }
}

impl std::error::Error for Elapsed {}

/// This core's clock.
pub trait Timer {
    /// Wait for `duration`.
    ///
    /// # Arguments
    ///
    /// * `duration` - how long.
    fn sleep(&self, duration: Duration) -> impl Future<Output = ()>;

    /// Run `future` for at most `duration`.
    ///
    /// # Arguments
    ///
    /// * `duration` - the deadline, from now.
    /// * `future` - the work.
    ///
    /// # Returns
    ///
    /// The future's output, or [`Elapsed`] when the deadline passed first.
    fn timeout<F>(
        &self,
        duration: Duration,
        future: F,
    ) -> impl Future<Output = Result<F::Output, Elapsed>>
    where
        F: Future;
}

/// This core's `Date` header block, refreshed every second.
pub trait DateService {
    /// The block, `Date: <IMF-fixdate>\r\n`, 37 bytes.
    fn date_block(&self) -> [u8; crate::date::DATE_BLOCK_LEN];
}

/// The shutdown signal: requested once, observed everywhere.
pub trait Shutdown {
    /// Ask every core to stop accepting and to drain.
    fn request(&self);

    /// Whether a shutdown was requested.
    fn is_requested(&self) -> bool;

    /// Wait until a shutdown is requested; returns at once when it already was.
    fn requested(&self) -> impl Future<Output = ()>;

    /// Run `future` until it finishes or a shutdown is requested, whichever is first.
    ///
    /// # Arguments
    ///
    /// * `future` - the work.
    ///
    /// # Returns
    ///
    /// The future's output, or `None` when the shutdown came first.
    fn until<F>(&self, future: F) -> impl Future<Output = Option<F::Output>>
    where
        F: Future;
}

#[cfg(test)]
mod tests {
    use super::{DatagramMeta, Ecn, Elapsed};

    #[test]
    fn the_ecn_codepoint_is_the_low_two_bits() {
        assert_eq!(Ecn::from_tos(0b1011_1000), Ecn::NotCapable);
        assert_eq!(Ecn::from_tos(0b0000_0001), Ecn::Ect1);
        assert_eq!(Ecn::from_tos(0b1111_1110), Ecn::Ect0);
        assert_eq!(Ecn::from_tos(0b0000_0011), Ecn::Ce);
        for codepoint in [Ecn::NotCapable, Ecn::Ect1, Ecn::Ect0, Ecn::Ce] {
            assert_eq!(Ecn::from_tos(codepoint.bits()), codepoint);
        }
        assert_eq!(DatagramMeta::default().ecn, Ecn::NotCapable);
        assert_eq!(format!("{Elapsed}"), "the deadline passed");
    }
}
