# Changes to the vendored `oracledb` crate

Upstream: https://github.com/oracle/rust-oracledb, version 26.0.0-beta.5, licence `UPL-1.0 OR Apache-2.0`
(`LICENSE.txt`, `NOTICE.txt`, `README.md` are the upstream files). Only the library is vendored: the user
guide (`doc/`), tests, examples and helper binaries of the upstream crate were left out, and `Cargo.toml` is
trimmed accordingly. The crate is a path dependency of `crates/dbcore` and is **not** a workspace member
(`exclude = ["vendor"]` in the root `Cargo.toml`), so `cargo clippy --workspace` does not lint it.

Why: Prometeo DataGrip needs to cancel a running statement (the console's Stop button), and the public API of
the crate has no way to do it from another thread.

| file | change |
|---|---|
| `src/cancel.rs` (new) | `CancelHandle`: writes the in-band break marker (packet type MARKER, `MARKER_TYPE_INTERRUPT`) to a clone of the connection's TCP socket. Does nothing when no call is running. |
| `src/client/mod.rs` | `BreakState` shared with the handle (a call is running / a break was sent and is not answered yet); `perform_round_trip` marks the call; a break that arrives after the call finished leaves a marker packet in the socket, which is consumed before the next call (otherwise ORA-01013 would hit it); `reset()` accepts a reset marker that was already received (the server answers a break with the reset marker itself, the original code always waited for a second one and hung). `Client::cancel_handle()`, `Client::in_transaction()`. |
| `src/connection/conn_impl.rs`, `src/connection/mod.rs` | `Connection::cancel_handle()` (fails for TLS connections: a marker cannot be injected into the TLS stream) and `Connection::in_transaction()` (the "transaction in progress" flag the server sets in every response). |
| `src/transport.rs` | `Transport::cancel_socket()`. |
| `src/lib.rs` | `mod cancel; pub use cancel::CancelHandle;`; the `guide` module (it includes the not vendored `doc/` files) is removed. |
| `src/messages/auth.rs`, `src/constants.rs`, `src/error.rs`, `Cargo.toml` (`sha1`) | Logon with **11G password verifiers** (upstream only knew 12C and panicked on the missing `AUTH_PBKDF2_VGEN_COUNT`, seen as "connection has been closed" / ORA-01017 on old accounts). Same algorithm as python-oracledb thin mode: the verifier type is the flags of the `AUTH_VFR_DATA` pair; 11G hash = SHA1(password ‖ vfr_data) + 4 zero bytes (AES-192); a 48-byte session key gives combo key = XOR of bytes 16..40; no speedy key. A 10g / 11g server (its logon types in the compile capabilities have no `0x20` bit, `Capabilities::server_has_md5_combo_key`) wants MD5 of the first 16 bytes of that XOR followed by MD5 of the last 8, cut to 24 bytes (go-ora): checked live against Oracle Database 11g XE 11.2.0.2 (ORA-01017 without it). Other verifier types and missing / malformed auth values return `ErrorKind::UnsupportedPasswordVerifier` / `InvalidAuthResponse` instead of panicking. The stored combo key is a `Vec<u8>` (24 or 32 bytes). |
| `src/messages/auth.rs`, `src/constants.rs`, `src/error.rs`, `Cargo.toml` (`des`, `md-5`) | Logon with **10G password verifiers** (`0x939`, accounts never re-passworded since 10g; python-oracledb thin does not support them, JDBC thin does). Hash = the DES password hash of the upper-cased user and password (UTF-16BE, DES-CBC with key `0123456789ABCDEF`, then again with the last block as key) + 8 zero bytes, AES-128 for the session key halves (32 bytes). When the server sends `AUTH_PBKDF2_CSK_SALT` (12c+ servers) the combo key is the PBKDF2 one, as for 12C; without it, MD5 of the XOR of bytes 16..32 of both halves. Unit tests check the hash against the known 10g values of SCOTT/TIGER and SYSTEM/MANAGER; the logon was checked live against a 12c+ server with 10G-only accounts, and against Oracle Database 10g XE 10.2.0.1 (it sends `AUTH_VFR_DATA` empty, with the flags `0x939`). |
| `src/messages/connect.rs`, `src/constants.rs` | **10g / 11g servers** (upstream refused every server before 12.1: "connections to this database server are not supported"). The client accepts TNS protocol 313 (10g) and 314 (11g) (`PROTOCOL_VERSION_MIN_ACCEPTED`). Their accept packet is 32 bytes: the SDU is the 16-bit value after the service options, and there is no 32-bit SDU or flags block (upstream read past the end). A server that needs native network encryption / integrity (`NSI_NA_REQUIRED`) gives a "not implemented" error, and an unknown packet type during connect an "unexpected result" error, instead of `todo!()` panics. |
| `src/client/mod.rs`, `src/transport.rs` | Before protocol 315 the packet length stays 16 bits (+ 2 checksum bytes) after the accept (upstream always switched to 32 bits). For every server version, packets sent are at most the SDU the server accepted when that is smaller than the one asked for (`Transport::limit_send_packet_size`; upstream ignored the accepted SDU; 10g gives 2048 when 8192 is asked for, 12c+ servers usually accept the 8192); the receive buffer keeps its size. |
| `src/client/capabilities.rs` | 10g sends 5 runtime capabilities (upstream indexed byte 6 and panicked): no TTC byte means no 32k strings (`max_string_size` 4000) and no session state operations. The compile capabilities give the TTC field version (4 on 10.2) and whether the server has **big chunks** (`TTC3 & BIG_CHUNK_CLR`; 10g / 11g do not). The capability bits that select 10g / 11g behavior (big chunks, the logon types of the 11G combo key) are only read for a server before 12.1 (TNS protocol before 315 and TTC field version before 7): 12.1+ always gets the upstream behavior. Unit tests in `capabilities.rs`. |
| `src/read_buffer.rs`, `src/write_buffer.rs`, `src/response/mod.rs`, `src/client/mod.rs`, `src/constants.rs` | Without big chunks, the chunks of a value longer than 252 bytes have **one-byte lengths** (chunks of 64 bytes are sent, as go-ora and JDBC thin do) instead of UB4 lengths, in both directions. Upstream sent UB4 lengths (ORA-00911 on a 300-character statement) and read them (an "integer of length 64" error on a long value). |
| `src/response/error_info.rs`, `src/constants.rs` | Before TTC field version 7 (12.1) the error block ends with three length-prefixed fields instead of the batch error arrays, and has no 32-bit error number and 64-bit row count: the short error number and the current row number are used (upstream waited for bytes that never came: a hang at logon). |
| `src/messages/execute.rs`, `src/constants.rs` | The execute message leaves out the fields that came later (as go-ora): registration id and object list pointers need field version 4 (10.2), the `al8blv` / `al8dnam` / `al8regid_msb` group 5 (11.1), the DML row count array 7 (12.1). Upstream sent all of them (ORA-03120 on 10g). |
| `src/metadata.rs`, `src/statement/mod.rs`, `src/constants.rs` | Describe info: the UDS flags of a column need field version 6 (11.2), the query cache key (`dcbqcky`) 5 (11.1). A **LOB column fetched as string / bytes** is defined as LONG VARCHAR (94) / LONG VARRAW (95) with a buffer of `0x3FFFFFFF` before 12.1: 10.2 refuses the LONG / LONG RAW define with ORA-00932, and a NULL value with a `0x7FFFFFFF` buffer crashes the server process (ORA-07445 in `memcpy`). The data comes back in the chunked LONG form, so the reading code is the same. |
| `src/messages/mod.rs`, `src/messages/fast_auth.rs`, `src/client/mod.rs` | `Message::pre_process` returns `Result` (auth errors propagate); `change_password` without a combo key is `NotConnected` instead of a panic. |
| `src/metadata.rs` | `Metadata::declared_data_type()`: CLOB / BLOB / NCLOB columns fetched as string / bytes are described as `LONG` / `LONG RAW` by `data_type()` (the driver redefines them); this returns the declared type. |

The server of the test container (`sqlnet.ora` with `DISABLE_OOB=ON`, `BREAK_POLL_SKIP=1000`) only notices a
break while it sends result packets or reads: a call that just burns CPU or sleeps (`dbms_session.sleep`) is
interrupted when it ends. Queries that scan or stream are cancelled at once.

The 10g / 11g protocol is the one of go-ora (https://github.com/sijms/go-ora, a pure-Go driver that supports
10.2): the field version checks follow it, and every change was checked with packet dumps
(`RSO_DEBUG_PACKETS=1`) against Oracle Database 10g XE 10.2.0.1 (TNS 313, SDU 2048, field version 4); Oracle
Database 11g XE 11.2.0.2 (TNS 314, SDU 8192, field version 6, no big chunks) was tested the same way. The live tests are
`crates/dbcore/tests/oracle_legacy.rs` (`PROMETEO_ORACLE_10G_URL`, `make db-up-oracle-legacy`); the 12.1+ paths
stay as upstream wrote them and are covered by the Oracle 23 Free tests.

Oracle Database 19c 19.3 (TNS 318, SDU 8192, field version 12, big chunks, 32k strings, no fast authentication)
with the single-byte database character sets WE8MSWIN1252 and WE8ISO8859P15 was checked the same way: it gets
none of the 10g / 11g paths, the accepted SDU limits nothing, and text (also NCHAR text and names outside ASCII)
comes back unchanged, because the client asks for UTF-8 and the server converts. No driver change was necessary
for it. The live test is `crates/dbcore/tests/oracle_charset.rs` (`PROMETEO_ORACLE_19C_URL`).

The 11G logon is tested by `logon_with_11g_password_verifier` in `crates/dbcore/tests/oracle.rs`
(`PROMETEO_ORACLE_11G_URL`). It needs `SQLNET.ALLOWED_LOGON_VERSION_SERVER=11` in the server's `sqlnet.ora`
and an account whose `dba_users.password_versions` is `11G` only.
