# zero serve: sources and decisions

Every fact below was fetched on 2026-10-01 and is cited in the rustdoc of the item that relies on it.
Re-verified live on 2026-10-02 (Invoke-WebRequest, each quoted statement found in the page text):
the Kubernetes pod lifecycle page, POSIX sigwait, pthread_sigmask, pthread_create, XSH 2.4.1,
XCU 2.8.2, the kill utility, raise, SetConsoleCtrlHandler, HandlerRoutine (including the 5000 ms
close time-out), MS-ERREF STATUS_CONTROL_C_EXIT, RFC 6797 Section 7.2 and RFC 9110 Section 17.3.

## Registry rows

- runtime-06 stays on crates/zero-serve/src/lib.rs; its `at` matches exactly one line, the
  test `the_default_drain_timeout_is_shorter_than_the_kubernetes_default_terminationgraceperiodseconds_of_30_seconds`.
- runtime-01 and runtime-07 describe the Node.js process and belong to the Node facade's signal
  handling: their evidence now names bindings/node/test/lifecycle.test.js (arrives with the Node
  binding). Until that file exists, `cargo xtask standards --check` reports both rows, as it
  already did when they named zero-serve.
- Review follow-up (2026-10-02): `at` now quotes the JavaScript test titles,
  "installing SIGTERM and SIGINT listeners replaces the default exit" and
  "work in the process 'exit' handler is synchronous only", since a `fn` line cannot appear in a
  JS test file. `release` stays 1 on purpose: the Node lifecycle module ships in release 1
  (conformance/api-surface.json lists `lifecycle.lifecycle_manager` with `"release": 1`; the
  legacy manifest in .github/cloud/work/step12/map-legacy-tests.md puts `app/lifecycle.test.js`, signal
  handlers included, at release 1; ROADMAP step 13 is the Node facade and release 1 ends at step
  14). Moving the rows to release 2 would let the release 1 preflight pass without the Node
  signal handling, so the two rows stay reported until step 13 writes the test. ci.yml runs the
  check with `continue-on-error`; release-preflight.yml blocks on it, which is the intended gate.
- Node.js v26.10.0 process page re-fetched 2026-10-02 (https://nodejs.org/api/process.html):
  "'SIGTERM' and 'SIGINT' have default handlers on non-Windows platforms that reset the terminal
  mode before exiting with code 128 + signal number. If one of these signals has a listener
  installed, its default behavior will be removed." and, for 'exit', "Listener functions must
  only perform synchronous operations."

## Kubernetes pod termination (runtime-06)

- https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination
  (fetched with Invoke-WebRequest; the WebFetch summary truncated the page before the section)
  - "A Pod is granted a term to terminate gracefully, which defaults to 30 seconds."
  - "The default terminationGracePeriodSeconds setting is 30 seconds."
  - "By default, all deletes are graceful within 30 seconds."
  - "... first sending a TERM (aka. SIGTERM) signal, with a grace period timeout, to the main
    process in each container." (Pod Termination Flow, #pod-termination-flow)
  - "Once the grace period has expired, the KILL signal is sent to any remaining processes"
    (read from the page source, kubernetes/website content/en/docs/concepts/workloads/pods/pod-lifecycle.md)
- Decision: DEFAULT_DRAIN = 10 s; the process-level backstop equals the drain limit, so a
  SIGTERM leaves the process within 10 s, inside the 30 s grace period that also covers any
  preStop hook.

## POSIX.1-2024 (IEEE Std 1003.1-2024, Issue 8)

- sigwait: https://pubs.opengroup.org/onlinepubs/9799919799/functions/sigwait.html
  - "The sigwait() function shall select a pending signal from set, atomically clear it from
    the system's set of pending signals, and return that signal number in the location
    referenced by sig."
  - "The signals defined by set shall have been blocked at the time of the call to sigwait();
    otherwise, the behavior is undefined." So `wait` blocks the set in the calling thread
    before every call, which makes the safe API sound on any thread.
  - Returns zero or an error number; EINVAL for an invalid signal number.
- pthread_sigmask: https://pubs.opengroup.org/onlinepubs/9799919799/functions/pthread_sigmask.html
  - SIG_BLOCK: "The resulting set shall be the union of the current set and the signal set
    pointed to by set."
  - "The sigprocmask() function shall be equivalent to pthread_sigmask(), except that its
    behavior is unspecified if called from a multi-threaded process." Hence pthread_sigmask.
  - Returns 0 or the error number; never EINTR.
- pthread_create: https://pubs.opengroup.org/onlinepubs/9799919799/functions/pthread_create.html
  - "The signal mask shall be inherited from the creating thread."
  - "The set of signals pending for the new thread shall be empty."
- Signal concepts, 2.4.1: https://pubs.opengroup.org/onlinepubs/9799919799/functions/V2_chap02.html#tag_16_04_01
  - "Signals generated for the process shall be delivered to exactly one of those threads
    within the process which is in a call to a sigwait() function selecting that signal or
    has not blocked delivery of the signal."
  - A blocked signal generated for the thread "shall remain pending until it is unblocked, it
    is accepted when it is selected and returned by a call to the sigwait() function, ..."
  - 2.4.3 restricts a signal-catching function to async-signal-safe calls; no handler is
    installed, so nothing runs in signal context.
- raise: https://pubs.opengroup.org/onlinepubs/9799919799/functions/raise.html
  - "The effect of the raise() function shall be equivalent to calling:
    pthread_kill(pthread_self(), sig);" so a test can direct a signal at its own thread.
- Shell exit status, 2.8.2: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_08_02
  - "If the command terminated due to the receipt of a signal, the shell shall assign it an
    exit status greater than 128." The forced exit uses 128 plus the signal number (130 for
    SIGINT, 143 for SIGTERM), the value common shells report.

## Microsoft console control handlers

- SetConsoleCtrlHandler: https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler
  - Handlers "are called on a last-registered, first-called basis until one of the handlers
    returns TRUE. If none of the handlers returns TRUE, the default handler is called."
  - The initial list holds "only a default handler function that calls the ExitProcess
    function"; nonzero return on success, zero and GetLastError on failure.
- HandlerRoutine: https://learn.microsoft.com/en-us/windows/console/handlerroutine
  - "When the signal is received, the system creates a new thread in the process to execute
    the function." So the callback is an ordinary thread, not signal context.
  - CTRL_C_EVENT 0, CTRL_BREAK_EVENT 1, CTRL_CLOSE_EVENT 2, CTRL_LOGOFF_EVENT 5 and
    CTRL_SHUTDOWN_EVENT 6 (the last two reach services only).
  - For CTRL_CLOSE_EVENT: "Return TRUE. In this case, no other handler functions are called
    and the system terminates the process." So the handler holds its thread for close until
    the process exits; the Timeouts table caps CTRL_CLOSE_EVENT at SPI_GETHUNGAPPTIMEOUT,
    5000 ms, and CTRL_C and CTRL_BREAK have "no timeout".
- NTSTATUS values (MS-ERREF 2.3.1): https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
  - STATUS_CONTROL_C_EXIT 0xC000013A, "{Application Exit by CTRL+C} The application
    terminated as a result of a CTRL+C." The forced exit code on Windows.

## Pinned crate APIs (no new crate, no version change)

- libc 0.2.189 (already a zero-sys dependency), source read from the registry copy and
  https://docs.rs/libc/0.2.189/libc/: `sigemptyset(*mut sigset_t) -> c_int`,
  `sigaddset(*mut sigset_t, c_int) -> c_int`, `pthread_sigmask(c_int, *const sigset_t,
  *mut sigset_t) -> c_int`, `sigwait(*const sigset_t, *mut c_int) -> c_int`,
  `raise(c_int) -> c_int`, on linux_like (glibc and musl) and bsd (Apple).
- windows-sys 0.61.2 (already a zero-sys dependency), https://docs.rs/windows-sys/0.61.2/:
  `Win32::System::Console::SetConsoleCtrlHandler(PHANDLER_ROUTINE, windows_sys::core::BOOL)
  -> BOOL`, `PHANDLER_ROUTINE = Option<unsafe extern "system" fn(u32) -> BOOL>`,
  `CTRL_C_EVENT/CTRL_BREAK_EVENT/CTRL_CLOSE_EVENT: u32`; feature `Win32_System_Console =
  ["Win32_System"]` (added to zero-sys, and to the windows-sys feature allow lists in
  deny.toml and deny/*.toml); `Win32::Foundation::STATUS_CONTROL_C_EXIT: NTSTATUS (i32)`.
- rustls 0.23.45 as a dev-dependency of zero-serve for the HTTPS test client, the version and
  features zero-tls already pins; no new crate enters the graph.

## Decisions

- Exit codes: 0 stopped cleanly (also after a drain that hit its limit), 1 the server could
  not start or a core failed, 2 a usage error, 128 + signal number (Windows:
  STATUS_CONTROL_C_EXIT) when a second signal ends the drain.
- A core that stops while no stop was requested stops the rest with a drain and exits 1, so a
  core with no worker is never a silent outage (DESIGN 10.2 fails closed).
- The security headers are the zero-policy defaults rendered once per transport; HSTS only on
  the TLS listener. Responses the driver writes on its own (400, 408, 413, 417, 421, 505, and
  the problem response after a handler error) do not pass through the handler and carry no
  security headers. USAGE and the crate docs say so, and the end-to-end test
  `a_400_or_421_the_http_layer_writes_itself_carries_no_security_headers` pins it. Giving those
  responses the fields needs zero-http to write a configured field set on every response (it
  only has `Config::server` today); that change belongs to zero-http, not to this crate.

## Review fixes (2026-10-02)

Sources fetched 2026-10-02 with Invoke-WebRequest, each quoted statement found in the page text:

- POSIX open(): https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html
  - "When opening a FIFO with O_RDONLY or O_WRONLY set: If O_NONBLOCK is set, an open() for
    reading-only shall return without delay. ... If O_NONBLOCK is clear, an open() for
    reading-only shall block the calling thread until a thread opens the file for writing."
- POSIX fcntl(): https://pubs.opengroup.org/onlinepubs/9799919799/functions/fcntl.html
  - F_GETFL "Get the file status flags and file access modes"; F_SETFL "Set the file status
    flags ... from the corresponding bits in the third argument, arg, taken as type int. Bits
    corresponding to the file access mode and the file creation flags ... that are set in arg
    shall be ignored. If any bits in arg other than those mentioned here are changed by the
    application, the result is unspecified." Hence F_GETFL, clear O_NONBLOCK, F_SETFL. F_GETFL
    returns a non-negative value; F_SETFL "Value other than -1"; otherwise -1 and errno.
- POSIX read(): https://pubs.opengroup.org/onlinepubs/9799919799/functions/read.html
  - "When attempting to read a file (other than a pipe or FIFO) that supports non-blocking reads
    and has no data currently available: If O_NONBLOCK is set, read() shall return -1 and set
    errno to [EAGAIN]."
- Linux open(2): https://man7.org/linux/man-pages/man2/open.2.html
  - "Note that this flag has no effect for regular files and block devices ... Since O_NONBLOCK
    semantics might eventually be implemented, applications should not depend upon blocking
    behavior when specifying this flag for regular files and block devices." So zero-sys clears
    the flag once the file is open.
- POSIX mkfifo utility: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/mkfifo.html
  (the tests make FIFOs with it, so they hold no unsafe code).
- HandlerRoutine Timeouts table: https://learn.microsoft.com/en-us/windows/console/handlerroutine
  - "CTRL_CLOSE_EVENT any system parameter SPI_GETHUNGAPPTIMEOUT, 5000ms"; "CTRL_C, CTRL_BREAK
    any no timeout". So CLOSE_DRAIN = 4 s and a console close drains for min(--drain, 4 s).
- RFC 9112 Section 3.2: https://www.rfc-editor.org/rfc/rfc9112.html#section-3.2
  - "A server MUST respond with a 400 (Bad Request) status code to any HTTP/1.1 request message
    that lacks a Host header field and to any request message that contains more than one Host
    header field line or a Host header field with an invalid field value."
- RFC 9110 Section 7.4: https://www.rfc-editor.org/rfc/rfc9110.html#section-7.4
  - "a request for an "https" resource MUST be rejected unless it has been received over a
    connection that has been secured via a certificate valid for that target URI's origin".
- libc 0.2.189 (registry copy, src/unix/mod.rs): `pub fn fcntl(fd: c_int, cmd: c_int, ...) ->
  c_int`; F_GETFL, F_SETFL, O_NONBLOCK, O_ACCMODE defined on linux_like and apple.
- tokio 1.53.1 (registry copy): `Runtime::shutdown_timeout` calls
  `blocking_pool.shutdown(Some(duration))`, and src/runtime/context/blocking.rs computes
  `let when = Instant::now() + timeout;`, which panics on overflow. Hence MAX_DRAIN.

Decisions:

- `--drain` takes 0 to 86400 seconds (MAX_DRAIN, one day); a larger value is a usage error
  (exit 2) instead of a panic in every worker at the stop (exit 1).
- zero_sys::fs::open_nofollow opens with O_NONBLOCK on Unix, then clears it with fcntl, so
  opening a FIFO never waits for a writer and the returned file reads in blocking mode as
  before. zero-static still refuses the descriptor because it is not a regular file (404).
- An empty `--cert`, `--key` or DIRECTORY is a usage error; `help` takes no arguments, like
  `version`.
- The supervisor takes the drain limit from the signal thread's report; a console close drains
  for at most CLOSE_DRAIN, and a sooner limit cuts short a drain a failed core started.
