/*
 * The C ABI of zero-server: a curated `extern "C"` surface over its host boundary.
 *
 * C and C++ link this library directly, and .NET (P/Invoke) and Python (`ctypes`) load
 * it as a shared library. It is a thin layer over `zero-host`, which holds the
 * applications, the servers, the dispatch of requests to a host and the rules of slot
 * access: every function checks its arguments, calls zero-host, and writes its outputs.
 * It is the one audited `unsafe` boundary on the language side; every pointer a host
 * passes is read or written here and nowhere else. The header `include/zero.h` is
 * generated from this crate by cbindgen and opens with this text.
 *
 * A host builds an app (`zero_app_new`, routes and policies from JSON option
 * documents), builds a server from it (`zero_server_new`), attaches a pull target to its
 * worker indexes (`zero_target_attach`), starts it, and polls batches of leased requests
 * on its own thread (`zero_target_poll`). It reads each request by slot id, writes the
 * response, and hands the answered ids back with `zero_batch_complete`, acknowledging
 * each batch by its epoch from the polling thread.
 *
 * # Rules
 *
 * 1. Ids. Servers, apps, targets, slots and connections are `uint64_t` ids of at most
 *    53 bits, exact as JavaScript numbers. A stale or unknown id returns
 *    `ZeroStatus_Closed`, and an id above `ZERO_ID_MAX` returns
 *    `ZeroStatus_InvalidArgument`. `ZERO_NONE` means "no id" where an argument allows
 *    one to be absent.
 * 2. Input ranges. A byte range `(const uint8_t *ptr, uintptr_t len)` is borrowed for
 *    the call only and must not change during it. A zero `len` accepts any `ptr`, NULL
 *    included; NULL with a nonzero `len`, or a `len` above `PTRDIFF_MAX`, returns
 *    `InvalidArgument`. The library copies whatever it keeps. In `zero_sse_send` alone, a
 *    NULL `event` or `id` with a zero length means the field is absent, and a non-NULL
 *    pointer with a zero length is a present empty value.
 * 3. Outputs. An output pointer must be non-null and aligned for its type, otherwise the
 *    call returns `InvalidArgument` and does nothing. Outputs are written only on
 *    `ZeroStatus_Ok`, except the per-slot `results_out` of `zero_batch_complete` and the
 *    `count_out` of `zero_server_workers`, which reports the full count with
 *    `ZeroStatus_Limit` when `cap` is too small.
 * 4. Sized structs. Every struct passed alone by pointer starts with `uint32_t size`. For
 *    an input the host sets `size` to the size of the struct; the library reads the
 *    smaller of `size` and its own size and zero-fills the rest. For an output the host
 *    sets `size` before the call; the library writes the smaller of the two and stores
 *    the number of octets written in `size`. A `size` below the version 1 size returns
 *    `InvalidArgument`. An array of structs carries its element size beside the pointer
 *    instead (`field_size` of `ZeroResponseSpec` and of `ZeroRequestView`, `event_size`
 *    of `zero_target_poll`), read and written by the same rule per element. Fields are
 *    appended, never reordered, so an older host keeps working.
 * 5. Views. A view (`ZeroBytes`, `ZeroRequestView` and the pointers inside it) points
 *    into a slot and is read-only. A call that returns one succeeds only on a thread
 *    that holds a pin on the slot (`zero_slot_pin`), or on the slot's target thread
 *    before it acknowledged the batch that delivered the slot; any other thread gets
 *    `InvalidArgument`. A view stays valid until the later of that thread's unpin and
 *    its acknowledgment of the delivering batch. A thread holds at most 64 pins
 *    (`ZeroStatus_Limit` beyond). `{NULL, 0}` means absent; a present empty value has a
 *    non-null pointer.
 * 6. Body regions. `zero_res_body_alloc` returns a writable, zero-filled region inside
 *    the slot's response. It requires the calling thread's pin and is valid while that
 *    pin is held and until the response is sealed. While a region is open, every other
 *    body call and `zero_res_reset` on that slot return `InvalidArgument`.
 * 7. Owned handles. The library frees what it allocated: a `ZeroString *` or
 *    `ZeroBuffer *` is released only by `zero_string_free` or `zero_buffer_free`, exactly
 *    once, and NULL is a no-op. They are owned pointers, not checked ids, so the six
 *    functions over them take NULL as no handle, and using one after its free is a host
 *    error, as with `free(3)`. Every function that takes an id returns a status for a
 *    stale one. The library never frees host memory and never calls a host function
 *    pointer.
 * 8. Closed sets. Every value from a closed set (a method, a kind, an opcode, a mode, a
 *    policy, a close code) is passed as an integer and checked against its set; the
 *    library never reads an enum from the host. `ZeroStatus` is only ever returned.
 * 9. Panics. Every function runs under `catch_unwind`. A function that returns a status
 *    returns `ZeroStatus_Panic` instead of unwinding; the functions that return a value
 *    (`zero_version`, `zero_abi_version`, `zero_last_error_message`, and the accessors
 *    and frees of strings and buffers) return NULL or 0.
 * 10. Threads. Every function may be called from any thread, except: `zero_target_poll`
 *     binds its target to the first thread that calls it, and another thread gets
 *     `InvalidArgument`; a nonzero `epoch` in `zero_batch_complete` is accepted only from
 *     that bound thread; `zero_target_poll` and `zero_server_wait` return
 *     `InvalidArgument` on an I/O worker thread instead of deadlocking, and
 *     `zero_server_wait` also on a thread bound to one of that server's targets, whose
 *     acknowledgments the drain needs.
 * 11. Event views. The event payloads `zero_target_poll` writes live in the target's
 *     delivery storage and stay valid until the next `zero_target_poll` on that target
 *     or `zero_target_detach`.
 * 12. Errors. A refused call records a thread-local message naming the argument or the
 *     refusal; `zero_last_error_message` returns it as a new owned string, or NULL when
 *     the thread has none. Success leaves it unchanged. The message is kept in a fixed
 *     buffer of 256 octets per thread, cut at a UTF-8 boundary, so recording a refusal
 *     allocates nothing and takes no lock.
 */

#pragma once

/* Generated by cbindgen from crates/zero-ffi. Do not edit by hand; run `cargo build -p zero-ffi` to regenerate. */

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

// The version of the C ABI, which `zero_abi_version` returns.
#define ZERO_ABI_VERSION 1

// The version of the plugin ABI, which a plugin's `ZeroPluginAbiVersionFn` returns.
#define ZERO_PLUGIN_ABI_VERSION 1

// The largest id, 2^53 - 1, so every id is exact as a JavaScript number. An id above it is
// refused with `ZeroStatus_InvalidArgument`.
#define ZERO_ID_MAX 9007199254740991ull

// No id, where an argument allows the id to be absent.
#define ZERO_NONE UINT64_MAX

// The epoch of a completion that acknowledges no batch.
#define ZERO_EPOCH_NONE 0

// The worker index of a target that serves every worker of a server from one queue.
#define ZERO_ALL_WORKERS UINT32_MAX

// The most entries one batch carries; the capacity `zero_target_poll` takes is at least this.
#define ZERO_MAX_BATCH 256

// The most parameters one route captures.
#define ZERO_MAX_PARAMS 16

// The id of a field name outside the interned table.
#define ZERO_HEADER_NONE UINT32_MAX

// The number of interned field names; the `ZERO_HEADER_*` ids of the names run from 0 below
// it.
#define ZERO_HEADER_COUNT 49

// `Accept` (RFC 9110 Section 12.5.1).
#define ZERO_HEADER_ACCEPT 0

// `Accept-Charset` (RFC 9110 Section 12.5.2, deprecated).
#define ZERO_HEADER_ACCEPT_CHARSET 1

// `Accept-Encoding` (RFC 9110 Section 12.5.3).
#define ZERO_HEADER_ACCEPT_ENCODING 2

// `Accept-Language` (RFC 9110 Section 12.5.4).
#define ZERO_HEADER_ACCEPT_LANGUAGE 3

// `Accept-Ranges` (RFC 9110 Section 14.3).
#define ZERO_HEADER_ACCEPT_RANGES 4

// `Age` (RFC 9111 Section 5.1).
#define ZERO_HEADER_AGE 5

// `Allow` (RFC 9110 Section 10.2.1).
#define ZERO_HEADER_ALLOW 6

// `Authentication-Info` (RFC 9110 Section 11.6.3).
#define ZERO_HEADER_AUTHENTICATION_INFO 7

// `Authorization` (RFC 9110 Section 11.6.2).
#define ZERO_HEADER_AUTHORIZATION 8

// `Cache-Control` (RFC 9111 Section 5.2).
#define ZERO_HEADER_CACHE_CONTROL 9

// `Connection` (RFC 9110 Section 7.6.1).
#define ZERO_HEADER_CONNECTION 10

// `Content-Encoding` (RFC 9110 Section 8.4).
#define ZERO_HEADER_CONTENT_ENCODING 11

// `Content-Language` (RFC 9110 Section 8.5).
#define ZERO_HEADER_CONTENT_LANGUAGE 12

// `Content-Length` (RFC 9110 Section 8.6).
#define ZERO_HEADER_CONTENT_LENGTH 13

// `Content-Location` (RFC 9110 Section 8.7).
#define ZERO_HEADER_CONTENT_LOCATION 14

// `Content-Range` (RFC 9110 Section 14.4).
#define ZERO_HEADER_CONTENT_RANGE 15

// `Content-Type` (RFC 9110 Section 8.3).
#define ZERO_HEADER_CONTENT_TYPE 16

// `Date` (RFC 9110 Section 6.6.1).
#define ZERO_HEADER_DATE 17

// `ETag` (RFC 9110 Section 8.8.3).
#define ZERO_HEADER_ETAG 18

// `Expect` (RFC 9110 Section 10.1.1).
#define ZERO_HEADER_EXPECT 19

// `Expires` (RFC 9111 Section 5.3).
#define ZERO_HEADER_EXPIRES 20

// `From` (RFC 9110 Section 10.1.2).
#define ZERO_HEADER_FROM 21

// `Host` (RFC 9110 Section 7.2).
#define ZERO_HEADER_HOST 22

// `If-Match` (RFC 9110 Section 13.1.1).
#define ZERO_HEADER_IF_MATCH 23

// `If-Modified-Since` (RFC 9110 Section 13.1.3).
#define ZERO_HEADER_IF_MODIFIED_SINCE 24

// `If-None-Match` (RFC 9110 Section 13.1.2).
#define ZERO_HEADER_IF_NONE_MATCH 25

// `If-Range` (RFC 9110 Section 13.1.5).
#define ZERO_HEADER_IF_RANGE 26

// `If-Unmodified-Since` (RFC 9110 Section 13.1.4).
#define ZERO_HEADER_IF_UNMODIFIED_SINCE 27

// `Last-Modified` (RFC 9110 Section 8.8.2).
#define ZERO_HEADER_LAST_MODIFIED 28

// `Location` (RFC 9110 Section 10.2.2).
#define ZERO_HEADER_LOCATION 29

// `Max-Forwards` (RFC 9110 Section 7.6.2).
#define ZERO_HEADER_MAX_FORWARDS 30

// `MIME-Version` (RFC 9112 Section B.1).
#define ZERO_HEADER_MIME_VERSION 31

// `Pragma` (RFC 9111 Section 5.4).
#define ZERO_HEADER_PRAGMA 32

// `Proxy-Authenticate` (RFC 9110 Section 11.7.1).
#define ZERO_HEADER_PROXY_AUTHENTICATE 33

// `Proxy-Authentication-Info` (RFC 9110 Section 11.7.3).
#define ZERO_HEADER_PROXY_AUTHENTICATION_INFO 34

// `Proxy-Authorization` (RFC 9110 Section 11.7.2).
#define ZERO_HEADER_PROXY_AUTHORIZATION 35

// `Range` (RFC 9110 Section 14.2).
#define ZERO_HEADER_RANGE 36

// `Referer` (RFC 9110 Section 10.1.3).
#define ZERO_HEADER_REFERER 37

// `Retry-After` (RFC 9110 Section 10.2.3).
#define ZERO_HEADER_RETRY_AFTER 38

// `Server` (RFC 9110 Section 10.2.4).
#define ZERO_HEADER_SERVER 39

// `TE` (RFC 9110 Section 10.1.4).
#define ZERO_HEADER_TE 40

// `Trailer` (RFC 9110 Section 6.6.2).
#define ZERO_HEADER_TRAILER 41

// `Transfer-Encoding` (RFC 9112 Section 6.1).
#define ZERO_HEADER_TRANSFER_ENCODING 42

// `Upgrade` (RFC 9110 Section 7.8).
#define ZERO_HEADER_UPGRADE 43

// `User-Agent` (RFC 9110 Section 10.1.5).
#define ZERO_HEADER_USER_AGENT 44

// `Vary` (RFC 9110 Section 12.5.5).
#define ZERO_HEADER_VARY 45

// `Via` (RFC 9110 Section 7.6.3).
#define ZERO_HEADER_VIA 46

// `Warning` (RFC 9111 Section 5.5).
#define ZERO_HEADER_WARNING 47

// `WWW-Authenticate` (RFC 9110 Section 11.6.1).
#define ZERO_HEADER_WWW_AUTHENTICATE 48

// The `GET` method. Transfer a current representation of the target resource.
#define ZERO_METHOD_GET 0

// The `HEAD` method. Same as GET, but do not transfer the response content.
#define ZERO_METHOD_HEAD 1

// The `POST` method. Perform resource-specific processing on the request content.
#define ZERO_METHOD_POST 2

// The `PUT` method. Replace all current representations of the target resource with the
// request content.
#define ZERO_METHOD_PUT 3

// The `DELETE` method. Remove all current representations of the target resource.
#define ZERO_METHOD_DELETE 4

// The `CONNECT` method. Establish a tunnel to the server identified by the target resource.
#define ZERO_METHOD_CONNECT 5

// The `OPTIONS` method. Describe the communication options for the target resource.
#define ZERO_METHOD_OPTIONS 6

// The `TRACE` method. Perform a message loop-back test along the path to the target resource.
#define ZERO_METHOD_TRACE 7

// The `PATCH` method. Apply a set of changes described in the request content to the target
// resource (RFC 5789 Section 2).
//
// @see <https://www.rfc-editor.org/rfc/rfc5789.html#section-2>
#define ZERO_METHOD_PATCH 8

// Registers a route for every method; never the method of a request.
#define ZERO_METHOD_ANY 254

// The method of a request whose token is outside the method table; `zero_req_method_token`
// reads the token.
#define ZERO_METHOD_OTHER 255

// `zero_res_header` mode: replace every field line of the name.
#define ZERO_HEADER_SET 0

// `zero_res_header` mode: add one more field line, so each `Set-Cookie` is its own line.
#define ZERO_HEADER_APPEND 1

// `ZeroBatch.kind`: the batch carries leased request slots.
#define ZERO_BATCH_REQUESTS 1

// `ZeroBatch.kind`: the batch carries WebSocket and server-sent events.
#define ZERO_BATCH_EVENTS 2

// `ZeroEvent.kind`: a WebSocket connection opened.
#define ZERO_EVENT_WS_OPEN 1

// `ZeroEvent.kind`: a WebSocket message arrived; `opcode` says text or binary.
#define ZERO_EVENT_WS_MESSAGE 2

// `ZeroEvent.kind`: a WebSocket Pong frame arrived.
#define ZERO_EVENT_WS_PONG 3

// `ZeroEvent.kind`: a WebSocket connection closed; `close_code` and `data` hold the code and
// the reason.
#define ZERO_EVENT_WS_CLOSE 4

// `ZeroEvent.kind`: a WebSocket connection's outbox drained below its high-water mark.
#define ZERO_EVENT_WS_DRAINED 5

// `ZeroEvent.kind`: a server-sent events stream closed.
#define ZERO_EVENT_SSE_CLOSED 6

// `ZeroEvent.kind`: a server-sent events stream's outbox drained below its high-water mark.
#define ZERO_EVENT_SSE_DRAINED 7

// A text message: WebSocket opcode %x1.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>
#define ZERO_OPCODE_TEXT 1

// A binary message: WebSocket opcode %x2.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.2>
#define ZERO_OPCODE_BINARY 2

// `ZeroRequestView.flags`: the request arrived over TLS.
#define ZERO_VIEW_SECURE 1

// `ZeroRequestView.flags`: the request asks for a protocol upgrade.
#define ZERO_VIEW_UPGRADE 2

// `ZeroRequestView.flags`: the connection stays open after the response.
#define ZERO_VIEW_KEEP_ALIVE 4

// `ZeroRequestView.flags`: the request carries `Expect: 100-continue`.
#define ZERO_VIEW_EXPECT_CONTINUE 8

// `ZeroRequestView.flags`: a HEAD request matched a GET route.
#define ZERO_VIEW_HEAD_AS_GET 16

// `ZeroRequestView.flags`: the target has a query, possibly empty.
#define ZERO_VIEW_QUERY 32

// `zero_app_route` kind: a route the host answers.
#define ZERO_ROUTE_HOST 0

// `zero_app_route` kind: files served from a directory.
#define ZERO_ROUTE_STATIC 1

// `zero_app_route` kind: a redirect the core answers.
#define ZERO_ROUTE_REDIRECT 2

// `zero_app_route` kind: a fixed response the core answers.
#define ZERO_ROUTE_FIXED 3

// `zero_app_route` kind: a WebSocket endpoint.
#define ZERO_ROUTE_WEBSOCKET 4

// `zero_app_route` kind: a health check the core answers.
#define ZERO_ROUTE_HEALTH 5

// `zero_app_policy` kind: cross-origin resource sharing.
#define ZERO_POLICY_CORS 0

// `zero_app_policy` kind: security fields added to every response.
#define ZERO_POLICY_SECURITY_HEADERS 1

// `zero_app_policy` kind: an id for every request.
#define ZERO_POLICY_REQUEST_ID 2

// `zero_app_policy` kind: the proxies whose forwarding fields are trusted.
#define ZERO_POLICY_TRUST_PROXY 3

// `zero_app_policy` kind: the largest request body.
#define ZERO_POLICY_BODY_LIMIT 4

// What a call ended with. The library only ever returns a status, and never reads
// one from the host.
typedef enum {
  // The call succeeded.
  ZeroStatus_Ok = 0,
  // A protocol rule refused the input.
  ZeroStatus_Protocol = 1,
  // The operating system refused: a bind failure, TLS material that cannot be read.
  ZeroStatus_Io = 2,
  // An option document is malformed; the last error names the key or the position.
  ZeroStatus_Codec = 3,
  // The id is stale or unknown, the slot is not in a state the call accepts, the
  // response is sealed, the connection is gone, the target is detached or the server
  // is stopped.
  ZeroStatus_Closed = 4,
  // An authentication rule refused the input.
  ZeroStatus_Auth = 5,
  // The capability is compiled out, the call needs a feature that has not shipped, or
  // the conformance section is unknown.
  ZeroStatus_Unsupported = 6,
  // A poll or a wait timed out, or a poll was woken.
  ZeroStatus_Timeout = 7,
  // A bound is reached: the pins of a thread, the readers of a slot, the response
  // limit, an outbox limit, the free worker indexes, a target already attached, a
  // server still running at its free, or an array too short for its count.
  ZeroStatus_Limit = 8,
  // An argument is out of its range or its set, a pointer is NULL or misaligned, a
  // size is below its version 1 size, or the call is made from a thread that may not
  // make it.
  ZeroStatus_InvalidArgument = 9,
  // A panic was caught inside the export, or a panic poisoned the state the call
  // needs.
  ZeroStatus_Panic = 10,
} ZeroStatus;

// Owned bytes the library allocated. Released only by `zero_buffer_free`.
typedef struct ZeroBuffer ZeroBuffer;

// An owned UTF-8 string the library allocated, terminated by NUL. Released only by
// `zero_string_free`.
typedef struct ZeroString ZeroString;

// A read-only byte range: a view into a slot, or a range of static text. `{NULL, 0}`
// means absent, and a present empty value has a non-null pointer.
typedef struct {
  // The first byte, or NULL when absent.
  const uint8_t *ptr;
  // The number of bytes.
  uintptr_t len;
} ZeroBytes;

// A byte range of the request head as offset and length.
typedef struct {
  // The offset of the first byte from the start of the head.
  uint32_t start;
  // The number of bytes.
  uint32_t len;
} ZeroSpan;

// One field line of the request head, as spans into the head.
typedef struct {
  // The field name as received.
  ZeroSpan name;
  // The field value without its surrounding whitespace.
  ZeroSpan value;
  // The interned name's id, a `ZERO_HEADER_*` value, or `ZERO_HEADER_NONE`.
  uint32_t id;
} ZeroField;

// The request of a leased slot in one read: values, and views into the slot that the
// view rule governs.
typedef struct {
  // The size of this struct as the host built it; the library stores the octets it
  // wrote.
  uint32_t size;
  // The method: a `ZERO_METHOD_*` value, or `ZERO_METHOD_OTHER` for a token outside
  // the method table.
  uint8_t method;
  // The protocol version: 10 for HTTP/1.0, 11 for HTTP/1.1.
  uint8_t version;
  // The `ZERO_VIEW_*` flags.
  uint16_t flags;
  // The route id the request matched.
  uint32_t route;
  // The status the core would have answered, for a request on the miss route; 0 for
  // a matched route.
  uint16_t miss_status;
  // The methods the path allows, bit `i` for method id `i`, for the miss route.
  uint16_t allow;
  // The head as received; every span indexes it.
  const uint8_t *head;
  // The length of the head in octets.
  uint32_t head_len;
  // The number of entries of `fields`.
  uint32_t field_count;
  // The method token.
  ZeroSpan method_token;
  // The request target.
  ZeroSpan target;
  // The path of the target, without the query.
  ZeroSpan path;
  // The query without its `?`; meaningful when `ZERO_VIEW_QUERY` is set.
  ZeroSpan query;
  // The authority; `{0, 0}` when the request has none.
  ZeroSpan authority;
  // The field table, `field_count` entries `field_size` octets apart.
  const ZeroField *fields;
  // The normalized path the route matched.
  const uint8_t *route_path;
  // The length of the route path in octets.
  uint32_t route_path_len;
  // The number of route parameters.
  uint32_t param_count;
  // The buffered body.
  const uint8_t *body;
  // The length of the body in octets.
  uint64_t body_len;
  // The size of one `ZeroField` as the library wrote the table: the stride of
  // `fields`.
  uint32_t field_size;
  // Zero.
  uint32_t reserved;
} ZeroRequestView;

// The addresses of a request's connection.
typedef struct {
  // The size of this struct as the host built it; the library stores the octets it
  // wrote.
  uint32_t size;
  // The peer's address family: 4, 6, or 0 when the address is unknown.
  uint8_t family;
  // 1 when the connection is secure, 0 otherwise.
  uint8_t secure;
  // The transport: 1 for TCP, 2 for TLS over TCP.
  uint8_t transport;
  // The negotiated application protocol; 0 at this version.
  uint8_t alpn;
  // The peer's port.
  uint16_t port;
  // The client's port after the trust-proxy rule.
  uint16_t client_port;
  // The client's address family after the trust-proxy rule: 4, 6 or 0.
  uint8_t client_family;
  // Zero.
  uint8_t reserved[7];
  // The peer's address: four octets then zeros for IPv4, sixteen for IPv6.
  uint8_t address[16];
  // The client's address after the trust-proxy rule, laid out as `address`; the peer
  // without a rule.
  uint8_t client_address[16];
} ZeroPeer;

// One field line a host writes: a name and a value.
typedef struct {
  // The field name, a token.
  ZeroBytes name;
  // The field value.
  ZeroBytes value;
} ZeroHeaderPair;

// A whole response in one call: the status, field lines and the body.
typedef struct {
  // The size of this struct as the host built it.
  uint32_t size;
  // The status, 200 to 599, or 0 to keep the one set before (200 by default).
  uint16_t status;
  // Zero.
  uint16_t reserved;
  // The size of one `ZeroHeaderPair` as the host built the array: its stride.
  uint32_t field_size;
  // Zero.
  uint32_t reserved2;
  // The field lines, appended in order; `Set-Cookie` may repeat.
  const ZeroHeaderPair *fields;
  // The number of field lines.
  uintptr_t field_count;
  // The body; copied, and it replaces any body written before.
  ZeroBytes body;
} ZeroResponseSpec;

// A server's statistics, summed over its worker indexes. The counts start at zero for
// each server; `pinned`, `quarantined_peak`, `in_flight`, `leased` and `retained` are
// current values.
typedef struct {
  // The size of this struct as the host built it; the library stores the octets it
  // wrote.
  uint32_t size;
  // Zero.
  uint32_t reserved;
  // Requests posted to a target in batches it took.
  uint64_t dispatched;
  // Batches the targets took.
  uint64_t batches;
  // Batches acknowledged.
  uint64_t acks;
  // Slots that waited for a lock or a pin before the worker took them back.
  uint64_t late_readers;
  // Posts a target answered full.
  uint64_t queue_full;
  // Host requests answered 503 before a slot was claimed.
  uint64_t refused_503;
  // Leases closed because their target was lost.
  uint64_t closed_leases;
  // Panics of the host dispatch.
  uint64_t panics;
  // Pins host threads hold now.
  uint64_t pinned;
  // The longest a quarantine of retired slots has been.
  uint64_t quarantined_peak;
  // Batches posted and not acknowledged.
  uint64_t in_flight;
  // Slots leased to a host whose lease has not ended.
  uint64_t leased;
  // Acknowledgments refused while their completions were applied.
  uint64_t refused_acks;
  // Batches a target gave up on.
  uint64_t abandoned_batches;
  // Octets of exchanges held outside the connection records.
  uint64_t retained;
} ZeroStats;

// One batch a target took.
typedef struct {
  // The size of this struct as the host built it; the library stores the octets it
  // wrote.
  uint32_t size;
  // The worker index whose slots or connections the batch names.
  uint8_t worker;
  // `ZERO_BATCH_REQUESTS` or `ZERO_BATCH_EVENTS`.
  uint8_t kind;
  // Zero at this version.
  uint16_t flags;
  // How many requests or events the batch carries.
  uint32_t count;
  // Zero.
  uint32_t reserved;
  // The epoch `zero_batch_complete` acknowledges the batch with.
  uint64_t epoch;
} ZeroBatch;

// One WebSocket or server-sent event occurrence of an event batch.
typedef struct {
  // The connection id.
  uint64_t conn;
  // The route the connection was accepted on.
  uint32_t route;
  // A `ZERO_EVENT_*` value.
  uint8_t kind;
  // The message opcode, `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`, for a message.
  uint8_t opcode;
  // The close code, for a WebSocket close.
  uint16_t close_code;
  // The message, the pong's data or the close reason, in the target's delivery
  // storage; absent for the other kinds.
  ZeroBytes data;
} ZeroEvent;

// What a plugin hands the core.
typedef struct {
  // `ZERO_PLUGIN_ABI_VERSION`.
  uint32_t abi_version;
  // The size of this struct as the plugin built it.
  uint32_t size;
  // The plugin's own state, opaque to the core.
  void *ctx;
  // Answers a request on a route the plugin serves, returning a `ZeroStatus` value.
  int32_t (*handle)(void *ctx, uint32_t route, uint64_t slot);
  // Releases the plugin's state.
  void (*unload)(void *ctx);
} ZeroPluginVTable;

// What the core hands a plugin: the calls a plugin's handler reads and answers a
// request with, which are the exports of the same names.
typedef struct {
  // `ZERO_PLUGIN_ABI_VERSION`.
  uint32_t abi_version;
  // The size of this struct as the core built it.
  uint32_t size;
  // `zero_req_view`.
  ZeroStatus (*req_view)(uint64_t slot, ZeroRequestView *out);
  // `zero_req_header`.
  ZeroStatus (*req_header)(uint64_t slot,
                           const uint8_t *name,
                           uintptr_t len,
                           uint32_t nth,
                           ZeroBytes *out);
  // `zero_req_body`.
  ZeroStatus (*req_body)(uint64_t slot, ZeroBytes *out);
  // `zero_res_respond`.
  ZeroStatus (*res_respond)(uint64_t slot, const ZeroResponseSpec *spec);
  // `zero_res_body_alloc`.
  ZeroStatus (*res_body_alloc)(uint64_t slot, uintptr_t len, uint8_t **region);
  // `zero_res_send`.
  ZeroStatus (*res_send)(uint64_t slot);
} ZeroHostApi;

// A plugin's first export: the plugin ABI version it was built against.
typedef uint32_t (*ZeroPluginAbiVersionFn)(void);

// A plugin's second export: fills its vtable from the host table, returning a
// `ZeroStatus` value.
typedef int32_t (*ZeroPluginRegisterFn)(const ZeroHostApi *host, ZeroPluginVTable *out);

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// Creates an app with no route.
//
// # Arguments
//
// * `app_out` - receives the app's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a NULL or misaligned `app_out`.
//
// # Safety
//
// `app_out` must be NULL or point to a writable `uint64_t`.
ZeroStatus zero_app_new(uint64_t *app_out);

// Releases an app. A server built from it keeps its own frozen copy.
//
// # Arguments
//
// * `app` - the app's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for an unknown or freed id, `InvalidArgument` for an id above `ZERO_ID_MAX`.
ZeroStatus zero_app_free(uint64_t app);

// Registers a route.
//
// The option document of each kind holds these keys: `ZERO_ROUTE_HOST` `maxBody`;
// `ZERO_ROUTE_STATIC` `root`, `index` (a name or false), `maxAgeMs`, `dotfiles`
// (`ignore`, `deny` or `allow`), `extensions`, `fallthrough`, `etag`, `ranges`;
// `ZERO_ROUTE_REDIRECT` `status` (301, 302, 303, 307 or 308) and `location`;
// `ZERO_ROUTE_FIXED` `status`, `contentType`, and `body` or `bodyBase64`;
// `ZERO_ROUTE_WEBSOCKET` `protocols`, `origins` (an array or null), `maxPayload`,
// `pingIntervalMs`; `ZERO_ROUTE_HEALTH` `status` and `body`. An empty document takes
// every default.
//
// # Arguments
//
// * `app` - the app's id.
// * `kind` - a `ZERO_ROUTE_*` value.
// * `method` - a `ZERO_METHOD_*` id, or `ZERO_METHOD_ANY` for every method.
// * `pattern` - the UTF-8 path pattern: `/` then static segments, `:name` parameters and
//   at most one final `*` or `*name` catch-all.
// * `pattern_len` - its length in octets.
// * `options` - the UTF-8 JSON option document.
// * `options_len` - its length in octets.
// * `route_out` - receives the route's id, the next in registration order.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Codec` for a malformed option document, naming the key; `InvalidArgument` for an
// undeclared kind or method, a pattern that is not UTF-8 or is outside the syntax, or a
// route already registered for the method and pattern; `Io` for a static root that
// cannot be opened; `Unsupported` for a kind whose capability is compiled out; `Closed`
// for an unknown app.
//
// # Safety
//
// `pattern` and `options` must be readable ranges of their lengths, and `route_out` NULL
// or a writable `uint32_t`.
ZeroStatus zero_app_route(uint64_t app,
                          uint32_t kind,
                          uint8_t method,
                          const uint8_t *pattern,
                          uintptr_t pattern_len,
                          const uint8_t *options,
                          uintptr_t options_len,
                          uint32_t *route_out);

// Mounts one app under a prefix of another: the child's routes are matched under the
// prefix, renumbered after the routes the parent holds, and its policies apply under
// the prefix. On success the child's id is consumed.
//
// # Arguments
//
// * `app` - the parent's id.
// * `prefix` - the UTF-8 prefix: `/` and static segments, not the root.
// * `prefix_len` - its length in octets.
// * `child` - the child's id; it must have no miss route and no trust-proxy policy.
// * `base_out` - receives how much every child route id grew: the id the child's first
//   route has now.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a prefix outside the syntax or not UTF-8, a child with a miss
// route or a trust-proxy policy, or a child that is the parent; `Closed` for an unknown
// app. Both apps are unchanged, and the child's id stays valid, after a refusal.
//
// # Safety
//
// `prefix` must be a readable range of `prefix_len` octets, and `base_out` NULL or a
// writable `uint32_t`.
ZeroStatus zero_app_mount(uint64_t app,
                          const uint8_t *prefix,
                          uintptr_t prefix_len,
                          uint64_t child,
                          uint32_t *base_out);

// Registers the miss route: requests no route matches go to the host under its id,
// with the status the core would have answered (404, 405, 501, or 200 for OPTIONS) in
// `ZeroRequestView.miss_status` and the allowed methods in `allow`.
//
// # Arguments
//
// * `app` - the app's id.
// * `route_out` - receives the miss route's id; the same id when it is registered again.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for an unknown app, `InvalidArgument` for a NULL or misaligned `route_out`.
//
// # Safety
//
// `route_out` must be NULL or point to a writable `uint32_t`.
ZeroStatus zero_app_miss(uint64_t app, uint32_t *route_out);

// Registers a policy over the paths under a prefix.
//
// The option document of each kind holds these keys: `ZERO_POLICY_CORS` `origins` (`"*"`
// or an array of origins and `.suffix` entries), `methods`, `headers`, `expose`,
// `credentials`, `maxAge`; `ZERO_POLICY_SECURITY_HEADERS` `fields`, an array of name and
// value pairs; `ZERO_POLICY_REQUEST_ID` `header`, `trustIncoming`, `version` (4 or 7);
// `ZERO_POLICY_TRUST_PROXY` `cidrs` and `header` (`"x-forwarded-for"` or `"forwarded"`,
// the one family of forwarding fields the trusted proxies write and the only one read);
// `ZERO_POLICY_BODY_LIMIT` `max`. Where policies of one kind overlap, the longest prefix
// wins, then the later registration.
//
// # Arguments
//
// * `app` - the app's id.
// * `kind` - a `ZERO_POLICY_*` value.
// * `prefix` - the UTF-8 path prefix, matched on a segment boundary; empty or `/` for
//   every path, which a trust-proxy policy must be.
// * `prefix_len` - its length in octets.
// * `options` - the UTF-8 JSON option document.
// * `options_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Codec` for a malformed option document, naming the key; `InvalidArgument` for an
// undeclared kind, a prefix that is not an absolute path or not UTF-8, or a second
// trust-proxy policy; `Unsupported` when the `policy` capability is compiled out;
// `Closed` for an unknown app.
//
// # Safety
//
// `prefix` and `options` must be readable ranges of their lengths.
ZeroStatus zero_app_policy(uint64_t app,
                           uint32_t kind,
                           const uint8_t *prefix,
                           uintptr_t prefix_len,
                           const uint8_t *options,
                           uintptr_t options_len);

// Writes the canonical table of an app: one line per route (kind, method, normalized
// pattern, id and options) sorted by pattern then method, then the miss route, the
// policies in registration order and the mounts. Two hosts that registered the same app
// get the same bytes.
//
// # Arguments
//
// * `app` - the app's id.
// * `table_out` - receives the table, an owned buffer the caller releases with
//   `zero_buffer_free`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for an unknown app, `InvalidArgument` for a NULL or misaligned `table_out`.
//
// # Safety
//
// `table_out` must be NULL or point to a writable `ZeroBuffer *`.
ZeroStatus zero_app_table(uint64_t app, ZeroBuffer **table_out);

// Returns the version of the zero-server core.
//
// # Returns
//
// A NUL-terminated UTF-8 string owned by the library and valid for the life of the
// process, or NULL if the call panicked. The caller must not free it.
const char *zero_version(void);

// Returns the version of the C ABI this library implements.
//
// # Returns
//
// `ZERO_ABI_VERSION`, or 0 if the call panicked.
uint32_t zero_abi_version(void);

// Returns the message of the calling thread's most recent refused call.
//
// # Returns
//
// A new owned string the caller releases with `zero_string_free`, or NULL when the
// thread has no message or the call panicked. Reading the message does not clear it.
ZeroString *zero_last_error_message(void);

// Returns the text of an owned string.
//
// # Arguments
//
// * `string` - the string, or NULL.
//
// # Returns
//
// The NUL-terminated UTF-8 text, valid until the string is freed; NULL for NULL.
//
// # Safety
//
// `string` must be NULL or a string this library returned and that has not been freed.
const char *zero_string_data(const ZeroString *string);

// Returns the length of an owned string's text.
//
// # Arguments
//
// * `string` - the string, or NULL.
//
// # Returns
//
// The length in octets, without the terminator; 0 for NULL.
//
// # Safety
//
// As `zero_string_data`.
uintptr_t zero_string_len(const ZeroString *string);

// Releases an owned string.
//
// # Arguments
//
// * `string` - the string; NULL does nothing.
//
// # Safety
//
// `string` must be NULL or a string this library returned and that has not been freed;
// it must not be used again.
void zero_string_free(ZeroString *string);

// Returns the bytes of an owned buffer.
//
// # Arguments
//
// * `buffer` - the buffer, or NULL.
//
// # Returns
//
// The first byte, valid until the buffer is freed and not NULL for an empty buffer;
// NULL for NULL.
//
// # Safety
//
// `buffer` must be NULL or a buffer this library returned and that has not been freed.
const uint8_t *zero_buffer_data(const ZeroBuffer *buffer);

// Returns the length of an owned buffer.
//
// # Arguments
//
// * `buffer` - the buffer, or NULL.
//
// # Returns
//
// The length in octets; 0 for NULL.
//
// # Safety
//
// As `zero_buffer_data`.
uintptr_t zero_buffer_len(const ZeroBuffer *buffer);

// Releases an owned buffer.
//
// # Arguments
//
// * `buffer` - the buffer; NULL does nothing.
//
// # Safety
//
// `buffer` must be NULL or a buffer this library returned and that has not been freed;
// it must not be used again.
void zero_buffer_free(ZeroBuffer *buffer);

// Writes the registered spelling of an interned field name.
//
// # Arguments
//
// * `id` - a `ZERO_HEADER_*` value.
// * `name_out` - receives the name, static text valid for the life of the process.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT` or a NULL or misaligned
// `name_out`.
//
// # Safety
//
// `name_out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_header_name(uint32_t id, ZeroBytes *name_out);

// Writes the interned id of a field name, compared without regard to case.
//
// # Arguments
//
// * `name` - the field name.
// * `len` - its length in octets.
// * `id_out` - receives a `ZERO_HEADER_*` value, or `ZERO_HEADER_NONE` for a name the
//   table does not hold.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an input range or an output the rules refuse.
//
// # Safety
//
// `name` must be a readable range of `len` octets, and `id_out` NULL or a writable
// `uint32_t`.
ZeroStatus zero_header_id(const uint8_t *name, uintptr_t len, uint32_t *id_out);

// Checks a field line against the rules `zero_res_header` applies, without a slot.
//
// The name must be a token (RFC 9110 Section 5.1) other than `Content-Length`,
// `Connection`, `Transfer-Encoding` and `Date`, which the driver writes itself. The value
// must be a field value without surrounding whitespace: "Field values containing CR,
// LF, or NUL characters are invalid and dangerous" (RFC 9110 Section 5.5), so the
// library refuses them rather than send them.
//
// # Arguments
//
// * `name` - the field name.
// * `name_len` - its length in octets.
// * `value` - the field value.
// * `value_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok` when a host may write the line, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a line the rules refuse or an input range they refuse.
//
// # Safety
//
// `name` and `value` must be readable ranges of their lengths.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
ZeroStatus zero_field_validate(const uint8_t *name,
                               uintptr_t name_len,
                               const uint8_t *value,
                               uintptr_t value_len);

// Recomputes one section of the shared conformance vectors: the section's name and a
// JSON document in its shape go in, and the same document comes out with every outcome
// computed again by the parsers and encoders the server uses, as canonical JSON. The
// entry keeps no state and never panics on arbitrary bytes.
//
// # Arguments
//
// * `section` - the section's name: `http1Parser`, `responseSplitting`, `router`, `ws`,
//   `sse`, `qpack` or `h3Frames`.
// * `section_len` - its length in octets.
// * `input` - the UTF-8 JSON document.
// * `input_len` - its length in octets.
// * `result_out` - receives the result, an owned buffer the caller releases with
//   `zero_buffer_free`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Unsupported` for an unknown section, and for `ws` and `sse` without the `realtime`
// capability; `Codec` for a document that is not JSON or not in the section's shape;
// `Limit` for a document past the JSON size or nesting cap; `InvalidArgument` for an
// argument the rules refuse.
//
// # Safety
//
// `section` and `input` must be readable ranges of their lengths, and `result_out` NULL
// or a writable `ZeroBuffer *`.
ZeroStatus zero_conformance_case(const uint8_t *section,
                                 uintptr_t section_len,
                                 const uint8_t *input,
                                 uintptr_t input_len,
                                 ZeroBuffer **result_out);

// Sends a message on a WebSocket connection.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `opcode` - `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`.
// * `data` - the message; UTF-8 for text (RFC 6455 Section 5.6).
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for another opcode, text that is not UTF-8, an id above
// `ZERO_ID_MAX`, the id of an event stream, or an input range the rules refuse;
// `Closed` once the connection ended or a close was sent; `Limit` when an outbox limit
// would be passed; nothing is queued then.
//
// # Safety
//
// `data` must be a readable range of `len` octets.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
ZeroStatus zero_ws_send(uint64_t conn, uint8_t opcode, const uint8_t *data, uintptr_t len);

// Sends a ping on a WebSocket connection; the pong arrives as `ZERO_EVENT_WS_PONG`.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `data` - the application data, at most 125 octets: "All control frames MUST have a
//   payload length of 125 bytes or less" (RFC 6455 Section 5.5).
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for more than 125 octets; otherwise as `zero_ws_send`.
//
// # Safety
//
// `data` must be a readable range of `len` octets.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
ZeroStatus zero_ws_ping(uint64_t conn, const uint8_t *data, uintptr_t len);

// Starts the closing handshake of a WebSocket connection, after what was sent before.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `code` - a status code a server may send: 1000 to 1003, 1007 to 1009, 1011 to 1014,
//   or 3000 to 4999. 1005, 1006 and 1015 "MUST NOT be set as a status code in a Close
//   control frame by an endpoint", 1004 is reserved, 1010 is a client's, the rest of
//   1000 to 2999 is unassigned in the IANA registry that Section 11.7 creates, and codes
//   below 1000 are not used (RFC 6455 Sections 7.4.1, 7.4.2 and 11.7).
// * `reason` - the reason, UTF-8 and at most 123 octets, so the code and the reason fit
//   a control frame (Sections 5.5 and 5.5.1).
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for any other code, or a reason that is not UTF-8 or is longer than
// 123 octets; otherwise as `zero_ws_send`.
//
// # Safety
//
// `reason` must be a readable range of `len` octets.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2>
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-11.7>
// @see <https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number>
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.1>
ZeroStatus zero_ws_close(uint64_t conn, uint16_t code, const uint8_t *reason, uintptr_t len);

// Ends a WebSocket connection without a Close frame, once what was sent before is
// written.
//
// # Arguments
//
// * `conn` - the connection's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_ws_send`.
ZeroStatus zero_ws_terminate(uint64_t conn);

// Writes whether a WebSocket connection takes more without passing its high-water
// mark; a send may still be queued when it does not, up to the outbox limits.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `writable_out` - receives 1 when it takes more, 0 otherwise.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an id above `ZERO_ID_MAX`, the id of an event stream, or a NULL
// `writable_out`; `Closed` once the connection ended.
//
// # Safety
//
// `writable_out` must be NULL or point to a writable `uint8_t`.
ZeroStatus zero_ws_writable(uint64_t conn, uint8_t *writable_out);

// Writes the octets sent on a WebSocket connection and not yet written to its socket.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `bytes_out` - receives the octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_ws_writable`.
//
// # Safety
//
// `bytes_out` must be NULL or point to a writable `uint64_t`.
ZeroStatus zero_ws_buffered(uint64_t conn, uint64_t *bytes_out);

// Sends an event on an event stream.
//
// `event` and `id` hold no CR or LF, since the stream grammar's `name-char` and
// `any-char` exclude them, and `id` holds no NUL, which a client ignores an `id` for
// (WHATWG HTML Sections 9.2.5 and 9.2.6); `data` is split at CRLF, LF and CR, each line
// its own `data` field.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `event` - the event type; NULL with a zero length for none, and a non-NULL pointer
//   with a zero length for an empty type, which the client reads as `message`.
// * `event_len` - its length in octets.
// * `id` - the event id; NULL with a zero length for none, and a non-NULL pointer with a
//   zero length for an empty id, which resets the id the client reports.
// * `id_len` - its length in octets.
// * `data` - the data, UTF-8.
// * `data_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a value that is not UTF-8, an `event` or `id` holding CR or LF,
// an `id` holding NUL, an id above `ZERO_ID_MAX`, the id of a WebSocket, or an input
// range the rules refuse; `Closed` once the stream ended or was closed; `Limit` as for
// `zero_ws_send`; nothing is queued then.
//
// # Safety
//
// `event`, `id` and `data` must be NULL or readable ranges of their lengths.
//
// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
ZeroStatus zero_sse_send(uint64_t conn,
                         const uint8_t *event,
                         uintptr_t event_len,
                         const uint8_t *id,
                         uintptr_t id_len,
                         const uint8_t *data,
                         uintptr_t data_len);

// Sends a comment on an event stream, which the client ignores: one comment line per
// line of `text`, split at CRLF, LF and CR.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `text` - the comment, UTF-8.
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_sse_send`.
//
// # Safety
//
// `text` must be a readable range of `len` octets.
//
// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
ZeroStatus zero_sse_comment(uint64_t conn, const uint8_t *text, uintptr_t len);

// Tells the client of an event stream how long to wait before it reconnects, written
// as ASCII digits.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `milliseconds` - the reconnection time.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_sse_send`.
//
// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
ZeroStatus zero_sse_retry(uint64_t conn, uint32_t milliseconds);

// Ends an event stream once what was sent before is written.
//
// # Arguments
//
// * `conn` - the connection's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_sse_send`.
ZeroStatus zero_sse_close(uint64_t conn);

// Writes whether an event stream takes more without passing its high-water mark.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `writable_out` - receives 1 when it takes more, 0 otherwise.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an id above `ZERO_ID_MAX`, the id of a WebSocket, or a NULL
// `writable_out`; `Closed` once the stream ended.
//
// # Safety
//
// `writable_out` must be NULL or point to a writable `uint8_t`.
ZeroStatus zero_sse_writable(uint64_t conn, uint8_t *writable_out);

// Writes the octets sent on an event stream and not yet written to its socket.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `bytes_out` - receives the octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_sse_writable`.
//
// # Safety
//
// `bytes_out` must be NULL or point to a writable `uint64_t`.
ZeroStatus zero_sse_buffered(uint64_t conn, uint64_t *bytes_out);

// Puts a WebSocket connection in a room of its server, in order with what is sent on
// it.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `room` - the room's name, UTF-8.
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a name that is not UTF-8; otherwise as `zero_ws_send`.
//
// # Safety
//
// `room` must be a readable range of `len` octets.
ZeroStatus zero_room_join(uint64_t conn, const uint8_t *room, uintptr_t len);

// Takes a WebSocket connection out of a room, in order with what is sent on it.
//
// # Arguments
//
// * `conn` - the connection's id.
// * `room` - the room's name, UTF-8.
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_room_join`.
//
// # Safety
//
// `room` must be a readable range of `len` octets.
ZeroStatus zero_room_leave(uint64_t conn, const uint8_t *room, uintptr_t len);

// Sends a message to every WebSocket connection in one of a server's rooms, on every
// core, but the one left out. The frame is encoded once; each member writes it in order
// with what is sent on it, after the sends made before this call returned and before
// those made after it, and a member with 16 MiB of broadcasts waiting is closed with
// 1013 Try Again Later rather than holding more.
//
// # Arguments
//
// * `server` - the server's id.
// * `room` - the room's name, UTF-8.
// * `room_len` - its length in octets.
// * `opcode` - `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`.
// * `data` - the message; UTF-8 for text.
// * `len` - its length in octets.
// * `except_conn` - the connection to leave out, usually the sender, or `ZERO_NONE`.
// * `delivered_out` - receives how many members the message was queued for.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a name or a text that is not UTF-8, another opcode, an
// `except_conn` above `ZERO_ID_MAX`, or an argument the rules refuse; `Unsupported` when
// the `realtime` capability is compiled out; `Closed` for an unknown server.
//
// # Safety
//
// `room` and `data` must be readable ranges of their lengths, and `delivered_out` NULL
// or a writable `uint64_t`.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
ZeroStatus zero_room_broadcast(uint64_t server,
                               const uint8_t *room,
                               uintptr_t room_len,
                               uint8_t opcode,
                               const uint8_t *data,
                               uintptr_t len,
                               uint64_t except_conn,
                               uint64_t *delivered_out);

// Writes how many WebSocket connections are in one of a server's rooms, over every
// core.
//
// # Arguments
//
// * `server` - the server's id.
// * `room` - the room's name, UTF-8.
// * `len` - its length in octets.
// * `count_out` - receives the count.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a name that is not UTF-8 or an argument the rules refuse;
// `Unsupported` when the `realtime` capability is compiled out; `Closed` for an unknown
// server.
//
// # Safety
//
// `room` must be a readable range of `len` octets, and `count_out` NULL or a writable
// `uint64_t`.
ZeroStatus zero_room_size(uint64_t server, const uint8_t *room, uintptr_t len, uint64_t *count_out);

// Writes the whole request of a leased slot in one read of its published view, with
// no lock and no atomic read-modify-write: the fast path. The pointers inside follow
// the view rule.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `view_out` - receives the view; its `size` is set before the call.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a thread the view rule refuses, an id above `ZERO_ID_MAX`, a
// NULL or misaligned `view_out` or a `size` below the version 1 size; `Closed` unless
// the slot is leased or completing at the id's generation.
//
// # Safety
//
// `view_out` must be NULL or point to a writable struct of at least its `size` octets.
ZeroStatus zero_req_view(uint64_t slot, ZeroRequestView *view_out);

// Writes the method of a slot's request, from any thread.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `method_out` - receives a `ZERO_METHOD_*` id, or `ZERO_METHOD_OTHER` for a token
//   outside the method table, which `zero_req_method_token` reads.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` unless the slot is leased or completing at the id's generation;
// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL `method_out`.
//
// # Safety
//
// `method_out` must be NULL or point to a writable `uint8_t`.
ZeroStatus zero_req_method(uint64_t slot, uint8_t *method_out);

// Writes a view of the method token as received.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_method_token(uint64_t slot, ZeroBytes *out);

// Writes a view of the request target as received.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_target(uint64_t slot, ZeroBytes *out);

// Writes a view of the path of the request target, without the query.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_path(uint64_t slot, ZeroBytes *out);

// Writes a view of the query as received, without its `?`: absent, `{NULL, 0}`, when the
// target has none, and present and empty for a bare `?`.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_query(uint64_t slot, ZeroBytes *out);

// Writes a view of the normalized path the route matched.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_route_path(uint64_t slot, ZeroBytes *out);

// Writes a view of the authority: the `Host` value or the host and port of an
// absolute-form target; absent when the request has none.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_authority(uint64_t slot, ZeroBytes *out);

// Writes the number of route parameters, from any thread.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `count_out` - receives the count.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_method`.
//
// # Safety
//
// `count_out` must be NULL or point to a writable `uint32_t`.
ZeroStatus zero_req_param_count(uint64_t slot, uint32_t *count_out);

// Writes a view of a route parameter in pattern order, as the normalized path holds it:
// reserved characters stay percent-encoded.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `index` - the parameter's position in the pattern.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an index at or past the count; otherwise as `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_param(uint64_t slot, uint32_t index, ZeroBytes *out);

// Writes the number of field lines of the request head, from any thread.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `count_out` - receives the count.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_method`.
//
// # Safety
//
// `count_out` must be NULL or point to a writable `uint32_t`.
ZeroStatus zero_req_header_count(uint64_t slot, uint32_t *count_out);

// Writes views of the name and the value of a field line, in the order received.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `index` - the line's position.
// * `name_out` - receives the name as received.
// * `value_out` - receives the value without its surrounding whitespace.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an index at or past the count; otherwise as `zero_req_view`.
//
// # Safety
//
// `name_out` and `value_out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_header_at(uint64_t slot,
                              uint32_t index,
                              ZeroBytes *name_out,
                              ZeroBytes *value_out);

// Writes a view of the value of the `nth` field line with an interned name.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name_id` - a `ZERO_HEADER_*` value.
// * `nth` - which line of that name, from 0.
// * `out` - receives the value; absent when the request has fewer such lines.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT`; otherwise as
// `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_header_id(uint64_t slot, uint32_t name_id, uint32_t nth, ZeroBytes *out);

// Writes a view of the value of the `nth` field line with a name, compared without
// regard to ASCII case.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name` - the field name.
// * `len` - its length in octets.
// * `nth` - which line of that name, from 0.
// * `out` - receives the value; absent when the request has fewer such lines.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`, and `InvalidArgument` for an input range the rules refuse.
//
// # Safety
//
// `name` must be a readable range of `len` octets, and `out` NULL or a writable
// `ZeroBytes`.
ZeroStatus zero_req_header(uint64_t slot,
                           const uint8_t *name,
                           uintptr_t len,
                           uint32_t nth,
                           ZeroBytes *out);

// Writes a view of the value of the first trailer field with a name, compared without
// regard to case, among the trailers the server's `trailers` option allows; any other
// name is absent.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name` - the trailer field name.
// * `len` - its length in octets.
// * `out` - receives the value, or absent.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_header`.
//
// # Safety
//
// As `zero_req_header`.
ZeroStatus zero_req_trailer(uint64_t slot, const uint8_t *name, uintptr_t len, ZeroBytes *out);

// Writes a view of the buffered request body.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `out` - receives the view.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_view`.
//
// # Safety
//
// `out` must be NULL or point to a writable `ZeroBytes`.
ZeroStatus zero_req_body(uint64_t slot, ZeroBytes *out);

// Writes an owned copy of the buffered request body, from any thread; it stays valid
// after the slot is gone.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `body_out` - receives the copy, an owned buffer the caller releases with
//   `zero_buffer_free`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_method`, and `Panic` for a slot a panic poisoned.
//
// # Safety
//
// `body_out` must be NULL or point to a writable `ZeroBuffer *`.
ZeroStatus zero_req_body_retain(uint64_t slot, ZeroBuffer **body_out);

// Reads a claim of the request's verified token. Token verification is not part of
// this version, so a valid call returns `ZeroStatus_Unsupported`.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name` - the claim's name.
// * `len` - its length in octets.
// * `out` - would receive the claim's value.
//
// # Returns
//
// `ZeroStatus_Unsupported` for a valid call, or another refusal.
//
// # Errors
//
// As `zero_req_method`, and `InvalidArgument` for an input range the rules refuse.
//
// # Safety
//
// `name` must be a readable range of `len` octets, and `out` NULL or a writable
// `ZeroBytes`.
ZeroStatus zero_req_claim(uint64_t slot, const uint8_t *name, uintptr_t len, ZeroBytes *out);

// Writes the addresses of a request's connection, from any thread: the peer, and the
// client after the trust-proxy rule.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `peer_out` - receives the addresses; its `size` is set before the call.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_req_method`, and `InvalidArgument` for a `size` below the version 1 size.
//
// # Safety
//
// `peer_out` must be NULL or point to a writable struct of at least its `size` octets.
ZeroStatus zero_req_peer(uint64_t slot, ZeroPeer *peer_out);

// Sets the response status.
//
// RFC 9110 Section 15: "All valid status codes are within the range of 100 to 599,
// inclusive." A host sets 200 to 599: 100 belongs to the driver, which sends it for
// `Expect: 100-continue`, 101 only to an accepted upgrade (`zero_res_ws_accept`), and "a
// server MUST NOT send a 1xx response to an HTTP/1.0 client" (Section 15.2), which the
// status call cannot tell apart.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `status` - the status, 200 to 599.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a status outside 200 to 599 or an id above `ZERO_ID_MAX`;
// `Closed` for a stale id, a slot that is not leased, or a sealed response; `Panic` for
// a slot a panic poisoned.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15>
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2>
ZeroStatus zero_res_status(uint64_t slot, uint16_t status);

// Writes a field line.
//
// The name is a token (RFC 9110 Section 5.1) other than `Content-Length`, `Connection`,
// `Transfer-Encoding` and `Date`, which the driver writes itself. The value is a field
// value without surrounding whitespace: "Field values containing CR, LF, or NUL
// characters are invalid and dangerous" (Section 5.5), so a value holding any of them,
// or another control character, is refused rather than sent, and nothing is written.
// `ZERO_HEADER_SET` replaces every line of the name, compared without regard to case;
// `ZERO_HEADER_APPEND` adds one more line, so each `Set-Cookie` leaves as a field line of
// its own, as it "does not use the list syntax" (Section 5.3).
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name` - the field name.
// * `name_len` - its length in octets.
// * `value` - the field value.
// * `value_len` - its length in octets.
// * `mode` - `ZERO_HEADER_SET` or `ZERO_HEADER_APPEND`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a name or a value the rules refuse, an undeclared mode, or an
// input range the rules refuse; otherwise as `zero_res_status`.
//
// # Safety
//
// `name` and `value` must be readable ranges of their lengths.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
ZeroStatus zero_res_header(uint64_t slot,
                           const uint8_t *name,
                           uintptr_t name_len,
                           const uint8_t *value,
                           uintptr_t value_len,
                           uint32_t mode);

// Writes a field line under an interned name, with the rules of `zero_res_header`.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `name_id` - a `ZERO_HEADER_*` value.
// * `value` - the field value.
// * `value_len` - its length in octets.
// * `mode` - `ZERO_HEADER_SET` or `ZERO_HEADER_APPEND`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT`; otherwise as
// `zero_res_header`.
//
// # Safety
//
// `value` must be a readable range of `value_len` octets.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
ZeroStatus zero_res_header_id(uint64_t slot,
                              uint32_t name_id,
                              const uint8_t *value,
                              uintptr_t value_len,
                              uint32_t mode);

// Replaces the response body with a copy, up to the server's `maxResponseBody`.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `body` - the body.
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Limit` for a body longer than the server's response limit; `InvalidArgument` while a
// body region is open or for an input range the rules refuse; otherwise as
// `zero_res_status`.
//
// # Safety
//
// `body` must be a readable range of `len` octets.
ZeroStatus zero_res_body_copy(uint64_t slot, const uint8_t *body, uintptr_t len);

// Replaces the response body with a copy of a JSON text and sets `Content-Type` to
// `application/json`, the media type of JSON text (RFC 8259 Section 11). The text is not
// parsed.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `json` - the JSON text.
// * `len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_res_body_copy`.
//
// # Safety
//
// `json` must be a readable range of `len` octets.
//
// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-11>
ZeroStatus zero_res_json(uint64_t slot, const uint8_t *json, uintptr_t len);

// Answers with an error in the server's error shape and seals: the response written so
// far is replaced by the status, the shape's `Content-Type` and an error body written by
// the library. An error path never fails a second time: a status outside 400 to 599 is
// answered 500, a message that is not UTF-8 is written with its invalid sequences
// replaced, details that are not one JSON value are dropped, and the message, then the
// details, are kept only while the body fits the server's response limit.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `status` - the status, 400 to 599.
// * `code` - the error code, 1 to 64 octets of `A` to `Z`, `0` to `9` and `_`.
// * `code_len` - its length in octets.
// * `message` - the message; a zero length uses the status's reason phrase.
// * `message_len` - its length in octets.
// * `details_json` - one JSON value with the details; a zero length has none.
// * `details_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a code outside its alphabet or length, while a body region is
// open, or for an input range the rules refuse; otherwise as `zero_res_status`.
//
// # Safety
//
// `code`, `message` and `details_json` must be readable ranges of their lengths.
ZeroStatus zero_res_error(uint64_t slot,
                          uint16_t status,
                          const uint8_t *code,
                          uintptr_t code_len,
                          const uint8_t *message,
                          uintptr_t message_len,
                          const uint8_t *details_json,
                          uintptr_t details_len);

// Opens a body region: the body becomes `len` zero octets that the calling thread fills
// in place, so a host that writes less than it asked for never sends another
// response's bytes. The region needs the calling thread's pin, and is valid while the
// pin is held and until the response is sealed; while it is open, every other body call
// and `zero_res_reset` are refused, so the region cannot move. `zero_res_send` seals the
// response with the region as its body.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `len` - the body length in octets, up to the server's `maxResponseBody`.
// * `region_out` - receives the start of the region.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` without the calling thread's pin, while a region is already open,
// or for a NULL or misaligned `region_out`; `Limit` for a length above the server's
// response limit or one that cannot be allocated; otherwise as `zero_res_status`.
//
// # Safety
//
// `region_out` must be NULL or point to a writable `uint8_t *`.
ZeroStatus zero_res_body_alloc(uint64_t slot, uintptr_t len, uint8_t **region_out);

// Writes the status, the field lines and the body in one call and seals. Every field
// line is checked with the rules of `zero_res_header` before any is written, so a
// refused call leaves the response as it was; the lines are appended after those
// written before, each a line of its own.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `spec` - the response; its `size` is the size the host built it with.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a NULL `spec`, a `size` below the version 1 size, a
// `field_size` below the version 1 size of `ZeroHeaderPair`, a field line the rules
// refuse, or while a body region is open; otherwise as `zero_res_status` and
// `zero_res_body_copy`.
//
// # Safety
//
// `spec` must be NULL or point to a readable struct of at least its `size` octets,
// whose `fields` holds `field_count` readable pairs of `field_size` octets, and every
// range it names must be readable.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
ZeroStatus zero_res_respond(uint64_t slot, const ZeroResponseSpec *spec);

// Serves a file as the response once the slot is completed: the field lines the host
// set stay, before the file's own, and so does its status unless the file answer sets
// one (206, 304 or a refusal). The path goes through the static file policy segment by
// segment; a path the root does not serve, or a root that does not exist, is answered
// 404, and a method other than GET and HEAD 405 with `Allow: GET, HEAD`. Seals.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `root` - the root directory, UTF-8 and not empty.
// * `root_len` - its length in octets.
// * `path` - the path of the file under the root, percent-encoded as a request path is.
// * `path_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for an empty root or one that is not UTF-8, while a body region is
// open, or for an input range the rules refuse; `Unsupported` when the `static`
// capability is compiled out; otherwise as `zero_res_status`.
//
// # Safety
//
// `root` and `path` must be readable ranges of their lengths.
//
// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
ZeroStatus zero_res_file(uint64_t slot,
                         const uint8_t *root,
                         uintptr_t root_len,
                         const uint8_t *path,
                         uintptr_t path_len);

// Answers with a server-sent event stream once the slot is completed; the status and
// fields the host set go into the stream head. The connection's id is valid at once,
// and events sent before the head is written wait in its outbox. Seals.
//
// # Arguments
//
// * `slot` - the slot's id; not a HEAD request, whose response carries no body.
// * `keep_alive_ms` - the interval of the keep-alive comment written while nothing
//   else is; 0 writes none.
// * `conn_out` - receives the connection's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a HEAD request, while a body region is open, or for a NULL or
// misaligned `conn_out`; `Limit` when the core holds its bound of connections;
// `Unsupported` when the `realtime` capability is compiled out; otherwise as
// `zero_res_status`.
//
// # Safety
//
// `conn_out` must be NULL or point to a writable `uint64_t`.
//
// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>
ZeroStatus zero_res_sse_open(uint64_t slot, uint32_t keep_alive_ms, uint64_t *conn_out);

// Accepts a WebSocket route's upgrade request once the slot is completed: `101
// Switching Protocols` with the accept value and the chosen subprotocol. The
// connection's id is valid at once, and messages sent before the `101` is written wait
// in its outbox. A host that declines answers with an error status of its own instead.
// Seals.
//
// # Arguments
//
// * `slot` - the slot's id; a leased upgrade request of a WebSocket route.
// * `protocol` - the subprotocol: one the client offered and the route allows, since
//   "The value chosen MUST be derived from the client's handshake" (RFC 6455 Section
//   4.2.2); a zero length chooses none and sends no `Sec-WebSocket-Protocol`.
// * `protocol_len` - its length in octets.
// * `conn_out` - receives the connection's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a request that is not a WebSocket route's, a protocol the
// client did not offer or the route does not allow, while a body region is open, or
// for an output or an input range the rules refuse; `Limit` when the core holds its
// bound of connections; `Unsupported` when the `realtime` capability is compiled out;
// otherwise as `zero_res_status`.
//
// # Safety
//
// `protocol` must be a readable range of `protocol_len` octets, and `conn_out` NULL or a
// writable `uint64_t`.
//
// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
ZeroStatus zero_res_ws_accept(uint64_t slot,
                              const uint8_t *protocol,
                              uintptr_t protocol_len,
                              uint64_t *conn_out);

// Discards the status, the field lines, the body and the action written so far.
//
// # Arguments
//
// * `slot` - the slot's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` while a body region is open; otherwise as `zero_res_status`.
ZeroStatus zero_res_reset(uint64_t slot);

// Seals the response as written; an open body region closes for the host, which may no
// longer write to it.
//
// # Arguments
//
// * `slot` - the slot's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// As `zero_res_status`, without its range.
ZeroStatus zero_res_send(uint64_t slot);

// Builds a server from an app: claims its worker indexes and builds their state without
// binding. The app is frozen into the server; later changes to it do not reach it.
//
// The option document holds `host`, `port` (0 lets the system pick one), `threads` (0
// for the smaller of the available parallelism and the free worker indexes, at least
// 1), `drainMs`, `retryAfterSecs`, `drainRetryAfterSecs`, `maxResponseBody`,
// `maxBatchSize` (1 to 256), `maxBatchesInFlight` (1 to 8), `maxQueuedBatches`,
// `server`, `trailers` (the trailer names a host may read), `errorShape` (`"problem"` or
// `"legacy"`) and `limits` (`maxBody`, `requestTotalMs`, which is also the lease
// timeout, and the HTTP/1.1 limits). An empty document takes every default.
//
// # Arguments
//
// * `app` - the app's id.
// * `options` - the UTF-8 JSON option document.
// * `options_len` - its length in octets.
// * `server_out` - receives the server's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Codec` for a malformed option document, naming the key; `InvalidArgument` for a
// lease timeout that differs from the request total or limits that contradict each
// other; `Limit` when fewer worker indexes are free than `threads` asks for; `Closed`
// for an unknown app.
//
// # Safety
//
// `options` must be a readable range of `options_len` octets, and `server_out` NULL or a
// writable `uint64_t`.
ZeroStatus zero_server_new(uint64_t app,
                           const uint8_t *options,
                           uintptr_t options_len,
                           uint64_t *server_out);

// Serves over TLS: the certificate chain and the private key as PEM, never inside the
// JSON, and a TLS option document with `alpn`, `minVersion`, `maxVersion` (`"1.2"` or
// `"1.3"`; TLS 1.3 is always offered), `requireEms` and `names`, the hosts the
// certificate serves. The key is copied into memory that is zeroized once the identity
// is built.
//
// # Arguments
//
// * `server` - the server's id; it has not started.
// * `cert_chain_pem` - the certificate chain.
// * `cert_len` - its length in octets.
// * `key_pem` - the private key.
// * `key_len` - its length in octets.
// * `options` - the UTF-8 JSON option document.
// * `options_len` - its length in octets.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Codec` for a malformed option document; `Io` for material that cannot be read as a
// certificate and a key; `InvalidArgument` once the server started or while it starts;
// `Unsupported` when the `tls` capability is compiled out; `Closed` for an unknown
// server.
//
// # Safety
//
// `cert_chain_pem`, `key_pem` and `options` must be readable ranges of their lengths.
ZeroStatus zero_server_tls(uint64_t server,
                           const uint8_t *cert_chain_pem,
                           uintptr_t cert_len,
                           const uint8_t *key_pem,
                           uintptr_t key_len,
                           const uint8_t *options,
                           uintptr_t options_len);

// Compares a server's canonical table with an app's, as a host that built the app on
// another thread checks that every route id means the same route.
//
// # Arguments
//
// * `server` - the server's id.
// * `app` - the app's id.
//
// # Returns
//
// `ZeroStatus_Ok` when the tables are identical, or a refusal.
//
// # Errors
//
// `InvalidArgument` naming the first line that differs in the last error; `Closed` for
// an unknown server or app.
ZeroStatus zero_server_check_table(uint64_t server, uint64_t app);

// Binds and starts one core per worker index, and returns once listening.
//
// # Arguments
//
// * `server` - the server's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Io` when the address does not resolve or cannot be bound or a thread cannot start;
// `InvalidArgument` when the server already started or is starting; `Closed` once a
// stop began or for an unknown server. A start that fails leaves the server ready with
// its targets attached.
ZeroStatus zero_server_start(uint64_t server);

// Writes the address the server listens on, as `host:port` with an IPv6 host in
// brackets.
//
// # Arguments
//
// * `server` - the server's id.
// * `address_out` - receives the address, an owned string the caller releases with
//   `zero_string_free`.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` before the start, after the stop, or for an unknown server;
// `InvalidArgument` for a NULL or misaligned `address_out`.
//
// # Safety
//
// `address_out` must be NULL or point to a writable `ZeroString *`.
ZeroStatus zero_server_address(uint64_t server, ZeroString **address_out);

// Writes the global worker indexes the server claimed, one per core in core order; a
// target attaches to one of them.
//
// # Arguments
//
// * `server` - the server's id.
// * `workers_out` - receives the indexes; NULL is accepted when `cap` is 0.
// * `cap` - how many indexes `workers_out` holds.
// * `count_out` - receives the number of indexes, also when `cap` is too small.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Limit` when `cap` is smaller than the count, after writing `count_out`;
// `InvalidArgument` for a NULL or misaligned output; `Closed` for an unknown server.
//
// # Safety
//
// `workers_out` must be NULL or point to `cap` writable octets, and `count_out` NULL or
// a writable `uintptr_t`.
ZeroStatus zero_server_workers(uint64_t server,
                               uint8_t *workers_out,
                               uintptr_t cap,
                               uintptr_t *count_out);

// Requests the drain and returns at once: the cores stop accepting, finish their
// in-flight requests within the drain deadline, and the server stops. A server that
// never started stops now.
//
// # Arguments
//
// * `server` - the server's id.
// * `drain_ms` - the longest the drain may take: `ZERO_NONE`, or at least the server's
//   `drainMs` option, which is the deadline the cores apply.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Unsupported` for a drain shorter than the server's `drainMs` option, which this
// version cannot apply; `Closed` for an unknown server.
ZeroStatus zero_server_shutdown(uint64_t server, uint64_t drain_ms);

// Blocks until the server stopped.
//
// # Arguments
//
// * `server` - the server's id.
// * `timeout_ms` - the longest wait in milliseconds; `ZERO_NONE` waits as long as it
//   takes.
//
// # Returns
//
// `ZeroStatus_Ok` once the server stopped, or a refusal.
//
// # Errors
//
// `Timeout` when the server is still running when the timeout passes;
// `InvalidArgument` on an I/O worker thread and, until a stop began, on a thread bound
// to one of the server's targets, since the drain needs that thread's
// acknowledgments; `Closed` for an unknown server.
ZeroStatus zero_server_wait(uint64_t server, uint64_t timeout_ms);

// Writes a server's statistics, summed over its worker indexes; once it stopped, those
// it had when it gave its indexes back.
//
// # Arguments
//
// * `server` - the server's id.
// * `stats_out` - receives the statistics; its `size` is set before the call.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a NULL or misaligned `stats_out` or a `size` below the version 1
// size; `Closed` for an unknown server.
//
// # Safety
//
// `stats_out` must be NULL or point to a writable struct of at least its `size` octets.
ZeroStatus zero_server_stats(uint64_t server, ZeroStats *stats_out);

// Releases a server's id once the server is not running. A server that never started
// gives its worker indexes back.
//
// # Arguments
//
// * `server` - the server's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Limit` while the server runs, its drain included; `Closed` for an unknown or freed
// server.
ZeroStatus zero_server_free(uint64_t server);

// Pins a slot for the calling thread: while the pin is held the slot is not retired, so
// the views the thread reads stay valid, and a body region can be opened. A thread
// holds at most 64 pins; one that exits holding pins releases them.
//
// # Arguments
//
// * `slot` - the slot's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` unless the slot is leased or completing at the id's generation;
// `InvalidArgument` for a slot the thread already pinned or an id above `ZERO_ID_MAX`;
// `Limit` when the thread holds 64 pins or the slot counts the most pins it can.
ZeroStatus zero_slot_pin(uint64_t slot);

// Releases the calling thread's pin on a slot.
//
// # Arguments
//
// * `slot` - the slot's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` unless the calling thread pinned that id, or for an id above
// `ZERO_ID_MAX`.
ZeroStatus zero_slot_unpin(uint64_t slot);

// Writes the route id a slot's request matched, from any thread.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `route_out` - receives the route id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` unless the slot is leased or completing at the id's generation;
// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL or misaligned `route_out`.
//
// # Safety
//
// `route_out` must be NULL or point to a writable `uint32_t`.
ZeroStatus zero_slot_route(uint64_t slot, uint32_t *route_out);

// Writes whether a slot's request was canceled: its connection or its target went
// away, so its lease was closed and later writes are refused. A host may stop working
// on a canceled request.
//
// # Arguments
//
// * `slot` - the slot's id.
// * `canceled_out` - receives 1 for a canceled or closed lease, 0 otherwise.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for a stale or unknown id, including a lease the worker already retired;
// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL `canceled_out`.
//
// # Safety
//
// `canceled_out` must be NULL or point to a writable `uint8_t`.
ZeroStatus zero_slot_canceled(uint64_t slot, uint8_t *canceled_out);

// Attaches a pull target to one of a server's worker indexes, or to every one of them
// served from one queue. A worker index has at most one target.
//
// # Arguments
//
// * `server` - the server's id.
// * `worker` - a global worker index from `zero_server_workers`, or `ZERO_ALL_WORKERS`.
// * `target_out` - receives the target's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a worker index of another server or outside the indexes;
// `Limit` when a worker index already has a target; `Closed` once a stop of the server
// began, or for an unknown server.
//
// # Safety
//
// `target_out` must be NULL or point to a writable `uint64_t`.
ZeroStatus zero_target_attach(uint64_t server, uint32_t worker, uint64_t *target_out);

// Waits for the next batch of a target and copies it out.
//
// The first thread to poll binds the target. A request batch writes its slot ids to
// `slots` and their route ids to `routes`; an event batch writes one `ZeroEvent` per
// event to `events`, `event_size` octets apart, whose payloads stay valid until the next
// poll on this target or its detach. `batch_out` says which and how many.
//
// # Arguments
//
// * `target` - the target's id.
// * `timeout_ms` - how long to wait in milliseconds; 0 checks once, `ZERO_NONE` waits
//   as long as it takes.
// * `batch_out` - receives the batch; its `size` is set before the call.
// * `slots` - receives a request batch's slot ids, `cap` entries.
// * `routes` - receives their route ids, `cap` entries.
// * `events` - receives an event batch's records, `cap` entries.
// * `event_size` - the size of one `ZeroEvent` as the host built the array.
// * `cap` - the entries each array holds, at least `ZERO_MAX_BATCH`.
//
// # Returns
//
// `ZeroStatus_Ok` with a batch written, or a refusal.
//
// # Errors
//
// `Timeout` when nothing arrived in time or `zero_target_wake` ended the wait; `Closed`
// once the target is detached or its server stopped, or for an unknown target;
// `InvalidArgument` on an I/O worker thread, on a thread other than the bound one, for
// a `cap` below `ZERO_MAX_BATCH`, an `event_size` below the version 1 size, or an
// output the rules refuse.
//
// # Safety
//
// `batch_out` must be NULL or a writable struct of at least its `size` octets; `slots`,
// `routes` and `events` must be NULL or writable arrays of `cap` entries, those of
// `events` `event_size` octets each.
ZeroStatus zero_target_poll(uint64_t target,
                            uint64_t timeout_ms,
                            ZeroBatch *batch_out,
                            uint64_t *slots,
                            uint32_t *routes,
                            ZeroEvent *events,
                            uintptr_t event_size,
                            uintptr_t cap);

// Ends a poll blocked on a target with `ZeroStatus_Timeout`, or the next poll when none
// is blocked.
//
// # Arguments
//
// * `target` - the target's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for an unknown or detached target.
ZeroStatus zero_target_wake(uint64_t target);

// Detaches a target: the worker indexes it serves close its leases and answer them
// 503, fail its queued requests the same way, and release the slots it held. The id is
// released and the target's event views end. The target's thread holds no view through
// it afterward and makes no view call through it.
//
// # Arguments
//
// * `target` - the target's id.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `Closed` for an unknown or detached target.
ZeroStatus zero_target_detach(uint64_t target);

// Hands answered slots back to their worker and, from the thread bound to the worker's
// target, acknowledges a batch.
//
// Each id is checked on its own: an id above `ZERO_ID_MAX` or of another worker index
// is `InvalidArgument`, and a stale id or a slot neither leased nor completing is
// `Closed`. The accepted ids are applied with one wake of the worker per 256 ids. A
// slot completed without a response is answered 500 `NO_RESPONSE`. An acknowledgment
// is accepted only from the bound thread, for the epoch after the last one
// acknowledged; a refused one changes nothing but is reported, and the ids of the
// call are applied anyway.
//
// # Arguments
//
// * `worker` - the worker index the ids belong to, `ZeroBatch.worker`.
// * `slots` - the answered slot ids.
// * `count` - how many.
// * `epoch` - the epoch to acknowledge, or `ZERO_EPOCH_NONE`.
// * `results_out` - NULL, or receives the status of each id, `count` entries, also when
//   the call fails.
//
// # Returns
//
// `ZeroStatus_Ok`, or a refusal.
//
// # Errors
//
// `InvalidArgument` for a worker index of 128 or more, a refused acknowledgment (from
// another thread or out of order), or an argument the rules refuse; `Closed` for a
// worker index no server claimed.
//
// # Safety
//
// `slots` must be a readable array of `count` ids, and `results_out` NULL or a writable
// array of `count` statuses.
ZeroStatus zero_batch_complete(uint8_t worker,
                               const uint64_t *slots,
                               uintptr_t count,
                               uint64_t epoch,
                               ZeroStatus *results_out);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus
