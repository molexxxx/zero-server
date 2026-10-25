//! Compile-time layout checks of every struct of the ABI, on every target that builds
//! the crate: no struct has a padding byte, so nothing uninitialized is ever copied out,
//! `ZeroField` and `ZeroSpan` are laid out as zero-http's `HostField` and `HostSpan`, so a
//! request view's field table is the exchange's own, and on 64-bit targets the sizes and
//! offsets are the numbers the .NET declarations are held to.

use std::mem::{align_of, offset_of, size_of};

use zero_http::{HostField, HostSpan};

use crate::abi::plugin::{ZeroHostApi, ZeroPluginVTable};
use crate::abi::{
    ZeroBatch, ZeroBytes, ZeroEvent, ZeroField, ZeroHeaderPair, ZeroPeer, ZeroRequestView,
    ZeroResponseSpec, ZeroSpan, ZeroStats, ZeroStatus,
};

/// The function pointer type of every entry of the plugin tables, for its size.
type Entry = Option<unsafe extern "C" fn()>;

/// Assert that the fields of a struct follow one another with no padding byte between
/// them or after the last.
macro_rules! no_padding {
    ($ty:ty { $($field:ident: $field_ty:ty),+ $(,)? }) => {
        const _: () = {
            let mut end = 0usize;
            $(
                assert!(
                    offset_of!($ty, $field) == end,
                    concat!("padding before ", stringify!($ty), ".", stringify!($field))
                );
                end = offset_of!($ty, $field) + size_of::<$field_ty>();
            )+
            assert!(end == size_of::<$ty>(), concat!("padding at the end of ", stringify!($ty)));
        };
    };
}

no_padding!(ZeroBytes { ptr: *const u8, len: usize });
no_padding!(ZeroSpan {
    start: u32,
    len: u32
});
no_padding!(ZeroField {
    name: ZeroSpan,
    value: ZeroSpan,
    id: u32
});
no_padding!(ZeroRequestView {
    size: u32,
    method: u8,
    version: u8,
    flags: u16,
    route: u32,
    miss_status: u16,
    allow: u16,
    head: *const u8,
    head_len: u32,
    field_count: u32,
    method_token: ZeroSpan,
    target: ZeroSpan,
    path: ZeroSpan,
    query: ZeroSpan,
    authority: ZeroSpan,
    fields: *const ZeroField,
    route_path: *const u8,
    route_path_len: u32,
    param_count: u32,
    body: *const u8,
    body_len: u64,
    field_size: u32,
    reserved: u32,
});
no_padding!(ZeroPeer {
    size: u32,
    family: u8,
    secure: u8,
    transport: u8,
    alpn: u8,
    port: u16,
    client_port: u16,
    client_family: u8,
    reserved: [u8; 7],
    address: [u8; 16],
    client_address: [u8; 16],
});
no_padding!(ZeroHeaderPair {
    name: ZeroBytes,
    value: ZeroBytes
});
no_padding!(ZeroResponseSpec {
    size: u32,
    status: u16,
    reserved: u16,
    field_size: u32,
    reserved2: u32,
    fields: *const ZeroHeaderPair,
    field_count: usize,
    body: ZeroBytes,
});
no_padding!(ZeroBatch {
    size: u32,
    worker: u8,
    kind: u8,
    flags: u16,
    count: u32,
    reserved: u32,
    epoch: u64,
});
no_padding!(ZeroEvent {
    conn: u64,
    route: u32,
    kind: u8,
    opcode: u8,
    close_code: u16,
    data: ZeroBytes,
});
no_padding!(ZeroStats {
    size: u32,
    reserved: u32,
    dispatched: u64,
    batches: u64,
    acks: u64,
    late_readers: u64,
    queue_full: u64,
    refused_503: u64,
    closed_leases: u64,
    panics: u64,
    pinned: u64,
    quarantined_peak: u64,
    in_flight: u64,
    leased: u64,
    refused_acks: u64,
    abandoned_batches: u64,
    retained: u64,
});
no_padding!(ZeroPluginVTable {
    abi_version: u32,
    size: u32,
    ctx: *mut std::ffi::c_void,
    handle: Entry,
    unload: Entry,
});
no_padding!(ZeroHostApi {
    abi_version: u32,
    size: u32,
    req_view: Entry,
    req_header: Entry,
    req_body: Entry,
    res_respond: Entry,
    res_body_alloc: Entry,
    res_send: Entry,
});

const _: () = {
    assert!(size_of::<ZeroSpan>() == size_of::<HostSpan>());
    assert!(align_of::<ZeroSpan>() == align_of::<HostSpan>());
    assert!(offset_of!(ZeroSpan, start) == offset_of!(HostSpan, start));
    assert!(offset_of!(ZeroSpan, len) == offset_of!(HostSpan, len));
    assert!(size_of::<ZeroField>() == size_of::<HostField>());
    assert!(align_of::<ZeroField>() == align_of::<HostField>());
    assert!(offset_of!(ZeroField, name) == offset_of!(HostField, name));
    assert!(offset_of!(ZeroField, value) == offset_of!(HostField, value));
    assert!(offset_of!(ZeroField, id) == offset_of!(HostField, id));
    assert!(size_of::<Entry>() == size_of::<*const u8>());
    assert!(size_of::<ZeroStatus>() == size_of::<u32>());
};

#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(size_of::<ZeroBytes>() == 16);
    assert!(size_of::<ZeroSpan>() == 8);
    assert!(size_of::<ZeroField>() == 20);
    assert!(size_of::<ZeroRequestView>() == 120);
    assert!(offset_of!(ZeroRequestView, head) == 16);
    assert!(offset_of!(ZeroRequestView, method_token) == 32);
    assert!(offset_of!(ZeroRequestView, fields) == 72);
    assert!(offset_of!(ZeroRequestView, body_len) == 104);
    assert!(offset_of!(ZeroRequestView, field_size) == 112);
    assert!(size_of::<ZeroPeer>() == 52);
    assert!(offset_of!(ZeroPeer, address) == 20);
    assert!(offset_of!(ZeroPeer, client_address) == 36);
    assert!(size_of::<ZeroHeaderPair>() == 32);
    assert!(size_of::<ZeroResponseSpec>() == 48);
    assert!(offset_of!(ZeroResponseSpec, fields) == 16);
    assert!(offset_of!(ZeroResponseSpec, body) == 32);
    assert!(size_of::<ZeroBatch>() == 24);
    assert!(offset_of!(ZeroBatch, epoch) == 16);
    assert!(size_of::<ZeroEvent>() == 32);
    assert!(offset_of!(ZeroEvent, data) == 16);
    assert!(size_of::<ZeroStats>() == 128);
    assert!(size_of::<ZeroPluginVTable>() == 32);
    assert!(size_of::<ZeroHostApi>() == 56);
};
