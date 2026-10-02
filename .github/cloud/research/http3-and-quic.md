# Research: HTTP/3 and QUIC as a first-class transport for the zero-server Rust core

Status: complete (2026-09-30). Every claim below cites a source fetched in this task, a measurement run in this task (Section 4.2), or is marked "unverified".
Related notes in this folder: research-runtime-io.md (io_uring, SO_REUSEPORT, tokio/monoio/compio), research-tls-and-deps.md (rustls posture), research-http-and-ws.md (crate versions for quinn, s2n-quic, h3).

## 1. Standards baseline (fetched from rfc-editor.org and datatracker.ietf.org)

### 1.1 RFC 9000, QUIC: A UDP-Based Multiplexed and Secure Transport (May 2021)
- Connection IDs: "Each endpoint selects connection IDs using an implementation-specific (and perhaps deployment-specific) method that will allow packets with that connection ID to be routed back to the endpoint" (Section 5.1). This is the hook for routing datagrams to the owning core: the server encodes a core index in the CIDs it issues, and a steering layer (eBPF or userspace) dispatches on it.
- "Multiple connection IDs are used so that endpoints can send packets that cannot be identified by an observer as being for the same connection without cooperation from an endpoint" (Section 5.1). Migration therefore requires a pool of unused CIDs per connection.
- Migration: "Only clients are able to migrate in this version of QUIC. This design also allows connections to continue after changes in network topology or address mappings, such as might be caused by NAT rebinding" (Section 1). Servers can only steer clients with the preferred_address transport parameter (Section 5.2.3).
- 0-RTT: "0-RTT provides no protection against replay attacks" (Section 5 summary of the fetched text; full replay treatment lives in RFC 9001 Section 9.2).
- Streams: "QUIC does not provide any means of ordering between bytes on different streams" (Section 2). Per-stream flow control plus connection-level flow control; loss on one stream does not stall delivery on another. This is the transport-level fact behind "head-of-line elimination".
- Version negotiation: "A server responds with a Version Negotiation packet if the version selected by the client is not acceptable" (Section 6.1).
- Stateless Reset (Section 10.3) lets an endpoint without state tell the peer the connection is dead.
- Datagram size and anti-amplification (Section 8.1 and Section 14): values re-verified below in 1.1a.

### 1.2 RFC 9001, Using TLS to Secure QUIC (May 2021)
- "QUIC carries TLS handshake data in CRYPTO frames, each of which consists of a contiguous block of handshake data identified by an offset and length" (Section 4). QUIC does not use TLS records; TLS is used as a handshake and key-schedule engine only.
- Four encryption levels (Initial, 0-RTT, Handshake, 1-RTT), each with its own keys; Initial keys derive from the client Destination Connection ID with a fixed salt (Sections 5.1 to 5.2).
- Header protection: "Parts of QUIC packet headers, in particular the Packet Number field, are protected using a key that is derived separately from the packet protection key and IV" (Section 5.4).
- "Clients MUST NOT offer TLS versions older than 1.3. An endpoint MUST terminate the connection if a version of TLS older than 1.3 is negotiated" (Section 4.2).
- "QUIC prohibits the use of the middlebox compatibility mode" (Section 8.4).
- 0-RTT replay: "Application data that is received in 0-RTT could cause an application at the server to process the data multiple times rather than just once" (Section 5.6 of fetched summary; RFC 9001 Section 9.2). A server that cannot tolerate replay must not enable early_data.
- Key update via the "quic ku" label, signaled by toggling the short-header bit reserved for key rotation (Section 6.1).
- ALPN is mandatory (Section 8.1); a QUIC handshake without ALPN fails.
- TLS library contract (Section 4.1): the QUIC stack needs a TLS API that exposes handshake bytes in and out per encryption level, secret export per level, and the negotiated AEAD and KDF. This is the "QUIC-aware TLS" surface that rustls exposes under its `quic` module and that s2n-tls, BoringSSL, and OpenSSL 3.2+ expose natively. An in-house QUIC therefore also needs a TLS library with this surface; it cannot reuse a record-layer-only TLS.

### 1.3 RFC 9002, QUIC Loss Detection and Congestion Control (May 2021)
- Loss detection: packet threshold "kPacketThreshold is 3" (6.1.1); time threshold `max(9/8 * max(smoothed_rtt, latest_rtt), 1 ms)` (6.1.2); PTO `smoothed_rtt + max(4*rttvar, kGranularity) + max_ack_delay` (6.2.1).
- Congestion control: "a sender-side congestion controller for QUIC similar to TCP NewReno" (Section 7); "a sender can unilaterally choose a different algorithm to use, such as CUBIC" (Section 7). Initial window: ten times max_datagram_size, capped at max(14,720 bytes, 2 * max_datagram_size) (7.2); minimum window 2 * max_datagram_size (7.2).
- ECN: "If a path has been validated to support Explicit Congestion Notification (ECN), QUIC treats a Congestion Experienced (CE) codepoint in the IP header as a signal of congestion" (7.1). Requires reading the ECN bits from received datagrams (IP_TOS / IPV6_TCLASS ancillary data on POSIX, IP_ECN on Windows) and setting them on sends.
- Pacing: "A sender SHOULD pace sending of all in-flight packets based on input from the congestion controller" (7.7). Pacing means the transport needs a fine-grained timer wheel; on Linux, SO_TXTIME or GSO-batched sends amortize this.

### 1.4 RFC 9114, HTTP/3 (June 2022)
- ALPN token "h3" (3.1).
- Discovery: "An HTTP origin can advertise the availability of an equivalent HTTP/3 endpoint via the Alt-Svc HTTP response header field or the HTTP/2 ALTSVC frame using the 'h3' ALPN token", example `Alt-Svc: h3=":50781"` (3.1.1). RFC 9460 HTTPS records are the second discovery path (see 1.9).
- Streams: request streams are client-initiated bidirectional (6.1); control streams (6.2.1), push streams (6.2.2), QPACK encoder/decoder streams (RFC 9204) are unidirectional.
- Frame format: "Type (i), Length (i), Frame Payload (..)" (7.1); both fields are QUIC varints. Frame types: DATA 0x00, HEADERS 0x01, CANCEL_PUSH 0x03, SETTINGS 0x04, PUSH_PROMISE 0x05, GOAWAY 0x06, MAX_PUSH_ID 0x07 (7.2). This is a small, regular grammar: an HTTP/3 framer is far simpler than an HTTP/2 framer because there is no per-frame stream ID, no priority, no window update, no ping, no continuation.
- Head-of-line: HTTP/2 over TCP suffers because "a lost or reordered packet causes all active transactions to experience a stall" (1.1); HTTP/3 streams progress independently.
- Semantics: same request/response model and pseudo-headers as HTTP/2 (:method, :scheme, :authority, :path, :status) (4.1, 4.3). This is the fact that makes one request pipeline possible: HTTP/2 and HTTP/3 produce the same header list shape.
- SETTINGS: "SETTINGS parameters are not negotiated; they describe characteristics of the sending peer" (7.2.4); must be the first frame on the control stream.
- GOAWAY: "contains an identifier that indicates to the receiver the range of requests or pushes that were or might be processed in this connection" (5.2); graceful drain mirrors HTTP/2 GOAWAY.
- Server push (4.6) exists; browsers have removed HTTP/2 push support (unverified in this task; the Chrome removal is widely documented but not fetched here), so the server should not implement push beyond rejecting it.

### 1.5 RFC 9204, QPACK: Field Compression for HTTP/3 (June 2022)
- Goal: "reduce head-of-line blocking" that HPACK would reintroduce over out-of-order streams (Section 1).
- Static table: 99 entries, indices 0 to 98 (Appendix A).
- Dynamic table state is carried on the encoder stream (type 0x02) and decoder stream (type 0x03) (4.2).
- SETTINGS_QPACK_MAX_TABLE_CAPACITY and SETTINGS_QPACK_BLOCKED_STREAMS both default to zero (Section 5); with zero capacity "the encoder MUST NOT insert entries into the dynamic table and MUST NOT send any encoder instructions" (3.2.3). A server may legally ship a static-table-plus-literals QPACK encoder and a decoder that advertises capacity 0; that is a complete, conformant implementation with no cross-stream state and no blocking, which is what makes an in-house no_std QPACK a bounded task.
- Huffman: "the Huffman table from Appendix B of [RFC7541] without modification" (4.1.2), so the HPACK Huffman codec is shared with HTTP/2.
- Representations: indexed, literal with name reference (static or dynamic), literal with literal name (4.5.2 to 4.5.6).

### 1.6 RFC 9221, An Unreliable Datagram Extension to QUIC (March 2022)
- DATAGRAM frame types 0x30 and 0x31; transport parameter max_datagram_frame_size (0x20), default 0 meaning unsupported.
- "Although DATAGRAM frames are not retransmitted upon loss detection, they are ack-eliciting" (5.2); they use the connection's congestion controller (5.4); they are not flow controlled (5.3).
- Use cases named: audio/video, gaming, real-time, VPN tunneling. For zero-server this is the substrate for WebTransport datagrams and for the existing WebRTC/SFU features if they ever move onto QUIC.

### 1.7 RFC 9297, HTTP Datagrams and the Capsule Protocol (August 2022)
- "HTTP Datagrams are a convention for conveying bidirectional and potentially unreliable datagrams inside an HTTP connection with multiplexing when possible" (Section 2).
- HTTP/3 mapping: Quarter Stream ID = client-initiated bidirectional stream ID / 4 (2.1). SETTINGS_H3_DATAGRAM = 0x33; "QUIC DATAGRAM frames MUST NOT be sent until the SETTINGS_H3_DATAGRAM setting has been both sent and received with a value of 1" (2.1.1).
- Capsule protocol: "a sequence of type-length-value tuples" with varint type and length (3.2); DATAGRAM capsule type 0x00 carries datagrams over HTTP/1.1 and HTTP/2 streams (3.5). Applies to upgrade tokens via extended CONNECT.

### 1.8 WebTransport over HTTP/3 (draft-ietf-webtrans-http3-16, 2026-07-06)
- Status at fetch time: Working Group Last Call, "I-D Exists", not in the RFC Editor queue. Not an RFC yet.
- Mechanism: extended CONNECT (RFC 9220) with `:protocol` = `webtransport-h3`, `:scheme` = https; server signals SETTINGS_WT_ENABLED = 1 (older drafts used SETTINGS_WT_MAX_SESSIONS; draft 16 text names SETTINGS_WT_ENABLED). Unidirectional stream signal 0x54, bidirectional stream signal 0x41, each followed by the session ID; datagrams via RFC 9297 HTTP Datagrams.
- Depends on RFC 9220, RFC 9297, RFC 9221, and draft-ietf-quic-reliable-stream-reset (RESET_STREAM_AT).
- HTTP/2 fallback exists as draft-ietf-webtrans-http2 with upgrade token "webtransport".
- Consequence: WebTransport is an application-layer protocol over the HTTP/3 request stream plus raw QUIC streams and datagrams. The transport abstraction must expose "open a raw QUIC stream tied to session X" and "send a datagram tied to stream X", not only request/response.

### 1.9 Discovery: RFC 7838 Alt-Svc (April 2016) and RFC 9460 SVCB/HTTPS records (November 2023)
- Alt-Svc syntax `Alt-Svc = clear / 1#alt-value`, example `Alt-Svc: h3=":443"; ma=86400` (Section 3). Default freshness "24 hours from generation of the message" (3.1); `ma` overrides; `persist=1` survives network changes (3.1); `clear` invalidates all alternatives (3).
- "Clients MUST have reasonable assurances that the alternative service is under control of and valid for the whole origin" (2.1): the certificate must be valid for the origin host, so the QUIC listener must serve the same certificate as the TCP listener.
- HTTP/2 ALTSVC frame type 0xa (Section 4). "The client does not need to block requests on any existing connection; it can be used until the alternative connection is established" (2.4): browsers race or lazily switch; the first request never uses HTTP/3 via Alt-Svc alone.
- RFC 9460: HTTPS RR type 65, SVCB type 64. "alpn" SvcParam: "Clients filter the set of ALPN identifiers to match the protocol suites they support, and this informs the underlying transport protocol used (such as QUIC over UDP or TLS over TCP)" (7.1). The HTTPS RR "enables many of the benefits of Alt-Svc without waiting for a full HTTP connection initiation (multiple round trips)" (Section 9). `port`, `ipv4hint`, `ipv6hint`, `ech` SvcParams (7.2, 7.3, 14.3.2). AliasMode SvcPriority 0, ServiceMode SvcPriority > 0. Clients using both "ensure that their connection attempts are consistent with both the Alt-Svc parameters and any received HTTPS SvcParams" (9.3).
- Consequence for the plan: Alt-Svc is emitted by the server and needs no operator DNS work; the HTTPS record is set by the operator in DNS and gets HTTP/3 on first contact. The server should emit Alt-Svc automatically when a QUIC listener is bound, and the docs should tell operators to publish `HTTPS 1 . alpn="h3,h2"` for first-contact HTTP/3.

## 2. QUIC implementations surveyed (GitHub API, repository READMEs, docs.rs, fetched 2026-09-30)

| Project | Created | Last push | Stars | Open issues | License | Language and TLS | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| quinn (quinn-rs/quinn) | 2018-04-03 | 2026-09-30 | 5,275 | 185 | Apache-2.0 OR MIT | Rust; rustls with ring (default) or aws-lc-rs, FIPS variant | quinn-proto is "a fully deterministic implementation of QUIC protocol logic" that "contains no networking code"; quinn-udp is the socket layer; quinn is the tokio API. MSRV 1.80. |
| quiche (cloudflare/quiche) | 2018-09-29 | 2026-09-29 | 12,719 | 378 | BSD-2-Clause | Rust; BoringSSL built by boring-sys (cmake, NASM on Windows) | "The application is responsible for providing I/O"; `quiche::h3` module with QPACK; pacing hints via `SendInfo.at`; used at the Cloudflare edge, in Android DNS and curl; Reno, CUBIC (default), BBRv2 (gcongestion branch); Rust 1.88+. |
| neqo (mozilla/neqo) | 2019-02-18 | 2026-09-30 | 2,243 | 189 | Apache-2.0 OR MIT | Rust; NSS only (system NSS or a Mercurial/GYP/Ninja build) | Firefox's stack; crates neqo-transport, neqo-http3, neqo-qpack, neqo-crypto, neqo-common, neqo-udp; transport source tree has ecn.rs, pmtud.rs, pace.rs, cc/, recovery/, quic_datagrams.rs. |
| msquic (microsoft/msquic) | 2019-10-26 | 2026-09-30 | 4,782 | 349 | MIT | C; Schannel on Windows (Server 2022 or Windows 11, no 0-RTT), OpenSSL/quictls fork elsewhere | Ships in the Windows kernel as msquic.sys; RFC 9000, 9001, 9002, 9221, 9287, 9368, 9369 plus drafts (load balancers, ack frequency, reliable stream reset); "Receive side scaling (RSS)", "UDP send and receive coalescing", "Kernel stack bypass via XDP"; Rust crate `msquic` 2.7.0-beta in-repo (docs.rs shows 2.5.1-beta, 5 percent documented), `build = "scripts/build.rs"`, default feature `src` builds the C code with cmake, `find` uses vcpkg on Windows or system paths on Linux and does not support macOS. |
| s2n-quic (aws/s2n-quic) | 2020-06-25 | 2026-09-29 | 1,371 | 290 | Apache-2.0 | Rust; s2n-tls (Unix default) or rustls (Windows MSVC default) | tokio io provider is the default and the only one documented on docs.rs; s2n-quic-xdp 0.89.0 is an "Internal crate" for AF_XDP; CUBIC and BBR controllers; GSO/GRO builder switches, PMTU discovery, "unique connection identifiers detached from the address"; MSRV 1.92 (rolling six month policy); Linux kernel 5.0+. |

Cross-cutting facts:
- Every surveyed stack is at least six years old and still carries 185 to 378 open issues while being pushed to daily. None of them is finished; they are maintained.
- quinn-proto (docs.rs 0.11.18, 2026-09-14) has no no_std support and depends on bytes, lru-slab, rand, rand_pcg, rustc-hash, slab, thiserror, tinyvec, tracing, web-time, rustls-pki-types, and optionally rustls, ring, aws-lc-rs, fastbloom, qlog, arbitrary. Congestion module: Cubic ("The RFC8312 congestion controller, as widely used for TCP"), NewReno, Bbr ("Experimental! Use at your own risk."). TransportConfig exposes initial_mtu (default 1200), min_mtu, mtu_discovery_config (enabled by default; DPLPMTUD with binary search, upper bound 1452, rerun interval 600 s "as recommended by RFC 8899", black hole cooldown one minute, reset to 1200 on black hole), enable_segmentation_offload (default on), ack_frequency_config, datagram buffers, stream and connection windows, packet_threshold (minimum 3), time_threshold, persistent_congestion_threshold.
- quinn-proto's crypto module defines Session, ServerConfig, ClientConfig, PacketKey, HeaderKey, AeadKey, HmacKey, HandshakeTokenKey traits with a rustls submodule; "usage of any protocol (version) other than TLS 1.3 does not conform to any published versions of the specification". This is the seam through which the audited TLS choice from research-tls-and-deps.md plugs in.
- rustls 0.23.45 `quic` module: ServerConnection, ClientConnection, Keys, PacketKeySet, DirectionalKeys, Secrets, KeyChange, HeaderProtectionKey, PacketKey, Suite, Version. rustls ServerConfig: max_early_data_size "Specify 0 to disable early data"; 0-RTT also needs session_storage and ticketer; send_half_rtt_data defaults to false.
- compio-quic 0.8.2 is "QUIC implementation based on `quinn-proto`" on the compio runtime with rustls and an optional `h3` feature, exposing Endpoint, Connection, SendStream, RecvStream and EcnCodepoint. Since research-runtime-io.md recommends building on compio-driver's Proactor, this crate is the proof that quinn-proto runs on io_uring and IOCP without a tokio dependency.
- h3 (hyperium/h3) 0.0.8: "The `h3` crate is still very experimental. While the client and servers do work, there may still be bugs."; "generic over a provided QUIC transport"; crates h3, h3-quinn, h3-webtransport, h3-datagram; 895 stars; depends on tokio ^1, bytes, http. Its QPACK usage on the wire is stateless only: connection.rs calls `qpack::encode_stateless` and `qpack::decode_stateless`, and the encoder and decoder unidirectional streams send only the stream type byte. The qpack directory does contain dynamic.rs, but it is not wired to the connection.
- QUIC interop runner (interop.seemann.io): the page states it tracks client and server implementations and updates several times a day; the result matrix and JSON were not extractable in this task (result.json returned 404), so per-implementation pass/fail is not verified here. h3's README states it participates in that runner.

## 3. UDP fast path per operating system

### 3.1 Linux (man7 udp(7), IP_MTU_DISCOVER(2const), IP_RECVERR(2const), IP_RECVTOS(2const), io_uring man pages, kernel selftests, quinn-udp unix.rs)
- GSO: UDP_SEGMENT "since Linux 4.18": "Segmentation offload reduces send(2) cost by transferring multiple datagrams worth of data as a single large packet through the kernel transmit path, even when that exceeds MTU"; "at most 64 datagrams are sent in a single call". quinn-udp probes it with setsockopt at startup and falls back to one segment when sendmsg returns EIO or EINVAL.
- GRO: UDP_GRO "since Linux 5.0": "the socket may receive multiple datagrams worth of data as a single large buffer, together with a cmsg(3) that holds the segment size". quinn-udp reads the stride from the SOL_UDP/UDP_GRO cmsg and reports 64 segments (`UDP_GRO_CNT_MAX 64`), and batches with recvmmsg, BATCH_SIZE 32.
- DF and PMTU: IP_MTU_DISCOVER values IP_PMTUDISC_WANT ("Use per-route settings"), DONT, DO ("forces the don't-fragment flag to be set on all outgoing packets"; oversized sends fail with EMSGSIZE), PROBE ("Set DF but ignore Path MTU", Linux 2.6.22). quinn-udp sets IP_PMTUDISC_PROBE so the transport's own DPLPMTUD (RFC 8899: probes of increasing size, no reliance on ICMP, DF set on IPv4 probes, MAX_PROBES 3, black hole detection) sees real loss instead of kernel fragmentation. IP_RECVERR (Linux 2.2) queues ICMP errors to the socket error queue readable with MSG_ERRQUEUE, and `ee_info` carries "the discovered MTU for EMSGSIZE errors", which is the optional ICMP hint RFC 8899 allows.
- ECN: IP_RECVTOS (Linux 2.2) "the IP_TOS ancillary message is passed with incoming packets"; quinn-udp enables IP_RECVTOS and IP_PKTINFO and reads TOS and destination address per datagram. Sending ECN uses the IP_TOS value per packet (quinn-udp Transmit.ecn), which RFC 9002 7.1 requires for ECN-CE to count as congestion.
- io_uring: multishot recvmsg "available since kernel 6.0", "requires the IOSQE_BUFFER_SELECT flag", each CQE takes a buffer from a provided buffer ring, and the buffer is prefixed by `struct io_uring_recvmsg_out { namelen, controllen, payloadlen, flags }` with the sender address, then control messages (`io_uring_recvmsg_cmsg_firsthdr`, `_nexthdr`), then payload. Control messages are delivered, so a single multishot submission per socket yields GRO stride, ECN and destination address per completion, with no per-datagram syscall. Termination: a CQE without IORING_CQE_F_MORE means the request is done and must be re-armed. Zero-copy send (`io_uring_prep_sendmsg_zc`) posts two CQEs, the second with IORING_CQE_F_NOTIF meaning "the memory associated with the send is safe to get reused"; combined with UDP_SEGMENT this is one submission per burst of up to 64 datagrams.
- Steering by connection ID: BPF_PROG_TYPE_SK_REUSEPORT programs attach with SO_ATTACH_REUSEPORT_EBPF and see `sk_reuseport_md` with data, data_end, len, ip_protocol, hash, sk and migrating_sk; the kernel selftest `test_select_reuseport_kern.c` is `SEC("sk_reuseport")`, reads `reuse_md->data`, branches on `data_check.ip_protocol == IPPROTO_UDP`, and calls `bpf_sk_select_reuseport(reuse_md, reuseport_array, &index, flags)` against a BPF_MAP_TYPE_REUSEPORT_SOCKARRAY (SOCKMAP and SOCKHASH also accepted). A QUIC server therefore binds one UDP socket per core with SO_REUSEPORT, issues connection IDs whose leading bytes carry the core index, and installs a small eBPF program that reads the DCID from the short header and picks the socket; long header packets (new connections) hash by 4-tuple. The QUIC-LB draft (draft-ietf-quic-load-balancers-21, expired 2026-02-28) formalizes the same idea for external load balancers: first octet holds "Config Rotation (3), CID Len or Random Bits (5)", then a server ID (at least 1 octet, server ID plus nonce at most 19 octets), and Section 7.2 proposes that servers "reserve ... bytes of the server ID to encode the process ID" for in-host demultiplexing. msquic does exactly this in production: "the server encodes information into the 'Server ID', bytes 1 through 4 of the connection IDs it creates". Note: the docs.ebpf.io helper page summary claims the context lacks packet data, while the program-type page and the kernel selftest show `data` and `data_end` present; the selftest is treated as authoritative.
- Fallback without eBPF (containers with restrictive seccomp, kernels without SO_ATTACH_REUSEPORT_EBPF): kernel default 4-tuple hashing across the reuseport group, which breaks only on client migration or NAT rebinding; the endpoint that receives a foreign CID forwards the datagram to the owning core over the runtime's cross-core wake channel (msg_ring on io_uring, per research-runtime-io.md). That is a rare path, not the hot path.

### 3.2 Windows (learn.microsoft.com, quinn-udp windows.rs, msquic docs)
- USO and URO: UDP_SEND_MSG_SIZE "buffers sent by your application are broken down into multiple messages by the networking stack" and UDP_RECV_MAX_COALESCED_SIZE "multiple received datagrams may be coalesced into a single message buffer" with the segment size in the UDP_COALESCED_INFO control message; both require WSASendMsg/WSARecvMsg and are available from "Windows 10, version 2004 (10.0; Build 19041)" and "Windows Server, version 2004". quinn-udp reports 512 GSO segments on Windows 11 and 64 GRO segments, but GRO is "Disabled by default on Windows due to quinn issue #2041" (opened 2024-11-14: coalesced datagrams larger than the MTU delivered without a correct stride; not reproduced by the maintainers, unresolved in the fetched text).
- ECN: IP_RECVECN / IPV6_RECVECN deliver "the ECN bits of the TOS IPv4 header field" as an IP_ECN control message; on a dual-stack wildcard socket both levels must be set. quinn-udp treats ECN as best-effort because "Some environments (notably Wine/Proton) don't implement IP_RECVECN/IP_ECN".
- DF and MTU: IP_DONTFRAGMENT ("Microsoft TCP/IP providers respect this option for UDP"), IP_MTU_DISCOVER with IP_PMTUDISC_DO/PROBE for datagram sockets, IP_MTU on connected sockets, IP_USER_MTU cap. quinn-udp enables IP_DONTFRAGMENT and IPV6_DONTFRAG and reports may_fragment() false.
- Completion model: WSARecvMsg and WSASendMsg are overlapped calls on the same IOCP as TCP (research-runtime-io.md 1.4), so QUIC needs no second reactor on Windows. msquic additionally offers XDP kernel bypass and RSS; msquic's Schannel configuration has no 0-RTT, and its OpenSSL configuration does.
- Per-core steering on Windows: Windows has no SO_REUSEPORT group semantics with a user program; how msquic distributes one UDP port across RSS queues and processors was not fetched (unverified). Design consequence: on Windows, run one UDP socket per listener, consume completions on one core, and hand datagrams to the owning core by CID through PostQueuedCompletionStatus, or accept a single-core QUIC datapath on Windows for the first release.

### 3.3 macOS and iOS (quinn-udp unix.rs, Apple NWProtocolQUIC, research-runtime-io.md 1.6)
- No kernel GSO or GRO: quinn-udp's `max_gso_segments` returns 1 on every non-Linux Unix, and the Apple slow path uses BATCH_SIZE 1. The faster path uses the private `sendmsg_x` and `recvmsg_x` calls behind an `apple_fast` cfg and must verify their availability at runtime. IP_DONTFRAG is available. A macOS bug where non-blocking sendmsg returns EWOULDBLOCK near the SO_SNDBUF threshold forces `MIN_SAFE_SNDBUF = 65535 + cmsg::LEN`.
- Apple's own QUIC is NWProtocolQUIC in Network.framework, available since macOS 12.0, iOS 15.0, tvOS 15.0, watchOS 8.0, visionOS 1.0; the fetched page shows connection options and metadata only, and does not document server listeners or datagrams, so server-side use of Apple's stack is unverified. For zero-server, macOS is a development platform: kqueue readiness plus recvmsg with IP_RECVTOS, one datagram per call, is acceptable.

### 3.4 What the transport layer must expose, per datagram, on every platform
Receive: payload slices (possibly one GRO buffer with a stride), source address, destination address (pktinfo, needed for multi-homed hosts and for the preferred_address parameter), ECN codepoint. Send: a batch of datagrams to one destination with an optional segment size, ECN codepoint, source address, DF always on. This matches quinn-udp's Transmit (segment_size, ecn, src_ip, destination, contents) and RecvMeta (stride, ecn, dst_ip, addr, len) and is the datagram batch API research-runtime-io.md already asks the core socket trait to expose from day one.

## 4. Crate versus in-house

### 4.1 QUIC transport: adopt a crate; an in-house QUIC is a multi-year project
Evidence:
- Age and activity of the surveyed stacks (Section 2): quinn started 2018-04, quiche 2018-09, neqo 2019-02, msquic 2019-10, s2n-quic 2020-06; all five were pushed on 2026-09-29 or 2026-09-30 and carry 185 to 378 open issues. Cloudflare, Mozilla, Microsoft and AWS each fund a team for this, and none has declared the work done.
- Scope of the normative text an implementation must satisfy: RFC 9000 (transport, connection IDs, migration, path validation, flow control, stateless reset, version negotiation, anti-amplification), RFC 9001 (four key levels, header protection, key update, 0-RTT), RFC 9002 (loss detection with packet and time thresholds, PTO, NewReno or CUBIC, ECN validation, pacing), RFC 8899 (DPLPMTUD), RFC 9221 (datagrams), plus the ack-frequency and QUIC-LB drafts that msquic already ships. Each of these interacts with the others through timers and per-path state, which is why the implementations are large and why interop runners exist.
- The measured size of the smallest maintained pure-Rust transport (Section 4.2): quinn-proto is 27,528 lines of Rust in src/ alone, before the socket layer and the async API.
- Security exposure: a QUIC transport parses untrusted UDP from unauthenticated peers before any handshake completes, and Initial packets are decryptable by anyone (RFC 9001 5.2 derives Initial keys from the client DCID). Anti-amplification, retry tokens, stateless reset, and header protection are all attack surface. That is where an in-house implementation would spend its audit budget for years.

Decision: adopt quinn-proto as the transport state machine, driven by the core's own reactor (compio-driver Proactor or the custom io_uring backend), with quinn-udp as the socket layer on the readiness backends and the core's own io_uring/IOCP batch path where those are available. Reasons over the alternatives: it is sans-I/O ("performs no I/O internally", "suitable for use with custom event loops"), it is pure Rust with rustls (no cmake, no BoringSSL, no NSS), its crypto traits let the audited TLS choice plug in, it has DPLPMTUD, GSO/GRO, ECN, CUBIC and BBR, ack frequency, and datagrams, and compio-quic already runs it on io_uring and IOCP. quiche is the strongest production transport but drags BoringSSL through cmake and is BSD-2 with a C-shaped API; s2n-quic is tokio-bound and needs s2n-tls or MinGW on Windows; neqo needs NSS; msquic is C behind a beta binding whose default feature compiles the C tree with cmake and whose `find` mode does not support macOS.

What stays in-house around the crate: the reactor integration (datagram batches in, `poll_transmit` batches out, timer wheel), the connection ID allocator that encodes the core index, the eBPF steering program, the 0-RTT policy layer (Section 7.1), and the observability hooks (qlog feature available). If the owner later wants a transport of their own, quinn-proto's crypto and congestion traits give a bounded place to start (a custom congestion controller or a custom TLS session) without rewriting the transport.

### 4.2 Measurement: source size of the candidate crates (run in this task)
Downloaded from static.crates.io on 2026-09-30, extracted with tar, counted `*.rs` under `src/` with Get-Content | Measure-Object -Line:

| Crate | Version | Files | Lines |
| --- | --- | --- | --- |
| quinn-proto | 0.11.18 | 52 | 27,528 |
| quinn-udp | 0.6.2 | 9 | 2,798 |
| quinn (tokio API) | 0.11.12 | 12 | 5,167 |
| h3 (HTTP/3 + QPACK + tests) | 0.0.8 | 51 | 17,487 |
| h3-webtransport | 0.1.1 | 3 | 729 |

Reading: the transport is ten times the socket layer and five times the async wrapper; h3's count includes its unused dynamic QPACK table and in-tree tests, so the on-the-wire HTTP/3 surface is materially smaller than the transport.

### 4.3 HTTP/3 framing and QPACK: in-house, no_std, sans-I/O
Evidence that the scope is bounded:
- RFC 9114 frame grammar is `Type (i), Length (i), Frame Payload (..)` with seven frame types and no per-frame stream ID, priority, window update, ping or continuation; stream types are four unidirectional kinds plus request streams; SETTINGS is declarative, not negotiated; GOAWAY carries one identifier.
- RFC 9204 with SETTINGS_QPACK_MAX_TABLE_CAPACITY = 0 and SETTINGS_QPACK_BLOCKED_STREAMS = 0 (the RFC defaults) is a complete conformant encoder and decoder: 99 static entries, prefix integers, the RFC 7541 Huffman table that the HTTP/2 codec already needs, three literal forms, and no encoder or decoder instructions. hyperium/h3 ships exactly this on the wire today (stateless encode and decode, type byte only on the QPACK streams) and interoperates with browsers through the interop runner. Dynamic QPACK is an additive feature behind the same API.
- RFC 9297 capsules are `type (i), length (i), value`; RFC 9221 datagrams are a frame type plus a transport parameter; WebTransport draft-16 adds two stream signal values (0x54, 0x41), one setting, and extended CONNECT. All of it is varint-shaped and byte-oriented, which is what a no_std codec handles well.
- The sibling note research-http-and-ws.md already decided `zero-h3-codec` (no_std, sans-I/O, static QPACK first) and shares the varint, field validation, request and response types and limits with `zero-h2-codec`. This note confirms that decision and adds: put QPACK in its own module or crate (`zero-qpack`) so the HTTP/2 HPACK Huffman table and integer coder are one implementation with two table layouts (61 entries 1-based for HPACK, 99 entries 0-based for QPACK).

## 5. Transport abstraction: one request pipeline over TCP+TLS, HTTP/2 and QUIC

Principle: the pipeline consumes and produces protocol-neutral values; the three front ends translate bytes to those values. RFC 9114 4.1 and 4.3 make HTTP/3 requests the same shape as HTTP/2 (request stream, :method, :scheme, :authority, :path, :status, trailers), and RFC 9110 semantics give HTTP/1.1 the same logical fields once the parser splits the request line and folds Host into :authority.

Layers (crate names follow the sibling notes):
1. `zero-http-types` (no_std): `RequestHead { method, scheme, authority, path, fields }`, `ResponseHead { status, fields }`, `Trailers`, body chunk slices, error codes mapped from H2 and H3 error spaces to one enum, and an `Early` marker meaning the request arrived in 0-RTT.
2. Front-end codecs (no_std, sans-I/O, pure functions of bytes and a small state struct):
   - `zero-h1-codec`: bytes to RequestHead plus body framing (chunked, content-length); one logical stream per connection.
   - `zero-h2-codec`: frames to streams; HPACK; flow control; produces the same RequestHead per stream.
   - `zero-h3-codec`: HTTP/3 frames on a QUIC bidi stream; QPACK; control stream and settings; produces the same RequestHead per request stream. No flow control of its own (QUIC owns it), no priority tree.
3. Transport adapters (std, runtime-bound, thin):
   - TCP+TLS adapter: a socket plus rustls unbuffered state; exposes one `ByteStream`.
   - HTTP/2 adapter: one `ByteStream` in, N virtual streams out, using zero-h2-codec.
   - QUIC adapter (`zero-quic`): quinn-proto Endpoint per core; incoming datagram batches go to `Endpoint::handle`, `Connection::handle_event`, and `poll_transmit` produces batches for the socket; each bidi stream is exposed as a `ByteStream`; unidirectional streams are routed to the h3 codec's control and QPACK handlers.
4. The pipeline (`zero-router`, handlers, response writer) sees only `Stream<RequestHead, Body>` and writes `ResponseHead`, body chunks and trailers back into the same handle. It never learns whether the stream is a TCP connection, an HTTP/2 stream or a QUIC stream.

The transport-facing trait, in prose (Rust sketch for the design document):
- `trait StreamTransport { type Stream: ByteStream; fn poll_accept_stream(&mut self) -> Poll<Option<Self::Stream>>; fn drain(&mut self, reason); fn peer(&self) -> PeerInfo; }` where PeerInfo carries the remote address, ALPN, TLS details, and for QUIC the current path and a migration counter.
- `trait ByteStream { fn read(&mut self, buf: OwnedBuf) -> Completion; fn write(&mut self, buf: OwnedBuf) -> Completion; fn finish(&mut self); fn reset(&mut self, code); fn stop_sending(&mut self, code); }` with owned buffers across awaits, as research-runtime-io.md requires. Reset and stop_sending map to RST_STREAM on HTTP/2 and RESET_STREAM/STOP_SENDING on QUIC; on HTTP/1.1 they close the connection.
- Optional capability traits, discovered at runtime and denied by default: `Datagrams` (send and receive HTTP datagrams keyed by quarter stream ID, RFC 9297; on HTTP/2 and HTTP/1.1 this falls back to DATAGRAM capsules on the stream), `RawStreams` (open and accept QUIC uni/bidi streams bound to a session, for WebTransport), `EarlyData` (whether the stream's request arrived before handshake completion). Handlers ask for a capability; the router refuses the route on transports that lack it. This keeps WebTransport and WebSocket-over-HTTP/3 (RFC 9220, setting 0x08) out of the common path.
- Connection lifecycle: `drain` sends GOAWAY with the last accepted stream ID on both HTTP/2 and HTTP/3 (RFC 9114 5.2), and closes after in-flight streams finish; the same drain signal on HTTP/1.1 sets Connection: close.

Threading and placement: one quinn-proto Endpoint per core, one SO_REUSEPORT UDP socket per core on Linux, connection IDs of the form [core index byte(s) | random], eBPF steering (Section 3.1). Timers come from the per-core wheel; quinn-proto returns the next timeout from `poll_timeout`. Cross-core traffic is limited to misrouted datagrams after migration.

Bindings: the Node, Python and C# surfaces expose `listen({ http3: true, port: 443 })` and the same request object; HTTP/3-only capabilities surface as optional methods (`request.datagrams`, `request.webtransport`) that throw a typed "not available on this transport" error elsewhere.

## 6. Measurements published for HTTP/3 versus HTTP/2 and HTTP/1.1

No fetched source gives a TechEmpower-style requests-per-second comparison of an HTTP/3 server against HTTP/1.1 or HTTP/2 on the same hardware. TechEmpower's load generator is wrk (research-techempower.md); wrk's README mentions no HTTP/2 or HTTP/3 support, and TechEmpower has no HTTP/3 test, so HTTP/3 cannot move a TechEmpower number (that the suite is HTTP/1.1-only is stated in the sibling note; wrk's README does not name a version, so "HTTP/1.1 only" is unverified from the README text alone). msquic's public performance dashboard (microsoft.github.io/msquic) lists throughput, RPS, HPS and P90 latency for five configurations on dual Xeon Gold 6230 with a 50 Gbit ConnectX-4 but the HTML shell carried no numbers at fetch time. What is verified:

| Source | Setup | Result |
| --- | --- | --- |
| Fastly, Oku and Iyengar, 2020-04-30 | quicly + picotls + H2O, one core capped at 400 MHz, gigabit adapter | Raw TCP 708 Mbps; TLS 1.3 over TCP 466 Mbps; QUIC off the shelf 196 Mbps (42 percent of TLS/TCP); after reduced ACK frequency (1 per 10 packets) 240 Mbps; after GSO with 10-packet coalescing 348 Mbps; after 1460-byte packets 466 Mbps; final "464 Mbps (1% faster than TLS 1.3 over TCP)" and "425Mbps (only 8% slower than TLS 1.3 over TCP)" at Chrome's 1350-byte default. This is the cleanest same-hardware CPU comparison fetched: a tuned QUIC server matches TLS over TCP per core only with GSO and ack frequency; without them it does 42 percent. |
| Cloudflare, 2020-04-14 | quiche edge, WebPageTest and Browser Insights | TTFB 176 ms HTTP/3 versus 201 ms HTTP/2 (12.4 percent better); 15 KB page 443 ms versus 458 ms; 1 MB page 2.33 s versus 2.30 s; blog.cloudflare.com "HTTP/3 performance still trails HTTP/2 performance, by about 1-4% on average in North America"; attributed to "HTTP/2 on BBR v1 vs. HTTP/3 on CUBIC". Small transfers and lossy paths favor HTTP/3; bulk transfer does not. |
| Google, SIGCOMM 2017 (Langley et al.) | Chrome desktop and Android apps against Google servers | "QUIC reduces latency of Google Search responses by 8.0% for desktop users and by 3.6% for mobile users, and reduces rebuffer rates of YouTube playbacks by 18.0% for desktop users and 15.3% for mobile users"; over 30 percent of Google egress bytes and an estimated 7 percent of Internet traffic at the time. Desktop search gains come "primarily from reducing handshake latency"; mobile 0-RTT success was 20 percent lower than desktop because network switches invalidate the source-address token and change data centers. |
| Facebook, 2020-10-21 | mvfst + Proxygen, Facebook app | "more than 75 percent of our internet traffic uses QUIC and HTTP/3"; "6 percent reduction in request errors", "20 percent tail latency reduction", "5 percent reduction in response header size"; video MTBR "improved in aggregate by up to 22 percent", stalls reduced 20 percent, video request errors reduced 8 percent. They "plan to continue to utilize more of QUIC's existing features, such as connection migration and true 0-RTT connection establishment", so those gains came without either. |
| Zhang et al., WWW 2024, "QUIC is not Quick Enough over Fast Internet" | Chrome, Edge, Firefox, Opera and lightweight clients on high-bandwidth links | "data rate reduction of up to 45.2% compared to the TCP+TLS+HTTP/2 counterpart", up to 9.8 percent video bitrate reduction; root cause "high receiver-side processing overhead, in particular, excessive data packets and QUIC's user-space ACKs". This is a client-side receive result at gigabit rates. |
| Ian Duncan, 2026-02-10 | Unspecified local network, no loss, no meaningful latency | HTTP/3 "consistently and measurably slower" than HTTP/2; the post repeats the 45.2 percent paper figure and a 231K versus 15K `netif_receive_skb` call count for one download; setup details are absent, so treat the direction as anecdotal and the magnitude as unverified. |
| W3Techs, September 2026 | Site survey | "HTTP/3 is used by 40.8% of all the websites." |
| caniuse, WebTransport | Browser support | 91.3 percent global usage: Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+, Chrome for Android 154. |

Reading for a server: QUIC costs more CPU per byte than kernel TCP unless GSO/GRO, ack frequency and full-size packets are in place, at which point one core reaches parity on encrypted throughput (Fastly). HTTP/3's user-visible wins are on handshake latency and lossy or high-RTT paths (Google, Cloudflare TTFB, Facebook errors and tail latency), not on bulk throughput over clean links (Cloudflare 1 MB, WWW 2024). None of this changes a TechEmpower ranking, so HTTP/3 is a product feature and a tail-latency feature, not the lever for "faster than Drogon".

## 7. What 0-RTT, migration and head-of-line elimination buy

### 7.1 0-RTT
- Saves one round trip on resumed connections (RFC 9001 keys at the 0-RTT level); Google attributes most of the desktop search gain to handshake latency and 0-RTT.
- Cost: "0-RTT provides no protection against replay attacks" (RFC 9000) and "Application data that is received in 0-RTT could cause an application at the server to process the data multiple times" (RFC 9001 5.6/9.2). RFC 8470 gives the HTTP policy: clients "MUST NOT send unsafe methods" in early data; servers without explicit per-resource configuration "MUST either reject early data or implement the techniques described in this document for ensuring that requests are not processed prior to TLS handshake completion"; the options are rejecting at TLS, delaying until the handshake completes, or answering 425 (Too Early); intermediaries forward with `Early-Data: 1` and such requests "that cannot be safely processed MUST be rejected using the 425 (Too Early) status code".
- Facebook served 75 percent of its traffic over QUIC without 0-RTT because its clients reuse connections aggressively. Mobile 0-RTT success is lower (Google) because tokens are bound to the client address and data center.
- Plan: 0-RTT off by default (rustls max_early_data_size 0). When enabled per listener, the QUIC adapter marks streams `Early`, the router accepts only safe methods on routes flagged `early_data: true`, buffers everything else until the handshake completes (quinn-proto reports handshake completion; the delay option is free with an async pipeline), and never issues 425 unless an `Early-Data: 1` header arrives from an intermediary. Add the Early-Data forwarding rule to the proxy middleware.

### 7.2 Connection migration
- "Only clients are able to migrate"; "Servers MUST NOT initiate migration of a connection" (RFC 9000 9); servers may offer preferred_address (9.6). The server's duties are: keep a pool of unused CIDs per connection, validate new paths (PATH_CHALLENGE), rate-limit to the anti-amplification bound (three times bytes received) until validated, and route foreign-CID datagrams to the owning core (Section 3.1).
- Real value: NAT rebinding survival on UDP, where "most middleboxes on the internet have a much smaller timeout period for UDP (20 to 30 seconds) compared to TCP" (msquic Deployment.md, which recommends a keep-alive of about 20 seconds). Wi-Fi to cellular handoff is the headline case; Facebook shipped without using it. For a Node-hosted API server, migration mostly means "long-lived WebSocket-style streams do not die when a mobile client's NAT mapping changes".
- Plan: support passive migration and NAT rebinding from the start (quinn-proto does; the core must route by CID); no preferred_address in the first release; keep-alive default around 20 s on QUIC listeners, exposed as a setting.

### 7.3 Head-of-line elimination
- Transport fact: "QUIC does not provide any means of ordering between bytes on different streams" (RFC 9000 2); HTTP/2 over TCP suffers because "a lost or reordered packet causes all active transactions to experience a stall" (RFC 9114 1.1). QPACK exists so field compression does not reintroduce blocking (RFC 9204 1), and with the zero-capacity defaults there is no cross-stream compression state at all.
- Value scales with loss and concurrency: Cloudflare and Google see gains on small objects and lossy paths; on clean links with one large transfer there is nothing to unblock and CPU dominates (Cloudflare 1 MB, WWW 2024). Benchmarks with zero loss on loopback cannot show the benefit by construction.
- Plan: nothing to build beyond one-stream-per-request; the win is inherent once requests ride QUIC streams. Keep QPACK static-only so a lost encoder-stream packet can never stall header decoding.

## 8. Ship recommendation and Alt-Svc plan

### 8.1 When HTTP/3 ships
- First release: HTTP/3 behind a cargo feature (`http3`) that is on in the published binaries and behind a runtime setting that is off by default (`listen({ http3: false })`). Reasons: the transport is a third-party crate on a UDP surface that container defaults (Docker 25 seccomp blocks io_uring, per research-runtime-io.md) and firewalls treat differently from TCP; GRO on Windows is disabled in the socket crate over an open bug; 0-RTT policy and per-core steering need soak time; and no benchmark the owner competes in exercises it. The UDP listener, the QUIC adapter, the eBPF steering program and the h3 codec are built and interop-tested from day one so that turning it on is a configuration change, not a release.
- The codec crates (`zero-h3-codec`, `zero-qpack`) are first-class from the start because they are no_std, sans-I/O, fully vector-testable, and shared with HTTP/2 work; ship them in the first release with conformance vectors even while the listener default is off.
- Promote to default-on when: the interop runner passes for handshake, transfer, retry, resumption, ecn, keyupdate and http3 against Chrome, Firefox, quic-go and ngtcp2 clients (the runner's test list is unverified here since the JSON was not fetched; the sibling repos' READMEs cite it); the CPU-per-request measurement of the QUIC path with GSO, GRO and ack frequency sits within the Fastly-style parity band of TLS over TCP on Linux; and the per-core steering fallback has been exercised under NAT rebinding tests.

### 8.2 Alt-Svc and discovery plan
- When a QUIC listener is bound and serving the same certificate as the TCP listener (RFC 7838 2.1 requires the alternative be valid for the whole origin), every HTTP/1.1 and HTTP/2 response carries `Alt-Svc: h3=":<udp-port>"; ma=86400`. `ma` is one day, matching the RFC default freshness of 24 hours; do not set `persist=1` (it survives the client's network changes, which is wrong for servers that may not be reachable over UDP from every network). Use the header on HTTP/2 rather than the ALTSVC frame (type 0xa), which is optional and adds a frame type to the h2 codec for no gain.
- When the operator disables HTTP/3 after having advertised it, emit `Alt-Svc: clear` for at least one `ma` period so cached alternatives are invalidated (RFC 7838 3).
- Clients "can be used until the alternative connection is established" (RFC 7838 2.4), so the first request of every new client stays on TCP. For first-contact HTTP/3, document the DNS HTTPS record (RFC 9460): `example.com. HTTPS 1 . alpn="h3,h2"`, with `port` only if the UDP port differs from 443, and `ipv4hint`/`ipv6hint` optional. Clients honoring both mechanisms "ensure that their connection attempts are consistent with both the Alt-Svc parameters and any received HTTPS SvcParams" (9460 9.3). The server cannot publish DNS, so this is an operator checklist item in the docs and in the CLI's `doctor` output.
- Port and host constraints: advertise only a port on the same host (`h3=":443"`), never a different host, so the certificate requirement is met trivially. Behind Docker or Kubernetes, the UDP port must be mapped alongside the TCP port; the health check reports "HTTP/3 advertised but UDP unreachable" when a self-probe fails, and suppresses the header in that state.
- Browser policy details (whether a given browser races h3 against h2, how long it caches Alt-Svc, and whether it uses the HTTPS record for h3) were not fetched in this task and are unverified.

## 9. Sources fetched in this task
- RFC 9000 https://www.rfc-editor.org/rfc/rfc9000.html (plus section 14 re-fetch)
- RFC 9001 https://www.rfc-editor.org/rfc/rfc9001.html
- RFC 9002 https://www.rfc-editor.org/rfc/rfc9002.html
- RFC 9114 https://www.rfc-editor.org/rfc/rfc9114.html
- RFC 9204 https://www.rfc-editor.org/rfc/rfc9204.html
- RFC 9221 https://www.rfc-editor.org/rfc/rfc9221.html
- RFC 9297 https://www.rfc-editor.org/rfc/rfc9297.html
- RFC 8899 https://www.rfc-editor.org/rfc/rfc8899.html
- RFC 8470 https://www.rfc-editor.org/rfc/rfc8470.html
- RFC 7838 https://www.rfc-editor.org/rfc/rfc7838.html
- RFC 9460 https://www.rfc-editor.org/rfc/rfc9460.html
- draft-ietf-webtrans-http3 https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- draft-ietf-quic-load-balancers-21 https://www.ietf.org/archive/id/draft-ietf-quic-load-balancers-21.html and datatracker page
- draft-ietf-quic-ack-frequency https://datatracker.ietf.org/doc/draft-ietf-quic-ack-frequency/
- quinn repo and API https://github.com/quinn-rs/quinn, https://api.github.com/repos/quinn-rs/quinn, quinn-udp lib.rs, unix.rs, windows.rs (raw.githubusercontent.com), issue 2041
- quinn-proto docs https://docs.rs/quinn-proto/latest/quinn_proto/ (crate root, congestion, crypto, TransportConfig, MtuDiscoveryConfig, features page)
- quinn-udp docs https://docs.rs/quinn-udp/latest/quinn_udp/
- s2n-quic https://github.com/aws/s2n-quic, api.github.com, docs.rs provider, io, io::tokio::Builder, congestion_controller, s2n-quic-xdp
- quiche https://github.com/cloudflare/quiche, api.github.com, docs.rs CongestionControlAlgorithm, h3 module
- neqo https://github.com/mozilla/neqo, api.github.com, neqo-transport/src tree
- msquic https://github.com/microsoft/msquic, api.github.com, docs/Platforms.md, docs/Deployment.md, Cargo.toml, https://docs.rs/msquic/latest/msquic/ and features page, https://microsoft.github.io/msquic/
- h3 https://github.com/hyperium/h3, https://docs.rs/h3/latest/h3/, h3/src/qpack tree, qpack/mod.rs, connection.rs, config.rs
- compio-quic https://docs.rs/compio-quic/latest/compio_quic/
- rustls https://docs.rs/rustls/latest/rustls/quic/index.html, server ServerConfig
- Linux: man7 udp(7), IP_MTU_DISCOVER(2const), IP_TOS(2const), IP_RECVTOS(2const), IP_RECVERR(2const), io_uring_prep_recvmsg_multishot(3), io_uring_recvmsg_out(3), io_uring_prep_sendmsg_zc(3); kernel selftest tools/testing/selftests/bpf/progs/test_select_reuseport_kern.c; docs.ebpf.io helper and program-type pages
- Windows: learn.microsoft.com IPPROTO_UDP socket options, IPPROTO_IP socket options, WSASetUdpSendMessageSize, WSASetUdpRecvMaxCoalescedSize
- Apple: developer.apple.com NWProtocolQUIC (JSON endpoint)
- Measurements: Fastly https://www.fastly.com/blog/measuring-quic-vs-tcp-computational-efficiency; Cloudflare https://blog.cloudflare.com/http-3-vs-http-2/; Google https://research.google/pubs/the-quic-transport-protocol-design-and-internet-scale-deployment/ and the PDF at static.googleusercontent.com (text extracted locally with pypdf); Facebook https://engineering.fb.com/2020/10/21/networking-traffic/how-facebook-is-bringing-quic-to-billions/; arXiv https://arxiv.org/abs/2310.09423; https://www.iankduncan.com/engineering/2026-02-10-http3-not-always-faster/; https://w3techs.com/technologies/details/ce-http3; https://caniuse.com/webtransport; https://developer.chrome.com/blog/removing-push; https://github.com/wg/wrk README
- Not retrievable: interop.seemann.io result JSON (404), dl.acm.org (403), radar.cloudflare.com (403), msquic src/rs/README.md (404), docs.rs neqo-transport (404)

## 10. Unverified items carried forward
- TechEmpower/wrk being strictly HTTP/1.1 (wrk README names no version).
- How msquic distributes a UDP port across processors on Windows (RSS with multiple sockets or a single socket).
- Browser Alt-Svc caching and racing behavior, and browser use of HTTPS records for h3.
- Apple Network.framework server-side QUIC listeners and datagram support.
- The QUIC interop runner's current pass matrix for quinn, s2n-quic, quiche, neqo, msquic and h3.
- Ian Duncan's local-network magnitude claim (setup not stated).
- Whether quinn-proto's default congestion controller is Cubic (the module page lists Cubic, NewReno and experimental Bbr without naming the default).
