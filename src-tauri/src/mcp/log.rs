//! The MCP action log: `<data dir>/mcp/log.jsonl`, one JSON entry per line, append-only.
//!
//! Entries older than [`RETENTION_DAYS`] are removed at start and every hour (the file is rewritten
//! atomically); a file above [`MAX_BYTES`] also loses its oldest entries. Queries read the file, so the log
//! needs no memory of its own and survives restarts as it is.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::write_private;

pub const RETENTION_DAYS: u32 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The file is cut to this size (oldest entries first) when it grows above it.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Rows and cell length of a result preview.
pub const PREVIEW_ROWS: usize = 20;
pub const PREVIEW_CELL_CHARS: usize = 200;
/// Most bytes one serialized entry may take. A caller can send big SQL, long names, many arguments or a result
/// with hundreds of columns: whatever does not fit is cut (see [`fit_entry`]), so no call can flood the log.
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// A file over [`MAX_BYTES`] is pruned down to this share of it, so the next entries do not prune again.
const LOW_WATER_PERCENT: u64 = 80;
/// A session counts as active when it was seen within this time and was not ended.
pub const ACTIVE_WINDOW_MS: i64 = 10 * 60 * 1000;
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpLogStatus {
    Ok,
    Error,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpLogKind {
    Session,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLogEntry {
    pub id: String,
    pub ts_ms: i64,
    pub session_id: String,
    pub client_name: String,
    pub kind: McpLogKind,
    pub tool: String,
    pub data_source_id: Option<String>,
    pub data_source_name: Option<String>,
    pub sql: Option<String>,
    pub args: Option<Value>,
    pub status: McpLogStatus,
    pub error: Option<String>,
    pub elapsed_ms: u64,
    pub row_count: Option<u64>,
    pub rows_affected: Option<u64>,
    pub truncated: bool,
    pub preview: Option<McpPreview>,
    pub summary: String,
}

impl McpLogEntry {
    /// An entry with the identity fields set and everything else empty (`ok`, no data source, no result).
    pub fn new(
        ts_ms: i64,
        session_id: &str,
        client_name: &str,
        kind: McpLogKind,
        tool: &str,
    ) -> Self {
        McpLogEntry {
            id: uuid::Uuid::new_v4().to_string(),
            ts_ms,
            session_id: session_id.to_string(),
            client_name: client_name.to_string(),
            kind,
            tool: tool.to_string(),
            data_source_id: None,
            data_source_name: None,
            sql: None,
            args: None,
            status: McpLogStatus::Ok,
            error: None,
            elapsed_ms: 0,
            row_count: None,
            rows_affected: None,
            truncated: false,
            preview: None,
            summary: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpLogQuery {
    pub session_id: Option<String>,
    pub data_source_id: Option<String>,
    pub status: Option<McpLogStatus>,
    pub text: Option<String>,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
    pub limit: Option<usize>,
    /// Paging: only entries older than this.
    pub before_ts_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSession {
    pub id: String,
    pub client_name: String,
    pub client_version: Option<String>,
    pub started_at_ms: i64,
    pub last_seen_ms: i64,
    pub active: bool,
    pub action_count: u64,
    pub error_count: u64,
    pub write_count: u64,
    pub data_source_ids: Vec<String>,
}

/// Cut `s` to `max` characters; `note` adds how long it was.
pub fn cut(s: &str, max: usize, note: bool) -> String {
    let mut it = s.char_indices();
    match it.nth(max) {
        None => s.to_string(),
        Some((at, _)) => {
            if note {
                format!(
                    "{}... [cut, {} characters in all]",
                    &s[..at],
                    s.chars().count()
                )
            } else {
                format!("{}...", &s[..at])
            }
        }
    }
}

fn json_len(v: &impl Serialize) -> usize {
    serde_json::to_string(v)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

/// `entry` cut so that its JSON is at most [`MAX_ENTRY_BYTES`]: the arguments first (replaced by a short note),
/// then the preview rows, then the SQL, then the long texts; the fixed-size fields stay.
pub fn fit_entry(entry: &McpLogEntry) -> McpLogEntry {
    let mut e = entry.clone();
    // bounded fields first: nothing here may take more than a few hundred bytes
    e.client_name = cut(&e.client_name, 100, false);
    e.session_id = cut(&e.session_id, 100, false);
    e.tool = cut(&e.tool, 100, false);
    e.id = cut(&e.id, 100, false);
    e.data_source_id = e.data_source_id.map(|s| cut(&s, 200, false));
    e.data_source_name = e.data_source_name.map(|s| cut(&s, 200, false));
    e.summary = cut(&e.summary, 500, false);
    e.error = e.error.map(|s| cut(&s, 4000, true));
    if let Some(sql) = &e.sql {
        e.sql = Some(cut(sql, 8000, true));
    }
    if json_len(&e.args) > 2000 {
        let text = e.args.as_ref().map(Value::to_string).unwrap_or_default();
        e.args = Some(serde_json::json!({ "cut": cut(&text, 500, true) }));
    }
    // the preview: fewer rows until it fits
    while json_len(&e) > MAX_ENTRY_BYTES {
        match e.preview.as_mut() {
            Some(p) if p.rows.len() > 1 => p.rows.truncate(p.rows.len() / 2),
            Some(p) if !p.rows.is_empty() || p.columns.len() > 20 => {
                p.rows.clear();
                p.columns.truncate(20);
            }
            Some(_) => e.preview = None,
            None => break,
        }
    }
    // then the SQL, error and arguments
    let mut sql_chars = 4000;
    while json_len(&e) > MAX_ENTRY_BYTES && sql_chars >= 100 {
        if let Some(sql) = &e.sql {
            e.sql = Some(cut(sql, sql_chars, true));
        }
        e.error = e.error.map(|s| cut(&s, sql_chars, true));
        sql_chars /= 2;
    }
    if json_len(&e) > MAX_ENTRY_BYTES {
        e.args = None;
        e.preview = None;
    }
    e
}

/// The preview of a result: at most [`PREVIEW_ROWS`] rows, every value cut to [`PREVIEW_CELL_CHARS`].
pub fn make_preview(columns: &[String], rows: &[Vec<Option<String>>]) -> McpPreview {
    McpPreview {
        columns: columns.to_vec(),
        rows: rows
            .iter()
            .take(PREVIEW_ROWS)
            .map(|r| {
                r.iter()
                    .map(|v| v.as_deref().map(|s| cut(s, PREVIEW_CELL_CHARS, false)))
                    .collect()
            })
            .collect(),
    }
}

/// Does `e` match every filter of `q`?
fn matches(e: &McpLogEntry, q: &McpLogQuery, needle: Option<&str>) -> bool {
    if q.session_id.as_deref().is_some_and(|s| s != e.session_id) {
        return false;
    }
    if let Some(d) = &q.data_source_id {
        if e.data_source_id.as_deref() != Some(d.as_str()) {
            return false;
        }
    }
    if q.status.is_some_and(|s| s != e.status) {
        return false;
    }
    if q.since_ms.is_some_and(|t| e.ts_ms < t)
        || q.until_ms.is_some_and(|t| e.ts_ms > t)
        || q.before_ts_ms.is_some_and(|t| e.ts_ms >= t)
    {
        return false;
    }
    if let Some(n) = needle {
        let hit = |s: &str| s.to_lowercase().contains(n);
        let found = e.sql.as_deref().is_some_and(hit)
            || hit(&e.summary)
            || hit(&e.tool)
            || e.error.as_deref().is_some_and(hit);
        if !found {
            return false;
        }
    }
    true
}

pub struct McpLog {
    path: PathBuf,
    /// Serializes appends, the atomic rewrite of a prune, and clearing.
    lock: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsOnly {
    ts_ms: i64,
}

impl McpLog {
    pub fn new(path: PathBuf) -> Self {
        McpLog {
            path,
            lock: Mutex::new(()),
        }
    }

    /// Adds one entry, cut to [`MAX_ENTRY_BYTES`].
    pub fn append(&self, entry: &McpLogEntry) -> Result<(), String> {
        let mut line = serde_json::to_string(&fit_entry(entry)).map_err(|e| e.to_string())?;
        line.push('\n');
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        }
        let mut opts = fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts
            .open(&self.path)
            .map_err(|e| format!("Cannot open {}: {e}", self.path.display()))?;
        f.write_all(line.as_bytes())
            .map_err(|e| format!("Cannot write {}: {e}", self.path.display()))
    }

    /// Current size of the file.
    pub fn size(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    /// Every readable entry, oldest first (a line that does not parse, e.g. a torn write, is skipped).
    fn read_all(&self) -> Vec<McpLogEntry> {
        let guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(text) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        drop(guard);
        text.lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Entries that match `q`, newest first.
    pub fn query(&self, q: &McpLogQuery) -> Vec<McpLogEntry> {
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let needle = q
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_lowercase);
        let mut all = self.read_all();
        // the file is in write order; a clock that moved back must not break the "newest first" promise
        all.sort_by_key(|e| e.ts_ms);
        all.into_iter()
            .rev()
            .filter(|e| matches(e, q, needle.as_deref()))
            .take(limit)
            .collect()
    }

    /// [`query`](Self::query) that never returns an entry older than the retention time, whether or not a prune
    /// has run since (the log may sit unpruned while the server is off).
    pub fn query_recent(&self, q: &McpLogQuery, now_ms: i64) -> Vec<McpLogEntry> {
        let cutoff = now_ms - i64::from(RETENTION_DAYS) * DAY_MS;
        let mut q = q.clone();
        q.since_ms = Some(q.since_ms.map_or(cutoff, |s| s.max(cutoff)));
        self.query(&q)
    }

    /// Entries of one session, oldest first.
    pub fn session_entries(&self, session_id: &str) -> Vec<McpLogEntry> {
        self.read_all()
            .into_iter()
            .filter(|e| e.session_id == session_id)
            .collect()
    }

    /// The sessions seen since `since_ms`, newest activity first, derived from the log entries.
    pub fn sessions(&self, now_ms: i64, since_ms: i64) -> Vec<McpSession> {
        sessions_of(self.read_all(), now_ms, since_ms)
    }

    /// Removes the entries older than `retention_days` and, when the file is still bigger than `max_bytes`, the
    /// oldest ones until it is down to 80% of it. Returns how many entries were removed. The file is replaced atomically.
    pub fn prune(&self, now_ms: i64, retention_days: u32, max_bytes: u64) -> Result<usize, String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(format!("Cannot read {}: {e}", self.path.display())),
        };
        let cutoff = now_ms - i64::from(retention_days) * DAY_MS;
        let total_lines = text.lines().count();
        let mut kept: Vec<&str> = text
            .lines()
            .filter(|l| {
                serde_json::from_str::<TsOnly>(l)
                    .map(|t| t.ts_ms >= cutoff)
                    .unwrap_or(false)
            })
            .collect();
        let mut bytes: u64 = kept.iter().map(|l| l.len() as u64 + 1).sum();
        // over the cap: go down to the low-water mark, not just under the cap
        let target = if bytes > max_bytes {
            max_bytes / 100 * LOW_WATER_PERCENT
        } else {
            max_bytes
        };
        let mut skip = 0;
        while bytes > target && skip < kept.len() {
            bytes -= kept[skip].len() as u64 + 1;
            skip += 1;
        }
        kept.drain(..skip);
        let removed = total_lines - kept.len();
        if removed == 0 {
            return Ok(0);
        }
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        write_private(&self.path, out.as_bytes())?;
        Ok(removed)
    }

    /// Deletes every entry.
    pub fn clear(&self) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Cannot delete {}: {e}", self.path.display())),
        }
    }
}

/// Folds log entries (oldest first) into sessions.
pub fn sessions_of(entries: Vec<McpLogEntry>, now_ms: i64, since_ms: i64) -> Vec<McpSession> {
    struct Acc {
        s: McpSession,
        ended: bool,
        ds: BTreeSet<String>,
        named: bool,
    }
    let mut map: HashMap<String, Acc> = HashMap::new();
    for e in entries.into_iter().filter(|e| e.ts_ms >= since_ms) {
        let acc = map.entry(e.session_id.clone()).or_insert_with(|| Acc {
            s: McpSession {
                id: e.session_id.clone(),
                client_name: e.client_name.clone(),
                client_version: None,
                started_at_ms: e.ts_ms,
                last_seen_ms: e.ts_ms,
                active: false,
                action_count: 0,
                error_count: 0,
                write_count: 0,
                data_source_ids: Vec::new(),
            },
            ended: false,
            ds: BTreeSet::new(),
            named: false,
        });
        acc.s.started_at_ms = acc.s.started_at_ms.min(e.ts_ms);
        acc.s.last_seen_ms = acc.s.last_seen_ms.max(e.ts_ms);
        match e.kind {
            McpLogKind::Session if e.tool == "initialize" => {
                acc.s.client_name = e.client_name.clone();
                acc.named = true;
                acc.s.client_version = e
                    .args
                    .as_ref()
                    .and_then(|a| a.pointer("/clientInfo/version"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                acc.ended = false;
            }
            McpLogKind::Session => acc.ended = true,
            McpLogKind::Tool => {
                // an agent that goes on after `end` is active again
                acc.ended = false;
                if !acc.named && e.client_name != "unknown" {
                    acc.s.client_name = e.client_name.clone();
                }
                acc.s.action_count += 1;
                if e.status != McpLogStatus::Ok {
                    acc.s.error_count += 1;
                }
                if e.tool == "execute_statement" {
                    acc.s.write_count += 1;
                }
                if let Some(d) = &e.data_source_id {
                    acc.ds.insert(d.clone());
                }
            }
        }
    }
    let mut out: Vec<McpSession> = map
        .into_values()
        .map(|mut a| {
            a.s.active = !a.ended && now_ms - a.s.last_seen_ms < ACTIVE_WINDOW_MS;
            a.s.data_source_ids = a.ds.into_iter().collect();
            a.s
        })
        .collect();
    out.sort_by(|a, b| {
        b.last_seen_ms
            .cmp(&a.last_seen_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log() -> (tempfile::TempDir, McpLog) {
        let dir = tempfile::tempdir().unwrap();
        let l = McpLog::new(dir.path().join("mcp").join("log.jsonl"));
        (dir, l)
    }

    fn tool(ts: i64, session: &str, name: &str, status: McpLogStatus) -> McpLogEntry {
        let mut e = McpLogEntry::new(ts, session, "claude-code", McpLogKind::Tool, name);
        e.status = status;
        e.summary = format!("did {name}");
        e
    }

    #[test]
    fn append_and_query_newest_first() {
        let (_d, l) = log();
        for i in 0..5 {
            l.append(&tool(1000 + i, "s1", "run_query", McpLogStatus::Ok))
                .unwrap();
        }
        let got = l.query(&McpLogQuery::default());
        assert_eq!(got.len(), 5);
        assert!(got.windows(2).all(|w| w[0].ts_ms > w[1].ts_ms));
        let got = l.query(&McpLogQuery {
            limit: Some(2),
            ..Default::default()
        });
        assert_eq!(
            got.iter().map(|e| e.ts_ms).collect::<Vec<_>>(),
            [1004, 1003]
        );
        // paging
        let got = l.query(&McpLogQuery {
            limit: Some(2),
            before_ts_ms: Some(1003),
            ..Default::default()
        });
        assert_eq!(
            got.iter().map(|e| e.ts_ms).collect::<Vec<_>>(),
            [1002, 1001]
        );
    }

    #[test]
    fn query_filters() {
        let (_d, l) = log();
        let mut a = tool(10, "s1", "run_query", McpLogStatus::Ok);
        a.data_source_id = Some("ds1".into());
        a.sql = Some("SELECT * FROM Orders".into());
        let mut b = tool(20, "s2", "execute_statement", McpLogStatus::Denied);
        b.data_source_id = Some("ds2".into());
        b.error = Some("No write permission".into());
        b.sql = Some("delete from t".into());
        let c = tool(30, "s1", "list_schemas", McpLogStatus::Error);
        for e in [&a, &b, &c] {
            l.append(e).unwrap();
        }
        let q = |f: fn(&mut McpLogQuery)| {
            let mut q = McpLogQuery::default();
            f(&mut q);
            l.query(&q).iter().map(|e| e.ts_ms).collect::<Vec<_>>()
        };
        assert_eq!(q(|q| q.session_id = Some("s1".into())), [30, 10]);
        assert_eq!(q(|q| q.data_source_id = Some("ds2".into())), [20]);
        assert_eq!(q(|q| q.status = Some(McpLogStatus::Denied)), [20]);
        assert_eq!(q(|q| q.since_ms = Some(20)), [30, 20]);
        assert_eq!(q(|q| q.until_ms = Some(20)), [20, 10]);
        // text: sql, summary, tool and error, case-insensitive
        assert_eq!(q(|q| q.text = Some("ORDERS".into())), [10]);
        assert_eq!(q(|q| q.text = Some("no write".into())), [20]);
        assert_eq!(q(|q| q.text = Some("EXECUTE_".into())), [20]);
        assert_eq!(q(|q| q.text = Some("did list".into())), [30]);
        assert_eq!(q(|q| q.text = Some("  ".into())).len(), 3);
        assert!(q(|q| q.text = Some("nothing like this".into())).is_empty());
    }

    #[test]
    fn query_limit_is_capped() {
        let (_d, l) = log();
        for i in 0..1005 {
            l.append(&tool(i, "s", "ping", McpLogStatus::Ok)).unwrap();
        }
        let q = McpLogQuery {
            limit: Some(100_000),
            ..Default::default()
        };
        assert_eq!(l.query(&q).len(), MAX_LIMIT);
        assert_eq!(l.query(&McpLogQuery::default()).len(), DEFAULT_LIMIT);
    }

    #[test]
    fn prune_removes_old_entries_and_keeps_the_rest() {
        let (_d, l) = log();
        let now = 100 * DAY_MS;
        l.append(&tool(now - 31 * DAY_MS, "old", "a", McpLogStatus::Ok))
            .unwrap();
        l.append(&tool(now - 30 * DAY_MS - 1, "old", "b", McpLogStatus::Ok))
            .unwrap();
        l.append(&tool(now - 29 * DAY_MS, "new", "c", McpLogStatus::Ok))
            .unwrap();
        l.append(&tool(now, "new", "d", McpLogStatus::Ok)).unwrap();
        assert_eq!(l.prune(now, RETENTION_DAYS, MAX_BYTES).unwrap(), 2);
        let tools: Vec<_> = l
            .query(&McpLogQuery::default())
            .into_iter()
            .map(|e| e.tool)
            .collect();
        assert_eq!(tools, ["d", "c"]);
        // nothing left to remove: no rewrite, no error
        assert_eq!(l.prune(now, RETENTION_DAYS, MAX_BYTES).unwrap(), 0);
        // appending still works after the rewrite
        l.append(&tool(now + 1, "new", "e", McpLogStatus::Ok))
            .unwrap();
        assert_eq!(l.query(&McpLogQuery::default()).len(), 3);
    }

    #[test]
    fn prune_without_a_file_is_fine() {
        let (_d, l) = log();
        assert_eq!(l.prune(1, RETENTION_DAYS, MAX_BYTES).unwrap(), 0);
    }

    #[test]
    fn prune_caps_the_size_dropping_the_oldest_first() {
        let (_d, l) = log();
        let now = DAY_MS * 50;
        for i in 0..10 {
            l.append(&tool(now + i, "s", &format!("t{i}"), McpLogStatus::Ok))
                .unwrap();
        }
        let one = l.size() / 10;
        let removed = l
            .prune(now + 10, RETENTION_DAYS, one * 3 + one / 2)
            .unwrap();
        // over the cap (3.5 entries): pruned to 80% of it (2.8 entries), so two are left
        assert_eq!(removed, 8);
        let tools: Vec<_> = l
            .query(&McpLogQuery::default())
            .into_iter()
            .map(|e| e.tool)
            .collect();
        assert_eq!(tools, ["t9", "t8"]);
        // under the cap nothing more goes
        let cap = l.size() + 10;
        assert_eq!(l.prune(now + 10, RETENTION_DAYS, cap).unwrap(), 0);
    }

    #[test]
    fn broken_lines_are_skipped_and_dropped_by_prune() {
        let (_d, l) = log();
        l.append(&tool(5, "s", "a", McpLogStatus::Ok)).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&l.path)
            .unwrap()
            .write_all(b"{\"id\": \"torn\n")
            .unwrap();
        l.append(&tool(6, "s", "b", McpLogStatus::Ok)).unwrap();
        assert_eq!(l.query(&McpLogQuery::default()).len(), 2);
        assert_eq!(l.prune(10, RETENTION_DAYS, MAX_BYTES).unwrap(), 1);
        assert_eq!(l.query(&McpLogQuery::default()).len(), 2);
    }

    #[test]
    fn clear_removes_everything() {
        let (_d, l) = log();
        l.clear().unwrap(); // no file yet
        l.append(&tool(5, "s", "a", McpLogStatus::Ok)).unwrap();
        l.clear().unwrap();
        assert!(l.query(&McpLogQuery::default()).is_empty());
        l.append(&tool(6, "s", "b", McpLogStatus::Ok)).unwrap();
        assert_eq!(l.query(&McpLogQuery::default()).len(), 1);
    }

    #[test]
    fn long_sql_is_cut_in_the_log() {
        let (_d, l) = log();
        let mut e = tool(1, "s", "run_query", McpLogStatus::Ok);
        e.sql = Some("x".repeat(100_000));
        l.append(&e).unwrap();
        let got = l.query(&McpLogQuery::default());
        let sql = got[0].sql.as_deref().unwrap();
        assert!(sql.len() < 9000 && sql.contains("cut"), "{}", sql.len());
    }

    #[test]
    fn no_entry_is_bigger_than_the_cap() {
        let (_d, l) = log();
        let mut e = tool(1, "s", "run_query", McpLogStatus::Ok);
        e.sql = Some("é".repeat(200_000));
        e.client_name = "c".repeat(50_000);
        e.session_id = "s".repeat(50_000);
        e.data_source_id = Some("d".repeat(50_000));
        e.data_source_name = Some("n".repeat(50_000));
        e.summary = "m".repeat(50_000);
        e.error = Some("x".repeat(50_000));
        let args: serde_json::Map<String, Value> = (0..5000)
            .map(|i| (format!("key{i}"), Value::String("v".repeat(300))))
            .collect();
        e.args = Some(Value::Object(args));
        // 200 columns and 20 rows of 200 characters
        let cols: Vec<String> = (0..200).map(|i| format!("c{i}")).collect();
        let rows: Vec<Vec<Option<String>>> = (0..30)
            .map(|_| (0..200).map(|_| Some("z".repeat(500))).collect())
            .collect();
        e.preview = Some(make_preview(&cols, &rows));
        let fitted = fit_entry(&e);
        let len = serde_json::to_string(&fitted).unwrap().len();
        assert!(len <= MAX_ENTRY_BYTES, "{len}");
        // what matters survives
        assert_eq!(fitted.tool, "run_query");
        assert_eq!(fitted.status, McpLogStatus::Ok);
        assert!(fitted.sql.as_deref().unwrap().starts_with("éé"));
        l.append(&e).unwrap();
        assert!(l.size() as usize <= MAX_ENTRY_BYTES + 1);
        assert_eq!(l.query(&McpLogQuery::default()).len(), 1);
    }

    #[test]
    fn small_entries_are_not_touched() {
        let mut e = tool(1, "s", "run_query", McpLogStatus::Ok);
        e.sql = Some("select 1".into());
        e.args = Some(serde_json::json!({"maxRows": 5}));
        e.preview = Some(make_preview(&["a".into()], &[vec![Some("1".into())]]));
        assert_eq!(fit_entry(&e), e);
    }

    #[test]
    fn a_wide_preview_loses_rows_not_the_entry() {
        let mut e = tool(1, "s", "run_query", McpLogStatus::Ok);
        let cols: Vec<String> = (0..10).map(|i| format!("c{i}")).collect();
        let rows: Vec<Vec<Option<String>>> = (0..20)
            .map(|_| (0..10).map(|_| Some("z".repeat(200))).collect())
            .collect();
        e.preview = Some(make_preview(&cols, &rows));
        let fitted = fit_entry(&e);
        let p = fitted.preview.unwrap();
        assert!(!p.rows.is_empty() && p.rows.len() < 20, "{}", p.rows.len());
        assert!(serde_json::to_string(&e).unwrap().len() > MAX_ENTRY_BYTES);
    }

    #[test]
    fn query_recent_never_shows_entries_past_retention() {
        let (_d, l) = log();
        let now = 100 * DAY_MS;
        l.append(&tool(now - 31 * DAY_MS, "s", "old", McpLogStatus::Ok))
            .unwrap();
        l.append(&tool(now - DAY_MS, "s", "new", McpLogStatus::Ok))
            .unwrap();
        // not pruned: still in the file
        let all = l.query(&McpLogQuery::default());
        assert_eq!(all.len(), 2);
        let recent = l.query_recent(&McpLogQuery::default(), now);
        assert_eq!(
            recent.iter().map(|e| e.tool.as_str()).collect::<Vec<_>>(),
            ["new"]
        );
        // a later `since` from the caller still applies
        let q = McpLogQuery {
            since_ms: Some(now),
            ..Default::default()
        };
        assert!(l.query_recent(&q, now).is_empty());
    }

    #[test]
    fn entries_serialize_camel_case() {
        let mut e = tool(7, "s", "run_query", McpLogStatus::Denied);
        e.preview = Some(make_preview(&["a".into()], &[vec![Some("1".into())]]));
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["tsMs"], 7);
        assert_eq!(v["sessionId"], "s");
        assert_eq!(v["kind"], "tool");
        assert_eq!(v["status"], "denied");
        assert_eq!(v["preview"]["rows"][0][0], "1");
        assert!(v["dataSourceId"].is_null() && v["rowCount"].is_null());
    }

    #[test]
    fn preview_is_limited() {
        let rows: Vec<Vec<Option<String>>> = (0..50)
            .map(|i| vec![Some("é".repeat(500)), None, Some(i.to_string())])
            .collect();
        let p = make_preview(&["a".into(), "b".into(), "c".into()], &rows);
        assert_eq!(p.rows.len(), PREVIEW_ROWS);
        let cell = p.rows[0][0].as_deref().unwrap();
        assert_eq!(cell.chars().count(), PREVIEW_CELL_CHARS + 3);
        assert!(p.rows[0][1].is_none());
        assert_eq!(p.rows[0][2].as_deref(), Some("0"));
    }

    #[test]
    fn cut_works_on_characters() {
        assert_eq!(cut("abc", 3, false), "abc");
        assert_eq!(cut("abcd", 3, false), "abc...");
        assert_eq!(cut("日本語です", 2, false), "日本...");
        assert!(cut("abcdef", 2, true).starts_with("ab... [cut, 6"));
    }

    fn session_entry(ts: i64, sid: &str, kind: McpLogKind, tool: &str) -> McpLogEntry {
        McpLogEntry::new(ts, sid, "claude-code", kind, tool)
    }

    #[test]
    fn sessions_are_derived_from_entries() {
        let now = 1_000_000_000;
        let mut init = session_entry(now - 5000, "s1", McpLogKind::Session, "initialize");
        init.args =
            Some(serde_json::json!({"clientInfo": {"name": "claude-code", "version": "2.1"}}));
        let mut q = session_entry(now - 4000, "s1", McpLogKind::Tool, "run_query");
        q.data_source_id = Some("b".into());
        let mut w = session_entry(now - 3000, "s1", McpLogKind::Tool, "execute_statement");
        w.data_source_id = Some("a".into());
        w.status = McpLogStatus::Denied;
        let mut e = session_entry(now - 2000, "s1", McpLogKind::Tool, "run_query");
        e.status = McpLogStatus::Error;
        e.data_source_id = Some("a".into());
        // an ended session, and one without initialize (implicit)
        let init2 = session_entry(now - 9000, "s2", McpLogKind::Session, "initialize");
        let end2 = session_entry(now - 8000, "s2", McpLogKind::Session, "end");
        let mut t3 = session_entry(now - 7000, "s3", McpLogKind::Tool, "list_schemas");
        t3.client_name = "unknown".into();
        let old = session_entry(now - 40 * DAY_MS, "s4", McpLogKind::Tool, "run_query");

        let got = sessions_of(
            vec![old, init2, end2, t3, init, q, w, e],
            now,
            now - 30 * DAY_MS,
        );
        assert_eq!(
            got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["s1", "s3", "s2"]
        );
        let s1 = &got[0];
        assert_eq!(s1.client_name, "claude-code");
        assert_eq!(s1.client_version.as_deref(), Some("2.1"));
        assert_eq!(
            (s1.started_at_ms, s1.last_seen_ms),
            (now - 5000, now - 2000)
        );
        assert_eq!((s1.action_count, s1.error_count, s1.write_count), (3, 2, 1));
        assert_eq!(s1.data_source_ids, ["a", "b"]);
        assert!(s1.active);
        assert!(!got[2].active, "ended");
        assert_eq!(got[1].client_name, "unknown");
        assert!(got[1].active);
    }

    #[test]
    fn a_session_is_not_active_after_ten_minutes() {
        let now = 10 * DAY_MS;
        let e = session_entry(
            now - ACTIVE_WINDOW_MS - 1,
            "s",
            McpLogKind::Tool,
            "run_query",
        );
        let got = sessions_of(vec![e], now, 0);
        assert!(!got[0].active);
    }
}
