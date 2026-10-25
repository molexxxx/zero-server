//! Slots: pins, the route id and the cancel flag.

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live};

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_slot_pin",
            cases: pin,
            placeholder: crate::placeholder_call!(zero_slot_pin(a)),
        },
        Entry {
            name: "zero_slot_unpin",
            cases: unpin,
            placeholder: crate::placeholder_call!(zero_slot_unpin(a)),
        },
        Entry {
            name: "zero_slot_route",
            cases: route,
            placeholder: crate::placeholder_call!(unsafe zero_slot_route(a, b)),
        },
        Entry {
            name: "zero_slot_canceled",
            cases: canceled,
            placeholder: crate::placeholder_call!(unsafe zero_slot_canceled(a, b)),
        },
    ]
}

fn pin(live: &Live, cases: &mut Cases) {
    cases.slot_ids(live, |id| zero_slot_pin(id));
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        zero_slot_pin(live.slot),
    );
    cases.case(
        Kind::Other,
        "a slot the thread pinned",
        ZeroStatus::InvalidArgument,
        zero_slot_pin(live.slot),
    );
    cases.case(
        Kind::Valid,
        "its unpin",
        ZeroStatus::Ok,
        zero_slot_unpin(live.slot),
    );
}

fn unpin(live: &Live, cases: &mut Cases) {
    cases.case(
        Kind::Id,
        "a wide slot id",
        ZeroStatus::InvalidArgument,
        zero_slot_unpin(live.wide),
    );
    cases.case(
        Kind::Id,
        "a stale slot id, which the thread did not pin",
        ZeroStatus::InvalidArgument,
        zero_slot_unpin(live.stale),
    );
    cases.case(
        Kind::Other,
        "a slot the thread did not pin",
        ZeroStatus::InvalidArgument,
        zero_slot_unpin(live.slot),
    );
    crate::support::ok(zero_slot_pin(live.slot));
    cases.case(
        Kind::Valid,
        "a slot the thread pinned",
        ZeroStatus::Ok,
        zero_slot_unpin(live.slot),
    );
    cases.case(
        Kind::Other,
        "the same slot again",
        ZeroStatus::InvalidArgument,
        zero_slot_unpin(live.slot),
    );
}

fn route(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut u32| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_slot_route(slot, out) }
    };
    let mut route = u32::MAX;
    cases.output("route_out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut route));
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, &mut route),
    );
    cases.case(
        Kind::Valid,
        "its route",
        ZeroStatus::Ok,
        held(route == live.host_route),
    );
}

fn canceled(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut u8| {
        // SAFETY: every `out` a case passes is NULL or writable, and the library refuses
        // NULL before any access.
        unsafe { zero_slot_canceled(slot, out) }
    };
    let mut canceled = 9u8;
    cases.output("canceled_out", |out| call(live.slot, out));
    cases.case(
        Kind::Id,
        "a stale slot id",
        ZeroStatus::Closed,
        call(live.stale, &mut canceled),
    );
    cases.case(
        Kind::Id,
        "a recycled slot id",
        ZeroStatus::Closed,
        call(live.recycled, &mut canceled),
    );
    cases.case(
        Kind::Id,
        "a foreign slot id",
        ZeroStatus::Closed,
        call(live.foreign, &mut canceled),
    );
    cases.case(
        Kind::Id,
        "a wide slot id",
        ZeroStatus::InvalidArgument,
        call(live.wide, &mut canceled),
    );
    cases.case(
        Kind::Id,
        "a closed lease",
        ZeroStatus::Ok,
        call(live.closed, &mut canceled),
    );
    cases.case(
        Kind::Id,
        "a closed lease reads canceled",
        ZeroStatus::Ok,
        held(canceled == 1),
    );
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, &mut canceled),
    );
    cases.case(
        Kind::Valid,
        "the live slot is not canceled",
        ZeroStatus::Ok,
        held(canceled == 0),
    );
}
