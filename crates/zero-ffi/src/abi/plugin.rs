//! The plugin interface: declared so the header carries its layout. Loading plugins is
//! not part of this version.
//!
//! Every function pointer is an `Option` of an `unsafe extern "C"` function, which is
//! null-pointer optimized, so a null entry reads as `None` and is checked before any
//! use (ANSSI FFI-MARKEDFUNPTR and FFI-CKFUNPTR); a plugin's `int32_t` results pass a
//! checked conversion to `ZeroStatus`, never a cast (FFI-NOENUM). The plugin functions
//! are plain `extern "C"`, so a plugin catches its own panics, and one that does not
//! aborts at its own boundary.
//!
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#function-pointers>
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#enumerations>

use std::ffi::c_void;
use std::mem::{offset_of, size_of};

use crate::abi::names::ZERO_PLUGIN_ABI_VERSION;
use crate::abi::req::{zero_req_body, zero_req_header, zero_req_view};
use crate::abi::res::{zero_res_body_alloc, zero_res_respond, zero_res_send};
use crate::abi::{ZeroBytes, ZeroRequestView, ZeroResponseSpec, ZeroStatus};

/// A plugin's first export: the plugin ABI version it was built against.
pub type ZeroPluginAbiVersionFn = Option<unsafe extern "C" fn() -> u32>;

/// A plugin's second export: fills its vtable from the host table, returning a
/// `ZeroStatus` value.
pub type ZeroPluginRegisterFn =
    Option<unsafe extern "C" fn(host: *const ZeroHostApi, out: *mut ZeroPluginVTable) -> i32>;

/// What a plugin hands the core.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ZeroPluginVTable {
    /// `ZERO_PLUGIN_ABI_VERSION`.
    pub abi_version: u32,
    /// The size of this struct as the plugin built it.
    pub size: u32,
    /// The plugin's own state, opaque to the core.
    pub ctx: *mut c_void,
    /// Answers a request on a route the plugin serves, returning a `ZeroStatus` value.
    pub handle: Option<unsafe extern "C" fn(ctx: *mut c_void, route: u32, slot: u64) -> i32>,
    /// Releases the plugin's state.
    pub unload: Option<unsafe extern "C" fn(ctx: *mut c_void)>,
}

impl ZeroPluginVTable {
    /// The version 1 size; a smaller `size` is refused.
    pub(crate) const V1_SIZE: usize = offset_of!(ZeroPluginVTable, unload)
        + size_of::<Option<unsafe extern "C" fn(*mut c_void)>>();
}

/// What the core hands a plugin: the calls a plugin's handler reads and answers a
/// request with, which are the exports of the same names.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ZeroHostApi {
    /// `ZERO_PLUGIN_ABI_VERSION`.
    pub abi_version: u32,
    /// The size of this struct as the core built it.
    pub size: u32,
    /// `zero_req_view`.
    pub req_view: Option<unsafe extern "C" fn(slot: u64, out: *mut ZeroRequestView) -> ZeroStatus>,
    /// `zero_req_header`.
    pub req_header: Option<
        unsafe extern "C" fn(
            slot: u64,
            name: *const u8,
            len: usize,
            nth: u32,
            out: *mut ZeroBytes,
        ) -> ZeroStatus,
    >,
    /// `zero_req_body`.
    pub req_body: Option<unsafe extern "C" fn(slot: u64, out: *mut ZeroBytes) -> ZeroStatus>,
    /// `zero_res_respond`.
    pub res_respond:
        Option<unsafe extern "C" fn(slot: u64, spec: *const ZeroResponseSpec) -> ZeroStatus>,
    /// `zero_res_body_alloc`.
    pub res_body_alloc:
        Option<unsafe extern "C" fn(slot: u64, len: usize, region: *mut *mut u8) -> ZeroStatus>,
    /// `zero_res_send`.
    pub res_send: Option<unsafe extern "C" fn(slot: u64) -> ZeroStatus>,
}

/// The host table the core hands a plugin, every entry the export of its name.
///
/// # Returns
///
/// The table, at `ZERO_PLUGIN_ABI_VERSION` with its own size.
#[must_use]
pub fn host_api() -> ZeroHostApi {
    ZeroHostApi {
        abi_version: ZERO_PLUGIN_ABI_VERSION,
        size: u32::try_from(size_of::<ZeroHostApi>()).unwrap_or(u32::MAX),
        req_view: Some(zero_req_view),
        req_header: Some(zero_req_header),
        req_body: Some(zero_req_body),
        res_respond: Some(zero_res_respond),
        res_body_alloc: Some(zero_res_body_alloc),
        res_send: Some(zero_res_send),
    }
}

/// Checks a plugin's vtable before the core uses it: its ABI version must be the core's,
/// its size at least the version 1 size, and its handler present. A null `unload` is
/// accepted and means the plugin keeps no state to release.
///
/// # Arguments
///
/// * `vtable` - the vtable the plugin filled.
///
/// # Returns
///
/// `ZeroStatus::Ok` for a vtable the core can use.
///
/// # Errors
///
/// `ZeroStatus::InvalidArgument` for a foreign ABI version, a size below the version 1
/// size, or a null handler.
///
/// @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#function-pointers>
pub fn validate_plugin(vtable: &ZeroPluginVTable) -> Result<(), ZeroStatus> {
    let size = usize::try_from(vtable.size).unwrap_or(usize::MAX);
    if vtable.abi_version != ZERO_PLUGIN_ABI_VERSION
        || size < ZeroPluginVTable::V1_SIZE
        || vtable.handle.is_none()
    {
        return Err(ZeroStatus::InvalidArgument);
    }
    Ok(())
}

impl ZeroStatus {
    /// The status a foreign function returned as an `int32_t`, checked against the set:
    /// the library never casts an integer from outside into an enum.
    ///
    /// # Arguments
    ///
    /// * `code` - the value, 0 to 10 for a status.
    ///
    /// # Returns
    ///
    /// The status, or `None` for a value outside the set.
    ///
    /// @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#enumerations>
    #[must_use]
    pub const fn from_code(code: i32) -> Option<ZeroStatus> {
        Some(match code {
            0 => ZeroStatus::Ok,
            1 => ZeroStatus::Protocol,
            2 => ZeroStatus::Io,
            3 => ZeroStatus::Codec,
            4 => ZeroStatus::Closed,
            5 => ZeroStatus::Auth,
            6 => ZeroStatus::Unsupported,
            7 => ZeroStatus::Timeout,
            8 => ZeroStatus::Limit,
            9 => ZeroStatus::InvalidArgument,
            10 => ZeroStatus::Panic,
            _ => return None,
        })
    }
}
