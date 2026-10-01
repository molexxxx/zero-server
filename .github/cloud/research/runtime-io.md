# Research: non-blocking runtime and I/O model for lowest CPU and memory per connection

Working notes, written incrementally. Every claim is tagged with the source fetched in this task; anything not fetched is marked unverified.

## 1. Operating system I/O primitives

### 1.1 Linux io_uring (fetched: man7 io_uring(7), io_uring_register(2))

- Model: two ring buffers shared between user space and kernel, a submission queue (SQ) and a completion queue (CQ). The man page states "ring buffers are shared between user space and kernel space. This arrangement allows for efficient I/O, while avoiding the overhead of copying buffers between them."
- Batching: applications "batch several requests in one go, simply by queueing up multiple SQEs ... and make a single call to io_uring_enter(2)."
- SQPOLL: "io_uring starts a kernel thread that polls the submission queue ... there is no need for you to call io_uring_enter(2), letting you avoid the overhead of system calls." (Cost: a busy kernel thread, so it raises CPU usage at idle; that trade-off is stated by the mechanism itself, and is the reason it is not the default for a low-CPU goal.)
- Completions arrive in any order: "I/O requests submitted to the kernel can complete in any order." IOSQE_IO_LINK enforces ordering when needed.
- CQE carries user_data, res, and flags (buffer selection, multishot continuation, socket state).
- Registration (io_uring_register(2)): "Registering files or user buffers allows the kernel to take long term references to internal data structures or create long term mappings of application memory, greatly reducing per-I/O overhead."
  - IORING_REGISTER_BUFFERS: since 5.1; buffers are "locked in memory and charged against the user's RLIMIT_MEMLOCK", 1 GiB per buffer, anonymous non-file-backed memory only.
  - IORING_REGISTER_FILES: since 5.1; ops use IOSQE_FIXED_FILE with an index instead of an fd. "Before 5.13 registering files would wait for the ring to idle."
  - IORING_REGISTER_PBUF_RING: since 5.19; "A newer alternative to using IORING_OP_PROVIDE_BUFFERS which is more efficient, to be used with request types that support the IOSQE_BUFFER_SELECT flag."
  - IORING_REGISTER_IOWQ_AFF: since 5.14; pins async worker threads to chosen CPUs.
  - IORING_REGISTER_RING_FDS: since 5.18; "reduces the overhead of the io_uring_enter(2) system call"; at most 16 registered ring descriptors.

### 1.2 Linux MSG_ZEROCOPY (fetched: kernel docs networking/msg_zerocopy)

- "The MSG_ZEROCOPY flag enables copy avoidance for socket send calls." Applies to TCP, UDP and VSOCK (virtio).
- "MSG_ZEROCOPY is generally only effective at writes over around 10 KB." It "replaces per byte copy cost with page accounting and completion notification overhead."
- Completion notifications are queued on the socket error queue; the kernel may fall back to a copy and flags it with SO_EE_CODE_ZEROCOPY_COPIED. Devices without scatter-gather cannot send zerocopy user data with kernel headers.
- Consequence for an HTTP server: TechEmpower-style responses are far below 10 KB, so zero-copy send does not help those workloads; it is a static-file and large-body feature.

### 1.3 Linux SO_REUSEPORT and related (fetched: man7 socket(7))

- SO_REUSEPORT since Linux 3.9: "Permits multiple AF_INET or AF_INET6 sockets to be bound to an identical socket address." For TCP it lets "accept(2) load distribution in a multi-threaded server to be improved by using a distinct listener socket for each thread." All binders must share the same effective UID. SO_ATTACH_REUSEPORT_CBPF / EBPF define "how packets are assigned to the sockets in the reuseport group."
- SO_INCOMING_CPU (gettable 3.19, settable 4.4): "one listening process per RX queue, with the incoming flow being handled by a listener on the same CPU."
- SO_BUSY_POLL since 3.11: busy poll on blocking receive; not useful for a low-CPU target.

### 1.4 Windows IOCP (fetched: learn.microsoft.com I/O Completion Ports)

- Completion packets queue FIFO; waiting threads are released LIFO so a hot thread keeps running: "No thread context switches will occur, because the running thread is continually picking up completion packets."
- NumberOfConcurrentThreads caps runnable threads per port; "The best overall maximum value to pick for the concurrency value is the number of CPUs on the computer."
- Microsoft's current guidance table: for a "High-performance server handling hundreds/thousands of concurrent connections" the recommended approach is IOCP; the thread pool API (CreateThreadpoolIo) wraps IOCP and is suggested when explicit concurrency control is not needed.
- "An I/O completion port is associated with the process that created it and is not sharable between processes."
- PostQueuedCompletionStatus lets any thread inject a packet, which is the natural cross-thread wake primitive.
- Overlapped socket functions that complete through IOCP: AcceptEx, WSASend, WSASendTo, WSASendMsg, WSARecv, WSARecvFrom, WSARecvMsg, ReadFile, WriteFile.

### 1.5 Windows Registered I/O (RIO)

- The Win32 conceptual page at learn.microsoft.com/en-us/windows/win32/winsock/winsock-registered-i-o-rio- returned 404 in this task. Second attempt pending (see below).

### 1.6 BSD and macOS kqueue (fetched: FreeBSD kqueue(2))

- "a generic method of notifying the user when an event happens or a condition holds, based on the results of small pieces of kernel code termed filters."
- kevent() registers and retrieves in one syscall: "All changes contained in the changelist are applied before any pending events are read from the queue." This is the batching advantage epoll lacks (epoll_ctl is one syscall per change).
- Filters: EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER (NOTE_SECONDS/MSECONDS/USECONDS/NSECONDS, NOTE_ABSTIME), EVFILT_USER (user-triggered wake), EVFILT_SIGNAL.
- Flags: EV_ADD, EV_ENABLE, EV_ONESHOT, EV_CLEAR ("Reset the state of the event after it is retrieved by the user", the edge-triggered mode), EV_DISPATCH ("Disable the event source immediately after delivery of an event"), EV_RECEIPT.
- Timers are kernel-side, so a kqueue reactor can run without a user-space timer wheel for coarse timeouts; EVFILT_USER replaces the self-pipe/eventfd wake trick.

## 2. Rust runtimes (first pass, from docs.rs and GitHub READMEs)

### 2.1 io-uring crate (fetched: docs.rs io-uring 0.7.15, released 2026-09-07)

- "The io_uring library for Rust", MIT OR Apache-2.0. Types: IoUring, Submitter ("Interface for submitting submission queue events ... and registering files or buffers"), SubmissionQueue, CompletionQueue, opcode module, Builder with setup_sqpoll, setup_single_issuer, setup_defer_taskrun, setup_coop_taskrun, setup_iopoll.
- Prebuilt bindings for x86_64, aarch64, riscv64, loongarch64, powerpc64; bindgen feature otherwise.
- Pushing SQEs is unsafe (the caller guarantees buffer lifetime); this is the layer a custom reactor would sit on.

### 2.2 tokio (fetched: docs.rs tokio runtime module)

- Multi-thread scheduler: work stealing, "will start a worker thread for each CPU core available on the system", one global queue plus a per-worker local queue of "at most 256 tasks", LIFO slot optimization.
- Current-thread scheduler: "All tasks will be created and executed on the current thread", global and local FIFO queues, "does not use the lifo slot optimization"; needs Runtime::block_on.
- I/O and timer drivers are polled "whenever there are no tasks ready to be scheduled, or when it has scheduled 61 tasks in a row" (event_interval, default 61).
- Docs: "The multi-thread scheduler ... tends to be the ideal configuration for most applications." NUMA guidance: "multiple runtimes instead of a single runtime for better performance." A thread-per-core tokio deployment is therefore N current-thread runtimes, each on its own thread, each with its own SO_REUSEPORT listener.

### 2.3 mio (fetched: docs.rs mio)

- "a fast, low-level I/O library for Rust focusing on non-blocking APIs and event notification for building high performance I/O apps with as little overhead as possible over the OS abstractions."
- Types: Poll, Registry, Token, Waker. Tier-1 targets listed include x86_64 linux, darwin, freebsd, netbsd, windows-msvc, windows-gnu, aarch64 ios/android, wasm32-wasip1. Windows backend details: pending (see below).

### 2.4 monoio (fetched: GitHub bytedance/monoio README and docs/en/benchmark.md)

- "a pure io_uring/epoll/kqueue Rust async runtime"; thread-per-core, no work stealing, tasks need not be Send; ownership-based buffer API. Drivers: Linux 5.6+ io_uring or epoll; older Linux epoll; macOS kqueue; Windows "experimental". Rust 1.75 minimum. MIT OR Apache-2.0.
- Benchmark (ByteDance, Xeon Gold 5118 @ 2.30 GHz, Intel X710 10GbE, Linux 5.15.4, nightly-2021-11-26, client and server on separate machines): at 4 cores monoio peak throughput "about twice" tokio; at 16 cores "close to 3 times"; with many connections "Monoio has the lowest latency and CPU usage"; with few connections and one core "Monoio's latency will be higher than Tokio". 100-byte messages: monoio and glommio scale linearly with cores, tokio "very little performance improvement". Exact per-run numbers are in charts, not text.

### 2.5 glommio (fetched: docs.rs glommio 0.9.0, released 2026-06-07)

- "a safe Rust interface for asynchronous, thread-local I/O, based on the linux io_uring interface and Rust's async support." Linux only, kernel 5.8+, needs 512 KiB memlock. Three rings per CPU: main, latency, poll (NVMe polling). Task queues with shares. DMA buffers for direct I/O. Apache-2.0 OR MIT, DataDog maintainers.

### 2.6 may (fetched: docs.rs may 0.3.51, released 2026-09-01)

- Stackful coroutines, "the Rust version of the popular Goroutine"; x86_64 on Linux, Windows, macOS; configurable stack_size via go_with; coroutine-local storage instead of TLS; schedules "on a configurable number of threads". Backend primitives not stated on docs.rs (pending). Stackful coroutines carry a stack per connection, which sets the memory floor per connection at the stack size rather than the future size.

### 2.7 compio (fetched: GitHub compio-rs/compio README)

- "A thread-per-core Rust runtime with IOCP/io_uring/polling inspired by monoio." Linux io_uring, Windows IOCP, macOS and others via polling/kqueue. Crates: compio-driver (proactor), compio-runtime, compio-net, compio-fs, compio-tls, compio-quic, plus signal, websocket, actor crates. Ownership-based buffer model; tracing spans compatible with tokio-console. MIT. 1.9k stars, 1,867+ commits at fetch time.
- This is the only runtime in the set whose native completion backend covers all three target operating systems.

## 2b. Second pass: details that decide the design

### io_uring setup flags (fetched: man7 io_uring_setup(2), liburing wiki "io_uring and networking in 2023")

- IORING_SETUP_COOP_TASKRUN (5.19): "By default, io_uring will interrupt a task running in userspace when a completion event comes in." The flag removes that inter-processor interrupt and defers task work to the next kernel transition.
- IORING_SETUP_SINGLE_ISSUER (6.0): "A hint to the kernel that only a single task (or thread) will submit requests."
- IORING_SETUP_DEFER_TASKRUN (6.1): "hint to io_uring that it should defer work until an io_uring_enter(2) call with the IORING_ENTER_GETEVENTS flag set"; must pair with SINGLE_ISSUER.
- IORING_SETUP_SUBMIT_ALL (5.18), IORING_SETUP_CQSIZE, IORING_SETUP_NO_MMAP (6.5), IORING_SETUP_REGISTERED_FD_ONLY (6.5).
- IORING_SETUP_SQPOLL: "a kernel thread is created to perform submission queue polling"; sq_thread_idle sets when it sleeps and sets IORING_SQ_NEED_WAKEUP. Rejected for this design: a spinning kernel thread is the opposite of low CPU.
- IORING_SETUP_IOPOLL: "busy-waiting for an I/O completion"; storage only, rejected for a network server.
- Feature bits: IORING_FEAT_FAST_POLL (5.7) "io_uring supports using an internal poll mechanism to drive data/space readiness" (this is what makes socket recv/send non-blocking without io-wq threads); IORING_FEAT_NODROP (5.5); IORING_FEAT_SUBMIT_STABLE (5.5).
- The liburing wiki (Jens Axboe) states the networking recommendation: SINGLE_ISSUER + DEFER_TASKRUN + COOP_TASKRUN, and "Not sharing a ring between threads is the recommended way to use rings in general, as it avoids any unnecessary synchronization." It gives no quantified numbers ("in real life applications, this has shown to yield very nice benefits in terms of efficiency").
- Multishot accept (5.19): "a single accept request, which will repeatedly trigger a CQE when a connection request comes in"; IORING_CQE_F_MORE says more CQEs follow. Direct descriptors "avoid some of the overhead associated with thread shared file tables" (IORING_FILE_INDEX_ALLOC).
- Multishot recv (6.0): "a single receive request, which repeatedly posts a CQE when data is available"; requires IOSQE_BUFFER_SELECT (provided buffers) and no MSG_WAITALL; ends when a CQE lacks IORING_CQE_F_MORE or on error; -ENOBUFS when the pool is empty. IORING_RECVSEND_BUNDLE (6.10) fills multiple buffers per completion.
- send_zc: "a zerocopy send will usually generate two CQEs"; the first carries the send result with IORING_CQE_F_MORE, the second (IORING_CQE_F_NOTIF) "tells the application that the memory associated with the send is safe to get reused". io_uring_prep_send_zc_fixed uses registered buffers. IORING_SEND_ZC_REPORT_USAGE reports bytes copied instead of zero-copied.
- Timeouts: io_uring_prep_timeout arms "a timeout specified by ts and with a timeout count of count completion entries"; flags ABS, BOOTTIME, REALTIME, MULTISHOT ("count is the number of repeats"), ETIME_SUCCESS; plus timeout_remove, timeout_update and link_timeout (per-operation deadline on a linked chain).
- Cancel: io_uring_prep_cancel matches by user_data; 5.19 adds IORING_ASYNC_CANCEL_ALL, _FD, _ANY. -ENOENT if already completed, -EALREADY if "the execution state of the request has progressed far enough that cancelation is no longer possible" (the caller then waits for the original CQE). "the kernel side of the cancelation is always run synchronously".
- msg_ring: "prepares to send a CQE to an io_uring file descriptor"; used for "simply waking up someone waiting on the targeted ring, or ... to pass messages between the two rings". This is the cross-core wake primitive for a thread-per-core design on Linux (liburing wiki: 8-byte cookie since 5.18, fd passing with direct descriptors since 6.0).
- eventfd(2): "The kernel overhead of an eventfd file descriptor is much lower than that of a pipe, and only one file descriptor is required"; the wake primitive for the epoll fallback path.

### epoll contract (fetched: man7 epoll(7))

- Level-triggered default "is simply a faster poll(2)". EPOLLET requires nonblocking descriptors and the rule to "wait for events only after read(2) or write(2) return EAGAIN"; partial reads under ET otherwise "will probably hang despite the available data still present". EPOLLONESHOT disables the fd after one event and requires EPOLL_CTL_MOD to rearm. Under ET with several threads in epoll_wait "just one of the threads ... is awoken".

### mio contract (fetched: docs.rs mio Poll, TcpListener)

- "Once a readiness event is received, the corresponding operation must be performed repeatedly until it returns WouldBlock". "Poll::poll may return readiness events even if the associated event source is not actually ready."
- Selectors: Linux/Android/illumos epoll, BSD/macOS/iOS kqueue, Windows IOCP, Solaris event ports.
- Windows: "IOCP uses a completion model instead of a readiness model"; "calls to read and write require data to be copied into an intermediate buffer before it is passed to the kernel"; "Windows needs all I/O operations to go through Mio". This is the concrete cost of running a readiness-style runtime (tokio/mio) on Windows: one extra copy per read and write and an internal buffer per socket.
- TcpListener::bind sets SO_REUSEADDR "on Unix" only.

### polling crate (fetched: docs.rs polling)

- Backends: epoll (Linux, Android, Redox), kqueue (macOS, iOS, tvOS, watchOS, visionOS, FreeBSD, NetBSD, OpenBSD, DragonFly), event ports (illumos, Solaris), poll (VxWorks, Fuchsia, Hermit, other Unix), IOCP (Windows, Wine 7.13+). "By default, polling is done in oneshot mode"; level and edge modes exist on some OSes. "Only one thread can be waiting for I/O events at a time."

### Windows details (fetched: learn.microsoft.com)

- GetQueuedCompletionStatusEx (Vista/Server 2008+): "Retrieves multiple completion port entries simultaneously" into a caller-supplied OVERLAPPED_ENTRY array (ulCount), optional alertable wait. "A thread can be associated with at most one completion port."
- SetFileCompletionNotificationModes FILE_SKIP_COMPLETION_PORT_ON_SUCCESS (Vista+): when "A request returns success immediately without returning ERROR_PENDING" the I/O manager "does not queue a completion entry to the port". Socket caveat: "only compatible with Layered Service Providers (LSP) that return Installable File Systems (IFS) handles" (check XP1_IFS_HANDLES via WSAEnumProtocols). This removes one port round trip for every send that completes inline, which is most HTTP responses.
- CancelIoEx (Vista+): cancels from any thread; "For asynchronous operations still pending, the cancel operation will queue an I/O completion packet"; canceled operations complete with ERROR_OPERATION_ABORTED; the OVERLAPPED must stay alive until that completion. All I/O issued by a thread is canceled when the thread exits (TransmitFile page, WSA_OPERATION_ABORTED), so per-core reactor threads must outlive their sockets.
- TransmitFile: "uses the operating system's cache manager to retrieve the file data"; TF_USE_KERNEL_APC "can deliver significant performance benefits"; up to 2,147,483,646 bytes per call; "Workstation and client versions of Windows ... limiting the number of concurrent TransmitFile operations allowed on the system to a maximum of two"; server versions have no default limit.
- SO_REUSEADDR on Windows "allows a socket to forcibly bind to a port in use by another socket ... the behavior for all sockets bound to that port is indeterminate" and "any application that sets this socket option should be redesigned"; "All server applications must set SO_EXCLUSIVEADDRUSE". Windows has no SO_REUSEPORT listener group (socket2 exposes set_reuse_port on all platforms except Windows and illumos/Solaris). Consequence: on Windows, one listener socket with several pre-posted AcceptEx calls on one IOCP, not N listeners.
- RIO (Windows 8 / Server 2012+): "send and receive operations to be performed with pre-registered buffers using queues for requests and completions"; "many different sockets can be associated with the same completion queue"; "Completion operations, such as polling, can be performed entirely in user-mode and without making system calls"; goal "Scale up your server to minimize CPU utilization per message"; TCP, UDP, multicast, IPv4 and IPv6. Function table obtained via WSAIoctl SIO_GET_MULTIPLE_EXTENSION_FUNCTION_POINTER / WSAID_MULTIPLE_RIO: RIOReceive(Ex), RIOSend(Ex), RIORegisterBuffer, RIODeregisterBuffer, RIOCreateCompletionQueue, RIOCreateRequestQueue, RIODequeueCompletion, RIONotify, RIOResize*. RIONotify arms one notification per call (WSAEALREADY if a previous one is outstanding) and delivers via RIO_EVENT_COMPLETION or RIO_IOCP_COMPLETION (IOCP handle, completion key, dedicated OVERLAPPED). "If the completion queues are not shared, mutual exclusion is not required." Limitation: RIO has no accept or connect; sockets are created with WSA_FLAG_REGISTERED_IO and accepted normally, then RIO request queues are created per socket. Microsoft publishes no numbers on the pages fetched; RIO gains versus IOCP are unverified.
- Windows IoRing (ioringapi.h, build 22000+, Windows 11): submission and completion queues with BuildIoRingReadFile, BuildIoRingRegisterBuffers, BuildIoRingRegisterFileHandles, BuildIoRingCancelRequest, SubmitIoRing, PopIoRingCompletion. Only file read is listed among build functions on the index page fetched; no socket operations. Not usable as a network backend.

### macOS and BSD details (fetched: XNU bsd/sys/event.h, Apple setsockopt(2), sendfile(2), FreeBSD setsockopt(2))

- XNU event.h defines EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER, EVFILT_USER, EVFILT_MACHPORT, EVFILT_VNODE, EVFILT_SIGNAL, EVFILT_EXCEPT; flags EV_ONESHOT, EV_CLEAR, EV_RECEIPT, EV_DISPATCH, EV_UDATA_SPECIFIC, EV_DISPATCH2; timer notes NOTE_SECONDS, NOTE_USECONDS, NOTE_NSECONDS, NOTE_ABSOLUTE, NOTE_LEEWAY, NOTE_CRITICAL, NOTE_BACKGROUND, NOTE_MACHTIME; kevent() and kevent64(). (The archived iPhoneOS man page still says EVFILT_TIMER is unsupported; the current header contradicts it, so kernel timers and EVFILT_USER wakes are available on macOS.)
- Apple SO_REUSEPORT: "permits multiple instances of a program to each receive UDP/IP multicast or broadcast datagrams destined for the bound port"; no TCP distribution is documented. FreeBSD adds SO_REUSEPORT_LB: "Incoming TCP and UDP connections are distributed among the participating listening sockets based on a hash function of local port number, and foreign IP address and port number", max 256 sockets per group. Consequence: on macOS, one listener with EV_CLEAR readiness, accept loop on one core, then hand the fd to a per-core reactor via EVFILT_USER wake; on FreeBSD, per-core listeners with SO_REUSEPORT_LB.
- Apple sendfile(2): regular file to stream socket in-kernel, sf_hdtr headers and trailers, EAGAIN with partial len on non-blocking sockets.

### Linux socket options that matter for latency (fetched: man7 tcp(7))

- TCP_NODELAY "disable the Nagle algorithm"; TCP_CORK "don't send out partial frames"; TCP_DEFER_ACCEPT (2.4) "Allow a listener to be awakened only when data arrives on the socket"; TCP_FASTOPEN (3.6) RFC 7413 on listeners; TCP_QUICKACK; TCP_USER_TIMEOUT (2.6.37) milliseconds unacknowledged data may remain; TCP_KEEPIDLE.

### Runtime details (fetched: docs.rs tokio Runtime, task, time wheel source; monoio 0.2.4; compio 0.19.2; tokio-uring; may; glommio README)

- tokio Runtime drop "waits indefinitely for spawned work to cease"; async tasks "continue running until they yield, then are dropped"; spawn_blocking tasks "keep running until they return". shutdown_timeout "waiting for at most duration for all spawned work to stop", after which remaining work and threads are leaked. shutdown_background does not wait. Current-thread: "block_on can be called concurrently from multiple threads", the first call owns the I/O and timer drivers.
- tokio graceful shutdown guide: three parts, "Figuring out when to shut down. Telling every part of the program to shut down. Waiting for other parts of the program to shut down." CancellationToken plus TaskTracker::wait, which "resolves only after all of its contained futures have resolved and the task tracker has been closed".
- tokio timer wheel: "Each level has 64 slots. By using 6 levels with 64 slots each, the timer is able to track time up to 2 years into the future with a precision of 1 millisecond." Level 1: 1 ms slots over 64 ms; level 2: 64 ms slots over about 4 s; level 3: about 4 s slots over 4 min; and so on.
- tokio task docs: "Tasks are light weight ... creating new tasks or switching between tasks does not require a context switch and has fairly low overhead"; no byte figure given. spawn_local on a LocalSet for !Send futures.
- monoio 0.2.4 (2026-09-04): IoUringDriver ("Driver with uring", 5.6+), LegacyDriver ("Driver with Poll-like syscall", epoll/kqueue), FusionDriver; BufResult ownership; "Experimental windows support is on the way"; memlock must be raised.
- compio 0.19.2: features actor, compat, dispatcher, fs, io, macros, net, process, quic, runtime, signal, tls, ws; console feature for tokio-console. compio-driver: Linux "fusion" driver tries io_uring then falls back to polling; SharedFd "passed to the operations to make sure the fd won't be closed before the operations complete"; BufferRef "A unique reference to a buffer within the buffer pool"; Proactor push, poll, cancel. Depends on io-uring ^0.7.13. No stated kernel minimum.
- tokio-uring: "still very young", filesystem and network only, kernel 5.11+ ("5.4.0 does not work ... 5.11.0 (the ubuntu hwe image) does work"), owned buffers.
- may: "Don't call thread-blocking API"; TLS access across scheduling points is undefined; "There is a guard page for each coroutine stack. When stack overflow occurs, it will trigger segment fault error." may_minihttp: "One of the fastest web frameworks available according to the TechEmpower Framework Benchmark" (data-r22); author's laptop, one thread, 200 connections: may_minihttp 116,181.73 req/s vs tokio_minihttp 100,650.94 req/s.
- glommio README: kernel "minimum version at this time is 5.8", "at least 512 KiB of locked memory", Rust 1.70 minimum. The Datadog introduction gives no reproducible measurements; it quotes third-party research ("thread-per-core architecture can improve tail latencies of applications by up to 71%") and Axboe's "Storage I/O times below four microseconds" versus a roughly five microsecond context switch.

### Security posture of io_uring (fetched: oss-security mirror of Google's kCTF post, moby/moby#46762, Docker seccomp docs)

- Google, June 2023: "60% of the submissions exploited the io_uring component of the Linux kernel (we paid out around 1 million USD for io_uring alone)"; io_uring was in every submission that bypassed mitigations; ChromeOS "We disabled io_uring (while we explore new ways to sandbox it)"; Android "Our seccomp-bpf filter ensures that io_uring is unreachable to apps"; io_uring "disabled on production Google servers"; verdict: "safe only for use by trusted components".
- Docker 25.0.0 (PR merged 2023-11-02): io_uring_setup, io_uring_enter, io_uring_register removed from the default seccomp allowlist, "Blocked due to security vulnerabilities that can be exploited to break out of containers." Consequence: inside a default Docker or containerd container, io_uring_setup fails with EPERM, so the epoll fallback is not optional; it is the path most container deployments will take unless the operator supplies a custom seccomp profile.

### TechEmpower status (fetched: TechEmpower R23 blog, issue #10932, HttpArena README)

- Round 23 (2025-03-17): Microsoft-provided ProLiant DL360 Gen10 Plus, "Intel Xeon Gold 6330 CPU @ 2.00GHz (56 cores)", 64 GB, "Mellanox Technologies MT28908 Family [ConnectX-6] 40Gbps Ethernet"; "3x Improvements in Practical Network-Bound Tests".
- Issue #10932 (2026-03-24): "we're sunsetting the project"; repository archived read-only; "The repository, history, and past results remain as a snapshot".
- HttpArena: "64-core dedicated hardware. Same conditions for every framework", 30 test profiles; efficiency profiles measure "CPU spent per request, read exactly from the container's cgroup rather than sampled", scored "CPU at 0.50, p99 at 0.25 and mean latency at 0.25". This matches the owner's priority list (CPU per request) better than TechEmpower's throughput-only ranking, and it is the live target to enter.

## 3. Published measurements (continued on 2026-09-30)

All items in section 2 marked "pending" were resolved in section 2b. This section adds the numbers that the comparison in section 4 rests on.

### 3.1 TechEmpower Round 23 results (measured locally from the archived results JSON, round23-ph.json, run "Continuous Benchmarking Run 2025-01-30 18:47:41", environment "Citrine"; extracted with tfb-extract.js as requests per second = totalRequests / (endTime - startTime), best concurrency level per entry, zero errors unless stated)

Concurrency levels: 16, 32, 64, 128, 256, 512 for json, db, fortune; pipeline levels 256, 1024, 4096, 16384 for plaintext; query counts 1, 5, 10, 15, 20 for query and update.

| Entry (runtime) | json | plaintext | db | query (1) | fortune | update (1) |
| --- | --- | --- | --- | --- | --- | --- |
| may-minihttp (may, stackful coroutines) | 3,102,063 (rank 2 of 540) | 27,906,423 (974 errors) | 1,357,757 | 1,440,112 (rank 1) | 1,327,379 (rank 1) | 474,901 |
| xitca-web (io_uring via tokio-uring-xitca, HttpServiceBuilder::h1().io_uring()) | 2,720,330 | 18,436,533 | 1,266,381 | 1,252,762 | 1,075,043 | 460,416 |
| ntex-plt (tokio) | 2,963,471 (rank 9) | 24,925,516 (rank 8) | n/a | n/a | n/a | n/a |
| ntex-plt-compio (compio, io_uring) | n/a | 23,164,471 (rank 10) | n/a | n/a | n/a | n/a |
| ntex-db (tokio) | n/a | n/a | 1,294,048 | 1,378,950 | 1,134,702 | 474,071 |
| ntex-db-compio (compio, io_uring) | n/a | n/a | 1,334,739 | 1,245,795 | 1,197,352 | 477,805 |
| hyper (tokio current-thread per core, default mode, SO_REUSEPORT, num_cpus threads) | 2,885,610 | 17,468,474 | n/a | n/a | n/a | n/a |
| axum (tokio current-thread per core, SO_REUSEPORT, num_cpus threads) | 2,709,795 | 12,048,256 | n/a | n/a | n/a | n/a |
| drogon (C++) | 2,474,350 (rank 66) | 14,655,006 | 1,014,116 | 985,657 | 947,069 | 454,275 |
| drogon-core (C++) | n/a | n/a | 1,033,970 | 999,446 | 1,042,653 | 454,002 |
| libreactor (C, epoll, per-core processes) | 3,098,627 | 28,025,993 | n/a | n/a | n/a | n/a |
| faf (Rust, custom epoll, no runtime) | n/a | 28,034,705 (rank 2) | n/a | n/a | n/a | n/a |
| aspnetcore | 2,546,481 | 27,530,836 (805 errors) | 844,156 | 846,600 | 741,878 | 231,891 |
| nodejs | 1,147,305 | 1,460,302 (3,488 errors) | n/a | n/a | n/a | n/a |

Runtime attribution sources: TFB frameworks/Rust/hyper/src/main.rs (clap Runtime enum, #[default] CurrentThread, hyper.dockerfile CMD passes no flags, set_reuse_port(true) on unix, threads default num_cpus::get()); frameworks/Rust/axum/src/server.rs (start_tokio builds new_current_thread per thread for 1..num_cpus::get(), set_reuse_port(true)); frameworks/Rust/xitca-web/src/main.rs (HttpServiceBuilder::h1().io_uring(), xitca-server depends on tokio-uring-xitca ^0.2.0); TFB frameworks/Rust/ntex/Cargo.toml (features tokio = ntex/tokio, compio = ntex/compio, neon = ntex/neon-polling, neon-uring = ntex/neon-uring; ntex 3.4.0) and ntex-plt-compio.dockerfile (--features="compio", RUSTFLAGS -C target-cpu=native); may-minihttp Cargo.toml (may 0.3, may_minihttp 0.1, mimalloc, lto thin, codegen-units 1, panic abort). Note that the current master benchmark_config.json for ntex lists tokio, neon and neon-uring variants, not compio; the compio entries are what ran in the Round 23 data set.

What the numbers say:

- Four Rust entries beat Drogon on json (may-minihttp by 25 percent, ntex by 20 percent, hyper by 17 percent, xitca-web by 10 percent), and may-minihttp beats Drogon on every database test (fortune 1,327,379 vs 947,069, a 40 percent margin). "Faster than Drogon" is therefore a demonstrated property of the Rust ecosystem on this hardware, not a research risk; the risk is the HTTP parser, the JSON path and the database driver, which the other research notes cover.
- The same framework on tokio versus compio (ntex, same code, same machine) lands within 5 percent either way: plaintext tokio 24.9M vs compio 23.2M; db compio 1.33M vs tokio 1.29M; fortune compio 1.20M vs tokio 1.13M; query tokio 1.38M vs compio 1.25M; update equal. On this workload the choice of io_uring versus epoll does not move throughput by more than noise. The HTTP framing code and allocator dominate.
- At low concurrency (16 and 32 connections) every Rust entry except libreactor shows about 500 to 600 microseconds average latency and 25k to 65k requests per second, then jumps to about 50 microseconds at 64 connections. libreactor shows 39 microseconds at 16 connections. That step is consistent with a per-core listener design where wrk's few connections land on a few cores and the rest idle; the data does not show the cause, so the mechanism is unverified. Drogon shows the same step (598 microseconds at 16, 57 microseconds at 64).
- Drogon's plaintext tail at 16,384 pipelined connections: 50.65 ms average with 217.83 ms standard deviation; ntex 13.13 ms, hyper 9.03 ms, xitca-web 9.65 ms. High connection counts are where the Rust entries already lead on latency.
- The top plaintext entries (mrhttp, faf, pico.v, uwebsockets.js, xitca-web-unrealistic, libreactor) cluster at 28.0M requests per second, which reads as the load generator or network ceiling on this hardware rather than a server limit; that is consistent with the Round 23 announcement's network-bound remark, but the ceiling itself is unverified.

### 3.2 Runtime-to-runtime measurements published by the projects

- monoio versus tokio (bytedance/monoio docs/en/benchmark.md, fetched): at 4 cores peak throughput "about twice" tokio, at 16 cores "close to 3 times"; with many connections "Monoio has the lowest latency and CPU usage"; with few connections on one core "Monoio's latency will be higher than Tokio". This is a 1 KiB echo benchmark with ByteDance's harness, not HTTP, on a 2021 nightly toolchain. It is the only published comparison in the set that states CPU usage, and it is qualitative.
- may_minihttp versus tokio_minihttp (may README, fetched): 116,181.73 vs 100,650.94 requests per second on one thread, 200 connections, author's laptop; 15 percent in favor of stackful coroutines on that micro-benchmark.
- compio publishes no benchmark numbers on its README or docs.rs page; its GitHub tree has no benches directory at the path checked (404). The only public compio measurement is the ntex Round 23 entry above.
- glommio publishes no reproducible measurement; the Datadog introduction quotes third parties.
- tokio publishes no throughput numbers; its docs describe scheduler mechanics only.
- No source fetched in this task publishes bytes per idle connection for any of these runtimes. Memory per connection is therefore reasoned from documented mechanisms in section 4 and marked unverified until measured.

## 4. Comparison: custom reactor versus the candidate runtimes

Legend: "doc" means the statement rests on documentation fetched in this task; "R23" on the Round 23 numbers above; "unverified" on reasoning alone.

### 4.1 Throughput and latency

- tokio multi-thread: work stealing with a 256-entry local queue and LIFO slot (doc). No Round 23 Rust entry of interest runs it: hyper, axum and ntex all run current-thread runtimes per core, which is itself evidence of what the framework authors found fastest (their reasoning is unverified). Cross-thread wakeups are the cost; every task on this scheduler must be Send, which forces Arc and atomics into per-request state (doc).
- tokio current-thread, one runtime per core with an SO_REUSEPORT listener each: no work stealing, no Send bound, drivers polled every 61 tasks or when idle (doc). R23: ntex-plt 2.96M json, 24.9M plaintext; hyper 2.89M json, 17.5M plaintext; axum 2.71M json, 12.0M plaintext. The 2x spread between ntex and axum on plaintext with the same runtime shape shows that the HTTP layer, not the reactor, sets throughput.
- io_uring through tokio-uring-xitca: R23 xitca-web 2.72M json, 18.4M plaintext, 1.27M db; the io_uring entry lands between the epoll entries, not above them.
- monoio: same thread-per-core shape on io_uring with completion semantics; ByteDance reports 2x to 3x tokio on echo at 4 to 16 cores (doc); no TFB entry to confirm on HTTP.
- compio: the same shape as monoio plus a real IOCP backend; R23 ntex-compio within 5 percent of ntex-tokio both ways.
- glommio: same shape, Linux only, kernel 5.8 plus, three rings per core, no TFB entry; no published numbers.
- may: stackful coroutines; R23 may-minihttp is the fastest Rust entry on json, query and fortune. The per-thread scheduler is documented but the I/O backend is not documented on docs.rs, so the reason it wins is unverified (the may_minihttp code is a hand-rolled HTTP/1.1 parser with mimalloc and thin LTO, which likely matters more than the coroutine model; unverified).
- Custom reactor on io-uring crate plus a hand-written IOCP and kqueue backend: the ceiling is what faf and libreactor show (28.0M plaintext on a bare epoll loop with no runtime), which is the same ceiling xitca-web-unrealistic and uwebsockets.js reach with runtimes. A custom reactor buys nothing on plaintext that a per-core runtime on a completion backend does not already reach. Where it can pay is CPU per request (fewer syscalls via multishot recv, buffer rings, DEFER_TASKRUN, registered ring fds) and memory per connection, which no TFB test measures.

### 4.2 Memory per connection (unverified; mechanism-based)

- Stackless futures (tokio, monoio, glommio, compio): one connection costs the size of its future state machine plus the socket and any pinned buffers. No source states a byte figure.
- Stackful coroutines (may): one stack per coroutine, size set by go_with or the global stack_size, plus a guard page (doc); the floor is the stack size, which is at least one page plus the guard page, so it is higher than a small future. The exact default is not stated on the page fetched.
- io_uring multishot recv with a provided buffer ring: an idle connection holds no receive buffer at all; the kernel picks a buffer from the shared ring only when data arrives (doc: multishot recv requires IOSQE_BUFFER_SELECT; buffer rings since 5.19, up to 32,768 entries, incremental consumption with IOU_PBUF_RING_INC since 6.12). This is the lowest idle memory any of the mechanisms offers.
- IOCP: a pending WSARecv pins its buffer until completion, so an idle connection holds one receive buffer unless the server posts zero-byte receives and reads into a pooled buffer after the notification (that zero-byte technique is unverified in this task; no Microsoft page was fetched for it). RIO removes the per-operation buffer pinning by pre-registering slabs (doc: "pre-registered buffers using queues for requests and completions") but has no accept or connect.
- mio on Windows: an extra intermediate buffer per socket and a copy on every read and write (doc). tokio on Windows inherits that.
- epoll and kqueue readiness: an idle connection holds no buffer; the reactor reads into a pooled buffer after readiness. Idle memory is comparable to io_uring with buffer rings, at the cost of one extra syscall per read.

### 4.3 CPU per request

- io_uring: batching several SQEs into one io_uring_enter, multishot accept and recv (one submission for many completions), registered ring fds, COOP_TASKRUN and DEFER_TASKRUN to avoid interrupting user space, and SINGLE_ISSUER are all documented as overhead reducers (doc). No fetched source quantifies them for networking; the liburing wiki says "very nice benefits" without numbers. R23 ntex tokio versus compio shows no throughput gain, which suggests that at TFB request sizes the syscall savings are small relative to HTTP parsing. HttpArena's efficiency profiles (CPU per request read from the cgroup) are the venue that would show a difference; no result was fetched.
- IOCP: FILE_SKIP_COMPLETION_PORT_ON_SUCCESS removes a port round trip for every inline-completing send (doc), GetQueuedCompletionStatusEx dequeues a batch per call (doc). RIO removes syscalls from the completion path entirely (doc: "entirely in user-mode and without making system calls") but Microsoft publishes no numbers.
- kqueue: kevent registers and reaps in one call (doc), so the per-event syscall count is lower than epoll's epoll_ctl plus epoll_wait pair.
- SQPOLL and IOPOLL raise CPU at idle by design (doc) and are excluded.

### 4.4 Portability

| Backend or runtime | Linux | Windows | macOS | FreeBSD |
| --- | --- | --- | --- | --- |
| io-uring crate | 5.1 plus (features by version) | no | no | no |
| tokio (mio) | epoll | IOCP with copy-through buffers | kqueue | kqueue |
| monoio | io_uring 5.6 plus or epoll | experimental | kqueue | kqueue (LegacyDriver) |
| glommio | io_uring 5.8 plus, 512 KiB memlock | no | no | no |
| may | yes (x86_64) | yes (x86_64) | yes (x86_64) | not listed |
| mio | epoll | IOCP | kqueue | kqueue |
| polling | epoll | IOCP, Wine 7.13 plus | kqueue | kqueue |
| compio | io_uring with polling fallback (fusion) | IOCP native | kqueue via polling | kqueue via polling |
| custom reactor | whatever is written | whatever is written | whatever is written | whatever is written |

Only compio and a custom reactor deliver completion-native I/O on Windows. Only compio, tokio, mio, polling and may cover all three target operating systems from one crate.

### 4.5 Maintenance burden (docs.rs metadata fetched 2026-09-30)

- tokio 1.53.1, released 2026-07-20, MIT; mio 1.2.3, MIT. The largest ecosystem; hyper, h2, quinn and rustls integrations are first-party or well-maintained. tokio's io-uring feature is marked unstable and Linux only (doc).
- compio 0.19.2, MIT, single-maintainer organization (compio-rs), 1.9k stars, pre-1.0; depends on io-uring 0.7.13 plus and polling. It ships its own net, tls, quic (quinn-proto, h3 optional), ws and fs crates, so nothing from the tokio ecosystem transfers without the compat feature.
- monoio 0.2.4, released 2026-09-04, MIT or Apache-2.0, ByteDance; Windows experimental; MSRV 1.75.
- glommio 0.9.0, released 2026-06-07, DataDog; Linux only.
- may 0.3.51, released 2026-09-01; one author; stackful coroutines carry the documented hazards (no blocking calls, TLS undefined across yields, guard-page segfault on overflow).
- polling 3.11.0, released 2026-07-25, Apache-2.0 or MIT (smol-rs).
- io-uring 0.7.15, released 2026-09-07, tokio-rs organization.
- A custom reactor is three backends (io_uring plus epoll fallback, IOCP, kqueue) written and maintained in-house with unsafe buffer-lifetime contracts on every push (doc: the io-uring crate's push is unsafe). That is the whole cost of the option: it moves the maintenance of the driver layer from the tokio-rs and compio-rs organizations to this project.

## 5. Buffer management, timers, graceful shutdown

### 5.1 Buffers

- Linux: one provided buffer ring per core (IORING_REGISTER_PBUF_RING, 5.19 plus, power-of-two entries up to 32,768) feeding multishot recv; buffers return to the ring with io_uring_buf_ring_advance after the request consumes them; IOU_PBUF_RING_INC (6.12) lets one large buffer serve several completions. Registered buffers (IORING_REGISTER_BUFFERS) for send_zc_fixed on large responses; MSG_ZEROCOPY is only effective above about 10 KB (doc), so small responses use plain send from a per-core slab. Registered memory is charged to RLIMIT_MEMLOCK (doc); glommio's 512 KiB requirement is the same constraint.
- Windows: IOCP sends complete inline for small responses with FILE_SKIP_COMPLETION_PORT_ON_SUCCESS (doc); receive buffers come from a per-core pool and stay pinned while the WSARecv is pending. TransmitFile for static files (doc: cache-manager backed; workstation editions limit concurrent calls to two). RIO is a later optimization for UDP (QUIC) rather than TCP because it lacks accept.
- macOS and BSD: readiness model; read into a pooled buffer after EVFILT_READ with EV_CLEAR; sendfile(2) with headers and trailers for static files (doc).
- Ownership rule that all three share: a buffer handed to a completion operation is owned by the driver until the completion arrives (monoio and compio document this as the BufResult and SharedFd contracts; io_uring cancel returns -EALREADY when it is too late to cancel and the CQE must still be awaited). The API to expose from the core is therefore owned buffers in and out, never borrowed slices across an await.

### 5.2 Timers

- Linux io_uring: IORING_OP_TIMEOUT with MULTISHOT, timeout_update, and link_timeout for per-operation deadlines (doc). A user-space hierarchical wheel like tokio's (6 levels of 64 slots, 1 ms precision, 2 years range, doc) is still needed for per-connection idle timeouts because linking a timeout to every recv doubles the SQE count.
- Windows: no port-native timer; GetQueuedCompletionStatusEx takes a millisecond wait (doc), so the wheel's next expiry becomes the wait argument.
- kqueue: EVFILT_TIMER with NOTE_NSECONDS and NOTE_ABSTIME on FreeBSD, NOTE_LEEWAY on XNU (doc); the wheel's next expiry becomes one kernel timer.
- QUIC needs 1 ms granularity (RFC 9002 section 6.1.2: "The RECOMMENDED value of the timer granularity (kGranularity) is 1 millisecond") and pacing that tolerates scheduling jitter (RFC 9002 section 7.7). The 1 ms wheel meets that.

### 5.3 Graceful shutdown

- Order that works on all three backends: stop accepting (close listeners or cancel multishot accept), signal handlers (a per-core flag or CancellationToken equivalent), drain in-flight requests with a deadline, cancel remaining operations (IORING_ASYNC_CANCEL_ALL on Linux 5.19 plus, CancelIoEx on Windows, EV_DELETE on kqueue), then wait for every CQE or completion packet before freeing buffers (doc: io_uring -EALREADY semantics; Windows canceled operations complete with ERROR_OPERATION_ABORTED and the OVERLAPPED must stay alive).
- Windows-specific constraint: I/O issued by a thread is canceled when that thread exits (doc), so per-core reactor threads must outlive their sockets and must not be recycled per request.
- tokio's model to copy: "Figuring out when to shut down. Telling every part of the program to shut down. Waiting for other parts of the program to shut down." with a tracker that resolves only when all tracked futures have finished (doc). tokio's Runtime drop waits indefinitely and shutdown_timeout leaks what is still running after the deadline (doc); the core should offer the same two modes.

## 6. HTTP/3 readiness of the I/O layer (added at the owner's request)

HTTP/3 rides QUIC over UDP; the runtime decision made now determines whether QUIC can be added without a second I/O design. Requirements taken from the RFCs and the platform pages:

- RFC 9000 section 14.1: "The maximum datagram size is limited to 1200 bytes for initial packets", "An endpoint MUST NOT fragment its Initial packets", "Endpoints SHOULD set the Don't Fragment (DF) bit on IP packets". Section 13.4: "ECN marking requires access to the IP header". So the socket layer must expose DF, ECN codepoints and the destination address per datagram.
- Linux: UDP_SEGMENT (4.18) "reduces send(2) cost by transferring multiple datagrams worth of data as a single large packet", at most 64 datagrams per call; UDP_GRO (5.0) delivers "multiple datagrams worth of data as a single large buffer, together with a cmsg(3) that holds the segment size" (doc, udp(7)). DF via IP_MTU_DISCOVER with IP_PMTUDISC_PROBE, ECN via IP_RECVTOS and IPV6_TCLASS (quinn-udp unix.rs, fetched). io_uring adds multishot recvmsg (6.0, IOSQE_BUFFER_SELECT, io_uring_recvmsg_out header) so one submission drains a QUIC socket into the buffer ring. SO_REUSEPORT with a CBPF or EBPF steering program (doc, socket(7)) distributes a UDP port over per-core sockets; steering by connection ID needs the EBPF variant (the program itself is unverified).
- Windows: UDP_SEND_MSG_SIZE segments a send buffer "into multiple messages by the networking stack" and UDP_RECV_MAX_COALESCED_SIZE coalesces receives from the same source into one buffer with a UDP_COALESCED_INFO control message, both requiring WSASendMsg and WSARecvMsg (doc). quinn-udp uses exactly these with IP_DONTFRAGMENT, IPV6_DONTFRAG, IP_RECVECN and IPV6_RECVECN, reports 512 GSO segments and 64 GRO segments, and notes "ECN is best-effort on Windows" (fetched source). Both calls are overlapped and complete on IOCP, so the same proactor serves TCP and QUIC.
- macOS: no kernel GSO or GRO; quinn-udp segments in user space and batches through the private sendmsg_x and recvmsg_x calls behind an apple_fast cfg, and uses IP_DONTFRAG (fetched source). kqueue readiness plus recvmsg with IP_RECVTOS works without the private calls.
- Rust building blocks: quinn-udp (unix, windows, wasi modules; GSO, GRO, ECN, DF, pktinfo) is runtime-agnostic at the socket layer; quinn-proto is the sans-I/O state machine; compio-quic 0.8.2 wraps quinn-proto on compio with rustls 0.23 and an optional h3 0.0.8 module (doc). Because quinn-proto is sans-I/O, the same state machine runs on a custom reactor, on compio or on tokio; the head start is to expose the datagram batch API (segments in, coalesced buffers plus per-datagram ECN and destination out) from the core's socket trait on day one so QUIC is a protocol crate on top, not a runtime fork.

## 7. Recommendation

### 7.1 Runtime model

Thread-per-core, one reactor and one single-threaded executor per core, no work stealing, !Send tasks, owned buffers across every await, completion semantics as the internal contract on all platforms (readiness backends emulate completion by performing the operation on readiness, which is what compio's polling driver and mio's Windows driver already do in opposite directions). Cross-core traffic only through explicit wake primitives (msg_ring on io_uring, PostQueuedCompletionStatus on IOCP, EVFILT_USER on kqueue, eventfd on epoll).

Build on compio-driver's Proactor as the driver layer rather than writing three backends from scratch: it is the only crate in the set with native io_uring, native IOCP and a kqueue path, an owned-buffer contract, a buffer pool, cancel, and a fusion fallback; the Round 23 data shows it at parity with tokio on HTTP throughput; and the io-uring crate underneath it is maintained by the tokio-rs organization. Keep the driver behind a small internal trait (submit, poll, cancel, wake, buffer pool, datagram batch) so a custom io_uring backend can replace it later on Linux for CPU-per-request work (multishot recv with buffer rings, DEFER_TASKRUN, registered ring fds, IOU_PBUF_RING_INC) without touching the HTTP layer. Reject tokio multi-thread for the hot path (Send bound and stealing cost), reject glommio (Linux only), reject may (stack per connection, TLS hazards, single author), reject SQPOLL and IOPOLL (idle CPU).

### 7.2 Backend and fallback order per operating system

- Linux: io_uring with SINGLE_ISSUER, DEFER_TASKRUN, COOP_TASKRUN, multishot accept, multishot recv over a provided buffer ring, registered ring fd; probe at startup and fall back to epoll with EPOLLET and eventfd wakes when io_uring_setup returns EPERM or ENOSYS (default Docker 25 seccomp blocks it; kernels before 5.19 lack buffer rings; kernels before 6.1 lack DEFER_TASKRUN, in which case run io_uring without those flags rather than falling back). Listener: one SO_REUSEPORT socket per core, optionally SO_INCOMING_CPU; TCP_NODELAY on accepted sockets, TCP_DEFER_ACCEPT and TCP_FASTOPEN on the listener as options.
- Windows: IOCP with one port per core (NumberOfConcurrentThreads 1), GetQueuedCompletionStatusEx batches, FILE_SKIP_COMPLETION_PORT_ON_SUCCESS where XP1_IFS_HANDLES allows it, one listener socket with SO_EXCLUSIVEADDRUSE and a pool of pre-posted AcceptEx calls distributed round-robin across cores, TransmitFile for static files. No fallback is needed (IOCP exists on every supported Windows version); RIO is a later optimization for QUIC sockets only. Never set SO_REUSEADDR on Windows listeners.
- macOS: kqueue with EV_CLEAR, EVFILT_TIMER, EVFILT_USER wakes, one listener whose accepts are distributed to per-core reactors by handing off descriptors (Apple's SO_REUSEPORT does not distribute TCP), sendfile(2). Fallback: poll(2) through the polling crate, only for platforms without kqueue.
- FreeBSD (not a primary target, comes free): kqueue with SO_REUSEPORT_LB per-core listeners.

### 7.3 What to measure before committing

- Bytes per idle connection at 10k, 100k and 1M connections per backend (no published figure exists); target the io_uring buffer-ring path as the floor.
- CPU per request on the HttpArena efficiency profile methodology (cgroup CPU accounting) for io_uring versus epoll on the same binary, since Round 23 shows no throughput difference and the case for io_uring rests entirely on CPU and memory.
- Low-concurrency latency (16 to 32 connections) with per-core listeners versus one shared listener, to explain the 500 microsecond step seen in every per-core entry in Round 23.
