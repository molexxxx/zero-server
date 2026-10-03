//! Worker placement inside the CPU set a process may use: started from a thread
//! confined to some of the machine's CPUs, as `taskset` or a container's cpuset
//! confines a process, every worker pins to a CPU of that set, wrapping around it when
//! there are more workers than CPUs.

#![cfg(all(target_os = "linux", any(feature = "io-tokio", feature = "io-compio")))]

use std::io;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use zero_io::rt::{serve, Acceptor, Config, Core};
use zero_sys::affinity::{current_thread_cpus, pin_current_thread};

/// What each worker saw: its index, the CPU it reports, and its thread's CPU set.
type Seen = (usize, Option<usize>, Vec<usize>);

/// Start `threads` workers from a thread confined to `confined`, and collect what each
/// worker saw from inside.
fn placed(confined: Vec<usize>, threads: usize) -> Vec<Seen> {
    thread::spawn(move || {
        pin_current_thread(&confined).unwrap();
        let (sender, receiver) = mpsc::channel::<Seen>();
        let config = Config {
            threads,
            pin: true,
            ..Config::default()
        };
        let workers = serve(
            "127.0.0.1:0".parse().unwrap(),
            config,
            move |core: Core, _acceptor: Acceptor| {
                let sender = sender.clone();
                async move {
                    let set = current_thread_cpus()?;
                    sender
                        .send((core.index(), core.cpu(), set))
                        .map_err(io::Error::other)?;
                    Ok(())
                }
            },
        )
        .unwrap();
        let mut seen: Vec<Seen> = (0..threads)
            .map(|_| receiver.recv_timeout(Duration::from_secs(30)).unwrap())
            .collect();
        workers.stop().unwrap();
        seen.sort_unstable();
        seen
    })
    .join()
    .unwrap()
}

#[test]
fn workers_started_inside_a_cpu_set_pin_only_to_cpus_of_that_set() {
    let allowed = current_thread_cpus().unwrap();
    // One CPU cannot tell placement by the set from placement by index.
    let [.., last] = allowed.as_slice() else {
        return;
    };
    if allowed.len() < 2 {
        return;
    }
    let seen = placed(vec![*last], 2);
    assert_eq!(
        seen,
        vec![(0, Some(*last), vec![*last]), (1, Some(*last), vec![*last])],
        "worker CPU 0 and 1 by index would leave the set {{{last}}}"
    );
}

#[test]
fn more_workers_than_cpus_in_the_set_wrap_around_it_in_order() {
    let allowed = current_thread_cpus().unwrap();
    let [.., second, last] = allowed.as_slice() else {
        return;
    };
    let (second, last) = (*second, *last);
    let seen = placed(vec![second, last], 3);
    assert_eq!(
        seen,
        vec![
            (0, Some(second), vec![second]),
            (1, Some(last), vec![last]),
            (2, Some(second), vec![second]),
        ]
    );
}
