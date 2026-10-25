//! The table of the table-driven test over the header: one entry per prototype, each
//! with the cases that apply to its parameters and a call with placeholder arguments for
//! the panic test.

#![allow(dead_code, unsafe_code)]

pub mod fixture;

mod app;
mod library;
mod realtime;
mod req;
mod res;
mod server;
mod slot;
mod target;

use std::mem::align_of;
use std::ptr;

use zero_ffi::ZeroStatus;

pub use fixture::Live;

/// What a case checks, so a test can run its own part of the table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A NULL or misaligned pointer, a NULL range with a length, a size below version 1.
    Pointer,
    /// A stale, foreign, wide or closed id.
    Id,
    /// A value from a closed set outside its set.
    Set,
    /// The view rule: a view call from a thread that may not read views.
    View,
    /// A call from a thread that may not make it.
    Thread,
    /// A field line with CR, LF or NUL in its value.
    Field,
    /// An owned string or buffer.
    Handle,
    /// A valid call: the positive control.
    Valid,
    /// Any other refusal.
    Other,
}

/// One case and what it returned.
#[derive(Debug)]
pub struct Check {
    pub export: &'static str,
    pub kind: Kind,
    pub what: String,
    pub expected: ZeroStatus,
    pub actual: ZeroStatus,
    /// For an output refused, whether its memory is as it was before the call.
    pub untouched: bool,
}

/// What an export returned to the panic test.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Status(ZeroStatus),
    Null(bool),
    Number(u64),
    Unit,
}

/// A return value of an export, as the panic test sees it.
pub trait IntoOutcome {
    fn outcome(self) -> Outcome;
}

impl IntoOutcome for ZeroStatus {
    fn outcome(self) -> Outcome {
        Outcome::Status(self)
    }
}

impl<T> IntoOutcome for *const T {
    fn outcome(self) -> Outcome {
        Outcome::Null(self.is_null())
    }
}

impl<T> IntoOutcome for *mut T {
    fn outcome(self) -> Outcome {
        Outcome::Null(self.is_null())
    }
}

impl IntoOutcome for u32 {
    fn outcome(self) -> Outcome {
        Outcome::Number(u64::from(self))
    }
}

impl IntoOutcome for usize {
    fn outcome(self) -> Outcome {
        Outcome::Number(u64::try_from(self).unwrap())
    }
}

impl IntoOutcome for () {
    fn outcome(self) -> Outcome {
        Outcome::Unit
    }
}

/// A placeholder argument: zero or NULL.
pub trait Placeholder {
    fn placeholder() -> Self;
}

macro_rules! placeholder_zero {
    ($($ty:ty),*) => {
        $(impl Placeholder for $ty {
            fn placeholder() -> Self {
                0
            }
        })*
    };
}

placeholder_zero!(u8, u16, u32, u64, usize);

impl<T> Placeholder for *const T {
    fn placeholder() -> Self {
        ptr::null()
    }
}

impl<T> Placeholder for *mut T {
    fn placeholder() -> Self {
        ptr::null_mut()
    }
}

/// A call of an export with placeholder arguments, for the panic test, which arms a panic
/// first: the export raises it before it reads an argument.
#[macro_export]
macro_rules! placeholder_call {
    (unsafe $export:ident($($arg:ident),*)) => {
        || {
            $(let $arg = $crate::table::Placeholder::placeholder();)*
            // SAFETY: the panic test arms a panic, which the export raises before it reads
            // an argument, and every argument is zero or NULL, which each export accepts
            // or refuses without reading memory.
            $crate::table::IntoOutcome::outcome(unsafe { zero_ffi::$export($($arg),*) })
        }
    };
    ($export:ident($($arg:ident),*)) => {
        || {
            $(let $arg = $crate::table::Placeholder::placeholder();)*
            $crate::table::IntoOutcome::outcome(zero_ffi::$export($($arg),*))
        }
    };
}

/// One prototype of the header and its cases.
pub struct Entry {
    pub name: &'static str,
    pub cases: fn(&Live, &mut Cases),
    pub placeholder: fn() -> Outcome,
}

/// The cases a runner records.
pub struct Cases {
    pub export: &'static str,
    pub checks: Vec<Check>,
}

impl Cases {
    /// Record a case.
    pub fn case(
        &mut self,
        kind: Kind,
        what: impl Into<String>,
        expected: ZeroStatus,
        actual: ZeroStatus,
    ) {
        self.checks.push(Check {
            export: self.export,
            kind,
            what: what.into(),
            expected,
            actual,
            untouched: true,
        });
    }

    /// Record a refused output case and whether its memory stayed as it was.
    pub fn untouched(
        &mut self,
        what: impl Into<String>,
        expected: ZeroStatus,
        actual: ZeroStatus,
        untouched: bool,
    ) {
        self.checks.push(Check {
            export: self.export,
            kind: Kind::Pointer,
            what: what.into(),
            expected,
            actual,
            untouched,
        });
    }

    /// The id cases of a call that takes a slot id.
    pub fn slot_ids(&mut self, live: &Live, mut call: impl FnMut(u64) -> ZeroStatus) {
        self.case(
            Kind::Id,
            "a stale slot id",
            ZeroStatus::Closed,
            call(live.stale),
        );
        self.case(
            Kind::Id,
            "a recycled slot id",
            ZeroStatus::Closed,
            call(live.recycled),
        );
        self.case(
            Kind::Id,
            "a foreign slot id",
            ZeroStatus::Closed,
            call(live.foreign),
        );
        self.case(
            Kind::Id,
            "a wide slot id",
            ZeroStatus::InvalidArgument,
            call(live.wide),
        );
        self.case(
            Kind::Id,
            "a closed lease",
            ZeroStatus::Closed,
            call(live.closed),
        );
    }

    /// The id cases of a call that takes a connection id.
    pub fn conn_ids(&mut self, live: &Live, mut call: impl FnMut(u64) -> ZeroStatus) {
        self.case(
            Kind::Id,
            "a stale connection id",
            ZeroStatus::Closed,
            call(live.conn_stale),
        );
        self.case(
            Kind::Id,
            "a foreign connection id",
            ZeroStatus::Closed,
            call(live.conn_foreign),
        );
        self.case(
            Kind::Id,
            "a wide connection id",
            ZeroStatus::InvalidArgument,
            call(live.wide),
        );
    }

    /// The id cases of a call that takes an app id.
    pub fn app_ids(&mut self, live: &Live, mut call: impl FnMut(u64) -> ZeroStatus) {
        self.case(
            Kind::Id,
            "a freed app id",
            ZeroStatus::Closed,
            call(live.app_stale),
        );
        self.case(
            Kind::Id,
            "a server id as an app id",
            ZeroStatus::Closed,
            call(live.server),
        );
        self.case(
            Kind::Id,
            "a wide app id",
            ZeroStatus::InvalidArgument,
            call(live.wide),
        );
    }

    /// The id cases of a call that takes a server id.
    pub fn server_ids(&mut self, live: &Live, mut call: impl FnMut(u64) -> ZeroStatus) {
        self.case(
            Kind::Id,
            "a freed server id",
            ZeroStatus::Closed,
            call(live.server_stale),
        );
        self.case(
            Kind::Id,
            "an app id as a server id",
            ZeroStatus::Closed,
            call(live.app),
        );
        self.case(
            Kind::Id,
            "a wide server id",
            ZeroStatus::InvalidArgument,
            call(live.wide),
        );
    }

    /// The id cases of a call that takes a target id.
    pub fn target_ids(&mut self, live: &Live, mut call: impl FnMut(u64) -> ZeroStatus) {
        self.case(
            Kind::Id,
            "a detached target id",
            ZeroStatus::Closed,
            call(live.target_stale),
        );
        self.case(
            Kind::Id,
            "a server id as a target id",
            ZeroStatus::Closed,
            call(live.server),
        );
        self.case(
            Kind::Id,
            "a wide target id",
            ZeroStatus::InvalidArgument,
            call(live.wide),
        );
    }

    /// The pointer cases of an output: NULL, and misaligned when `T` needs alignment,
    /// with nothing written.
    pub fn output<T>(&mut self, name: &str, mut call: impl FnMut(*mut T) -> ZeroStatus) {
        self.case(
            Kind::Pointer,
            format!("{name} NULL"),
            ZeroStatus::InvalidArgument,
            call(ptr::null_mut()),
        );
        if align_of::<T>() > 1 {
            let mut room = [SENTINEL_WORD; 32];
            let misaligned = room.as_mut_ptr().cast::<u8>().wrapping_add(1).cast::<T>();
            let status = call(misaligned);
            let untouched = room.iter().all(|word| *word == SENTINEL_WORD);
            self.untouched(
                format!("{name} misaligned"),
                ZeroStatus::InvalidArgument,
                status,
                untouched,
            );
        }
    }

    /// The pointer case of a byte range: NULL with a nonzero length.
    pub fn null_range(&mut self, name: &str, mut call: impl FnMut(*const u8, usize) -> ZeroStatus) {
        self.case(
            Kind::Pointer,
            format!("{name} NULL with a length"),
            ZeroStatus::InvalidArgument,
            call(ptr::null(), 1),
        );
    }
}

/// Set a field line on a slot's response.
pub fn res_write_header(slot: u64, name: &[u8], value: &[u8]) -> ZeroStatus {
    res::write_header(slot, name, value, zero_ffi::ZERO_HEADER_SET)
}

/// The filler of an output a refused call must not touch.
pub const SENTINEL_WORD: u64 = 0xA5A5_A5A5_A5A5_A5A5;

/// Every prototype the header must declare, with its cases.
pub fn entries() -> Vec<Entry> {
    let mut entries = Vec::new();
    entries.extend(library::entries());
    entries.extend(app::entries());
    entries.extend(server::entries());
    entries.extend(target::entries());
    entries.extend(slot::entries());
    entries.extend(req::entries());
    entries.extend(res::entries());
    entries.extend(realtime::entries());
    entries
}

/// Run the cases of every entry against a live fixture.
pub fn run(live: &Live, entries: &[Entry]) -> Vec<Check> {
    let mut checks = Vec::new();
    for entry in entries {
        let mut cases = Cases {
            export: entry.name,
            checks: Vec::new(),
        };
        (entry.cases)(live, &mut cases);
        assert!(!cases.checks.is_empty(), "{} has no case", entry.name);
        checks.extend(cases.checks);
    }
    checks
}

/// Fail with every case of `kinds` that returned another status or wrote an output it
/// refused; an empty `kinds` checks every case.
#[track_caller]
pub fn assert_cases(checks: &[Check], kinds: &[Kind]) {
    let chosen: Vec<&Check> = checks
        .iter()
        .filter(|check| kinds.is_empty() || kinds.contains(&check.kind))
        .collect();
    assert!(!chosen.is_empty(), "no case of {kinds:?}");
    let failed: Vec<String> = chosen
        .iter()
        .filter(|check| check.actual != check.expected || !check.untouched)
        .map(|check| {
            format!(
                "{}: {}: expected {:?}, got {:?}{}",
                check.export,
                check.what,
                check.expected,
                check.actual,
                if check.untouched {
                    ""
                } else {
                    ", and the output was written"
                }
            )
        })
        .collect();
    assert!(
        failed.is_empty(),
        "{} of {} cases failed:\n{}",
        failed.len(),
        chosen.len(),
        failed.join("\n")
    );
}

/// The names of the prototypes of a C header.
pub fn prototypes(header: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in header.lines() {
        let starts_declaration = line.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && !line.starts_with("typedef");
        if !starts_declaration {
            continue;
        }
        if let Some(open) = line.find('(') {
            let before = &line[..open];
            let name_start = before
                .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .map_or(0, |at| at + 1);
            let name = &before[name_start..];
            if name.starts_with("zero_") {
                names.push(name.to_owned());
            }
        }
    }
    names
}
