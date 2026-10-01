//! Thread affinity: pin the calling thread to a set of CPUs.
//!
//! On Linux `sched_setaffinity(2)` on the calling thread (pid 0) takes a `cpu_set_t`
//! built with `CPU_SET`; an index at or beyond `CPU_SETSIZE` is refused here rather than
//! written past the set. On Windows `SetThreadAffinityMask` on the current thread takes
//! a bit mask of the first processor group; an index beyond that group is reported as
//! unsupported. Apple platforms expose no affinity call the design verified
//! (`DESIGN.md` section 5.4), so pinning there reports unsupported and the caller runs
//! unpinned.
//!
//! Sources: sched_setaffinity(2) and CPU_SET(3) of the Linux man-pages project and the
//! pinned libc crate; the Windows binding from the pinned windows-sys crate, with the
//! return convention (the previous mask, zero on failure) read from Wine's
//! implementation of the call because the Microsoft reference page was unreachable.

use std::io;

/// Pin the calling thread to `cpus`, so the scheduler runs it on no other CPU.
///
/// # Arguments
///
/// * `cpus` - the CPU indices the thread may run on; at least one.
///
/// # Returns
///
/// Nothing; the thread is pinned.
///
/// # Errors
///
/// `InvalidInput` for an empty set or an index the set cannot hold, `Unsupported` where
/// the platform has no such call, else the operating system's error.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
pub fn pin_current_thread(cpus: &[usize]) -> io::Result<()> {
    if cpus.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a thread needs at least one CPU",
        ));
    }
    let mut set = empty_set();
    for &cpu in cpus {
        if cpu >= CPU_SET_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the CPU index is beyond what a CPU set holds",
            ));
        }
        // SAFETY: `cpu` is below `CPU_SETSIZE`, so the bit it sets lies inside `set`.
        unsafe { libc::CPU_SET(cpu, &mut set) };
    }
    // SAFETY: pid 0 names the calling thread; `set` lives on this frame for the call and
    // the length passed is its size.
    let rc = unsafe { libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The CPUs the calling thread may run on, in ascending order.
///
/// # Returns
///
/// The indices.
///
/// # Errors
///
/// The operating system's error.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
pub fn current_thread_cpus() -> io::Result<Vec<usize>> {
    let mut set = empty_set();
    // SAFETY: pid 0 names the calling thread; `set` lives on this frame for the call and
    // the length passed is its size, so the kernel writes inside it.
    let rc =
        unsafe { libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((0..CPU_SET_SIZE)
        .filter(|&cpu| {
            // SAFETY: `cpu` is below `CPU_SETSIZE`, so the bit it reads lies inside `set`.
            unsafe { libc::CPU_ISSET(cpu, &set) }
        })
        .collect())
}

/// How many CPUs a `cpu_set_t` holds.
#[cfg(target_os = "linux")]
const CPU_SET_SIZE: usize = libc::CPU_SETSIZE as usize;

/// An empty CPU set.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn empty_set() -> libc::cpu_set_t {
    // SAFETY: `cpu_set_t` is a plain C bit set, for which all-zero bytes are the empty
    // set.
    unsafe { std::mem::zeroed() }
}

/// Pin the calling thread to `cpus`, so the scheduler runs it on no other processor.
///
/// # Arguments
///
/// * `cpus` - the processor indices the thread may run on; at least one, each within
///   the first processor group (below the bit width of a pointer).
///
/// # Returns
///
/// Nothing; the thread is pinned.
///
/// # Errors
///
/// `InvalidInput` for an empty set, `Unsupported` for a processor beyond the first
/// group, else the operating system's error.
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn pin_current_thread(cpus: &[usize]) -> io::Result<()> {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadAffinityMask};

    if cpus.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a thread needs at least one processor",
        ));
    }
    let mut mask: usize = 0;
    for &cpu in cpus {
        let bit = u32::try_from(cpu)
            .ok()
            .filter(|cpu| *cpu < usize::BITS)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "a processor beyond the first processor group",
                )
            })?;
        mask |= 1usize << bit;
    }
    // SAFETY: returns the pseudo handle of the calling thread, which needs no closing;
    // no preconditions.
    let thread = unsafe { GetCurrentThread() };
    // SAFETY: `thread` is the calling thread's pseudo handle and `mask` is passed by
    // value; the call changes only this thread's affinity.
    let previous = unsafe { SetThreadAffinityMask(thread, mask) };
    if previous == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Pin the calling thread to `cpus`.
///
/// # Arguments
///
/// * `cpus` - the CPU indices the thread may run on.
///
/// # Returns
///
/// Never: this platform exposes no affinity call the design verified.
///
/// # Errors
///
/// `Unsupported`, always.
#[cfg(not(any(target_os = "linux", windows)))]
pub fn pin_current_thread(cpus: &[usize]) -> io::Result<()> {
    let _ = cpus;
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "thread affinity is not available on this platform",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{current_thread_cpus, pin_current_thread, CPU_SET_SIZE};

    #[test]
    #[cfg_attr(miri, ignore)]
    fn the_thread_runs_only_where_it_is_pinned() {
        let before = current_thread_cpus().unwrap();
        assert!(!before.is_empty());
        let first = before[0];
        pin_current_thread(&[first]).unwrap();
        assert_eq!(current_thread_cpus().unwrap(), vec![first]);
        pin_current_thread(&before).unwrap();
        assert_eq!(current_thread_cpus().unwrap(), before);
    }

    #[test]
    fn an_impossible_set_is_refused_before_the_call() {
        assert_eq!(
            pin_current_thread(&[]).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            pin_current_thread(&[CPU_SET_SIZE]).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn a_cpu_the_machine_does_not_have_is_the_kernels_error() {
        let err = pin_current_thread(&[CPU_SET_SIZE - 1]).unwrap_err();
        assert!(err.raw_os_error().is_some(), "{err}");
    }
}
