//! The C ABI of zero-server: a curated `extern "C"` surface over its host boundary.
//!
//! C and C++ link this library directly, and .NET (P/Invoke) and Python (`ctypes`) load
//! it as a shared library. It is a thin layer over `zero-host`, which holds the
//! applications, the servers, the dispatch of requests to a host and the rules of slot
//! access: every function checks its arguments, calls zero-host, and writes its outputs.
//! It is the one audited `unsafe` boundary on the language side; every pointer a host
//! passes is read or written here and nowhere else. The header `include/zero.h` is
//! generated from this crate by cbindgen and opens with this text.
//!
//! A host builds an app (`zero_app_new`, routes and policies from JSON option
//! documents), builds a server from it (`zero_server_new`), attaches a pull target to its
//! worker indexes (`zero_target_attach`), starts it, and polls batches of leased requests
//! on its own thread (`zero_target_poll`). It reads each request by slot id, writes the
//! response, and hands the answered ids back with `zero_batch_complete`, acknowledging
//! each batch by its epoch from the polling thread.
//!
//! # Rules
//!
//! 1. Ids. Servers, apps, targets, slots and connections are `uint64_t` ids of at most
//!    53 bits, exact as JavaScript numbers. A stale or unknown id returns
//!    `ZeroStatus_Closed`, and an id above `ZERO_ID_MAX` returns
//!    `ZeroStatus_InvalidArgument`. `ZERO_NONE` means "no id" where an argument allows
//!    one to be absent.
//! 2. Input ranges. A byte range `(const uint8_t *ptr, uintptr_t len)` is borrowed for
//!    the call only and must not change during it. A zero `len` accepts any `ptr`, NULL
//!    included; NULL with a nonzero `len`, or a `len` above `PTRDIFF_MAX`, returns
//!    `InvalidArgument`. The library copies whatever it keeps. In `zero_sse_send` alone, a
//!    NULL `event` or `id` with a zero length means the field is absent, and a non-NULL
//!    pointer with a zero length is a present empty value.
//! 3. Outputs. An output pointer must be non-null and aligned for its type, otherwise the
//!    call returns `InvalidArgument` and does nothing. Outputs are written only on
//!    `ZeroStatus_Ok`, except the per-slot `results_out` of `zero_batch_complete` and the
//!    `count_out` of `zero_server_workers`, which reports the full count with
//!    `ZeroStatus_Limit` when `cap` is too small.
//! 4. Sized structs. Every struct passed alone by pointer starts with `uint32_t size`. For
//!    an input the host sets `size` to the size of the struct; the library reads the
//!    smaller of `size` and its own size and zero-fills the rest. For an output the host
//!    sets `size` before the call; the library writes the smaller of the two and stores
//!    the number of octets written in `size`. A `size` below the version 1 size returns
//!    `InvalidArgument`. An array of structs carries its element size beside the pointer
//!    instead (`field_size` of `ZeroResponseSpec` and of `ZeroRequestView`, `event_size`
//!    of `zero_target_poll`), read and written by the same rule per element. Fields are
//!    appended, never reordered, so an older host keeps working.
//! 5. Views. A view (`ZeroBytes`, `ZeroRequestView` and the pointers inside it) points
//!    into a slot and is read-only. A call that returns one succeeds only on a thread
//!    that holds a pin on the slot (`zero_slot_pin`), or on the slot's target thread
//!    before it acknowledged the batch that delivered the slot; any other thread gets
//!    `InvalidArgument`. A view stays valid until the later of that thread's unpin and
//!    its acknowledgment of the delivering batch. A thread holds at most 64 pins
//!    (`ZeroStatus_Limit` beyond). `{NULL, 0}` means absent; a present empty value has a
//!    non-null pointer.
//! 6. Body regions. `zero_res_body_alloc` returns a writable, zero-filled region inside
//!    the slot's response. It requires the calling thread's pin and is valid while that
//!    pin is held and until the response is sealed. While a region is open, every other
//!    body call and `zero_res_reset` on that slot return `InvalidArgument`.
//! 7. Owned handles. The library frees what it allocated: a `ZeroString *` or
//!    `ZeroBuffer *` is released only by `zero_string_free` or `zero_buffer_free`, exactly
//!    once, and NULL is a no-op. They are owned pointers, not checked ids, so the six
//!    functions over them take NULL as no handle, and using one after its free is a host
//!    error, as with `free(3)`. Every function that takes an id returns a status for a
//!    stale one. The library never frees host memory and never calls a host function
//!    pointer.
//! 8. Closed sets. Every value from a closed set (a method, a kind, an opcode, a mode, a
//!    policy, a close code) is passed as an integer and checked against its set; the
//!    library never reads an enum from the host. `ZeroStatus` is only ever returned.
//! 9. Panics. Every function runs under `catch_unwind`. A function that returns a status
//!    returns `ZeroStatus_Panic` instead of unwinding; the functions that return a value
//!    (`zero_version`, `zero_abi_version`, `zero_last_error_message`, and the accessors
//!    and frees of strings and buffers) return NULL or 0.
//! 10. Threads. Every function may be called from any thread, except: `zero_target_poll`
//!     binds its target to the first thread that calls it, and another thread gets
//!     `InvalidArgument`; a nonzero `epoch` in `zero_batch_complete` is accepted only from
//!     that bound thread; `zero_target_poll` and `zero_server_wait` return
//!     `InvalidArgument` on an I/O worker thread instead of deadlocking, and
//!     `zero_server_wait` also on a thread bound to one of that server's targets, whose
//!     acknowledgments the drain needs.
//! 11. Event views. The event payloads `zero_target_poll` writes live in the target's
//!     delivery storage and stay valid until the next `zero_target_poll` on that target
//!     or `zero_target_detach`.
//! 12. Errors. A refused call records a thread-local message naming the argument or the
//!     refusal; `zero_last_error_message` returns it as a new owned string, or NULL when
//!     the thread has none. Success leaves it unchanged. The message is kept in a fixed
//!     buffer of 256 octets per thread, cut at a UTF-8 boundary, so recording a refusal
//!     allocates nothing and takes no lock.

mod abi;
mod guard;
mod handles;
mod ids;
mod last_error;
mod ptr;

pub use abi::app::*;
pub use abi::library::*;
pub use abi::names::*;
pub use abi::plugin::*;
pub use abi::realtime::*;
pub use abi::req::*;
pub use abi::res::*;
pub use abi::server::*;
pub use abi::slot::*;
pub use abi::target::*;
pub use abi::{
    ZeroBatch, ZeroBytes, ZeroEvent, ZeroField, ZeroHeaderPair, ZeroPeer, ZeroRequestView,
    ZeroResponseSpec, ZeroSpan, ZeroStats, ZeroStatus,
};
pub use handles::{ZeroBuffer, ZeroString};

/// The version of this crate, as published to crates.io, for Rust callers; C callers
/// read it with `zero_version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
