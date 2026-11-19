//! The embedded MCP (Model Context Protocol) server: see `docs/MCP.md` for what it offers and the contract
//! with the frontend.
//!
//! [`McpService`] owns everything: the settings file (`<config dir>/mcp.json`: enabled, port, token, policy),
//! the HTTP listener, the agent sessions, the log (`<data dir>/mcp/log.jsonl`) and the database connections.
//! It depends on the connection manager and the data source store only, not on Tauri.

pub mod classify;
pub mod db;
pub mod http;
pub mod log;
pub mod policy;
pub mod protocol;
pub mod tools;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use dbcore::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::{write_secret, DataSourceStore};
use db::{McpDb, Mode};
use http::{Request, Response};
use log::{
    McpLog, McpLogEntry, McpLogKind, McpLogQuery, McpSession, ACTIVE_WINDOW_MS, MAX_BYTES,
    RETENTION_DAYS,
};
use policy::{McpPolicy, McpPolicyInput};
use protocol::Incoming;

pub const DEFAULT_PORT: u16 = 7311;
/// The id of the session of an agent that sends no `Mcp-Session-Id`.
const IMPLICIT_SESSION: &str = "implicit";
/// Longest session id accepted from a client.
const MAX_SESSION_ID: usize = 100;
/// Most live sessions kept in memory.
const MAX_LIVE_SESSIONS: usize = 500;
/// Entries per minute that callers without the token may add to the log.
const UNAUTHORIZED_LOGS_PER_MINUTE: u32 = 60;
const PRUNE_EVERY: Duration = Duration::from_secs(3600);

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `pdg_` + 64 hex characters from two random UUIDs.
pub fn new_token() -> String {
    format!(
        "pdg_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Comparison of two secrets that takes the same time wherever they differ.
pub fn tokens_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

/// Is `host` (the value of a `Host` header) a loopback name?
fn host_is_loopback(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, tail)) if tail.is_empty() || tail.starts_with(':') => {
                return inner == "::1";
            }
            _ => return false,
        }
    } else {
        host.rsplit_once(':').map_or(host, |(n, _)| n)
    };
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1"
}

/// `Authorization: Bearer <token>` -> the token.
fn bearer(req: &Request) -> Option<&str> {
    let v = req.header("authorization")?.trim();
    let (scheme, token) = v.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

// ------------------------------------------------------------------ settings, status, events

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    enabled: bool,
    port: u16,
    token: String,
    policy: McpPolicyInput,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
            policy: McpPolicyInput::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// The user setting.
    pub enabled: bool,
    /// The listener is bound.
    pub running: bool,
    pub port: u16,
    pub endpoint: String,
    pub token: String,
    pub error: Option<String>,
    pub started_at_ms: Option<i64>,
    /// Sessions seen in the last 10 minutes and not ended.
    pub active_sessions: usize,
    pub log_retention_days: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpEvent {
    Entry {
        entry: Box<McpLogEntry>,
    },
    Status {
        status: McpStatus,
    },
    /// The session list changed: fetch it again.
    Sessions,
}

/// Receives events; returns `false` when nobody listens any more (the subscription is then dropped).
pub type Subscriber = Arc<dyn Fn(&McpEvent) -> bool + Send + Sync>;

struct Running {
    server: http::Server,
    started_at_ms: i64,
    pruner: tokio::task::JoinHandle<()>,
}

struct LiveSession {
    client_name: String,
    client_version: Option<String>,
    started_at_ms: i64,
    last_seen_ms: i64,
    ended: bool,
}

/// Who is calling: the session id (from the header, or [`IMPLICIT_SESSION`]) and the client's name.
#[derive(Debug, Clone)]
pub struct SessionRef {
    pub id: String,
    pub client_name: String,
}

/// What came with one HTTP request.
struct Ctx {
    authorized: bool,
    session_header: Option<String>,
}

struct Processed {
    reply: Option<Value>,
    new_session: Option<String>,
    invalid: bool,
}

pub struct McpService {
    pub(crate) sources: Arc<DataSourceStore>,
    pub(crate) db: McpDb,
    log: Arc<McpLog>,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    /// Serializes start / stop / restart.
    lifecycle: tokio::sync::Mutex<()>,
    running: Mutex<Option<Running>>,
    last_error: Mutex<Option<String>>,
    live: Mutex<HashMap<String, LiveSession>>,
    subscribers: Mutex<Vec<(u64, Subscriber)>>,
    next_subscription: AtomicU64,
    /// (start of the minute, entries) of the log entries of callers without the token.
    unauthorized_logs: Mutex<(i64, u32)>,
    /// When the log was last pruned (the prune at start counts).
    last_prune_ms: Mutex<i64>,
}

impl McpService {
    /// Loads the settings and prunes the log; nothing listens until [`start_if_enabled`](Self::start_if_enabled)
    /// or [`configure`](Self::configure).
    pub fn new(
        mgr: ConnectionManager,
        sources: Arc<DataSourceStore>,
        config_dir: &Path,
        data_dir: &Path,
    ) -> Arc<Self> {
        let settings_path = config_dir.join("mcp.json");
        let log = Arc::new(McpLog::new(data_dir.join("mcp").join("log.jsonl")));
        if let Err(e) = log.prune(now_ms(), RETENTION_DAYS, MAX_BYTES) {
            tracing::warn!("cannot prune the MCP log: {e}");
        }
        Arc::new(McpService {
            db: McpDb::new(mgr, sources.clone()),
            sources,
            log,
            settings: Mutex::new(load_settings(&settings_path)),
            settings_path,
            lifecycle: tokio::sync::Mutex::new(()),
            running: Mutex::new(None),
            last_error: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            next_subscription: AtomicU64::new(1),
            unauthorized_logs: Mutex::new((0, 0)),
            last_prune_ms: Mutex::new(now_ms()),
        })
    }

    // -------------------------------------------------------------- settings

    fn save_settings(&self, s: &Settings) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        write_secret(&self.settings_path, &json)
    }

    pub(crate) fn policy_input(&self) -> McpPolicyInput {
        self.settings.lock().unwrap().policy.clone()
    }

    fn data_source_flags(&self) -> Vec<(String, bool)> {
        self.sources
            .list()
            .into_iter()
            .map(|v| (v.cfg.id, v.cfg.read_only))
            .collect()
    }

    pub fn policy(&self) -> McpPolicy {
        policy::compute(&self.policy_input(), &self.data_source_flags())
    }

    /// Stores the policy. MCP connections whose access it takes away are closed.
    pub async fn set_policy(&self, input: McpPolicyInput) -> Result<McpPolicy, String> {
        let flags = self.data_source_flags();
        let before = policy::compute(&self.policy_input(), &flags);
        let after = policy::compute(&input, &flags);
        {
            let mut s = self.settings.lock().unwrap();
            let mut next = s.clone();
            next.policy = input;
            self.save_settings(&next)?;
            *s = next;
        }
        for (id, was) in &before.effective {
            let now = after.effective.get(id).map(|e| e.perm).unwrap_or_default();
            if was.perm.read && !now.read {
                self.db.close(id, Mode::Read).await;
            }
            if was.perm.write && !now.write {
                self.db.close(id, Mode::Write).await;
            }
        }
        Ok(after)
    }

    /// A data source was deleted or its connection settings changed behind the server's back.
    pub async fn close_source(&self, ds_id: &str) {
        self.db.close_source(ds_id).await;
    }

    // -------------------------------------------------------------- status and lifecycle

    pub fn status(&self) -> McpStatus {
        let s = self.settings.lock().unwrap().clone();
        let (running, port, started) = match self.running.lock().unwrap().as_ref() {
            Some(r) => (true, r.server.addr.port(), Some(r.started_at_ms)),
            None => (false, s.port, None),
        };
        let now = now_ms();
        let active = self
            .live
            .lock()
            .unwrap()
            .values()
            .filter(|l| !l.ended && now - l.last_seen_ms < ACTIVE_WINDOW_MS)
            .count();
        McpStatus {
            enabled: s.enabled,
            running,
            port,
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            token: s.token,
            error: self.last_error.lock().unwrap().clone(),
            started_at_ms: started,
            active_sessions: active,
            log_retention_days: RETENTION_DAYS,
        }
    }

    /// Starts the listener when the saved settings say so (app start).
    pub async fn start_if_enabled(self: &Arc<Self>) {
        let _life = self.lifecycle.lock().await;
        let (enabled, port) = {
            let s = self.settings.lock().unwrap();
            (s.enabled, s.port)
        };
        if enabled {
            self.start_listener(port).await;
        }
    }

    /// Applies the user's choice: starts, stops or restarts the server. A port that cannot be bound is reported in
    /// [`McpStatus::error`], not as a failure of the call. `port` 0 picks a free port (tests).
    pub async fn configure(
        self: &Arc<Self>,
        enabled: bool,
        port: u16,
    ) -> Result<McpStatus, String> {
        let _life = self.lifecycle.lock().await;
        let changed = {
            let mut s = self.settings.lock().unwrap();
            let mut next = s.clone();
            next.enabled = enabled;
            next.port = port;
            if enabled && next.token.is_empty() {
                next.token = new_token();
            }
            let changed = next.enabled != s.enabled || next.port != s.port || next.token != s.token;
            if changed {
                self.save_settings(&next)?;
                *s = next;
            }
            changed
        };
        let bound = self
            .running
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.server.addr.port());
        let same = bound.is_some() && enabled && (port == 0 || bound == Some(port));
        let retry =
            enabled && bound.is_none() && !changed && self.last_error.lock().unwrap().is_none();
        if !same || retry {
            self.stop_listener().await;
            if enabled {
                self.start_listener(port).await;
            } else {
                *self.last_error.lock().unwrap() = None;
            }
        }
        let status = self.status();
        self.emit(&McpEvent::Status {
            status: status.clone(),
        });
        Ok(status)
    }

    /// Replaces the token; sessions that still use the old one get the "unauthorized" tool error.
    pub async fn regenerate_token(&self) -> Result<McpStatus, String> {
        {
            let mut s = self.settings.lock().unwrap();
            let mut next = s.clone();
            next.token = new_token();
            self.save_settings(&next)?;
            *s = next;
        }
        let status = self.status();
        self.emit(&McpEvent::Status {
            status: status.clone(),
        });
        Ok(status)
    }

    async fn start_listener(self: &Arc<Self>, port: u16) {
        let weak: Weak<McpService> = Arc::downgrade(self);
        let handler: http::Handler = Arc::new(move |req| {
            let weak = weak.clone();
            Box::pin(async move {
                match weak.upgrade() {
                    Some(svc) => svc.handle_http(req).await,
                    None => Response::json(500, &json!({ "error": "The server is shutting down" })),
                }
            })
        });
        match http::bind(port, handler).await {
            Ok(server) => {
                tracing::info!("MCP server listening on {}", server.addr);
                let me = Arc::downgrade(self);
                let pruner = tokio::spawn(async move {
                    let mut tick = tokio::time::interval_at(
                        tokio::time::Instant::now() + PRUNE_EVERY,
                        PRUNE_EVERY,
                    );
                    loop {
                        tick.tick().await;
                        let Some(svc) = me.upgrade() else { return };
                        let log = svc.log.clone();
                        drop(svc);
                        let res = tokio::task::spawn_blocking(move || {
                            log.prune(now_ms(), RETENTION_DAYS, MAX_BYTES)
                        })
                        .await;
                        if let Ok(Err(e)) = res {
                            tracing::warn!("cannot prune the MCP log: {e}");
                        }
                    }
                });
                *self.last_error.lock().unwrap() = None;
                *self.running.lock().unwrap() = Some(Running {
                    server,
                    started_at_ms: now_ms(),
                    pruner,
                });
            }
            Err(e) => {
                let msg = match e.kind() {
                    std::io::ErrorKind::AddrInUse => format!("Port {port} is in use"),
                    std::io::ErrorKind::PermissionDenied => {
                        format!("Not allowed to listen on port {port}")
                    }
                    _ => format!("Cannot listen on port {port}: {e}"),
                };
                tracing::warn!("MCP server not started: {msg}");
                *self.last_error.lock().unwrap() = Some(msg);
            }
        }
    }

    /// Stops the listener and closes the MCP database connections.
    async fn stop_listener(&self) {
        let running = self.running.lock().unwrap().take();
        if let Some(r) = running {
            r.pruner.abort();
            r.server.stop().await;
            tracing::info!("MCP server stopped");
        }
        self.db.close_all().await;
    }

    /// App exit.
    pub async fn shutdown(&self) {
        let _life = self.lifecycle.lock().await;
        self.stop_listener().await;
    }

    // -------------------------------------------------------------- log and sessions

    /// Prunes the log when the last prune is an hour old. The hourly task only runs while the server is on; this
    /// covers the rest, and what is read is cut to the retention time anyway (`query_recent`, `sessions`).
    async fn prune_if_due(&self) {
        let now = now_ms();
        {
            let mut last = self.last_prune_ms.lock().unwrap();
            if now - *last < PRUNE_EVERY.as_millis() as i64 {
                return;
            }
            *last = now;
        }
        let log = self.log.clone();
        let res =
            tokio::task::spawn_blocking(move || log.prune(now_ms(), RETENTION_DAYS, MAX_BYTES))
                .await;
        if let Ok(Err(e)) = res {
            tracing::warn!("cannot prune the MCP log: {e}");
        }
    }

    pub async fn log_query(&self, q: McpLogQuery) -> Result<Vec<McpLogEntry>, String> {
        self.prune_if_due().await;
        let log = self.log.clone();
        tokio::task::spawn_blocking(move || log.query_recent(&q, now_ms()))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn clear_log(&self) -> Result<(), String> {
        let log = self.log.clone();
        tokio::task::spawn_blocking(move || log.clear())
            .await
            .map_err(|e| e.to_string())??;
        self.emit(&McpEvent::Sessions);
        Ok(())
    }

    /// The sessions of the last 30 days (from the log) merged with the live ones, newest activity first.
    pub async fn sessions(&self) -> Result<Vec<McpSession>, String> {
        self.prune_if_due().await;
        let now = now_ms();
        let log = self.log.clone();
        let mut out = tokio::task::spawn_blocking(move || {
            log.sessions(now, now - i64::from(RETENTION_DAYS) * 24 * 3600 * 1000)
        })
        .await
        .map_err(|e| e.to_string())?;
        let live = self.live.lock().unwrap();
        for (id, l) in live.iter() {
            match out.iter_mut().find(|s| &s.id == id) {
                Some(s) => {
                    s.last_seen_ms = s.last_seen_ms.max(l.last_seen_ms);
                    s.active = !l.ended && now - s.last_seen_ms < ACTIVE_WINDOW_MS;
                    if l.client_version.is_some() {
                        s.client_version = l.client_version.clone();
                    }
                }
                None => out.push(McpSession {
                    id: id.clone(),
                    client_name: l.client_name.clone(),
                    client_version: l.client_version.clone(),
                    started_at_ms: l.started_at_ms,
                    last_seen_ms: l.last_seen_ms,
                    active: !l.ended && now - l.last_seen_ms < ACTIVE_WINDOW_MS,
                    action_count: 0,
                    error_count: 0,
                    write_count: 0,
                    data_source_ids: Vec::new(),
                }),
            }
        }
        out.sort_by(|a, b| {
            b.last_seen_ms
                .cmp(&a.last_seen_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// Adds `entry` to the log and tells the subscribers.
    pub(crate) async fn record(&self, entry: McpLogEntry) {
        let log = self.log.clone();
        let e = entry.clone();
        let res = tokio::task::spawn_blocking(move || {
            log.append(&e)?;
            if log.size() > MAX_BYTES {
                log.prune(now_ms(), RETENTION_DAYS, MAX_BYTES)?;
            }
            Ok::<(), String>(())
        })
        .await;
        match res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("cannot write the MCP log: {e}"),
            Err(e) => tracing::warn!("cannot write the MCP log: {e}"),
        }
        self.emit(&McpEvent::Entry {
            entry: Box::new(entry),
        });
    }

    /// May one more log entry of a caller without the token be written (a small budget per minute)?
    pub(crate) fn allow_unauthorized_log(&self) -> bool {
        let now = now_ms();
        let mut w = self.unauthorized_logs.lock().unwrap();
        if now - w.0 >= 60_000 {
            *w = (now, 0);
        }
        w.1 += 1;
        w.1 <= UNAUTHORIZED_LOGS_PER_MINUTE
    }

    // -------------------------------------------------------------- subscribers

    pub fn subscribe(&self, f: Subscriber) -> u64 {
        let id = self.next_subscription.fetch_add(1, Ordering::Relaxed);
        self.subscribers.lock().unwrap().push((id, f));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.subscribers.lock().unwrap().retain(|(i, _)| *i != id);
    }

    fn emit(&self, ev: &McpEvent) {
        let subs: Vec<(u64, Subscriber)> = self.subscribers.lock().unwrap().clone();
        let dead: Vec<u64> = subs
            .iter()
            .filter(|(_, f)| !f(ev))
            .map(|(id, _)| *id)
            .collect();
        if !dead.is_empty() {
            self.subscribers
                .lock()
                .unwrap()
                .retain(|(id, _)| !dead.contains(id));
        }
    }

    /// The session list changed (and with it the number of active sessions).
    fn emit_sessions_changed(&self) {
        self.emit(&McpEvent::Sessions);
        self.emit(&McpEvent::Status {
            status: self.status(),
        });
    }

    // -------------------------------------------------------------- HTTP

    fn authorized(&self, req: &Request) -> bool {
        let token = self.settings.lock().unwrap().token.clone();
        match bearer(req) {
            Some(t) => !token.is_empty() && tokens_equal(t, &token),
            None => false,
        }
    }

    async fn handle_http(self: &Arc<Self>, req: Request) -> Response {
        if !req.header("host").is_some_and(host_is_loopback) {
            return Response::json(
                403,
                &json!({ "error": "The Host header must be 127.0.0.1, localhost or [::1]" }),
            );
        }
        // a browser sends Origin; agents do not. Refusing it stops DNS-rebinding from web pages.
        if req.header("origin").is_some() {
            return Response::json(
                403,
                &json!({ "error": "Requests with an Origin header are refused" }),
            );
        }
        if req.path != "/mcp" {
            // includes /.well-known/*: there is no OAuth here
            return Response::json(404, &json!({ "error": "not_found" }));
        }
        match req.method.as_str() {
            "POST" => self.handle_post(&req).await,
            "DELETE" => self.handle_delete(&req).await,
            "GET" => Response::json(
                405,
                &json!({ "error": "This server has no SSE stream; use POST" }),
            )
            .with_header("Allow", "POST, DELETE"),
            _ => Response::json(405, &json!({ "error": "Method not allowed" }))
                .with_header("Allow", "POST, DELETE"),
        }
    }

    async fn handle_post(self: &Arc<Self>, req: &Request) -> Response {
        let ctx = Ctx {
            authorized: self.authorized(req),
            session_header: valid_session_id(req.header("mcp-session-id")),
        };
        let body: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(e) => {
                return Response::json(
                    400,
                    &protocol::error(
                        &Value::Null,
                        protocol::PARSE_ERROR,
                        &format!("Invalid JSON: {e}"),
                    ),
                )
            }
        };
        let processed = match &body {
            Value::Array(items) if items.is_empty() => Processed {
                reply: Some(protocol::error(
                    &Value::Null,
                    protocol::INVALID_REQUEST,
                    "Empty batch",
                )),
                new_session: None,
                invalid: true,
            },
            Value::Array(items) => {
                let mut replies = Vec::new();
                let mut new_session = None;
                for item in items {
                    let p = self.process(&ctx, item).await;
                    replies.extend(p.reply);
                    new_session = new_session.or(p.new_session);
                }
                Processed {
                    reply: (!replies.is_empty()).then_some(Value::Array(replies)),
                    new_session,
                    invalid: false,
                }
            }
            single => self.process(&ctx, single).await,
        };
        let res = match processed.reply {
            Some(v) => Response::json(if processed.invalid { 400 } else { 200 }, &v),
            None => Response::empty(202),
        };
        match processed.new_session {
            Some(id) => res.with_header("Mcp-Session-Id", &id),
            None => res,
        }
    }

    async fn handle_delete(self: &Arc<Self>, req: &Request) -> Response {
        if !self.authorized(req) {
            return Response::json(403, &json!({ "error": "Missing or invalid bearer token" }));
        }
        let Some(id) = valid_session_id(req.header("mcp-session-id")) else {
            return Response::json(400, &json!({ "error": "Missing Mcp-Session-Id header" }));
        };
        let session = self.session_for(Some(&id), true).await;
        {
            let mut live = self.live.lock().unwrap();
            if let Some(l) = live.get_mut(&id) {
                l.ended = true;
            }
        }
        let mut entry = McpLogEntry::new(
            now_ms(),
            &session.id,
            &session.client_name,
            McpLogKind::Session,
            "end",
        );
        entry.summary = format!("Session ended by {}", session.client_name);
        self.record(entry).await;
        self.emit_sessions_changed();
        Response::empty(200)
    }

    /// One JSON-RPC message.
    async fn process(self: &Arc<Self>, ctx: &Ctx, message: &Value) -> Processed {
        let reply = |v: Value| Processed {
            reply: Some(v),
            new_session: None,
            invalid: false,
        };
        match protocol::parse(message) {
            Incoming::Invalid { id, message } => Processed {
                reply: Some(protocol::error(&id, protocol::INVALID_REQUEST, &message)),
                new_session: None,
                invalid: true,
            },
            Incoming::Response => Processed {
                reply: None,
                new_session: None,
                invalid: false,
            },
            Incoming::Notification { .. } => {
                if ctx.authorized {
                    self.session_for(ctx.session_header.as_deref(), true).await;
                }
                Processed {
                    reply: None,
                    new_session: None,
                    invalid: false,
                }
            }
            Incoming::Request { id, method, params } => match method.as_str() {
                "initialize" => {
                    let (result, session) = self.initialize(ctx, &params).await;
                    Processed {
                        reply: Some(protocol::ok(&id, result)),
                        new_session: Some(session),
                        invalid: false,
                    }
                }
                "ping" => {
                    if ctx.authorized && ctx.session_header.is_some() {
                        self.session_for(ctx.session_header.as_deref(), true).await;
                    }
                    reply(protocol::ok(&id, json!({})))
                }
                "tools/list" => {
                    if ctx.authorized && ctx.session_header.is_some() {
                        self.session_for(ctx.session_header.as_deref(), true).await;
                    }
                    reply(protocol::ok(&id, json!({ "tools": tools::definitions() })))
                }
                "tools/call" => {
                    let session = self
                        .session_for(ctx.session_header.as_deref(), ctx.authorized)
                        .await;
                    match tools::call(self, &session, ctx.authorized, &params).await {
                        Ok(result) => reply(protocol::ok(&id, result)),
                        Err((code, msg)) => reply(protocol::error(&id, code, &msg)),
                    }
                }
                other => reply(protocol::error(
                    &id,
                    protocol::METHOD_NOT_FOUND,
                    &format!("Method not found: {other}"),
                )),
            },
        }
    }

    /// `initialize`: a new session. Without the token it still answers (the client must be able to connect and
    /// read the tool error), but nothing is recorded.
    async fn initialize(self: &Arc<Self>, ctx: &Ctx, params: &Value) -> (Value, String) {
        let info = params.get("clientInfo");
        let text = |k: &str| {
            info.and_then(|i| i.get(k))
                .and_then(Value::as_str)
                .map(|s| log::cut(s.trim(), 100, false))
                .filter(|s| !s.is_empty())
        };
        let name = text("name").unwrap_or_else(|| "unknown".into());
        let version = text("version");
        let client_protocol = params.get("protocolVersion").and_then(Value::as_str);
        let session_id = uuid::Uuid::new_v4().simple().to_string();
        if ctx.authorized {
            let now = now_ms();
            self.register_live(&session_id, &name, version.clone(), now);
            let mut entry =
                McpLogEntry::new(now, &session_id, &name, McpLogKind::Session, "initialize");
            entry.args = Some(json!({
                "clientInfo": { "name": name, "version": version },
                "protocolVersion": client_protocol,
            }));
            entry.summary = format!(
                "Session started by {name}{}",
                version.map(|v| format!(" {v}")).unwrap_or_default()
            );
            self.record(entry).await;
            self.emit_sessions_changed();
        }
        (protocol::initialize_result(client_protocol), session_id)
    }

    fn register_live(&self, id: &str, name: &str, version: Option<String>, now: i64) {
        let mut live = self.live.lock().unwrap();
        if live.len() >= MAX_LIVE_SESSIONS {
            // forget the one that was seen longest ago (its history stays in the log)
            if let Some(oldest) = live
                .iter()
                .min_by_key(|(_, l)| l.last_seen_ms)
                .map(|(k, _)| k.clone())
            {
                live.remove(&oldest);
            }
        }
        live.insert(
            id.to_string(),
            LiveSession {
                client_name: name.to_string(),
                client_version: version,
                started_at_ms: now,
                last_seen_ms: now,
                ended: false,
            },
        );
    }

    /// The session of a request. An authorized request marks it seen; a session id this process does not know
    /// (the app restarted, or no header) is learned from the log and registered.
    async fn session_for(self: &Arc<Self>, header: Option<&str>, authorized: bool) -> SessionRef {
        let id = header.unwrap_or(IMPLICIT_SESSION).to_string();
        let now = now_ms();
        let existing = {
            let mut live = self.live.lock().unwrap();
            live.get_mut(&id).map(|l| {
                let revived = authorized && l.ended;
                if authorized {
                    l.last_seen_ms = now;
                    l.ended = false;
                }
                (l.client_name.clone(), revived)
            })
        };
        if let Some((client_name, revived)) = existing {
            if revived {
                self.emit_sessions_changed();
            }
            return SessionRef { id, client_name };
        }
        if !authorized {
            return SessionRef {
                id,
                client_name: "unknown".into(),
            };
        }
        let log = self.log.clone();
        let lookup = id.clone();
        let (name, version) = tokio::task::spawn_blocking(move || known_client(&log, &lookup))
            .await
            .unwrap_or_else(|_| ("unknown".into(), None));
        self.register_live(&id, &name, version, now);
        self.emit_sessions_changed();
        SessionRef {
            id,
            client_name: name,
        }
    }
}

/// The client name and version a session was started with, as the log remembers them.
fn known_client(log: &McpLog, session_id: &str) -> (String, Option<String>) {
    let entries = log.session_entries(session_id);
    let init = entries
        .iter()
        .find(|e| e.kind == McpLogKind::Session && e.tool == "initialize");
    let version = init
        .and_then(|e| e.args.as_ref())
        .and_then(|a| a.pointer("/clientInfo/version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = init
        .or_else(|| entries.iter().find(|e| e.client_name != "unknown"))
        .map(|e| e.client_name.clone())
        .unwrap_or_else(|| "unknown".into());
    (name, version)
}

/// A session id from a header: printable ASCII, not too long.
fn valid_session_id(v: Option<&str>) -> Option<String> {
    v.map(str::trim)
        .filter(|s| {
            !s.is_empty() && s.len() <= MAX_SESSION_ID && s.chars().all(|c| c.is_ascii_graphic())
        })
        .map(str::to_string)
}

fn load_settings(path: &Path) -> Settings {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(e) => {
            tracing::warn!("cannot read {}: {e}", path.display());
            return Settings::default();
        }
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut s) => {
            if s.port < 1024 {
                s.port = DEFAULT_PORT;
            }
            s
        }
        Err(e) => {
            // set the broken file aside (it holds the token), start from the defaults
            let aside = path.with_extension(format!("json.corrupt-{}", now_ms() / 1000));
            tracing::warn!(
                "{} is not valid ({e}); moved to {}",
                path.display(),
                aside.display()
            );
            let _ = std::fs::rename(path, aside);
            Settings::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_have_the_expected_shape_and_differ() {
        let t = new_token();
        assert!(t.starts_with("pdg_") && t.len() == 4 + 64, "{t}");
        assert!(t[4..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, new_token());
    }

    #[test]
    fn token_comparison() {
        assert!(tokens_equal("pdg_abc", "pdg_abc"));
        assert!(!tokens_equal("pdg_abc", "pdg_abd"));
        assert!(!tokens_equal("pdg_abc", "pdg_ab"));
        assert!(!tokens_equal("pdg_ab", "pdg_abc"));
        assert!(!tokens_equal("", "x"));
        assert!(tokens_equal("", ""));
        assert!(!tokens_equal("é", "e"));
    }

    #[test]
    fn loopback_hosts() {
        for h in [
            "127.0.0.1",
            "127.0.0.1:7311",
            "localhost",
            "LOCALHOST:7311",
            "[::1]",
            "[::1]:7311",
        ] {
            assert!(host_is_loopback(h), "{h}");
        }
        for h in [
            "evil.example",
            "evil.example:7311",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
            "[::2]",
            "[::1]x",
            "192.168.1.5:7311",
            "0.0.0.0",
            "",
        ] {
            assert!(!host_is_loopback(h), "{h}");
        }
    }

    #[test]
    fn bearer_parsing() {
        let req = |auth: Option<&str>| Request {
            method: "POST".into(),
            path: "/mcp".into(),
            headers: auth
                .map(|a| vec![("authorization".to_string(), a.to_string())])
                .unwrap_or_default(),
            body: Vec::new(),
        };
        assert_eq!(bearer(&req(Some("Bearer abc"))), Some("abc"));
        assert_eq!(bearer(&req(Some("bearer  abc "))), Some("abc"));
        assert_eq!(bearer(&req(Some("Basic abc"))), None);
        assert_eq!(bearer(&req(Some("abc"))), None);
        assert_eq!(bearer(&req(None)), None);
    }

    #[test]
    fn session_ids_from_headers() {
        assert_eq!(
            valid_session_id(Some(" abc123 ")).as_deref(),
            Some("abc123")
        );
        assert_eq!(valid_session_id(None), None);
        assert_eq!(valid_session_id(Some("")), None);
        assert_eq!(valid_session_id(Some("a b")), None);
        assert_eq!(valid_session_id(Some(&"x".repeat(101))), None);
        assert_eq!(valid_session_id(Some("é")), None);
    }

    #[test]
    fn settings_roundtrip_and_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        assert!(!load_settings(&path).enabled);
        std::fs::write(&path, r#"{"enabled":true,"port":7400,"token":"pdg_x"}"#).unwrap();
        let s = load_settings(&path);
        assert!(s.enabled && s.port == 7400 && s.token == "pdg_x");
        std::fs::write(&path, r#"{"enabled":true,"port":80}"#).unwrap();
        assert_eq!(load_settings(&path).port, DEFAULT_PORT);
        std::fs::write(&path, "not json").unwrap();
        let s = load_settings(&path);
        assert!(!s.enabled);
        assert!(!path.exists(), "the broken file is set aside");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn events_serialize_with_a_type_tag() {
        let v = serde_json::to_value(McpEvent::Sessions).unwrap();
        assert_eq!(v, json!({ "type": "sessions" }));
        let e = McpLogEntry::new(1, "s", "c", McpLogKind::Tool, "ping");
        let v = serde_json::to_value(McpEvent::Entry { entry: Box::new(e) }).unwrap();
        assert_eq!(v["type"], "entry");
        assert_eq!(v["entry"]["tool"], "ping");
    }
}
