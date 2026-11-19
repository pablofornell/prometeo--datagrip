//! A minimal HTTP/1.1 server for the MCP endpoint, on `tokio::net`.
//!
//! It understands what MCP clients send: a request line, headers, a body with `Content-Length` (or chunked),
//! `Expect: 100-continue` (curl), and keep-alive. Every response has a `Content-Length` and no streaming.
//! Limits: header block 32 KiB, body 4 MiB, 64 connections, read timeouts. Nothing here knows about MCP.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::time::Instant;

pub const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_HEADERS: usize = 32 * 1024;
const MAX_CONNECTIONS: usize = 64;
/// How long a kept-alive connection may stay silent before the next request starts.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a whole request (headers and body) may take once its first byte arrived: a deadline for the request,
/// not for each read, so a client that sends one byte at a time cannot hold a connection.
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
/// How long writing a response may take.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Most trailer lines of a chunked body that are read and thrown away.
const MAX_TRAILERS: usize = 32;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// The path without the query string.
    pub path: String,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn empty(status: u16) -> Self {
        Response {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn json(status: u16, body: &serde_json::Value) -> Self {
        Response {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "OK",
    }
}

/// Handles one request. Boxed so the server does not depend on the handler's type.
pub type Handler =
    Arc<dyn Fn(Request) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync>;

/// A running server: the bound address and the way to stop it.
pub struct Server {
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    /// Stops accepting and closes every connection (a request being handled is dropped with its task).
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), self.task).await;
    }
}

/// Binds `127.0.0.1:port` (`0` picks a free port) and serves `handler` until [`Server::stop`].
pub async fn bind(port: u16, handler: Handler) -> std::io::Result<Server> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    let (tx, rx) = watch::channel(false);
    let task = tokio::spawn(accept_loop(listener, handler, rx));
    Ok(Server {
        addr,
        shutdown: tx,
        task,
    })
}

async fn accept_loop(listener: TcpListener, handler: Handler, mut stop: watch::Receiver<bool>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut conns = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            // reap finished connections so the set does not grow
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(a) => a,
                    Err(e) => {
                        tracing::warn!("MCP accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    // too many connections: drop this one
                    continue;
                };
                let (handler, stop) = (handler.clone(), stop.clone());
                conns.spawn(async move {
                    let _permit = permit;
                    serve_connection(stream, handler, stop).await;
                });
            }
        }
    }
    // dropping the JoinSet aborts the connections
    conns.abort_all();
}

async fn serve_connection(
    mut stream: TcpStream,
    handler: Handler,
    mut stop: watch::Receiver<bool>,
) {
    let _ = stream.set_nodelay(true);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let read = tokio::select! {
            _ = stop.changed() => return,
            r = read_request(&mut stream, &mut buf) => r,
        };
        let (req, close) = match read {
            Ok(Some(r)) => r,
            Ok(None) => return,
            Err(e) => {
                let (status, msg) = match e {
                    ReadError::TooLarge => (413, "Request body too large (limit 4 MiB)"),
                    ReadError::HeadersTooLarge => (431, "Request headers too large"),
                    ReadError::Timeout => (408, "Request timed out"),
                    ReadError::Malformed => (400, "Malformed HTTP request"),
                    ReadError::Unsupported => (501, "Unsupported transfer encoding"),
                    ReadError::Io => return,
                };
                let res = Response::json(status, &serde_json::json!({ "error": msg }));
                let _ =
                    tokio::time::timeout(WRITE_TIMEOUT, write_response(&mut stream, &res, true))
                        .await;
                return;
            }
        };
        let res = tokio::select! {
            _ = stop.changed() => return,
            res = handler(req) => res,
        };
        let written =
            tokio::time::timeout(WRITE_TIMEOUT, write_response(&mut stream, &res, close)).await;
        if !matches!(written, Ok(Ok(()))) || close {
            return;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ReadError {
    TooLarge,
    HeadersTooLarge,
    Timeout,
    Malformed,
    Unsupported,
    Io,
}

/// Reads one request; `Ok(None)` when the peer closed (or stayed idle) between requests. `buf` keeps the bytes
/// of a following (pipelined) request. The bool is "close the connection after the response".
async fn read_request<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
) -> Result<Option<(Request, bool)>, ReadError> {
    read_request_within(stream, buf, REQUEST_DEADLINE).await
}

/// [`read_request`] with the time the whole request may take once its first byte arrived.
async fn read_request_within<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
    within: Duration,
) -> Result<Option<(Request, bool)>, ReadError> {
    // header block; the request deadline starts with its first byte
    let mut deadline = (!buf.is_empty()).then(|| Instant::now() + within);
    let head_end = loop {
        if let Some(p) = find(buf, b"\r\n\r\n") {
            break p;
        }
        if buf.len() > MAX_HEADERS {
            return Err(ReadError::HeadersTooLarge);
        }
        let mut chunk = [0u8; 8192];
        let read = match deadline {
            None => tokio::time::timeout(IDLE_TIMEOUT, stream.read(&mut chunk))
                .await
                .map_err(|_| None::<ReadError>),
            Some(d) => tokio::time::timeout_at(d, stream.read(&mut chunk))
                .await
                .map_err(|_| Some(ReadError::Timeout)),
        };
        match read {
            Err(None) => return Ok(None),
            Err(Some(e)) => return Err(e),
            Ok(Ok(0)) if buf.is_empty() => return Ok(None),
            Ok(Ok(0)) => return Err(ReadError::Malformed),
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                deadline.get_or_insert_with(|| Instant::now() + within);
            }
            Ok(Err(_)) => return Err(ReadError::Io),
        }
    };
    let deadline = deadline.unwrap_or_else(|| Instant::now() + within);
    if head_end > MAX_HEADERS {
        return Err(ReadError::HeadersTooLarge);
    }
    let head = std::str::from_utf8(&buf[..head_end]).map_err(|_| ReadError::Malformed)?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(ReadError::Malformed)?;
    let mut parts = request_line.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) if !m.is_empty() && t.starts_with('/') => (m, t, v),
        _ => return Err(ReadError::Malformed),
    };
    if !version.starts_with("HTTP/1.") {
        return Err(ReadError::Malformed);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        let (k, v) = line.split_once(':').ok_or(ReadError::Malformed)?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let method = method.to_string();
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    let get = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let chunked = get("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked"));
    if get("transfer-encoding").is_some() && !chunked {
        return Err(ReadError::Unsupported);
    }
    let length = match get("content-length") {
        Some(v) if !chunked => Some(v.parse::<usize>().map_err(|_| ReadError::Malformed)?),
        _ => None,
    };
    if length.is_some_and(|n| n > MAX_BODY) {
        return Err(ReadError::TooLarge);
    }
    let expect_continue = get("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue"));
    let close = match get("connection") {
        Some(v) if v.eq_ignore_ascii_case("close") => true,
        Some(v) if v.eq_ignore_ascii_case("keep-alive") => false,
        _ => version == "HTTP/1.0",
    };
    buf.drain(..head_end + 4);
    if expect_continue && (chunked || length.unwrap_or(0) > buf.len()) {
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|_| ReadError::Io)?;
    }
    let body = if chunked {
        read_chunked(stream, buf, deadline).await?
    } else {
        let n = length.unwrap_or(0);
        fill(stream, buf, n, deadline).await?;
        buf.drain(..n).collect()
    };
    Ok(Some((
        Request {
            method,
            path,
            headers,
            body,
        },
        close,
    )))
}

/// Reads until `buf` holds at least `n` bytes, before `deadline`.
async fn fill<S: AsyncRead + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
    n: usize,
    deadline: Instant,
) -> Result<(), ReadError> {
    while buf.len() < n {
        let mut chunk = [0u8; 16 * 1024];
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Err(_) => return Err(ReadError::Timeout),
            Ok(Ok(0)) => return Err(ReadError::Malformed),
            Ok(Ok(k)) => buf.extend_from_slice(&chunk[..k]),
            Ok(Err(_)) => return Err(ReadError::Io),
        }
    }
    Ok(())
}

/// Reads one more line (up to CRLF) from `buf`, reading the stream when needed.
async fn read_line<S: AsyncRead + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<String, ReadError> {
    loop {
        if let Some(p) = find(buf, b"\r\n") {
            let line: Vec<u8> = buf.drain(..p + 2).take(p).collect();
            return String::from_utf8(line).map_err(|_| ReadError::Malformed);
        }
        if buf.len() > 1024 {
            return Err(ReadError::Malformed);
        }
        let want = buf.len() + 1;
        fill(stream, buf, want, deadline).await?;
    }
}

/// The size of a chunk from its size line (`1a2b` or `1a2b;ext=1`). Anything above [`MAX_BODY`] is `TooLarge`
/// before any arithmetic or reading is done with it.
fn chunk_size(line: &str, already: usize) -> Result<usize, ReadError> {
    let text = line.split(';').next().unwrap_or("").trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ReadError::Malformed);
    }
    // more digits than the size of MAX_BODY needs: far too large (and it would overflow the parse)
    let size = match usize::from_str_radix(text, 16) {
        Ok(n) => n,
        Err(_) => return Err(ReadError::TooLarge),
    };
    match already.checked_add(size) {
        Some(total) if total <= MAX_BODY => Ok(size),
        _ => Err(ReadError::TooLarge),
    }
}

async fn read_chunked<S: AsyncRead + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<Vec<u8>, ReadError> {
    let mut body = Vec::new();
    loop {
        let line = read_line(stream, buf, deadline).await?;
        let size = chunk_size(&line, body.len())?;
        if size == 0 {
            // trailers up to the empty line
            for _ in 0..MAX_TRAILERS {
                if read_line(stream, buf, deadline).await?.is_empty() {
                    return Ok(body);
                }
            }
            return Err(ReadError::Malformed);
        }
        // size <= MAX_BODY here: the sum cannot overflow
        fill(stream, buf, size + 2, deadline).await?;
        if &buf[size..size + 2] != b"\r\n" {
            return Err(ReadError::Malformed);
        }
        body.extend_from_slice(&buf[..size]);
        buf.drain(..size + 2);
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

async fn write_response<S: AsyncWrite + Unpin>(
    stream: &mut S,
    res: &Response,
    close: bool,
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {}\r\n",
        res.status,
        reason(res.status),
        res.body.len(),
        if close { "close" } else { "keep-alive" }
    );
    for (k, v) in &res.headers {
        // header values come from this program, but never let one split the response
        if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&res.body).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    async fn parse(raw: &[u8]) -> Result<Option<(Request, bool)>, ReadError> {
        let (mut a, mut b) = duplex(64 * 1024);
        a.write_all(raw).await.unwrap();
        drop(a);
        let mut buf = Vec::new();
        read_request(&mut b, &mut buf).await
    }

    #[tokio::test]
    async fn parses_a_post_with_content_length() {
        let (req, close) = parse(
            b"POST /mcp?x=1 HTTP/1.1\r\nHost: 127.0.0.1:7311\r\nContent-Length: 5\r\nAuthorization: Bearer t\r\n\r\nhello",
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/mcp");
        assert_eq!(req.body, b"hello");
        assert_eq!(req.header("authorization"), Some("Bearer t"));
        assert_eq!(req.header("host"), Some("127.0.0.1:7311"));
        assert!(!close);
    }

    #[tokio::test]
    async fn parses_chunked_bodies() {
        let (req, _) = parse(
            b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4;ext=1\r\ndefg\r\n0\r\nX: y\r\n\r\n",
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(req.body, b"abcdefg");
    }

    #[tokio::test]
    async fn connection_close_and_http_1_0() {
        let (_, close) = parse(b"GET /mcp HTTP/1.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap()
            .unwrap();
        assert!(close);
        let (_, close) = parse(b"GET /mcp HTTP/1.0\r\n\r\n").await.unwrap().unwrap();
        assert!(close);
    }

    #[tokio::test]
    async fn refuses_what_it_does_not_understand() {
        assert!(parse(b"").await.unwrap().is_none());
        assert_eq!(
            parse(b"garbage\r\n\r\n").await.unwrap_err(),
            ReadError::Malformed
        );
        assert_eq!(
            parse(b"POST /mcp HTTP/1.1\r\nContent-Length: abc\r\n\r\n")
                .await
                .unwrap_err(),
            ReadError::Malformed
        );
        assert_eq!(
            parse(b"POST /mcp HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n")
                .await
                .unwrap_err(),
            ReadError::TooLarge
        );
        assert_eq!(
            parse(b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n")
                .await
                .unwrap_err(),
            ReadError::Unsupported
        );
        // the body ends early
        assert_eq!(
            parse(b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc")
                .await
                .unwrap_err(),
            ReadError::Malformed
        );
        let big = format!(
            "GET /mcp HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEADERS + 10)
        );
        assert_eq!(
            parse(big.as_bytes()).await.unwrap_err(),
            ReadError::HeadersTooLarge
        );
    }

    #[tokio::test]
    async fn huge_chunk_sizes_are_refused_without_panicking() {
        let chunked = |lines: &str| {
            format!("POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n{lines}")
        };
        for size in [
            "ffffffffffffffff",
            "fffffffffffffffd",
            "7fffffffffffffff",
            "10000000000000000",
            "ffffffffffffffffffffffffffffffff",
            "400001",
        ] {
            let raw = chunked(&format!("{size}\r\nabc"));
            assert_eq!(
                parse(raw.as_bytes()).await.unwrap_err(),
                ReadError::TooLarge,
                "{size}"
            );
            // after a first chunk the running total must not overflow either
            let raw = chunked(&format!("3\r\nabc\r\n{size}\r\nabc"));
            assert_eq!(
                parse(raw.as_bytes()).await.unwrap_err(),
                ReadError::TooLarge,
                "{size} after 3"
            );
        }
        assert_eq!(chunk_size("fffffffffffffffd", 3), Err(ReadError::TooLarge));
        assert_eq!(
            chunk_size(&format!("{:x}", usize::MAX - 2), 0),
            Err(ReadError::TooLarge)
        );
        assert_eq!(chunk_size("400000", 0), Ok(MAX_BODY));
        assert_eq!(chunk_size("1", MAX_BODY), Err(ReadError::TooLarge));
        assert_eq!(chunk_size("", 0), Err(ReadError::Malformed));
        assert_eq!(chunk_size("-1", 0), Err(ReadError::Malformed));
        assert_eq!(chunk_size("+1", 0), Err(ReadError::Malformed));
        assert_eq!(chunk_size("zz", 0), Err(ReadError::Malformed));
    }

    #[tokio::test]
    async fn bad_chunk_framing_and_trailer_floods_are_refused() {
        // no CRLF after the chunk data
        let raw = b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcXX0\r\n\r\n";
        assert_eq!(parse(raw).await.unwrap_err(), ReadError::Malformed);
        let mut raw = b"POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n".to_vec();
        for _ in 0..100 {
            raw.extend_from_slice(b"X: y\r\n");
        }
        raw.extend_from_slice(b"\r\n");
        assert_eq!(parse(&raw).await.unwrap_err(), ReadError::Malformed);
    }

    #[tokio::test]
    async fn a_slow_request_hits_the_request_deadline() {
        let (mut a, mut b) = duplex(1024);
        a.write_all(b"POST /mcp HTTP/1.1\r\nContent-Length: 10\r\n\r\nab")
            .await
            .unwrap();
        // the peer stays connected and silent: the body never completes
        let mut buf = Vec::new();
        let started = std::time::Instant::now();
        let r = read_request_within(&mut b, &mut buf, Duration::from_millis(200)).await;
        assert_eq!(r.unwrap_err(), ReadError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
        // also while the headers are still incomplete, even if bytes keep trickling in
        let (mut a, mut b) = duplex(1024);
        let writer = tokio::spawn(async move {
            for _ in 0..40 {
                if a.write_all(b"X").await.is_err() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        });
        let mut buf = Vec::new();
        let r = read_request_within(&mut b, &mut buf, Duration::from_millis(250)).await;
        assert_eq!(r.unwrap_err(), ReadError::Timeout);
        writer.abort();
    }

    #[tokio::test]
    async fn pipelined_requests_keep_their_bytes() {
        let (mut a, mut b) = duplex(64 * 1024);
        a.write_all(b"POST /a HTTP/1.1\r\nContent-Length: 1\r\n\r\nxPOST /b HTTP/1.1\r\nContent-Length: 1\r\n\r\ny")
            .await
            .unwrap();
        let mut buf = Vec::new();
        let (r1, _) = read_request(&mut b, &mut buf).await.unwrap().unwrap();
        let (r2, _) = read_request(&mut b, &mut buf).await.unwrap().unwrap();
        assert_eq!((r1.path.as_str(), r1.body.as_slice()), ("/a", &b"x"[..]));
        assert_eq!((r2.path.as_str(), r2.body.as_slice()), ("/b", &b"y"[..]));
    }

    #[tokio::test]
    async fn serves_over_a_socket_and_stops() {
        let handler: Handler = Arc::new(|req| {
            Box::pin(async move {
                Response::json(
                    200,
                    &serde_json::json!({ "path": req.path, "len": req.body.len() }),
                )
                .with_header("X-Test", "1")
            })
        });
        let server = bind(0, handler).await.unwrap();
        let mut s = TcpStream::connect(server.addr).await.unwrap();
        for _ in 0..2 {
            // two requests on one connection
            s.write_all(b"POST /x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nhi")
                .await
                .unwrap();
            let mut got = Vec::new();
            let mut chunk = [0u8; 1024];
            while !got.ends_with(b"}") {
                let n = s.read(&mut chunk).await.unwrap();
                assert!(n > 0, "closed early: {}", String::from_utf8_lossy(&got));
                got.extend_from_slice(&chunk[..n]);
            }
            let text = String::from_utf8(got).unwrap();
            assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
            assert!(text.contains("X-Test: 1") && text.contains("Connection: keep-alive"));
            assert!(text.ends_with(r#"{"len":2,"path":"/x"}"#), "{text}");
        }
        server.stop().await;
        // the open connection was closed by the stop
        let mut chunk = [0u8; 16];
        let n = tokio::time::timeout(Duration::from_secs(2), s.read(&mut chunk))
            .await
            .expect("connection still open")
            .unwrap_or(0);
        assert_eq!(n, 0);
    }
}
