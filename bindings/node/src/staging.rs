//! Large-body staging: a response body JavaScript writes in place into memory the
//! core then sends without a copy.
//!
//! [`res_stage`] creates a zeroed region shared by an external `ArrayBuffer` and the
//! isolate's staging map, at most one per slot. [`res_send_staged`] takes the slot's
//! region, checks that the buffer passed in is the staged one (same data pointer and
//! byte length) and that JavaScript did not detach it, detaches it, and only then
//! installs the region as the response body. After the detach "the ArrayBuffer is
//! considered detached if its internal data is null", so no JavaScript view can read
//! or write the region while the core writes it. A buffer JavaScript transferred
//! before the send is answered 500 `STAGING_DETACHED`, because whether the engine
//! moved the bytes is unknown; a buffer of another slot or one JavaScript made itself
//! is refused and nothing is detached or installed.
//!
//! The region is freed once both owners dropped it: the core after it wrote the
//! response, the buffer's finalizer after the engine collected the buffer.
//!
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_create_external_arraybuffer>
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_detach_arraybuffer>
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_is_detached_arraybuffer>

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Arc;

use napi::bindgen_prelude::ArrayBuffer;
use napi::Env;
use napi_derive::napi;
use zero_host::access;
use zero_host::{ExternalBody, Status};

use crate::guard::{node_guard, Code, Fail};
use crate::ids;
use crate::response::{checked_lines, pairs};

/// The error code of a staged body that was detached before the send.
const STAGING_DETACHED: &[u8] = b"STAGING_DETACHED";

/// How many open regions the map holds before a stage drops those whose slot no
/// longer accepts a response.
const PRUNE_AT: usize = 64;

/// A staged response body: zeroed octets shared by one external `ArrayBuffer` and,
/// after the send, the response. Nothing resizes the vector, so its buffer never
/// moves while either owner holds it.
pub(crate) struct Region {
    bytes: Vec<u8>,
}

impl ExternalBody for Region {
    fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// One open region of the staging map: the region and the address and length of
/// the buffer that backs it.
#[derive(Clone)]
struct Staged {
    region: Arc<Region>,
    address: usize,
    len: usize,
}

thread_local! {
    /// The open regions of this isolate, by slot id.
    static STAGED: RefCell<BTreeMap<u64, Staged>> = const { RefCell::new(BTreeMap::new()) };
}

/// Run `work` on this isolate's staging map.
fn with_staged<R>(
    work: impl FnOnce(&mut BTreeMap<u64, Staged>) -> Result<R, Fail>,
) -> Result<R, Fail> {
    STAGED
        .try_with(|staged| {
            let mut staged = staged
                .try_borrow_mut()
                .map_err(|_| Fail::invalid("the staging map is in use"))?;
            work(&mut staged)
        })
        .map_err(|_| Fail::closed("the isolate is shutting down"))?
}

/// Drop the regions of completed slots that were staged and never sent.
///
/// # Arguments
///
/// * `slots` - the slot ids a completion applied.
pub(crate) fn forget(slots: &[u64]) {
    let _ = STAGED.try_with(|staged| {
        if let Ok(mut staged) = staged.try_borrow_mut() {
            if !staged.is_empty() {
                for slot in slots {
                    staged.remove(slot);
                }
            }
        }
    });
}

/// Whether two buffers are the same memory: the staged region's and the argument's.
fn same_buffer(staged: &Staged, address: usize, len: usize) -> bool {
    staged.address == address && staged.len == len
}

/// Stage a response body of `length` zeroed octets for a slot and return the
/// `ArrayBuffer` JavaScript fills, for instance with `TextEncoder.encodeInto` or
/// `Uint8Array.set`. A slot holds at most one staged body.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `length` - the body length in octets, at least 1.
///
/// # Returns
///
/// The buffer.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a length of 0 or a slot that already holds a staged
/// body, `ZERO_UNSUPPORTED` when the runtime copied the buffer instead of sharing it
/// (no external buffers allowed), on which the body is to be copied instead,
/// `ZERO_LIMIT` when the memory cannot be allocated, and `ZERO_CLOSED` for a slot that
/// is no longer leased or a sealed response.
#[napi(catch_unwind)]
pub fn res_stage(env: &Env, slot: f64, length: f64) -> napi::Result<ArrayBuffer<'_>, Code> {
    node_guard(|| stage(env, slot, length))
}

/// The work of [`res_stage`].
#[allow(unsafe_code)]
fn stage<'env>(env: &'env Env, slot: f64, length: f64) -> Result<ArrayBuffer<'env>, Fail> {
    let id = ids::id(slot, "the slot id")?;
    let len = ids::length(length, "the staged length")?;
    if len == 0 {
        return Err(Fail::invalid("a staged body holds at least one octet"));
    }
    access::writable(id)?;
    with_staged(|staged| {
        if staged.len() >= PRUNE_AT {
            staged.retain(|&slot, _| access::writable(slot).is_ok());
        }
        if staged.contains_key(&id) {
            return Err(Fail::invalid(
                "the slot already holds a staged body; send it before staging another",
            ));
        }
        Ok(())
    })?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(len)
        .map_err(|_| Fail::new(Code::LIMIT, "the staged body cannot be allocated"))?;
    bytes.resize(len, 0);
    let pointer = bytes.as_mut_ptr();
    let region = Arc::new(Region { bytes });
    let hint = Arc::clone(&region);
    // SAFETY: `pointer` is valid for `len` octets until the finalizer drops `hint`:
    // the `Arc` owns the vector and nothing resizes it, so its buffer stays where it
    // is while any clone lives, and `Vec::as_mut_ptr` formed no reference to it. No
    // Rust reference to the octets exists before the send detaches the buffer:
    // `Region::bytes` is called only by the core's writer after the slot completes,
    // which follows the detach. The address belongs to this region alone while
    // either owner lives, so no other buffer shares it.
    let buffer =
        unsafe { ArrayBuffer::from_external(env, pointer, len, hint, |_env, hint| drop(hint)) }
            .map_err(|error| Fail::napi(&error))?;
    if buffer.as_ptr().addr() != pointer.addr() || buffer.len() != len {
        return Err(Fail::new(
            Code::UNSUPPORTED,
            "the runtime copied the staged buffer instead of sharing it; copy the body instead",
        ));
    }
    let staged = Staged {
        region,
        address: pointer.addr(),
        len,
    };
    with_staged(|map| {
        map.insert(id, staged);
        Ok(())
    })?;
    Ok(buffer)
}

/// Answer a slot whose staged body was detached before the send with 500
/// `STAGING_DETACHED`.
fn detached(id: u64) -> Result<i32, Fail> {
    access::error(id, 500, STAGING_DETACHED, None, None)?;
    Ok(Status::Ok.code())
}

/// Send the slot's staged body: the status and the field lines are written, the
/// buffer is checked to be the slot's staged one and detached, and the region
/// becomes the response body without a copy. Once sent, the buffer and every view
/// over it read as empty, and writes through them change nothing on the wire.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `status` - 200 to 599, or 0 to keep the status set before.
/// * `fields` - `[name, value, ...]`, latin1.
/// * `staged` - the buffer `resStage` returned for this slot.
///
/// # Returns
///
/// 0, both when the body was sent and when the buffer had been detached by
/// JavaScript, in which case the request was answered 500 `STAGING_DETACHED`.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a slot with no staged body, a buffer that is not the
/// slot's staged one, a status outside the range or a refused field line (nothing is
/// detached or written then); `ZERO_LIMIT` for a body above the server's response
/// limit; `ZERO_CLOSED` for a slot that is no longer leased or a sealed response.
#[napi(
    catch_unwind,
    ts_args_type = "slot: number, status: number, fields: string[], staged: ArrayBuffer"
)]
pub fn res_send_staged(
    slot: f64,
    status: f64,
    fields: Vec<String>,
    staged: ArrayBuffer<'_>,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let status = ids::u16_of(status, "the status")?;
        if status != 0 && !(200..=599).contains(&status) {
            return Err(Fail::invalid("a host sets a status from 200 to 599"));
        }
        let lines = checked_lines(&fields)?;
        let entry = with_staged(|map| {
            map.get(&id)
                .cloned()
                .ok_or_else(|| Fail::invalid("the slot holds no staged body"))
        })?;
        let was_detached = staged.is_detached().map_err(|error| Fail::napi(&error))?;
        if was_detached {
            with_staged(|map| Ok(map.remove(&id)))?;
            return detached(id);
        }
        if !same_buffer(&entry, staged.as_ptr().addr(), staged.len()) {
            return Err(Fail::invalid(
                "the buffer is not the one resStage returned for this slot",
            ));
        }
        access::writable(id)?;
        let detach = staged.detach();
        with_staged(|map| Ok(map.remove(&id)))?;
        if detach.is_err() {
            return detached(id);
        }
        let body: Arc<dyn ExternalBody> = entry.region;
        access::respond_external(id, status, pairs(&lines), body)?;
        Ok(Status::Ok.code())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_buffer_is_the_staged_one_only_with_the_same_address_and_length() {
        let region = Arc::new(Region { bytes: vec![0; 16] });
        let staged = Staged {
            region,
            address: 0x1000,
            len: 16,
        };
        assert!(same_buffer(&staged, 0x1000, 16));
        assert!(
            !same_buffer(&staged, 0x1000, 15),
            "a shorter view of the region"
        );
        assert!(
            !same_buffer(&staged, 0x1008, 16),
            "an offset into the region"
        );
        assert!(!same_buffer(&staged, 0x2000, 16), "another region");
    }
}
