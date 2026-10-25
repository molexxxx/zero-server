//! Pull targets and completion: attach, poll, wake, detach and batch completion.

use std::mem::size_of;
use std::ptr;

use zero_core::SlotId;
use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live, SENTINEL_WORD};
use crate::support::{
    attach, batch_out, complete, ok, poll, server_new, workers, FOREIGN_WORKER, NO_EVENT,
};

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_target_attach",
            cases: attach_cases,
            placeholder: crate::placeholder_call!(unsafe zero_target_attach(a, b, c)),
        },
        Entry {
            name: "zero_target_poll",
            cases: poll_cases,
            placeholder: crate::placeholder_call!(unsafe zero_target_poll(a, b, c, d, e, f, g, h)),
        },
        Entry {
            name: "zero_target_wake",
            cases: wake,
            placeholder: crate::placeholder_call!(zero_target_wake(a)),
        },
        Entry {
            name: "zero_target_detach",
            cases: detach,
            placeholder: crate::placeholder_call!(zero_target_detach(a)),
        },
        Entry {
            name: "zero_batch_complete",
            cases: batch_complete,
            placeholder: crate::placeholder_call!(unsafe zero_batch_complete(a, b, c, d, e)),
        },
    ]
}

fn attach_cases(live: &Live, cases: &mut Cases) {
    let call = |server: u64, worker: u32, out: *mut u64| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_target_attach(server, worker, out) }
    };
    let mut target = 0u64;
    let worker = u32::from(live.worker);
    cases.output("target_out", |out| call(live.server, worker, out));
    cases.case(
        Kind::Set,
        "worker 300",
        ZeroStatus::InvalidArgument,
        call(live.server, 300, &mut target),
    );
    cases.case(
        Kind::Other,
        "a worker index of no server of the call",
        ZeroStatus::InvalidArgument,
        call(live.server, u32::from(FOREIGN_WORKER), &mut target),
    );
    cases.case(
        Kind::Other,
        "a worker index that has a target",
        ZeroStatus::Limit,
        call(live.server, worker, &mut target),
    );
    cases.server_ids(live, |server| call(server, ZERO_ALL_WORKERS, &mut target));
    let server = server_new(live.app, r#"{"threads":1}"#);
    let status = call(server, ZERO_ALL_WORKERS, &mut target);
    cases.case(
        Kind::Valid,
        "every worker of an idle server",
        ZeroStatus::Ok,
        status,
    );
    if status == ZeroStatus::Ok {
        ok(zero_target_detach(target));
    }
    ok(zero_server_free(server));
}

/// Poll the live target with every argument given.
#[allow(clippy::too_many_arguments)]
fn raw_poll(
    target: u64,
    batch: *mut ZeroBatch,
    slots: *mut u64,
    routes: *mut u32,
    events: *mut ZeroEvent,
    event_size: usize,
    cap: usize,
) -> ZeroStatus {
    // SAFETY: every pointer a case passes is NULL, misaligned, or valid for `cap`
    // entries of its stride, and `batch` a struct of its size; the library refuses NULL,
    // misaligned pointers and small sizes before any access.
    unsafe { zero_target_poll(target, 0, batch, slots, routes, events, event_size, cap) }
}

fn poll_cases(live: &Live, cases: &mut Cases) {
    let max = usize::try_from(ZERO_MAX_BATCH).unwrap();
    let event_size = size_of::<ZeroEvent>();
    let mut batch = batch_out();
    let mut slots = vec![0u64; max + 1];
    let mut routes = vec![0u32; max];
    let mut events = vec![NO_EVENT; max];
    let target = live.target;
    cases.output("batch_out", |out| {
        raw_poll(
            target,
            out,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size,
            max,
        )
    });
    let mut small = ZeroBatch {
        size: 4,
        epoch: SENTINEL_WORD,
        ..batch_out()
    };
    let status = raw_poll(
        target,
        &mut small,
        slots.as_mut_ptr(),
        routes.as_mut_ptr(),
        events.as_mut_ptr(),
        event_size,
        max,
    );
    cases.untouched(
        "batch_out below version 1",
        ZeroStatus::InvalidArgument,
        status,
        small.size == 4 && small.epoch == SENTINEL_WORD,
    );
    cases.output("slots", |out| {
        raw_poll(
            target,
            &mut batch,
            out,
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size,
            max,
        )
    });
    cases.output("routes", |out| {
        raw_poll(
            target,
            &mut batch,
            slots.as_mut_ptr(),
            out,
            events.as_mut_ptr(),
            event_size,
            max,
        )
    });
    cases.output("events", |out| {
        raw_poll(
            target,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            out,
            event_size,
            max,
        )
    });
    cases.case(
        Kind::Other,
        "a capacity below ZERO_MAX_BATCH",
        ZeroStatus::InvalidArgument,
        raw_poll(
            target,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size,
            max - 1,
        ),
    );
    cases.case(
        Kind::Pointer,
        "event_size below version 1",
        ZeroStatus::InvalidArgument,
        raw_poll(
            target,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size - 1,
            max,
        ),
    );
    cases.target_ids(live, |id| {
        raw_poll(
            id,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size,
            max,
        )
    });
    let second = std::thread::spawn(move || poll(target, 0).err());
    cases.case(
        Kind::Thread,
        "a poll from a second thread",
        ZeroStatus::InvalidArgument,
        second.join().unwrap().unwrap_or(ZeroStatus::Ok),
    );
    let server = server_of(live.server).expect("the live server");
    let on_worker =
        zero_host::testing::run_on_worker(&server, live.worker, move || poll(target, 0).err());
    cases.case(
        Kind::Thread,
        "a poll from an I/O worker thread",
        ZeroStatus::InvalidArgument,
        on_worker.ok().flatten().unwrap_or(ZeroStatus::Ok),
    );
    cases.case(
        Kind::Valid,
        "a poll with nothing queued",
        ZeroStatus::Timeout,
        raw_poll(
            target,
            &mut batch,
            slots.as_mut_ptr(),
            routes.as_mut_ptr(),
            events.as_mut_ptr(),
            event_size,
            max,
        ),
    );
}

fn wake(live: &Live, cases: &mut Cases) {
    cases.target_ids(live, |id| zero_target_wake(id));
    cases.case(
        Kind::Valid,
        "the live target",
        ZeroStatus::Ok,
        zero_target_wake(live.target),
    );
    cases.case(
        Kind::Valid,
        "the next poll ends at once",
        ZeroStatus::Timeout,
        poll(live.target, 20_000).err().unwrap_or(ZeroStatus::Ok),
    );
}

fn detach(live: &Live, cases: &mut Cases) {
    cases.target_ids(live, |id| zero_target_detach(id));
    let server = server_new(live.app, r#"{"threads":1}"#);
    let target = attach(server, u32::from(workers(server)[0]));
    cases.case(
        Kind::Valid,
        "an idle server's target",
        ZeroStatus::Ok,
        zero_target_detach(target),
    );
    cases.case(
        Kind::Id,
        "a target detached twice",
        ZeroStatus::Closed,
        zero_target_detach(target),
    );
    ok(zero_server_free(server));
}

fn batch_complete(live: &Live, cases: &mut Cases) {
    let worker = live.worker;
    for index in [128u8, 200, u8::MAX] {
        cases.case(
            Kind::Set,
            format!("worker {index}"),
            ZeroStatus::InvalidArgument,
            complete(index, &[live.slot], 0).0,
        );
    }
    let (status, results) = complete(FOREIGN_WORKER, &[live.foreign], 0);
    cases.case(
        Kind::Id,
        "a worker index no server claimed",
        ZeroStatus::Closed,
        status,
    );
    cases.case(
        Kind::Id,
        "its id reported closed",
        ZeroStatus::Ok,
        held(results == [ZeroStatus::Closed]),
    );
    let raw = |slots: *const u64, count: usize, results: *mut ZeroStatus| {
        // SAFETY: every array a case passes is NULL, misaligned, or valid for `count`
        // entries; the library refuses the first two before any access.
        unsafe { zero_batch_complete(worker, slots, count, 0, results) }
    };
    cases.case(
        Kind::Pointer,
        "slots NULL with a count",
        ZeroStatus::InvalidArgument,
        raw(ptr::null(), 1, ptr::null_mut()),
    );
    let ids = [0u64; 3];
    let misaligned = ids.as_ptr().cast::<u8>().wrapping_add(1).cast::<u64>();
    cases.case(
        Kind::Pointer,
        "slots misaligned",
        ZeroStatus::InvalidArgument,
        raw(misaligned, 1, ptr::null_mut()),
    );
    let stale = [live.stale];
    let mut room = [SENTINEL_WORD; 2];
    let misaligned = room
        .as_mut_ptr()
        .cast::<u8>()
        .wrapping_add(1)
        .cast::<ZeroStatus>();
    let status = raw(stale.as_ptr(), 1, misaligned);
    cases.untouched(
        "results_out misaligned",
        ZeroStatus::InvalidArgument,
        status,
        room == [SENTINEL_WORD; 2],
    );
    cases.case(
        Kind::Pointer,
        "results_out NULL, which reports nothing",
        ZeroStatus::Ok,
        raw(stale.as_ptr(), 1, ptr::null_mut()),
    );
    let other_worker = SlotId::new(FOREIGN_WORKER, 1, 0).unwrap().as_u64();
    let (status, results) = complete(worker, &[live.stale, live.wide, other_worker], 0);
    cases.case(Kind::Id, "ids that cannot complete", ZeroStatus::Ok, status);
    cases.case(
        Kind::Id,
        "a stale id closed, a wide id and another worker's id invalid",
        ZeroStatus::Ok,
        held(
            results
                == [
                    ZeroStatus::Closed,
                    ZeroStatus::InvalidArgument,
                    ZeroStatus::InvalidArgument,
                ],
        ),
    );
    cases.case(
        Kind::Thread,
        "an epoch out of order",
        ZeroStatus::InvalidArgument,
        complete(worker, &[], live.epoch.saturating_add(1)).0,
    );
    ok(zero_res_send(live.other));
    let (other, epoch) = (live.other, live.epoch);
    let (status, results) = std::thread::spawn(move || complete(worker, &[other], epoch))
        .join()
        .unwrap();
    cases.case(
        Kind::Thread,
        "an epoch from another thread",
        ZeroStatus::InvalidArgument,
        status,
    );
    cases.case(
        Kind::Thread,
        "its completion still applied",
        ZeroStatus::Ok,
        held(results == [ZeroStatus::Ok]),
    );
    cases.case(
        Kind::Valid,
        "no ids and no epoch",
        ZeroStatus::Ok,
        complete(worker, &[], 0).0,
    );
}
