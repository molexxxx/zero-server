//! Slots: the pins that keep a slot's views valid on any thread, and the values of a
//! slot that need no view rule.
//!
//! A slot id names one request leased to the host, and is checked against the slot's
//! generation on every call: a stale id returns `ZeroStatus_Closed` and never reaches
//! another request. A thread that is not the slot's target thread inside the delivering
//! batch pins the slot before it reads views; while the pin is held the slot is not
//! retired, so the views stay valid (ANSSI FFI-CK-REF-MODEL).
//!
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#ffi-memory-model>

use std::mem::size_of;

use zero_host::access;

use crate::abi::ZeroStatus;
use crate::guard::guard;
use crate::ptr as host;

/// Pins a slot for the calling thread: while the pin is held the slot is not retired, so
/// the views the thread reads stay valid, and a body region can be opened. A thread
/// holds at most 64 pins; one that exits holding pins releases them.
///
/// # Arguments
///
/// * `slot` - the slot's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` unless the slot is leased or completing at the id's generation;
/// `InvalidArgument` for a slot the thread already pinned or an id above `ZERO_ID_MAX`;
/// `Limit` when the thread holds 64 pins or the slot counts the most pins it can.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_slot_pin(slot: u64) -> ZeroStatus {
    guard(|| access::pin(slot).map_err(Into::into))
}

/// Releases the calling thread's pin on a slot.
///
/// # Arguments
///
/// * `slot` - the slot's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` unless the calling thread pinned that id, or for an id above
/// `ZERO_ID_MAX`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_slot_unpin(slot: u64) -> ZeroStatus {
    guard(|| access::unpin(slot).map_err(Into::into))
}

/// Writes the route id a slot's request matched, from any thread.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `route_out` - receives the route id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` unless the slot is leased or completing at the id's generation;
/// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL or misaligned `route_out`.
///
/// # Safety
///
/// `route_out` must be NULL or point to a writable `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_slot_route(slot: u64, route_out: *mut u32) -> ZeroStatus {
    guard(|| {
        host::check_out(route_out)?;
        let route = access::with_values(slot, |view| view.route)?;
        // SAFETY: outputs: `route_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(route_out, size_of::<u32>(), &[route]) }
    })
}

/// Writes whether a slot's request was canceled: its connection or its target went
/// away, so its lease was closed and later writes are refused. A host may stop working
/// on a canceled request.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `canceled_out` - receives 1 for a canceled or closed lease, 0 otherwise.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for a stale or unknown id, including a lease the worker already retired;
/// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL `canceled_out`.
///
/// # Safety
///
/// `canceled_out` must be NULL or point to a writable `uint8_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_slot_canceled(slot: u64, canceled_out: *mut u8) -> ZeroStatus {
    guard(|| {
        host::check_out(canceled_out)?;
        let canceled = u8::from(access::canceled(slot)?);
        // SAFETY: outputs: `canceled_out` was checked and points to a writable `uint8_t`.
        unsafe { host::write_elements(canceled_out, size_of::<u8>(), &[canceled]) }
    })
}
