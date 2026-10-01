# Research: database drivers for the Rust core

Date: 2026-09-29, continued 2026-09-30. Status: round 2 fetches recorded in sections 1.6 to 3.2; decisions and estimates in sections 5 to 8.

Scope: PostgreSQL, MySQL and MariaDB, MongoDB, Redis, SQLite. Questions: in-house no_std codecs versus crates per protocol, pipelining and connection-per-core design, prepared statement caches, the SQLite engine question (bundled C library versus turso), effort per driver.

Every claim below is tagged with the source it came from. Anything not backed by a fetched source is marked "unverified".

## 1. Protocol facts (fetched)

### 1.1 PostgreSQL frontend/backend protocol

Source: https://www.postgresql.org/docs/current/protocol-overview.html

- Message framing: first byte is the message type, next four bytes are the length "of the rest of the message (includes itself, but not the message-type byte)". Exception: "the very first message sent by the client (the startup message) has no initial message-type byte."
- Formats: "the only supported formats are 'text' and 'binary'"; text is format code zero, binary is format code one. Binary integers use network byte order.
- Versions: 3.2 is current (PostgreSQL 18+, enlarged cancel secret key); 3.0 is the default that libpq still sends "for backwards compatibility with old server versions and middleware that don't support the version negotiation yet".

Source: https://www.postgresql.org/docs/current/protocol-flow.html

- Extended query sequence: Parse, Bind, Describe, Execute, Sync. "The query string contained in a Parse message cannot include more than one SQL statement".
- Pipelining is a protocol feature: "Use of the extended query protocol allows pipelining, which means sending a series of queries without waiting for earlier ones to complete."
- Error recovery: "after an error, the backend will skip command messages until it finds Sync". Each Sync ends an implicit transaction ("each Sync ordinarily causes an implicit COMMIT if the preceding step(s) succeeded, or an implicit ROLLBACK if they failed").
- Completion accounting: "completion of the pipeline must be determined by counting ReadyForQuery messages and waiting for that to reach the number of Syncs sent."
- Simple Query is "approximately equivalent to the series Parse, Bind, portal Describe, Execute, Close, Sync" but accepts multiple statements and returns fewer messages.

Source: https://www.postgresql.org/docs/current/protocol-message-formats.html

- Frontend types: B Bind, C Close, D Describe, E Execute, F FunctionCall, H Flush, P Parse, Q Query, S Sync, X Terminate, p (PasswordMessage, GSSResponse, SASLInitialResponse, SASLResponse), f CopyFail, c CopyDone, d CopyData.
- Backend types: R Authentication (all variants), K BackendKeyData, 2 BindComplete, 3 CloseComplete, C CommandComplete, D DataRow, G CopyInResponse, H CopyOutResponse, W CopyBothResponse, I EmptyQueryResponse, E ErrorResponse, V FunctionCallResponse, v NegotiateProtocolVersion, n NoData, N NoticeResponse, A NotificationResponse, t ParameterDescription, S ParameterStatus, 1 ParseComplete, s PortalSuspended, Z ReadyForQuery, T RowDescription.
- DataRow: Int16 column count, then per column Int32 length (-1 = NULL) and the bytes. RowDescription: per field String name, Int32 table OID, Int16 attribute number, Int32 type OID, Int16 type size, Int32 type modifier, Int16 format code.

Source: https://www.postgresql.org/docs/current/sasl-authentication.html

- "PostgreSQL implements three SASL authentication mechanisms: SCRAM-SHA-256, SCRAM-SHA-256-PLUS, and OAUTHBEARER." SCRAM per RFC 7677 and RFC 5802. Channel binding type is tls-server-end-point. Messages: AuthenticationSASL, SASLInitialResponse, AuthenticationSASLContinue, SASLResponse, optional AuthenticationSASLFinal, AuthenticationOk.

Source: https://www.postgresql.org/docs/current/libpq-pipeline-mode.html

- libpq pipeline API arrived in PostgreSQL 14 but "is a client-side feature which doesn't require special server support and works on any server that supports the v3 extended query protocol."
- In pipeline mode PQexec, PQprepare, PQexecPrepared and the simple query protocol are errors; "command strings containing multiple SQL commands are disallowed, and so is COPY."
- Guidance: "Use pipelined commands when your application does lots of small INSERT, UPDATE and DELETE operations that can't easily be transformed into operations on sets, or into a COPY operation."

### 1.2 MySQL client/server protocol

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_packets.html

- Packet: payload_length (3 bytes), sequence_id (1 byte), payload. "Data between client and server is exchanged in packets of max 16MByte size." Payloads >= 2^24-1 are split: "the length is set to 2^24-1 (ff ff ff) and a additional packets are sent with the rest of the payload until the payload of a packet is less than 2^24-1 bytes."
- "The sequence-id is incremented with each packet and may wrap around. It starts at 0 and is reset to 0 when a new command begins in the Command Phase."

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_command_phase_ps.html

- Prepared statement commands: COM_STMT_PREPARE, COM_STMT_EXECUTE, COM_STMT_FETCH, COM_STMT_CLOSE, COM_STMT_RESET, COM_STMT_SEND_LONG_DATA; "a more compact resultset format that is used instead of Text Resultset". "Keep in mind that not all SQL statements can be prepared."

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_com_stmt_execute.html

- COM_STMT_EXECUTE: status 0x17, statement_id int<4>, flags int<1>, iteration_count int<4>, optional parameter_count (CLIENT_QUERY_ATTRIBUTES), null_bitmap "length= (paramater_count + 7) / 8", new_params_bind_flag int<1>, per parameter type int<2> (MSB = unsigned), optional parameter_name, values.

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_binary_resultset.html

- Binary row: header 0x00, NULL bitmap "length= (column_count + 7 + 2) / 8" with the offset of 2, then values. Integers little-endian by width (int<8>, int<4>, int<2>, int<1>), strings string<lenenc>, DOUBLE/FLOAT as 8 and 4 IEEE 754 bytes, DATE/DATETIME/TIMESTAMP length byte then 0, 4, 7 or 11 bytes, TIME 0, 8 or 12 bytes.

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_caching_sha2_authentication_exchanges.html

- caching_sha2_password fast path: Scramble = XOR(SHA256(password), SHA256(SHA256(SHA256(password)), Nonce)). Full path when the server has no cached hash: "server will signal client to switch to full authentication that involves sending password over a secure connection" (TLS, or RSA public key exchange).

Pipelining: the MySQL documentation pages fetched in this round do not state whether a client may send a second command before reading the first command's response. Treated as unverified until a source is found (round 2).

### 1.3 MongoDB wire protocol and BSON

Source: https://www.mongodb.com/docs/manual/reference/mongodb-wire-protocol/

- "The MongoDB Wire Protocol is a simple socket-based, request-response style protocol." "All integers in the MongoDB wire protocol use little-endian byte order".
- MsgHeader: int32 messageLength (includes itself), int32 requestID, int32 responseTo, int32 opCode.
- OP_MSG: header, uint32 flagBits, sections, optional CRC-32C checksum. Flags: bit 0 checksumPresent (implied by the checksum field), bit 1 moreToCome ("The receiver MUST NOT send another message until receiving one with moreToCome set to 0"; "Requests with the moreToCome bit set will not receive a reply"), bit 16 exhaustAllowed.
- Section kind 0: one BSON document. Section kind 1: int32 size, cstring identifier, BSON documents "sequenced back to back with no separators".
- OP_COMPRESSED: header, int32 originalOpcode, int32 uncompressedSize, uint8 compressorId, compressed bytes.
- OP_DELETE, OP_GET_MORE, OP_INSERT, OP_KILL_CURSORS, OP_QUERY (except hello/isMaster in the handshake), OP_REPLY, OP_UPDATE: "Deprecated in MongoDB 5.0. Removed in MongoDB 5.1."

Source: https://bsonspec.org/spec.html

- document ::= int32 e_list "\x00"; e_list ::= element e_list | "". "Each type must be serialized in little-endian format." string ::= int32 (byte*) "\x00" (length includes the terminator); cstring ::= (byte*) "\x00" and "MUST NOT contain unsigned_byte(0)".
- Type bytes used by this design: 0x01 double, 0x02 string, 0x03 document, 0x04 array, 0x05 binary, 0x07 ObjectId, 0x08 bool, 0x09 UTC datetime, 0x0A null, 0x10 int32, 0x11 timestamp, 0x12 int64, 0x13 decimal128.

Source: https://github.com/mongodb/specifications/blob/master/source/message/OP_MSG.md

- "All messages, including authentication messages, MUST use OP_MSG." (servers 3.6+). "A fully constructed OP_MSG MUST contain exactly one Payload Type 0, optionally any number of Payload Type 1 ... and optionally at most one Payload Type 3."
- "Bulk writes SHOULD use Payload Type 1, and MUST do so when the batch contains more than one entry." Size limits: "Each OP_MSG MUST NOT exceed the maxMessageSizeBytes"; documents bounded by maxBSONObjectSize; batches bounded by maxWriteBatchSize.
- exhaustAllowed only for getMore (4.2+) and hello (4.4+).

Source: https://github.com/mongodb/specifications/blob/master/source/connection-monitoring-and-pooling/connection-monitoring-and-pooling.md

- Defaults: maxPoolSize 100, minPoolSize 0, maxIdleTimeMS 0, maxConnecting 2. Connections are checked out for one operation and checked in afterwards; pool clear bumps a generation number that invalidates existing connections. "SHOULD have a background Thread" that maintains minPoolSize and reaps perished connections; that work "MUST NOT block any application threads". Eleven monitoring events are required.

Source: https://github.com/mongodb/specifications/blob/master/source/auth/auth.md

- Mechanism negotiation through hello with saslSupportedMechs; "If SCRAM-SHA-256 is present in the list of mechanism, then it MUST be used as the default; otherwise, SCRAM-SHA-1 MUST be used as the default." SCRAM-SHA-256 passwords "MUST be prepared with SASLprep". Other mechanisms: MONGODB-X509, MONGODB-AWS, MONGODB-OIDC. Speculative authentication inside the hello handshake is allowed.

### 1.4 Redis RESP2 and RESP3

Source: https://redis.io/docs/latest/develop/reference/protocol-spec/

- First byte selects the type: + simple string, - simple error, : integer, $ bulk string, * array (RESP2); _ null, # boolean, , double, ( big number, ! bulk error, = verbatim string, % map, | attribute, ~ set, > push (RESP3). CRLF terminates every part. Streamed strings ($?) and streamed aggregates (*?, ~?, %?) exist in the RESP3 spec; "Redis doesn't emit streamed strings, because its RESP3 support excludes streamed types".
- Handshake: "New RESP connections should begin the session by calling the HELLO command." HELLO 3 upgrades; a RESP2-only server answers "-ERR unknown command 'HELLO'"; a too-high version answers -NOPROTO. Default is RESP2.
- Pipelining: "Pipelining is supported, so multiple commands can be sent with a single write operation by the client. The client can skip reading replies and continue to send the commands one after the other. All the replies can be read at the end."
- Push: "pushed data may appear before or after a command's reply, as well as by itself"; attributes "can appear anywhere before a valid part of the protocol identifying a given type" and must be surfaced to the caller separately.
- Parser guidance: length prefixes let a parser read bulk data "with a single read operation that doesn't inspect the payload in any way".

Source: https://redis.io/docs/latest/develop/using-commands/pipelining/

- Pipelining "eventually reaches 10 times the baseline obtained without pipelining" because "many commands are usually read with a single read() system call, and multiple replies are delivered with a single write() system call". The page recommends batches of about 10k commands so that server-side reply queues stay bounded. Loopback Ruby example: 1.185 s unpipelined versus 0.251 s pipelined for 10,000 PINGs.

### 1.5 SQLite C API

Source: https://sqlite.org/cintro.html

- Two core objects (sqlite3, sqlite3_stmt); six core routines: sqlite3_open, sqlite3_prepare, sqlite3_step, sqlite3_column, sqlite3_finalize, sqlite3_close. "Think of each SQL statement as a small computer program. The purpose of sqlite3_prepare() is to compile that program into object code." sqlite3_reset rewinds a statement for reuse; parameters (?, :AAA, $AAA) let "the same prepared statement to be evaluated multiple times".

Source: https://sqlite.org/c3ref/prepare.html

- v2/v3 "are recommended for all new programs"; with v2/v3 "sqlite3_step() will automatically recompile the SQL statement and try to run it again" on schema change instead of returning SQLITE_SCHEMA. sqlite3_prepare_v3 adds prepFlags (SQLITE_PREPARE_* flags). pzTail points past the first statement, which supports multi-statement scripts.

Source: https://sqlite.org/threadsafe.html

- Modes: single-thread ("unsafe to use in more than a single thread at once"), multi-thread (safe "provided that no single database connection nor any object derived from database connection, such as a prepared statement, is used in two or more threads at the same time"), serialized. Selected at compile time (SQLITE_THREADSAFE 0/1/2), start time (sqlite3_config), or per connection (SQLITE_OPEN_NOMUTEX, SQLITE_OPEN_FULLMUTEX). "The default mode is serialized."

### 1.6 MySQL and MariaDB pipelining (round 2)

Source: https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_connection_phase.html

- Handshake: server sends Protocol::Handshake (server version, capability flags, auth data and plugin name); "The client should only announce the capabilities in the Protocol::HandshakeResponse that it has in common with the server." TLS: Handshake, then Protocol::SSLRequest, "The usual SSL exchange leading to establishing SSL connection", then HandshakeResponse inside TLS. Auth switch: "Server sends to client the Protocol::AuthSwitchRequest which contains the name of the client authentication method to be used and the first authentication payload."

Source: https://mariadb.com/docs/server/reference/clientserver-protocol/3-binary-protocol-prepared-statements/com_stmt_execute

- COM_STMT_EXECUTE header 0x17, statement id int<4>, flags int<1>, iteration count int<4>, then null bitmap, optional types, binary values. Statement id 0xFFFFFFFF "can be used to indicate to use the last statement prepared on current connection if no COM_STMT_PREPARE has failed since", which lets a client send COM_STMT_PREPARE and COM_STMT_EXECUTE back to back in one write (MariaDB only; the MySQL page for COM_STMT_EXECUTE does not describe this value).

Source: https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-pipelining

- MariaDB Connector/Node.js "sends queries one after another, preserving the FIFO order" without waiting for responses; "the process is optimistic, meaning that if an error occurs on the first or second command, the following commands have already been sent to the database."

Conclusion for the design: the classic MySQL protocol has no pipelining feature of its own; commands are request-response with sequence ids that reset per command (section 1.2). Clients may still write several commands before reading responses because responses come back in order, which is what MariaDB's connectors do. Server-side ordering of responses under such optimistic sends is inferred from the connector documentation, not from a MySQL protocol page; treat as verified for MariaDB and unverified for MySQL server behavior under concurrent COM_QUERY.

### 1.7 SQLite prepare flags (round 2)

Source: https://sqlite.org/c3ref/c_prepare_dont_log.html

- SQLITE_PREPARE_PERSISTENT is "a hint to the query planner that the prepared statement will be retained for a long time and probably reused many times"; the implementation then avoids lookaside memory. Other flags: NORMALIZE (no-op), NO_VTAB, DONT_LOG, FROM_DDL. A statement cache should pass SQLITE_PREPARE_PERSISTENT through sqlite3_prepare_v3.

## 2. Crate facts (fetched from docs.rs and GitHub)

| Crate | Version (date) | Notes from docs |
|---|---|---|
| tokio-postgres | 0.7.18 (2026-09-03) | "Pipelining happens automatically when futures are polled concurrently (for example, by using the futures join combinator)." Client/Connection split; `runtime` feature optional so any AsyncRead + AsyncWrite works; TLS through postgres-openssl or postgres-native-tls. No built-in statement cache documented. |
| postgres-protocol | 0.6.12 | "Low level Postgres protocol APIs ... including message and value serialization and deserialization"; SCRAM helpers; deps bytes, base64, hmac, sha2, md-5, stringprep, rand, fallible-iterator, memchr, byteorder; requires client_encoding UTF8; no no_std support indicated. |
| xitca-postgres | 0.4.0 (2026-09-14) | Claims "async/await native", "less heap allocation on query", "zero copy row data parsing", QUIC transport; disadvantages listed by the author: "no built in back pressure mechanism" and lifetimes in public types. Pipeline API details not in the crate root page (round 2). |
| mysql_async | 0.37.1 (2026-09-01) | Pool is Send + Sync and lazy; per-connection statement cache sized by `stmt_cache_size` (DEFAULT_STMT_CACHE_SIZE); text protocol via query*, binary protocol via exec* ("Prepared statements is the only way to pass rust value to the MySql server"); TLS via native-tls or rustls (aws-lc-rs); no pipelining documented. |
| mysql_common | 0.38.2 (2026-07-24) | "basic MySql protocol primitives"; packet parsers, Value and Row types, auth plugins (caching_sha2_password, mysql_native_password, sha256_password); sha1, sha2, getrandom, flate2 deps; no no_std support indicated. |
| mongodb | 3.9.1 (2026-09-10) | tokio-only async API; `sync` feature; MSRV 1.88.0; bson 2.x by default, `bson-3` feature for 3.x; zlib, zstd, snappy compression features; rustls (ring) default or openssl. Supports server 4.4+. |
| bson | 3.1.0 (2026-08-31) | Document (ordered map), Bson enum, RawDocument ("A slice of a BSON document (akin to std::str)"), RawDocumentBuf, RawBson for zero-copy access; serde optional; no no_std support indicated. |
| fred | 10.1.0 (2026-07-26) | RESP2 and RESP3, pipelining and "Automatic pipelining", clustered, centralized and sentinel deployments, rustls or native-tls, experimental glommio and monoio runtimes, "Zero-copy frame parsing" through redis-protocol. |
| redis-protocol | 6.0.0 (2026-09-27) | "no_std builds are supported by disabling the std feature. However, a few optional dependencies must be activated as a substitute." (libm, hashbrown, alloc). OwnedFrame, BytesFrame, RangeFrame types; decode_bytes_mut avoids copies; nom 7 parser. |
| redis (redis-rs) | 1.7.1 (2026-09-25) | RESP3 via `?protocol=resp3`; push messages through set_push_sender; tokio and smol runtimes; "All async connections are cheap to clone, and clones can be used concurrently from multiple threads"; MultiplexedConnection pipelines automatically; cluster, sentinel, connection-manager features. |
| rusqlite | 0.40.2 (2026-08-08) | Supports SQLite 3.45.3 or newer; bundled SQLite is 3.53.2 per README (bindgen file shows 3.53.4); Connection is Send but not Sync ("Rusqlite enforces thread-safety at compile time, so additional locking is not needed"); default open flags include SQLITE_OPEN_NO_MUTEX; prepare_cached with set_prepared_statement_cache_capacity; default busy timeout 5000 ms. |
| libsqlite3-sys | 0.38.2 (2026-08-08) | Features bundled, bundled-windows, bundled-sqlcipher(-vendored-openssl), sqlcipher, buildtime_bindgen, session, preupdate_hook, unlock_notify, loadable_extension, wasm32-wasi-vfs; links via cc, pkg-config or vcpkg; MSRV 1.88.0. |
| turso | 0.8.1 (2026-09-29) | Async API (Builder, Database, Connection); docs.rs failed to build 0.8.1 (last built 0.8.0-pre.12). Repository: 24.4k stars, MIT, tracks SQLite 3.50.4, "we have not yet reached 1.0", "Turso powers production applications today at multiple organizations". |

Turso compatibility (source: https://github.com/tursodatabase/turso/blob/main/COMPAT.md): about 40 C API functions supported, about 80 unsupported including sqlite3_create_function, sqlite3_create_module, backup API, BLOB I/O, custom collations, loadable extensions; WAL only (no rollback journal modes); text must be valid UTF-8; FTS3/4/5 replaced by a Tantivy-based FTS; window functions partial; recursive CTEs unsupported.

### 2.1 no_std status of the candidate codec crates (round 2, from Cargo manifests and lib.rs)

| Crate | Evidence | no_std? |
|---|---|---|
| postgres-protocol | Cargo.toml (https://raw.githubusercontent.com/sfackler/rust-postgres/master/postgres-protocol/Cargo.toml): features are only `default = []` and `js = ["getrandom/wasm_js"]`; deps base64, byteorder, bytes, fallible-iterator, hmac, md-5, memchr, rand, sha2, stringprep. | No |
| mysql_common | Cargo.toml (https://raw.githubusercontent.com/blackbeam/rust_mysql_common/master/Cargo.toml): default features `["flate2/zlib", "derive"]`; mandatory sha1, sha2, base64, bitflags, byteorder, bytes, uuid, serde, serde_json, regex; optional curve25519-dalek, ed25519-dalek, pbkdf2, zstd. No std or no_std feature. | No |
| bson 3.1.0 | lib.rs (https://raw.githubusercontent.com/mongodb/bson-rust/main/src/lib.rs) has no `#![no_std]`; Cargo.toml deps ahash, indexmap, rand, uuid (v4), time; features are date/serde integrations only. | No |
| redis-protocol 6.0.0 | docs.rs: "no_std builds are supported by disabling the std feature" with libm, hashbrown, alloc substitutes (section 2). | Yes |
| rusqlite / libsqlite3-sys | C library through FFI; std-only wrapper. | No (not applicable) |

### 2.2 Driver internals (round 2, from source)

tokio-postgres (https://raw.githubusercontent.com/sfackler/rust-postgres/master/tokio-postgres/src/{connection,codec,prepare,statement,client}.rs):

- Connection owns `receiver: mpsc::UnboundedReceiver<Request>`; each Request carries `messages: RequestMessages` and a `sender: mpsc::Sender<BackendMessages>`. Responses are matched by order: `responses: VecDeque<Response>` and `self.responses.pop_front()`. A `pending_responses` queue holds decoded messages that could not be delivered under back pressure.
- The codec groups backend messages into a `BackendMessages` chunk and ends the chunk at ReadyForQuery: `if header.tag() == backend::READY_FOR_QUERY_TAG { request_complete = true; break; }`. NoticeResponse, NotificationResponse and ParameterStatus are delivered out of band as `BackendMessage::Async`.
- Every request therefore ends with its own Sync; pipelining is one Sync per request, matched FIFO. This is the same shape as libpq pipeline mode with a sync per query.
- Statement names come from a process-wide counter: `format!("s{}", NEXT_ID.fetch_add(1, Ordering::SeqCst))`; prepare sends Parse, Describe('S'), Sync and reads ParseComplete, ParameterDescription, RowDescription or NoData. Unknown OIDs trigger catalog lookups (with a pg_range fallback for old servers).
- `impl Drop for StatementInner` sends Close('S', name) plus Sync through a `Weak<InnerClient>`; unnamed statements skip it. The Client caches only type info ("A cache of type info and prepared statements for fetching type info"); user statements are not cached, and `query(&str)` prepares implicitly on every call. `query_typed` avoids "three round trips (for prepare, execute, and close)" by taking parameter types from the caller.

may_postgres (https://raw.githubusercontent.com/Xudong-Huang/may_postgres/master/src/client.rs): "Porting from rust-postgres for stackful coroutine." `send()` tags each request (`let tag = self.co_ch.tag()`), pushes it to the connection coroutine, and returns a RowStream that reads lazily; responses are routed by tag (`if messages.tag != self.tag { continue; }`), so a caller can issue many queries before reading any row.

xitca-postgres (https://docs.rs/xitca-postgres/latest/xitca_postgres/ and https://raw.githubusercontent.com/HFQR/xitca-web/main/postgres/src/driver.rs): the Client "interacts with [the Driver] using channel and message for IO operation and de/encoding of postgres protocol in byte format"; the driver is spawned (`tokio::spawn(drv.into_future())`); `GenericDriver::new(io, cfg.get_max_in_flight_requests())` bounds the in-flight queue, which is the back-pressure knob tokio-postgres lacks. The crate root lists "built in connection pool with pipelining support enabled". A dedicated Pipeline type was not found on docs.rs 0.4.0 or in the source tree listing (driver/, execute/, pool/, query/, row/, transaction/); its exact API is unverified.

Drogon PgBatchConnection (https://raw.githubusercontent.com/drogonframework/drogon/master/orm_lib/src/postgresql_impl/PgBatchConnection.cc; CMake `LIBPQ_BATCH_MODE` defaults ON and try_compile selects PgBatchConnection.cc when libpq supports it): calls `PQenterPipelineMode` right after connecting, sends with `PQsendPrepare` and `PQsendQueryPrepared`, ends a batch with `PQpipelineSync` when `batchSqlCommands_.size() == 1 || cmd->sql_.length() > 1024 || batchCount_ > maxBatchCount` or when a modifying statement is seen, keeps `preparedStatementsMap_` keyed by SQL text, and matches results FIFO from `batchCommandsForWaitingResults_`. The TechEmpower drogon.dockerfile pins commit 96919df4 and builds with `-DCMAKE_BUILD_TYPE=release -DCMAKE_CXX_FLAGS=-flto` plus mimalloc; the queries controller (QueriesCtrlRaw.cc) fires all N SELECTs at once through `getFastDbClient()` and counts callbacks down to zero.

mongodb Rust driver (https://docs.rs/mongodb/latest/mongodb/struct.Client.html and .../options/struct.ClientOptions.html): Client is Arc-based and "cheap to clone"; one pool per server; `max_pool_size` default 10, `min_pool_size` 0, `max_connecting` 2, idle connections not closed by default, `connect_timeout` 10 s, `server_selection_timeout` 30 s; `Client::shutdown()` waits for outstanding handles. The source tree could not be fetched (GitHub tree and raw src/cmap paths returned 404 in this run), so the per-connection concurrency model is taken from the CMAP specification (one operation per checked-out connection) rather than from the driver code.

fred (https://raw.githubusercontent.com/aembke/fred.rs/main/CHANGELOG.md, 10.0.0): "The `auto_pipeline` config option was removed. All clients now automatically pipeline commands"; "All transactions are now pipelined automatically"; "Write throughput is improved by a factor of 3-5x depending on the use case"; BackpressureConfig removed in favor of `max_command_buffer_len`. PerformanceConfig (docs.rs) still has `max_feed_count` default 200 ("The maximum number of frames that will be fed to a socket before flushing") and `blocking_encode_threshold` 50,000,000 bytes. Runtimes: tokio, experimental glommio, monoio; TLS through native-tls or rustls.

redis-rs MultiplexedConnection (https://docs.rs/redis/latest/redis/aio/struct.MultiplexedConnection.html): "A connection object which can be cloned, allowing requests to be be sent concurrently on the same underlying connection"; the constructor returns the connection plus a driver future to spawn; dropping a request future does not cancel the server-side command, so "in case of blocking commands, the underlying connection resource might not be released"; RESP3 push messages go to a configured push sender.

Turso (https://github.com/tursodatabase/turso, /releases, bindings/rust/README.md, COMPAT.md): "an in-process SQL database written in Rust, compatible with SQLite", formerly codenamed Limbo (rename confirmed by search results from turso.tech); releases 0.8.0 on 2026-09-28 (experimental PostgreSQL wire support, more window functions) and 0.8.1 on 2026-09-29 (a CI pin); FAQ: "we have not yet reached 1.0" and "some features are explicitly marked experimental"; bindings for Rust, JavaScript, Python, Go, Java, .NET and WebAssembly; tested with "a native Deterministic Simulation Testing suite and Antithesis"; the Rust binding README still documents `turso 0.4.3`, so its published example lags the release line.

## 3. TechEmpower database code (fetched)

- may-minihttp (https://github.com/TechEmpower/FrameworkBenchmarks/blob/master/frameworks/Rust/may-minihttp/src/main.rs): uses may_postgres; one connection per core (`(0..size).map(|_| may::go!(move || PgConnection::new(db_url)))`); statements prepared once at connection setup (`client.prepare("SELECT * FROM world WHERE id=$1")`), 500 pre-compiled UPDATE statements for batch sizes 1..500; the queries test pushes `query_raw` results into a SmallVec and iterates them afterwards (all requests written before any response is read).
- xitca-web (https://github.com/TechEmpower/FrameworkBenchmarks/blob/master/frameworks/Rust/xitca-web/src/db.rs): xitca-postgres, named statements FORTUNE_STMT, WORLD_STMT, UPDATE_STMT prepared at startup; updates use a single UPDATE with unnest($1), unnest($2) arrays; queries test creates a vector of query futures then awaits them.
- Drogon (https://github.com/TechEmpower/FrameworkBenchmarks/blob/master/frameworks/C++/drogon/drogon_benchmark/config.json): "rdbms": "postgreSQL", "connection_number": 1, "is_fast": true, "threads_num": 0 (one IO thread per processor). With is_fast the client is bound per IO thread, so this is also a connection-per-core layout.
- The TechEmpower results page is JavaScript-rendered and returned no data through fetch; tfb-status.techempower.com refused the connection.

### 3.1 Measurement over the local results file (run in this task)

The working folder holds round23-ph.json (metadata: name "Continuous Benchmarking Run 2025-01-30 18:47:41", uuid 91a66052-9d86-446c-b31a-eadbd669ed08, environmentDescription "Citrine", concurrency levels 16 to 512, query intervals 1, 5, 10, 15, 20). Whether this file is the exact run published as Round 23 is unverified (the earlier run that saved it did not record the download URL). I ran tfb-extract.js over it; "best" is the highest requests per second across concurrency levels, and the rank is among all entries in that test.

| Test | Entry | Rank | Best rps | Client used |
|---|---|---|---|---|
| db | xitca-web-unrealistic | 1 | 1,379,909 | xitca-postgres |
| db | may-minihttp | 3 | 1,357,757 | may_postgres |
| db | ntex-db-compio | 5 | 1,334,739 | tokio-postgres per fetched db.rs |
| db | ntex-db | 8 | 1,294,048 | tokio-postgres |
| db | xitca-web | 10 | 1,266,381 | xitca-postgres |
| db | axum-pg | 15 | 1,190,767 | tokio-postgres (unverified, not fetched) |
| db | drogon-core | 31 | 1,033,970 | libpq pipeline mode |
| db | drogon | 33 | 1,014,116 | libpq pipeline mode |
| db | axum-mongo | 138 | 458,312 | mongodb driver |
| db | axum-pg-pool | 405 | 70,385 | pooled client (unverified which) |
| db | axum-sqlx | 454 | 41,106 | sqlx |
| query (20 queries) | may-minihttp | 1 | 88,108 at 20 | may_postgres |
| query (20 queries) | ntex-db | 2 | 88,589 at 20 | tokio-postgres |
| query (20 queries) | drogon | 32 | 59,192 at 20 | libpq pipeline mode |
| query (20 queries) | axum-mongo | 123 | 19,823 at 20 | mongodb driver |
| update (20 queries) | xitca-web-unrealistic | 1 | 63,029 at 20 | xitca-postgres |
| update (20 queries) | may-minihttp | 4 | 58,532 at 20 | may_postgres |
| update (20 queries) | drogon | 19 | 24,034 at 20 | libpq pipeline mode |
| fortune | may-minihttp | 1 | 1,327,379 | may_postgres |
| fortune | drogon-core | 13 | 1,042,653 | libpq pipeline mode |

Readings: (a) the top PostgreSQL entries are within about 10 percent of each other whether they use may_postgres, xitca-postgres or plain tokio-postgres, so the layout (one persistent connection per core, statements prepared once, all requests written before responses are read) matters more than the crate; (b) Drogon trails the top Rust entries by 25 to 30 percent on db and by a factor of 1.5 on query at 20 queries and 2.4 on update at 20 queries, so "faster than Drogon" is reachable on the database tests with the layout above; (c) entries that check a connection out of a pool per request without pipelining (axum-pg-pool, axum-sqlx, salvo-diesel) are 17 to 30 times slower on db, which is the failure mode to design against; (d) MongoDB entries top out around 458k on db, about a third of PostgreSQL, with no pipelining on the wire.

## 4. Local context (read from disk)

- zero-edge (pamoja) workspace has 37 crates under crates/ (pamoja-core, pamoja-codec, pamoja-ffi, pamoja-security, xtask, ...), which is the layout the owner wants replicated.
- zero-server adapters today: lib/orm/adapters/{memory,mongo,mysql,postgres,redis,sqlite,json,sql-base}.js. The adapter surface (sql-base plus per-engine adapters) is the transferable design; the JS bodies are not.

## 5. Decisions: in-house no_std codec versus crate, per protocol

Decision rule applied: the codec (framing, message encode and decode, value encoding, auth message construction) is a no_std + alloc crate reused by the Node, Python and C# bindings and by the server core; the driver (sockets, TLS, queues, caches, pools) is a separate std crate. A third-party crate is only worth taking when it is already no_std, small, and does not drag crypto or serde into the tree.

| Protocol | Codec decision | Reason (sourced above) |
|---|---|---|
| PostgreSQL v3 | In-house no_std codec (`zero-pg-proto`) | postgres-protocol is std-only and pulls rand, base64, hmac, sha2, md-5, stringprep (2.1). The framing is one type byte plus Int32 length (1.1); the message catalog is about 40 message types (1.1); binary encodings are network-order fixed-width. SCRAM-SHA-256 needs SHA-256, HMAC and PBKDF2 from the core's own security crate, and SASLprep can be restricted to ASCII passwords at first with a documented limitation. Protocol 3.2 negotiation (NegotiateProtocolVersion) is small. |
| MySQL and MariaDB | In-house no_std codec (`zero-mysql-proto`) | mysql_common is std-only with flate2, serde, serde_json, regex and uuid on by default (2.1). Packet framing is 3-byte length plus sequence id with the 0xFFFFFF continuation rule (1.2); text and binary result sets, lenenc integers and the binary row NULL bitmap with offset 2 are fully specified (1.2). Auth: mysql_native_password (SHA-1) and caching_sha2_password fast path (SHA-256) from the security crate; the full path is served only over TLS or a Unix socket, so no RSA-OAEP implementation is needed in the first release (1.2). MariaDB additions: statement id 0xFFFFFFFF for prepare+execute in one write (1.6). Compression (CLIENT_COMPRESS) is off by default and out of scope for the codec. |
| MongoDB | In-house no_std BSON + OP_MSG codec (`zero-bson`, `zero-mongo-proto`) | bson 3.x is std-only with ahash, indexmap, uuid, time and rand (2.1). BSON is a short grammar with little-endian fixed encodings (1.3); OP_MSG needs a 16-byte header, flag bits, section kind 0 and 1, and an optional CRC-32C (1.3). The codec can expose a zero-copy raw document view (the same shape as bson::RawDocument) so bindings can hand documents across FFI without re-encoding. Decimal128 arithmetic is not needed; only the 16-byte carry is. |
| Redis RESP2/RESP3 | In-house no_std codec (`zero-resp`), with redis-protocol as the documented fallback | redis-protocol already supports no_std with libm and hashbrown (2, 2.1), so it is the one crate that would pass the rule. It is still rejected for the first release because it brings nom 7 and its own frame enum, while RESP3 is the smallest of the five grammars (14 type bytes, CRLF terminated, length-prefixed bulk payloads that a parser can copy "with a single read operation that doesn't inspect the payload in any way", 1.4). One in-house codec family shares one fuzz harness and one conformance-vector format across the bindings, which is what the pamoja layout expects. If the in-house RESP crate slips, redis-protocol is a drop-in with acceptable dependencies. |
| SQLite | No codec; bundled C library through libsqlite3-sys `bundled` (SQLite 3.53.x) behind a thin safe wrapper; turso as a feature-gated optional engine, not the default | See section 6. |

## 6. SQLite engine decision

Choose libsqlite3-sys with the `bundled` feature (2), compiled with the security options the SQLite project recommends for untrusted SQL (source: https://www.sqlite.org/security.html): `SQLITE_MAX_ALLOCATION_SIZE` at or below 100,000,000, `SQLITE_PRINTF_PRECISION_LIMIT=100000`, `SQLITE_TRUSTED_SCHEMA=0`, plus run time `SQLITE_DBCONFIG_DEFENSIVE`, `sqlite3_hard_heap_limit64`, `sqlite3_limit` reductions, `PRAGMA trusted_schema=OFF`, and `SQLITE_DBCONFIG_ENABLE_TRIGGER` and `ENABLE_VIEW` off when unused. Thread mode: build with SQLITE_THREADSAFE=2 (multi-thread) and open with SQLITE_OPEN_NOMUTEX, then enforce single-owner connections in Rust the way rusqlite does (Connection is Send, not Sync; 1.5, 2). Prepared statements: an LRU keyed by SQL text per connection, compiled with sqlite3_prepare_v3 and SQLITE_PREPARE_PERSISTENT (1.7), reset after each use, like rusqlite's prepare_cached (2).

Why not turso as the default now: 0.8.1 is one day old, the project says "we have not yet reached 1.0", COMPAT.md lists about 80 unsupported C API functions including sqlite3_create_function and the backup API, recursive CTEs are unsupported, journal mode is WAL only (2), and the Rust binding README still documents 0.4.3 (2.2). The zero-server sqlite adapter's users expect the SQLite feature set. Turso does bring what the owner wants (memory safety, native async I/O, MVCC, DST-tested), so the wrapper trait should be engine-agnostic from day one and a `sqlite-turso` feature can be added when turso reaches 1.0 or when COMPAT.md covers the functions the adapter uses.

Memory safety note: the bundled C library is the one deliberate exception to the memory-safe core. The unsafe surface is confined to the wrapper crate, the library is built with the hardening options above, and the project's own test discipline is the mitigation; this exception should be recorded in the design document.

Non-blocking I/O note: the SQLite C API is synchronous. The driver runs each connection on a dedicated thread (or the runtime's blocking pool) and exposes an async facade through a bounded channel; WAL mode allows readers to proceed while one writer holds the lock (unverified from this task's fetches; the WAL page was not fetched).

## 7. Pipelining, connection-per-core, and prepared statement caches

Layout (from 3, 3.1 and 2.2): each core runs one I/O driver task per database endpoint that owns one socket, one write buffer, one FIFO of in-flight requests, and one statement cache. Request handlers on that core enqueue encoded requests and receive a lazily read response stream; the driver writes everything queued in one syscall and reads replies in order. Cross-core sharing is not needed for the TechEmpower workloads and would reintroduce locks; a small per-core pool (default 1, configurable) covers long transactions that would otherwise block the single socket.

- PostgreSQL: extended protocol only for parameterized work (Parse, Bind, Describe, Execute, Sync); one Sync per logical request so a failed request only skips to its own Sync (1.1) and results are matched by counting ReadyForQuery (1.1, 2.2). Bounded in-flight count per connection (xitca's `max_in_flight_requests` idea, 2.2) is the back-pressure knob. Statement cache: per-connection LRU keyed by (SQL text, parameter OIDs), statement names "s{n}" from a per-connection counter, Close('S') on eviction, default capacity 256 (capacity is a judgment, unverified). Cache misses use the one-round-trip Parse+Bind+Execute+Sync path with caller-supplied types where known (the query_typed idea, 2.2); unknown result OIDs are resolved through a per-connection type map filled from pg_type. Binary format code 1 for all parameters and results with in-house decoders for the ~20 common OIDs; text fallback for the rest. Implicit transactions per Sync (1.1) mean explicit BEGIN/COMMIT must be pipelined with their statements. COPY and LISTEN/NOTIFY are supported but never interleaved with pipelined requests (libpq forbids COPY in pipeline mode, 1.1).
- MySQL and MariaDB: request-response per command with sequence id reset per command (1.2). Optimistic in-order sending of several commands before reading (what MariaDB connectors do, 1.6) is implemented in the driver but defaults off for MySQL and on for MariaDB, because MySQL server behavior under back-to-back commands is unverified. Statement cache: per-connection LRU keyed by SQL text over COM_STMT_PREPARE ids, COM_STMT_CLOSE on eviction, default 64 (mysql_async ships a stmt_cache_size default; the exact value was not captured, unverified). CLIENT_DEPRECATE_EOF and CLIENT_PROTOCOL_41 always requested; CLIENT_QUERY_ATTRIBUTES optional (1.6). Binary result sets for prepared statements (1.2). MariaDB fast path: COM_STMT_PREPARE followed by COM_STMT_EXECUTE with id 0xFFFFFFFF in one write (1.6).
- MongoDB: request-response with requestID/responseTo (1.3); the driver never has more than one command in flight per connection (CMAP model, 1.3), so concurrency comes from a per-core pool sized by `maxPoolSize` (spec default 100; the Rust driver defaults to 10, 2.2) with `maxConnecting` 2 during warm-up. OP_MSG with payload type 1 for bulk writes, exhaustAllowed for getMore, moreToCome rules honored (1.3). Handshake: hello with saslSupportedMechs, SCRAM-SHA-256 preferred, speculative authentication in the hello (1.3). No statement cache concept; instead a per-core cache of pre-encoded command prefixes (database name, collection name) is a small win (judgment, unverified). Scope for the first release: standalone and replica-set primary discovery from hello, retryable reads/writes and full SDAM deferred.
- Redis: pipelining is native (1.4); the per-core connection carries a FIFO of pending replies and flushes after N frames or at the end of the poll cycle (fred's max_feed_count 200 is the reference, 2.2). RESP3 by default through HELLO 3 with a RESP2 fallback on -ERR unknown command (1.4). Push frames (>) go to a per-connection subscriber channel and never consume a pending reply slot; attributes (|) are stripped and attached to the next reply (1.4). Blocking commands (BLPOP, XREAD BLOCK) get a dedicated connection so they do not stall the pipeline (redis-rs caveat, 2.2). Cluster (MOVED/ASK slot map) and Sentinel are second-release features.
- SQLite: no wire; per-connection statement cache as in section 6.

## 8. Effort estimates (judgment, not sourced)

Assumptions: one senior Rust engineer per line; each codec is a no_std + alloc crate with encode/decode round-trip tests, conformance vectors shared with the three bindings, and a cargo-fuzz target; TLS, SHA-1/SHA-256/HMAC/PBKDF2 and the runtime come from the core's existing crates; the driver crates expose one common `Value` and row model that the FFI layer already carries; bindings work is excluded. Ranges are engineer-weeks.

| Driver | Codec crate | Driver crate | Total | Notes |
|---|---|---|---|---|
| PostgreSQL | 3 to 4 | 4 to 6 | 7 to 10 | Message catalog, binary types, SCRAM; driver: pipeline queue, statement cache, transactions, COPY, LISTEN/NOTIFY, cancel, TLS negotiation, protocol 3.2 negotiation. |
| MySQL and MariaDB | 4 to 5 | 4 to 5 | 8 to 10 | Two result set formats, lenenc, three auth plugins (fast path only for caching_sha2), 0xFFFFFF continuation; driver: statement cache, optimistic sends, MariaDB execute-direct path. Add 1 to 2 weeks if RSA full auth over plaintext is required. |
| MongoDB | 3 to 4 (BSON + OP_MSG) | 6 to 8 | 9 to 12 | Driver scope: hello handshake, SCRAM, CRUD, aggregate, cursors, getMore and killCursors, sessions and transactions, primary discovery, OP_COMPRESSED optional. Full SDAM, retryable writes and change streams add 4 to 6. |
| Redis | 1 to 2 | 3 to 4 | 4 to 6 | RESP2/3, HELLO, pipelining, pub/sub push routing, blocking-command isolation. Cluster and Sentinel add 2 to 3. |
| SQLite | 0 | 3 to 4 | 3 to 4 | Safe wrapper over libsqlite3-sys bundled with hardening options, statement cache, blocking offload, WAL setup, backup optional. Turso feature-gate spike: 1 week when revisited. |
| Shared | 3 to 4 | | 3 to 4 | Common Value/Row model, FFI-safe row buffers, adapter trait mirroring zero-server's sql-base surface, test harness against Docker databases. |

Sum: 34 to 46 engineer-weeks for all five with the first-release scopes above, which lines up with the transferable parts of the current zero-server ORM adapter suite (memory, mongo, mysql, postgres, redis, sqlite, json, sql-base).

## 9. Unverified items carried forward

- Whether MySQL server (as opposed to MariaDB) processes back-to-back COM_QUERY or COM_STMT_EXECUTE packets in order without a protocol-level statement; the MySQL protocol pages fetched do not say.
- xitca-postgres's Pipeline API shape (only "pipelining support enabled" and `max_in_flight_requests` were confirmed).
- The mongodb Rust driver's per-connection concurrency (source not fetchable this run; taken from the CMAP specification).
- Whether round23-ph.json is the exact run published as Round 23; it is a Citrine continuous run dated 2025-01-30.
- Which client axum-pg and axum-pg-pool use (their source was not fetched).
- mysql_async's default stmt_cache_size value.
- SQLite WAL concurrent-reader semantics (page not fetched).
- All effort numbers in section 8.
