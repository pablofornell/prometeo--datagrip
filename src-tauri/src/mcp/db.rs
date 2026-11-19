//! The database connections of the MCP server.
//!
//! They are separate from the user's own: a data source `X` is connected a second time under the id
//! `mcp-ro:X` (read-only, whatever the data source says) for the read tools and `mcp-rw:X` (the data source's own
//! read-only flag) for `execute_statement`. These ids are never saved in the data source store and the app
//! never shows them. Each connection has one dbcore session behind a mutex, so concurrent calls queue instead
//! of failing with `Busy`. A lost connection is re-established once for reads; a write that was cut off is
//! never repeated (it may have been applied).
//!
//! Read-only is layered, and none of it is a substitute for a database user that only has SELECT rights:
//! the connection is opened read-only (PostgreSQL `default_transaction_read_only`, MySQL `READ ONLY` session,
//! SQLite read-only open, Oracle client-side keyword gate), and on PostgreSQL every read statement also runs in
//! its own `BEGIN READ ONLY` transaction, because a session setting can be switched off by a statement
//! (`select set_config('default_transaction_read_only', 'off', false)`) while a transaction that already ran a
//! query cannot be made read-write. Functions with side effects (Oracle autonomous transactions, `dblink`) are
//! beyond what any session setting stops.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbcore::{
    ConnectionManager, DataSourceConfig, DbError, Driver, ExecEvent, ExecOptions, SessionId,
};
use tokio::sync::Mutex as AsyncMutex;

use crate::state::{close_all, SHUTDOWN_GRACE, SHUTDOWN_SOURCE_GRACE};
use crate::store::DataSourceStore;

/// Why a call did not run: the policy refused it (again, once it had the connection) or the database failed.
#[derive(Debug)]
pub enum DbErr {
    Denied(String),
    Failed(String),
}

impl From<String> for DbErr {
    fn from(s: String) -> Self {
        DbErr::Failed(s)
    }
}

/// Checked once the call holds the connection (after it waited in line): `Err` when the access it needs was
/// taken away meanwhile, so a connection that a policy change closed is not opened again for a call that queued.
pub type Guard<'a> = &'a (dyn Fn() -> Result<(), String> + Sync);

/// A transaction that is still open after a statement is rolled back with this.
const ROLLBACK: &str = "ROLLBACK";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Read,
    Write,
}

pub fn conn_id(mode: Mode, ds_id: &str) -> String {
    match mode {
        Mode::Read => format!("mcp-ro:{ds_id}"),
        Mode::Write => format!("mcp-rw:{ds_id}"),
    }
}

#[derive(Default)]
struct Slot {
    /// Hash of the config the connection was made from: a changed data source reconnects.
    fingerprint: Option<u64>,
    session: Option<SessionId>,
}

pub struct McpDb {
    mgr: ConnectionManager,
    sources: Arc<DataSourceStore>,
    slots: Mutex<HashMap<String, Arc<AsyncMutex<Slot>>>>,
}

fn fingerprint(cfg: &DataSourceConfig) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(cfg).unwrap_or_default().hash(&mut h);
    h.finish()
}

impl McpDb {
    pub fn new(mgr: ConnectionManager, sources: Arc<DataSourceStore>) -> Self {
        McpDb {
            mgr,
            sources,
            slots: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, cid: &str) -> Arc<AsyncMutex<Slot>> {
        self.slots
            .lock()
            .unwrap()
            .entry(cid.to_string())
            .or_default()
            .clone()
    }

    /// The stored config (password included) as the MCP connection of `mode` uses it.
    async fn config(&self, ds_id: &str, mode: Mode) -> Result<DataSourceConfig, String> {
        let sources = self.sources.clone();
        let id = ds_id.to_string();
        let mut cfg = tokio::task::spawn_blocking(move || sources.get(&id))
            .await
            .map_err(|e| e.to_string())??;
        cfg.id = conn_id(mode, ds_id);
        if mode == Mode::Read {
            cfg.read_only = true;
        }
        Ok(cfg)
    }

    /// Drops the session and the connection of the slot.
    async fn reset(&self, slot: &mut Slot, cid: &str) {
        if let Some(sid) = slot.session.take() {
            self.mgr.close_session(&sid).await;
        }
        slot.fingerprint = None;
        self.mgr.disconnect(cid).await;
    }

    async fn ensure_connected(
        &self,
        slot: &mut Slot,
        cfg: &DataSourceConfig,
        fp: u64,
    ) -> Result<(), String> {
        if slot.fingerprint.is_some_and(|f| f != fp) {
            self.reset(slot, &cfg.id).await;
        }
        if !self.mgr.is_connected(&cfg.id) {
            slot.session = None;
            self.mgr
                .connect(cfg)
                .await
                .map_err(|e| format!("Cannot connect to '{}': {e}", cfg.name))?;
        }
        slot.fingerprint = Some(fp);
        Ok(())
    }

    async fn ensure_session(
        &self,
        slot: &mut Slot,
        cfg: &DataSourceConfig,
        fp: u64,
    ) -> Result<SessionId, String> {
        self.ensure_connected(slot, cfg, fp).await?;
        if let Some(sid) = &slot.session {
            match self.mgr.session_state(sid) {
                Ok(st) if !st.connection_lost => return Ok(sid.clone()),
                _ => {
                    // lost (dbcore would reopen it on its own, but we start from a clean connection) or gone
                    self.reset(slot, &cfg.id).await;
                    self.ensure_connected(slot, cfg, fp).await?;
                }
            }
        }
        let sid = self
            .mgr
            .open_session(&cfg.id)
            .await
            .map_err(|e| format!("Cannot open a session on '{}': {e}", cfg.name))?;
        slot.session = Some(sid.clone());
        Ok(sid)
    }

    /// One statement on `sid`. On PostgreSQL a read runs in its own `BEGIN READ ONLY` ... `ROLLBACK`; a result
    /// that has more rows than were asked for is cancelled (the rest of a result inside a transaction would
    /// otherwise be read to the end before the `ROLLBACK`).
    async fn run_statement(
        &self,
        sid: &SessionId,
        sql: &str,
        opts: &ExecOptions,
        read_only_tx: bool,
    ) -> Result<Vec<ExecEvent>, DbError> {
        if !read_only_tx {
            return self.mgr.execute_collect(sid, sql, opts.clone()).await;
        }
        let begin = self
            .mgr
            .execute_collect(sid, "BEGIN READ ONLY", simple_opts())
            .await?;
        if begin.iter().any(|e| matches!(e, ExecEvent::Error { .. })) {
            return Ok(begin);
        }
        let mut handle = match self.mgr.execute(sid, sql, opts.clone()).await {
            Ok(h) => h,
            Err(e) => {
                let _ = self.mgr.execute_collect(sid, ROLLBACK, simple_opts()).await;
                return Err(e);
            }
        };
        let mut out = Vec::new();
        let mut cancelled = false;
        while let Some(ev) = handle.events.recv().await {
            let done = matches!(ev, ExecEvent::Done { .. });
            if cancelled && matches!(ev, ExecEvent::Error { .. }) {
                // the error of our own cancel
                continue;
            }
            if matches!(ev, ExecEvent::ResultSet { has_more: true, .. }) && !cancelled {
                let _ = self.mgr.cancel(&handle.id);
                cancelled = true;
            }
            out.push(ev);
            if done {
                break;
            }
        }
        let _ = self.mgr.execute_collect(sid, ROLLBACK, simple_opts()).await;
        Ok(out)
    }

    /// Runs one statement on the connection of `mode` and returns its events. The statement is cancelled when
    /// it takes longer than `timeout`. A transaction that is still open afterwards is rolled back: for a write
    /// that is an error (nothing was committed), for a read it is silent.
    pub async fn run(
        &self,
        ds_id: &str,
        mode: Mode,
        sql: &str,
        opts: ExecOptions,
        timeout: Duration,
        guard: Guard<'_>,
    ) -> Result<Vec<ExecEvent>, DbErr> {
        let slot = self.slot(&conn_id(mode, ds_id));
        let mut slot = slot.lock().await;
        guard().map_err(DbErr::Denied)?;
        let cfg = self.config(ds_id, mode).await?;
        let fp = fingerprint(&cfg);
        let read_only_tx = mode == Mode::Read && cfg.driver == Driver::Postgres;
        let mut attempt = 0;
        loop {
            attempt += 1;
            let sid = self.ensure_session(&mut slot, &cfg, fp).await?;
            let retry_ok = mode == Mode::Read && attempt == 1;
            let run =
                tokio::time::timeout(timeout, self.run_statement(&sid, sql, &opts, read_only_tx));
            match run.await {
                Err(_) => {
                    let _ = self.mgr.cancel_session(&sid).await;
                    self.reset(&mut slot, &cfg.id).await;
                    return Err(DbErr::Failed(format!(
                        "The statement ran longer than {} seconds and was cancelled.{}",
                        timeout.as_secs(),
                        if mode == Mode::Write {
                            " Check whether it took effect before repeating it."
                        } else {
                            ""
                        }
                    )));
                }
                Ok(Err(e)) => {
                    let gone = e.is_connection_lost()
                        || matches!(e, DbError::NoSession(_) | DbError::NotConnected(_));
                    if gone {
                        self.reset(&mut slot, &cfg.id).await;
                    }
                    // `execute` failed before anything was sent: safe to try again, also for writes
                    if gone && attempt == 1 {
                        continue;
                    }
                    return Err(DbErr::Failed(e.to_string()));
                }
                Ok(Ok(events)) => {
                    let lost = events.iter().any(|e| {
                        matches!(
                            e,
                            ExecEvent::Error {
                                connection_lost: true,
                                ..
                            }
                        )
                    });
                    if lost {
                        self.reset(&mut slot, &cfg.id).await;
                        if retry_ok {
                            continue;
                        }
                        if mode == Mode::Write {
                            return Err(DbErr::Failed("The connection to the database was lost while the statement \
                                ran. It may or may not have been applied: check before repeating it."
                                .into()));
                        }
                        return Ok(events);
                    }
                    // never leave the shared session inside a transaction
                    if self
                        .mgr
                        .session_tx_status(&sid)
                        .map(|t| t.is_open())
                        .unwrap_or(false)
                    {
                        let _ = self
                            .mgr
                            .execute_collect(&sid, ROLLBACK, simple_opts())
                            .await;
                        let still_open = self
                            .mgr
                            .session_tx_status(&sid)
                            .map(|t| t.is_open())
                            .unwrap_or(true);
                        if still_open {
                            self.reset(&mut slot, &cfg.id).await;
                        }
                        let failed = events.iter().any(|e| matches!(e, ExecEvent::Error { .. }));
                        if mode == Mode::Write && !failed {
                            return Err(DbErr::Failed(
                                "The statement left a transaction open. It was rolled back: nothing was committed."
                                    .into(),
                            ));
                        }
                    }
                    return Ok(events);
                }
            }
        }
    }

    /// Runs `f` on the read-only connection of the data source (introspection works on the connection itself,
    /// not on a session). Tried a second time on a fresh connection when the first one was lost.
    pub async fn with_conn<T, F, Fut>(
        &self,
        ds_id: &str,
        timeout: Duration,
        guard: Guard<'_>,
        f: F,
    ) -> Result<T, DbErr>
    where
        F: Fn(ConnectionManager, String) -> Fut,
        Fut: Future<Output = Result<T, DbError>>,
    {
        let slot = self.slot(&conn_id(Mode::Read, ds_id));
        let mut slot = slot.lock().await;
        guard().map_err(DbErr::Denied)?;
        let cfg = self.config(ds_id, Mode::Read).await?;
        let fp = fingerprint(&cfg);
        for attempt in 1..=2 {
            self.ensure_connected(&mut slot, &cfg, fp).await?;
            let run = tokio::time::timeout(timeout, f(self.mgr.clone(), cfg.id.clone()));
            match run.await {
                Err(_) => {
                    self.reset(&mut slot, &cfg.id).await;
                    return Err(DbErr::Failed(format!(
                        "The request took longer than {} seconds.",
                        timeout.as_secs()
                    )));
                }
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(e)) => {
                    let gone = e.is_connection_lost() || matches!(e, DbError::NotConnected(_));
                    if gone {
                        self.reset(&mut slot, &cfg.id).await;
                    }
                    if !gone || attempt == 2 {
                        return Err(DbErr::Failed(e.to_string()));
                    }
                }
            }
        }
        unreachable!("the loop returns on its last attempt")
    }

    /// Closes the connections of one data source (a policy change took the access away, or it was deleted).
    pub async fn close(&self, ds_id: &str, mode: Mode) {
        let cid = conn_id(mode, ds_id);
        if tokio::time::timeout(SHUTDOWN_SOURCE_GRACE, self.mgr.disconnect(&cid))
            .await
            .is_err()
        {
            tracing::warn!("MCP connection {cid} did not close in time");
        }
    }

    pub async fn close_source(&self, ds_id: &str) {
        self.close(ds_id, Mode::Read).await;
        self.close(ds_id, Mode::Write).await;
    }

    /// Closes every MCP connection (the server stops, or the app exits), all at once and with the same time limits
    /// as the app's own connections: a connection that hangs is given up, not waited for.
    pub async fn close_all(&self) {
        let ids: Vec<String> = self.slots.lock().unwrap().keys().cloned().collect();
        let mgr = self.mgr.clone();
        let stuck = close_all(ids, SHUTDOWN_GRACE, SHUTDOWN_SOURCE_GRACE, move |id| {
            let mgr = mgr.clone();
            async move { mgr.disconnect(&id).await }
        })
        .await;
        if !stuck.is_empty() {
            tracing::warn!("{} MCP connection(s) did not close in time", stuck.len());
        }
        self.slots.lock().unwrap().clear();
    }
}

fn simple_opts() -> ExecOptions {
    ExecOptions {
        max_rows: 1,
        stop_on_error: true,
        keep_open_secs: 1,
        auto_commit: false,
    }
}
