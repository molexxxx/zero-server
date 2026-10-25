//! The plugin interface: the vtable check, the host table, and the checked conversion of
//! a plugin's status.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;

use zero_ffi::*;

/// A handler a plugin would export; never called.
unsafe extern "C" fn handle(_ctx: *mut c_void, _route: u32, _slot: u64) -> i32 {
    0
}

/// An unload a plugin would export; never called.
unsafe extern "C" fn unload(_ctx: *mut c_void) {}

/// A vtable a plugin built against this version.
fn vtable() -> ZeroPluginVTable {
    ZeroPluginVTable {
        abi_version: ZERO_PLUGIN_ABI_VERSION,
        size: u32::try_from(size_of::<ZeroPluginVTable>()).unwrap(),
        ctx: ptr::null_mut(),
        handle: Some(handle),
        unload: Some(unload),
    }
}

/// ANSSI FFI-MARKEDFUNPTR and FFI-CKFUNPTR: every entry is an `Option` of an
/// `unsafe extern "C"` function, checked for null, and a foreign ABI version or a size
/// below version 1 is refused.
#[test]
fn a_vtable_with_a_null_handler_or_a_foreign_abi_version_is_refused() {
    assert_eq!(validate_plugin(&vtable()), Ok(()));
    assert_eq!(
        validate_plugin(&ZeroPluginVTable {
            handle: None,
            ..vtable()
        }),
        Err(ZeroStatus::InvalidArgument)
    );
    for version in [0, 2, u32::MAX] {
        assert_eq!(
            validate_plugin(&ZeroPluginVTable {
                abi_version: version,
                ..vtable()
            }),
            Err(ZeroStatus::InvalidArgument),
            "version {version}"
        );
    }
    for size in [
        0,
        8,
        u32::try_from(size_of::<ZeroPluginVTable>()).unwrap() - 1,
    ] {
        assert_eq!(
            validate_plugin(&ZeroPluginVTable { size, ..vtable() }),
            Err(ZeroStatus::InvalidArgument),
            "size {size}"
        );
    }
    assert_eq!(
        validate_plugin(&ZeroPluginVTable {
            unload: None,
            ..vtable()
        }),
        Ok(())
    );
    let larger = u32::try_from(size_of::<ZeroPluginVTable>() + 8).unwrap();
    assert_eq!(
        validate_plugin(&ZeroPluginVTable {
            size: larger,
            ..vtable()
        }),
        Ok(())
    );
}

#[test]
fn the_host_table_carries_every_entry_at_its_own_size() {
    let api = host_api();
    assert_eq!(api.abi_version, ZERO_PLUGIN_ABI_VERSION);
    assert_eq!(usize::try_from(api.size).unwrap(), size_of::<ZeroHostApi>());
    assert!(api.req_view.is_some());
    assert!(api.req_header.is_some());
    assert!(api.req_body.is_some());
    assert!(api.res_respond.is_some());
    assert!(api.res_body_alloc.is_some());
    assert!(api.res_send.is_some());
    let register: ZeroPluginRegisterFn = None;
    let version: ZeroPluginAbiVersionFn = None;
    assert!(register.is_none() && version.is_none());
    assert_eq!(size_of::<ZeroPluginRegisterFn>(), size_of::<*const u8>());
}

#[test]
fn a_status_from_a_plugin_is_checked_against_the_set() {
    for code in 0..=10 {
        let status = ZeroStatus::from_code(code).expect("a status");
        assert_eq!(status as i32, code);
    }
    for code in [-1, 11, 255, i32::MAX, i32::MIN] {
        assert_eq!(ZeroStatus::from_code(code), None, "{code}");
    }
}
