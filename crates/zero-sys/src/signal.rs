//! The signals that ask the process to stop, delivered to a waiting thread instead of a
//! signal handler.
//!
//! On Unix, [`StopSignals::install`] blocks `SIGINT` and `SIGTERM` in the calling thread
//! with `pthread_sigmask`, and every thread started after it inherits that mask, since
//! "The signal mask shall be inherited from the creating thread" (POSIX
//! `pthread_create`). A stop signal sent to the process then stays pending until
//! [`StopSignals::wait`] accepts it with `sigwait`: "Signals generated for the process
//! shall be delivered to exactly one of those threads within the process which is in a
//! call to a sigwait() function selecting that signal or has not blocked delivery of the
//! signal" (Section 2.4.1). No handler is installed, so no code runs in signal context
//! and the async-signal-safety rules of Section 2.4.3 never apply.
//!
//! On Windows, [`StopSignals::install`] adds a console control handler with
//! `SetConsoleCtrlHandler`. "When the signal is received, the system creates a new
//! thread in the process to execute the function", so the handler is an ordinary thread:
//! it queues `CTRL_C_EVENT`, `CTRL_BREAK_EVENT` and `CTRL_CLOSE_EVENT` for
//! [`StopSignals::wait`] and leaves every other event to the next handler in the list.
//!
//! @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html#tag_16_04_01>
//! @see <https://learn.microsoft.com/en-us/windows/console/handlerroutine>

use std::fmt;
use std::io;

/// What asked the process to stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StopSignal {
    /// `SIGINT` on Unix and `CTRL_C_EVENT` on Windows: an interactive interrupt.
    Interrupt,
    /// `SIGTERM` on Unix: a request to terminate, the signal a container runtime or a
    /// service manager sends first.
    Terminate,
    /// `CTRL_BREAK_EVENT` on Windows.
    Break,
    /// `CTRL_CLOSE_EVENT` on Windows: the console the process is attached to is closing.
    Close,
}

impl StopSignal {
    /// The name an operator knows the signal by.
    ///
    /// # Returns
    ///
    /// `SIGINT` or `SIGTERM` on Unix; `Ctrl+C`, `Ctrl+Break` or `console close` on
    /// Windows.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            StopSignal::Interrupt if cfg!(windows) => "Ctrl+C",
            StopSignal::Interrupt => "SIGINT",
            StopSignal::Terminate => "SIGTERM",
            StopSignal::Break => "Ctrl+Break",
            StopSignal::Close => "console close",
        }
    }

    /// The exit status of a process that this signal ends without a clean stop.
    ///
    /// On Unix it is 128 plus the signal number (130 for `SIGINT`, 143 for `SIGTERM`):
    /// POSIX has the shell assign a command that a signal terminated "an exit status
    /// greater than 128", and 128 plus the number is the value shells report. On Windows
    /// it is `STATUS_CONTROL_C_EXIT` (`0xC000013A`), "The application terminated as a
    /// result of a CTRL+C", for every console event.
    ///
    /// # Returns
    ///
    /// The status to pass to `std::process::exit`.
    ///
    /// @see <https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_08_02>
    /// @see <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55>
    #[must_use]
    pub fn exit_status(self) -> i32 {
        imp::exit_status(self)
    }
}

impl fmt::Display for StopSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The stop signals of this process, routed to [`StopSignals::wait`].
///
/// One value serves the whole process; install it once, before the process starts any
/// other thread.
pub struct StopSignals {
    #[cfg(unix)]
    set: libc::sigset_t,
    #[cfg(not(unix))]
    _installed: (),
}

impl fmt::Debug for StopSignals {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StopSignals").finish_non_exhaustive()
    }
}

impl StopSignals {
    /// Route the stop signals to [`StopSignals::wait`].
    ///
    /// On Unix this blocks `SIGINT` and `SIGTERM` in the calling thread, and every thread
    /// it starts afterwards inherits the block. Call it before the process starts any
    /// other thread: a thread started earlier keeps the default action, which ends the
    /// process when the signal is delivered to it. A child process inherits the blocked
    /// mask too. On Windows this adds the console control handler; a second call adds
    /// nothing.
    ///
    /// # Returns
    ///
    /// The receiver of the stop signals.
    ///
    /// # Errors
    ///
    /// The operating system's error when the signal set cannot be built, the mask cannot
    /// be changed or the handler cannot be added, and `Unsupported` on a platform this
    /// crate has no stop signals for.
    ///
    /// @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/pthread_sigmask.html>
    /// @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/pthread_create.html>
    /// @see <https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler>
    pub fn install() -> io::Result<StopSignals> {
        #[cfg(unix)]
        {
            let set = imp::stop_set()?;
            imp::block(&set)?;
            Ok(StopSignals { set })
        }
        #[cfg(not(unix))]
        {
            imp::install()?;
            Ok(StopSignals { _installed: () })
        }
    }

    /// Wait for the next stop signal.
    ///
    /// On Unix the stop signals are blocked in the calling thread first, because
    /// `sigwait` requires that "The signals defined by set shall have been blocked at the
    /// time of the call"; a signal raised while no thread waits stays pending and is
    /// returned by the next call. On Windows a `CTRL_CLOSE_EVENT` is returned like the
    /// others, but its handler thread keeps the event open until the process exits,
    /// because returning lets "the system terminate the process"; the system still ends
    /// the process once its close time-out (5000 ms by default) passes.
    ///
    /// # Returns
    ///
    /// Which signal arrived.
    ///
    /// # Errors
    ///
    /// The error number `sigwait` or `pthread_sigmask` returned on Unix, and
    /// `Unsupported` on a platform this crate has no stop signals for.
    ///
    /// @see <https://pubs.opengroup.org/onlinepubs/9799919799/functions/sigwait.html>
    /// @see <https://learn.microsoft.com/en-us/windows/console/handlerroutine>
    pub fn wait(&self) -> io::Result<StopSignal> {
        #[cfg(unix)]
        {
            imp::block(&self.set)?;
            imp::wait(&self.set)
        }
        #[cfg(not(unix))]
        {
            imp::wait()
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io;
    use std::mem::MaybeUninit;

    use super::StopSignal;

    /// The signals that ask the process to stop.
    const STOPS: [libc::c_int; 2] = [libc::SIGINT, libc::SIGTERM];

    /// The offset POSIX shells add to the number of the signal that ended a command.
    const SIGNALED: i32 = 128;

    pub(super) fn exit_status(signal: StopSignal) -> i32 {
        let number = match signal {
            StopSignal::Interrupt => libc::SIGINT,
            StopSignal::Terminate | StopSignal::Break | StopSignal::Close => libc::SIGTERM,
        };
        SIGNALED.saturating_add(number)
    }

    /// The set holding `SIGINT` and `SIGTERM`.
    #[allow(unsafe_code)]
    pub(super) fn stop_set() -> io::Result<libc::sigset_t> {
        let mut set = MaybeUninit::<libc::sigset_t>::uninit();
        // SAFETY: `set` is writable storage for one sigset_t, which sigemptyset
        // initializes whole.
        let code = unsafe { libc::sigemptyset(set.as_mut_ptr()) };
        if code != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: sigemptyset returned 0, so the set is initialized.
        let mut set = unsafe { set.assume_init() };
        for signal in STOPS {
            // SAFETY: `set` is an initialized sigset_t borrowed for the call, and `signal`
            // is a signal number libc defines for this target.
            let code = unsafe { libc::sigaddset(&mut set, signal) };
            if code != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(set)
    }

    /// Add `set` to the calling thread's blocked signals.
    #[allow(unsafe_code)]
    pub(super) fn block(set: &libc::sigset_t) -> io::Result<()> {
        // SAFETY: `set` is an initialized sigset_t borrowed for the call, and the null
        // old-set pointer asks for no copy of the previous mask.
        let code = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, set, std::ptr::null_mut()) };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code));
        }
        Ok(())
    }

    /// Accept the next pending signal of `set`, which the calling thread blocks.
    #[allow(unsafe_code)]
    pub(super) fn wait(set: &libc::sigset_t) -> io::Result<StopSignal> {
        loop {
            let mut number: libc::c_int = 0;
            // SAFETY: `set` is an initialized sigset_t whose signals the caller blocked in
            // this thread, and `number` is a live, writable c_int for the call.
            let code = unsafe { libc::sigwait(set, &mut number) };
            if code == libc::EINTR {
                continue;
            }
            if code != 0 {
                return Err(io::Error::from_raw_os_error(code));
            }
            match number {
                libc::SIGINT => return Ok(StopSignal::Interrupt),
                libc::SIGTERM => return Ok(StopSignal::Terminate),
                _ => {}
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex, PoisonError};

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::STATUS_CONTROL_C_EXIT;
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
    };

    use super::StopSignal;

    /// The events the handler queued and no waiter took yet.
    static PENDING: Mutex<VecDeque<StopSignal>> = Mutex::new(VecDeque::new());

    /// Wakes the waiters when the handler queues an event.
    static ARRIVED: Condvar = Condvar::new();

    /// Whether the handler is in the process's list.
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    pub(super) fn exit_status(_signal: StopSignal) -> i32 {
        STATUS_CONTROL_C_EXIT
    }

    /// The console control handler, run by the system on a thread of its own: it queues
    /// the event and returns `TRUE` so the default handler, which calls `ExitProcess`,
    /// does not run. For `CTRL_CLOSE_EVENT` it never returns, since the system terminates
    /// the process as soon as the handler returns `TRUE`; every other event is left to
    /// the next handler with `FALSE`.
    extern "system" fn on_control(kind: u32) -> BOOL {
        let signal = match kind {
            CTRL_C_EVENT => StopSignal::Interrupt,
            CTRL_BREAK_EVENT => StopSignal::Break,
            CTRL_CLOSE_EVENT => StopSignal::Close,
            _ => return 0,
        };
        PENDING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(signal);
        ARRIVED.notify_all();
        if signal == StopSignal::Close {
            loop {
                std::thread::park();
            }
        }
        1
    }

    #[allow(unsafe_code)]
    pub(super) fn install() -> io::Result<()> {
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let routine: unsafe extern "system" fn(u32) -> BOOL = on_control;
        // SAFETY: `routine` has the PHANDLER_ROUTINE signature and is a function item,
        // valid for the life of the process; TRUE adds it to the handler list.
        let added = unsafe { SetConsoleCtrlHandler(Some(routine), 1) };
        if added == 0 {
            INSTALLED.store(false, Ordering::Release);
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn wait() -> io::Result<StopSignal> {
        let mut pending = PENDING.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if let Some(signal) = pending.pop_front() {
                return Ok(signal);
            }
            pending = ARRIVED
                .wait(pending)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use std::io;

    use super::StopSignal;

    pub(super) fn exit_status(_signal: StopSignal) -> i32 {
        1
    }

    fn unsupported() -> io::Error {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "no stop signals are wired for this platform",
        )
    }

    pub(super) fn install() -> io::Result<()> {
        Err(unsupported())
    }

    pub(super) fn wait() -> io::Result<StopSignal> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::StopSignal;

    #[cfg(unix)]
    #[test]
    fn a_command_a_signal_terminated_has_an_exit_status_greater_than_128_section_2_8_2() {
        assert_eq!(StopSignal::Interrupt.exit_status(), 128 + libc::SIGINT);
        assert_eq!(StopSignal::Terminate.exit_status(), 128 + libc::SIGTERM);
        for signal in [
            StopSignal::Interrupt,
            StopSignal::Terminate,
            StopSignal::Break,
            StopSignal::Close,
        ] {
            assert!(signal.exit_status() > 128, "{signal}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_console_event_exits_with_status_control_c_exit() {
        assert_eq!(StopSignal::Interrupt.exit_status(), 0xC000_013A_u32 as i32);
        assert_eq!(StopSignal::Close.exit_status(), 0xC000_013A_u32 as i32);
    }

    #[test]
    fn every_signal_is_shown_by_the_name_an_operator_knows() {
        assert_eq!(StopSignal::Terminate.to_string(), "SIGTERM");
        assert_eq!(StopSignal::Break.to_string(), "Ctrl+Break");
        assert_eq!(StopSignal::Close.to_string(), "console close");
        let interrupt = if cfg!(windows) { "Ctrl+C" } else { "SIGINT" };
        assert_eq!(StopSignal::Interrupt.to_string(), interrupt);
    }

    /// Send `signal` to the calling thread: in a multithreaded process `raise` is
    /// `pthread_kill(pthread_self(), sig)`, so no other thread of the test binary sees it.
    #[cfg(unix)]
    #[allow(unsafe_code)]
    fn raise(signal: libc::c_int) {
        // SAFETY: raise takes any signal number; the stop signals it is given here are
        // blocked in this thread, so no handler or default action runs.
        let code = unsafe { libc::raise(signal) };
        assert_eq!(code, 0, "raise({signal})");
    }

    #[cfg(unix)]
    #[test]
    #[cfg_attr(miri, ignore)]
    fn sigwait_selects_a_pending_signal_from_set_clears_it_and_returns_its_number() {
        std::thread::spawn(|| {
            let signals = super::StopSignals::install().expect("the stop signals");
            raise(libc::SIGTERM);
            raise(libc::SIGINT);
            let first = signals.wait().expect("a signal");
            let second = signals.wait().expect("a signal");
            let mut got = [first, second];
            got.sort_by_key(|signal| signal.exit_status());
            assert_eq!(got, [StopSignal::Interrupt, StopSignal::Terminate]);
            raise(libc::SIGTERM);
            assert_eq!(
                signals.wait().expect("a signal"),
                StopSignal::Terminate,
                "the earlier SIGTERM was cleared, so this one is new"
            );
        })
        .join()
        .expect("the waiting thread");
    }

    #[cfg(unix)]
    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_thread_started_after_install_inherits_the_blocked_stop_signals() {
        std::thread::spawn(|| {
            let signals = super::StopSignals::install().expect("the stop signals");
            std::thread::spawn(move || {
                raise(libc::SIGINT);
                assert_eq!(signals.wait().expect("a signal"), StopSignal::Interrupt);
            })
            .join()
            .expect("the inheriting thread");
        })
        .join()
        .expect("the installing thread");
    }
}
