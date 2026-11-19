//! The MCP tools: their definitions (`tools/list`) and what they do (`tools/call`).
//!
//! Every call is checked against the policy, run on the MCP connections (`db.rs`) and recorded in the log,
//! whatever its outcome. Results are compact JSON in one text block; errors are `isError` results whose text
//! says what is missing and how to fix it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dbcore::{split_statements, DbError, ExecEvent, ExecOptions, ObjectRef};
use serde_json::{json, Map, Value};

use super::classify;
use super::db::{DbErr, Mode};
use super::log::{cut, make_preview, McpLogEntry, McpLogKind, McpLogStatus};
use super::policy::McpEffectivePerm;
use super::protocol::{self, INVALID_PARAMS};
use super::{now_ms, McpService, SessionRef};

const DEFAULT_MAX_ROWS: usize = 200;
const MAX_ROWS: usize = 1000;
/// Longest value handed to the agent.
const AGENT_CELL_CHARS: usize = 2000;
/// Largest result text handed to the agent (a result that does not fit is cut at a row and marked `truncated`).
const MAX_RESULT_BYTES: usize = 512 * 1024;
const MAX_LISTED_TABLES: usize = 2000;
const MAX_DDL_CHARS: usize = 100_000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const WRITE_TIMEOUT: Duration = Duration::from_secs(300);
const INTROSPECT_TIMEOUT: Duration = Duration::from_secs(60);

/// The pseudo-session and client name of calls that came without the token: what the caller says about itself
/// is not stored.
const UNAUTHORIZED_SESSION: &str = "unauthorized";
const UNAUTHORIZED_CLIENT: &str = "unauthorized caller";

const FIX_PERMISSIONS: &str =
    "The user grants permissions in Prometeo DataGrip > MCP > Permissions.";
const UNAUTHORIZED: &str = "Missing or invalid bearer token for the Prometeo DataGrip MCP server. Copy the current token \
from Prometeo DataGrip > MCP and reconnect with the header `Authorization: Bearer <token>` \
(Claude Code: `claude mcp remove prometeo-datagrip`, then `claude mcp add --transport http prometeo-datagrip <url> --header \"Authorization: Bearer <token>\"`).";

/// A failed tool call. `denied` is for calls the policy or the token refused.
pub struct ToolErr {
    pub message: String,
    pub denied: bool,
}

impl ToolErr {
    fn error(message: impl Into<String>) -> Self {
        ToolErr {
            message: message.into(),
            denied: false,
        }
    }

    fn denied(message: impl Into<String>) -> Self {
        ToolErr {
            message: message.into(),
            denied: true,
        }
    }
}

impl From<DbErr> for ToolErr {
    fn from(e: DbErr) -> Self {
        match e {
            DbErr::Denied(m) => ToolErr::denied(m),
            DbErr::Failed(m) => ToolErr::error(m),
        }
    }
}

impl From<String> for ToolErr {
    fn from(message: String) -> Self {
        ToolErr::error(message)
    }
}

const TOOL_NAMES: [&str; 6] = [
    "list_data_sources",
    "list_schemas",
    "list_tables",
    "describe_table",
    "run_query",
    "execute_statement",
];

fn schema_props(extra: Value) -> Value {
    let mut props = json!({
        "dataSourceId": {
            "type": "string",
            "description": "Id of the data source, as returned by list_data_sources."
        }
    });
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    props
}

/// The `tools` of `tools/list`.
pub fn definitions() -> Value {
    let schema_arg = json!({
        "type": "string",
        "description": "Schema (PostgreSQL schema, MySQL database, Oracle user, SQLite `main`). \
    Default: the schema the connection starts in."
    });
    json!([
        {
            "name": "list_data_sources",
            "title": "List data sources",
            "description": "List the data sources you may use, with the database engine and the permissions of each \
    (`read`: list_schemas, list_tables, describe_table, run_query; `write`: execute_statement). \
    Data sources without any permission are not listed. Call this first.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "title": "List data sources", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "list_schemas",
            "title": "List schemas",
            "description": "List the schemas (users, databases) of a data source. Needs read permission.",
            "inputSchema": {
                "type": "object",
                "properties": schema_props(json!({})),
                "required": ["dataSourceId"],
                "additionalProperties": false
            },
            "annotations": { "title": "List schemas", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "list_tables",
            "title": "List tables",
            "description": "List the tables and views of a schema with their column counts. Needs read permission.",
            "inputSchema": {
                "type": "object",
                "properties": schema_props(json!({ "schema": schema_arg })),
                "required": ["dataSourceId"],
                "additionalProperties": false
            },
            "annotations": { "title": "List tables", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "describe_table",
            "title": "Describe a table",
            "description": "Columns (name, type, primary key), foreign keys and the DDL of a table or view. \
    Needs read permission.",
            "inputSchema": {
                "type": "object",
                "properties": schema_props(json!({
                    "table": { "type": "string", "description": "Table or view name." },
                    "schema": schema_arg
                })),
                "required": ["dataSourceId", "table"],
                "additionalProperties": false
            },
            "annotations": { "title": "Describe a table", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "run_query",
            "title": "Run a query",
            "description": "Run ONE read statement (SELECT, WITH, VALUES, SHOW, DESCRIBE, EXPLAIN, PRAGMA) on a \
    separate read-only connection. Returns {columns, rows, rowCount, truncated}; values are strings or null. \
    Needs read permission. To change data or the schema use execute_statement.",
            "inputSchema": {
                "type": "object",
                "properties": schema_props(json!({
                    "sql": { "type": "string", "description": "One SQL statement, without a trailing semicolon." },
                    "maxRows": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_ROWS,
                        "description": format!("Most rows to return (default {DEFAULT_MAX_ROWS}, at most {MAX_ROWS}). `truncated` tells when there were more.")
                    }
                })),
                "required": ["dataSourceId", "sql"],
                "additionalProperties": false
            },
            "annotations": { "title": "Run a query", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "execute_statement",
            "title": "Execute a statement",
            "description": "Run exactly ONE statement that changes data or the schema (INSERT, UPDATE, DELETE, \
    DDL, ...) and commit it when it succeeds (auto-commit). Returns the number of rows affected. \
    Needs write permission, which the user grants per data source; a data source marked read-only never allows it.",
            "inputSchema": {
                "type": "object",
                "properties": schema_props(json!({
                    "sql": { "type": "string", "description": "One SQL statement, without a trailing semicolon." }
                })),
                "required": ["dataSourceId", "sql"],
                "additionalProperties": false
            },
            "annotations": { "title": "Execute a statement", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false }
        }
    ])
}

/// `tools/call`. `Err` is a JSON-RPC error (an unknown tool); everything else, failures included, is a result.
pub async fn call(
    svc: &Arc<McpService>,
    session: &SessionRef,
    authorized: bool,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((INVALID_PARAMS, "Missing tool `name`".to_string()))?;
    if !TOOL_NAMES.contains(&name) {
        return Err((INVALID_PARAMS, format!("Unknown tool '{name}'")));
    }
    let empty = Map::new();
    let args_value = params.get("arguments").unwrap_or(&Value::Null);
    let args = match args_value {
        Value::Null => Some(&empty),
        other => other.as_object(),
    };

    let started = Instant::now();
    // a caller without the token gets a fixed pseudo-session and nothing it sent is stored (no SQL, no arguments,
    // not even the session id it claims): anyone on this machine can reach the port
    let mut entry = if authorized {
        McpLogEntry::new(
            now_ms(),
            &session.id,
            &session.client_name,
            McpLogKind::Tool,
            name,
        )
    } else {
        McpLogEntry::new(
            now_ms(),
            UNAUTHORIZED_SESSION,
            UNAUTHORIZED_CLIENT,
            McpLogKind::Tool,
            name,
        )
    };
    if let (true, Some(args)) = (authorized, args) {
        describe_args(&mut entry, args);
    }
    let outcome = match (authorized, args) {
        (false, _) => Err(ToolErr::denied(UNAUTHORIZED)),
        (true, None) => Err(ToolErr::error("`arguments` must be an object.")),
        (true, Some(args)) => run_tool(svc, name, args, &mut entry).await,
    };
    entry.elapsed_ms = started.elapsed().as_millis() as u64;
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(e) => {
            entry.status = if e.denied {
                McpLogStatus::Denied
            } else {
                McpLogStatus::Error
            };
            entry.summary = format!(
                "{}: {}",
                if e.denied { "Denied" } else { "Failed" },
                cut(e.message.lines().next().unwrap_or(""), 160, false)
            );
            entry.error = Some(e.message.clone());
            // no row data, no token: only what the call is
            tracing::info!(
                "MCP {} on {}: {}",
                name,
                entry.data_source_id.as_deref().unwrap_or("-"),
                if e.denied { "denied" } else { "error" }
            );
            (e.message, true)
        }
    };
    if !is_error {
        tracing::info!(
            "MCP {} on {}: ok in {} ms",
            name,
            entry.data_source_id.as_deref().unwrap_or("-"),
            entry.elapsed_ms
        );
    }
    // a caller without the token must not be able to flush the user's log: its attempts are rate limited
    if authorized || svc.allow_unauthorized_log() {
        svc.record(entry).await;
    }
    Ok(protocol::tool_result(&text, is_error))
}

/// The arguments as the log shows them: the SQL, and the other values (cut). `dataSourceId` stays among them
/// until `resolve` finds the data source (then it moves to the entry's own fields).
fn describe_args(entry: &mut McpLogEntry, args: &Map<String, Value>) {
    entry.sql = args.get("sql").and_then(Value::as_str).map(str::to_string);
    let rest: Map<String, Value> = args
        .iter()
        .filter(|(k, _)| k.as_str() != "sql")
        .map(|(k, v)| {
            let v = match v {
                Value::String(s) => Value::String(cut(s, 200, false)),
                Value::Number(_) | Value::Bool(_) | Value::Null => v.clone(),
                other => Value::String(cut(&other.to_string(), 200, false)),
            };
            (k.clone(), v)
        })
        .collect();
    if !rest.is_empty() {
        entry.args = Some(Value::Object(rest));
    }
}

fn required_str<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, ToolErr> {
    match args.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s),
        _ => Err(ToolErr::error(format!(
            "Missing required argument `{key}` (a non-empty string)."
        ))),
    }
}

fn optional_str<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ToolErr> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(ToolErr::error(format!("`{key}` must be a string."))),
    }
}

struct Resolved {
    id: String,
    name: String,
    driver: dbcore::Driver,
}

fn unknown_data_source(given: &str) -> String {
    format!(
        "Unknown data source '{given}'. Call list_data_sources to see the data sources you can use."
    )
}

/// The message for a call that needs `need` on a data source whose effective permission is `perm`; `None` when
/// the permission is there.
fn access_error(name: &str, need: Mode, perm: &McpEffectivePerm) -> Option<String> {
    let allowed = match need {
        Mode::Read => perm.perm.read,
        Mode::Write => perm.perm.write,
    };
    if allowed {
        return None;
    }
    let (what, extra) = match need {
        Mode::Read => ("read", ""),
        Mode::Write if perm.read_only_source => (
            "write",
            " The data source is marked read-only in its settings, so it never allows writes.",
        ),
        Mode::Write => ("write", ""),
    };
    Some(format!(
        "No {what} permission for data source '{name}'.{extra} {FIX_PERMISSIONS}"
    ))
}

/// The permission is checked again once the call holds the connection (see `db::Guard`): the user may have
/// changed it while the call waited behind a long query.
fn check_access(svc: &McpService, id: &str, need: Mode) -> Result<(), String> {
    let Some(view) = svc.sources.view(id) else {
        return Err(unknown_data_source(id));
    };
    let perm = super::policy::effective_for(&svc.policy_input(), id, view.cfg.read_only);
    if !perm.visible() {
        return Err(unknown_data_source(id));
    }
    match access_error(&view.cfg.name, need, &perm) {
        Some(m) => Err(m),
        None => Ok(()),
    }
}

/// A SQLite database that lives in memory: every MCP connection would open its own empty one.
fn is_memory_sqlite(cfg: &dbcore::DataSourceConfig) -> bool {
    if cfg.driver != dbcore::Driver::Sqlite {
        return false;
    }
    let target = cfg
        .url_override
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or(cfg.file.trim());
    target.contains(":memory:") || target.contains("mode=memory")
}

/// Finds the data source (by id; by name among the visible ones) and checks `need`. A data source the agent
/// has no permission at all for is answered like one that does not exist (its name is not revealed); the log
/// still says `denied`, with the id as given.
fn resolve(
    svc: &McpService,
    args: &Map<String, Value>,
    need: Mode,
    entry: &mut McpLogEntry,
) -> Result<Resolved, ToolErr> {
    let given = required_str(args, "dataSourceId")?;
    let views = svc.sources.list();
    let policy = svc.policy_input();
    let perm_of = |v: &crate::store::DataSourceView| {
        super::policy::effective_for(&policy, &v.cfg.id, v.cfg.read_only)
    };
    let by_id = views.iter().find(|v| v.cfg.id == given);
    let found = by_id.or_else(|| {
        let mut named = views
            .iter()
            .filter(|v| v.cfg.name.eq_ignore_ascii_case(given) && perm_of(v).visible());
        match (named.next(), named.next()) {
            (Some(v), None) => Some(v),
            _ => None,
        }
    });
    let Some(view) = found else {
        return Err(ToolErr::error(unknown_data_source(given)));
    };
    let perm = perm_of(view);
    if !perm.visible() {
        return Err(ToolErr::denied(unknown_data_source(given)));
    }
    if let Some(Value::Object(rest)) = entry.args.as_mut() {
        rest.remove("dataSourceId");
        if rest.is_empty() {
            entry.args = None;
        }
    }
    entry.data_source_id = Some(view.cfg.id.clone());
    entry.data_source_name = Some(view.cfg.name.clone());
    if let Some(message) = access_error(&view.cfg.name, need, &perm) {
        return Err(ToolErr::denied(message));
    }
    if is_memory_sqlite(&view.cfg) {
        return Err(ToolErr::error(format!(
            "Data source '{}' is an in-memory SQLite database. Agents get their own connection, which would see a \
             different, empty database, so it cannot be used here. Use a SQLite file.",
            view.cfg.name
        )));
    }
    Ok(Resolved {
        id: view.cfg.id.clone(),
        name: view.cfg.name.clone(),
        driver: view.cfg.driver,
    })
}

async fn run_tool(
    svc: &Arc<McpService>,
    name: &str,
    args: &Map<String, Value>,
    entry: &mut McpLogEntry,
) -> Result<String, ToolErr> {
    match name {
        "list_data_sources" => list_data_sources(svc, entry),
        "list_schemas" => {
            let ds = resolve(svc, args, Mode::Read, entry)?;
            let schemas = svc
                .db
                .with_conn(
                    &ds.id,
                    INTROSPECT_TIMEOUT,
                    &|| check_access(svc, &ds.id, Mode::Read),
                    |mgr, id| async move { mgr.list_schemas(&id).await },
                )
                .await?;
            let list: Vec<Value> = schemas
                .iter()
                .map(|s| json!({ "name": s.name, "default": s.default, "system": s.system }))
                .collect();
            entry.row_count = Some(list.len() as u64);
            entry.summary = format!("Listed {} schemas of {}", list.len(), ds.name);
            Ok(Value::Array(list).to_string())
        }
        "list_tables" => {
            let ds = resolve(svc, args, Mode::Read, entry)?;
            let schema = optional_str(args, "schema")?.map(str::to_string);
            let (used, objects) = svc
                .db
                .with_conn(
                    &ds.id,
                    INTROSPECT_TIMEOUT,
                    &|| check_access(svc, &ds.id, Mode::Read),
                    |mgr, id| {
                        let schema = schema.clone();
                        async move {
                            let schema = match schema {
                                Some(s) => Some(s),
                                None => default_schema(&mgr, &id).await?,
                            };
                            let objects = mgr.schema_snapshot(&id, schema.as_deref()).await?;
                            Ok((schema, objects))
                        }
                    },
                )
                .await?;
            let total = objects.len();
            let tables: Vec<Value> = objects
                .iter()
                .take(MAX_LISTED_TABLES)
                .map(|o| {
                    json!({
                        "schema": o.schema,
                        "name": o.name,
                        "type": kind_text(o.kind),
                        "columns": o.columns.len(),
                    })
                })
                .collect();
            let truncated = total > tables.len();
            entry.row_count = Some(tables.len() as u64);
            entry.truncated = truncated;
            entry.summary = format!(
                "Listed {} tables and views of {}{}",
                tables.len(),
                used.as_deref().unwrap_or(&ds.name),
                if truncated { " (more exist)" } else { "" }
            );
            let mut out = json!({ "schema": used, "tables": tables, "truncated": truncated });
            if truncated {
                out["note"] = json!(format!(
                    "Only the first {MAX_LISTED_TABLES} of {total} objects are listed; pass `schema` to narrow it."
                ));
            }
            Ok(out.to_string())
        }
        "describe_table" => describe_table(svc, args, entry).await,
        "run_query" => run_query(svc, args, entry).await,
        "execute_statement" => execute_statement(svc, args, entry).await,
        other => Err(ToolErr::error(format!("Unknown tool '{other}'"))),
    }
}

fn kind_text(kind: dbcore::NodeKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "table".into())
}

/// The schema the connection starts in (the user's own schema on Oracle, `public`, `main`, ...).
async fn default_schema(
    mgr: &dbcore::ConnectionManager,
    id: &str,
) -> Result<Option<String>, DbError> {
    Ok(mgr
        .list_schemas(id)
        .await?
        .into_iter()
        .find(|s| s.default)
        .map(|s| s.name))
}

fn list_data_sources(svc: &McpService, entry: &mut McpLogEntry) -> Result<String, ToolErr> {
    let policy = svc.policy_input();
    let list: Vec<Value> = svc
        .sources
        .list()
        .iter()
        .filter_map(|v| {
            let p = super::policy::effective_for(&policy, &v.cfg.id, v.cfg.read_only);
            p.visible().then(|| {
                json!({
                    "id": v.cfg.id,
                    "name": v.cfg.name,
                    "driver": v.cfg.driver,
                    "read": p.perm.read,
                    "write": p.perm.write,
                    "readOnlySource": p.read_only_source || v.cfg.read_only,
                })
            })
        })
        .collect();
    entry.row_count = Some(list.len() as u64);
    entry.summary = format!("Listed {} data sources", list.len());
    let mut out = json!({ "dataSources": list });
    if list.is_empty() {
        out["note"] = json!(format!(
            "No data source is shared with agents. {FIX_PERMISSIONS}"
        ));
    }
    Ok(out.to_string())
}

async fn describe_table(
    svc: &Arc<McpService>,
    args: &Map<String, Value>,
    entry: &mut McpLogEntry,
) -> Result<String, ToolErr> {
    let ds = resolve(svc, args, Mode::Read, entry)?;
    let table = required_str(args, "table")?.trim().to_string();
    let mut schema = optional_str(args, "schema")?.map(str::to_string);
    let mut table_name = table.clone();
    if schema.is_none() {
        // `schema.table` is accepted too
        if let Some((s, t)) = table.split_once('.') {
            if !s.is_empty() && !t.is_empty() && !t.contains('.') {
                schema = Some(s.to_string());
                table_name = t.to_string();
            }
        }
    }
    let (object, ddl) = svc
        .db
        .with_conn(&ds.id, INTROSPECT_TIMEOUT, &|| check_access(svc, &ds.id, Mode::Read), |mgr, id| {
            let (schema, table_name) = (schema.clone(), table_name.clone());
            async move {
                let schema = match schema {
                    Some(s) => Some(s),
                    None => default_schema(&mgr, &id).await?,
                };
                let objects = mgr.schema_snapshot(&id, schema.as_deref()).await?;
                let exact: Vec<_> = objects.iter().filter(|o| o.name == table_name).collect();
                let pick = match exact.as_slice() {
                    [one] => Some((*one).clone()),
                    [] => {
                        let loose: Vec<_> = objects
                            .iter()
                            .filter(|o| o.name.eq_ignore_ascii_case(&table_name))
                            .collect();
                        match loose.as_slice() {
                            [one] => Some((*one).clone()),
                            _ => None,
                        }
                    }
                    [first, ..] => Some((*first).clone()),
                };
                let Some(object) = pick else {
                    return Err(DbError::NotFound(format!(
                        "Table or view '{table_name}' not found{}. Use list_tables to see what exists.",
                        schema
                            .as_deref()
                            .map(|s| format!(" in schema '{s}'"))
                            .unwrap_or_default()
                    )));
                };
                let obj = ObjectRef {
                    schema: Some(object.schema.clone()),
                    name: object.name.clone(),
                    kind: object.kind,
                    table: None,
                    signature: None,
                };
                let ddl = mgr.ddl(&id, &obj).await.map_err(|e| e.to_string());
                Ok((object, ddl))
            }
        })
        .await?;
    let columns: Vec<Value> = object
        .columns
        .iter()
        .map(|c| json!({ "name": c.name, "type": c.type_name, "primaryKey": c.is_pk }))
        .collect();
    let fks: Vec<Value> = object
        .foreign_keys
        .iter()
        .map(|f| {
            json!({
                "name": f.name,
                "columns": f.columns,
                "references": { "schema": f.ref_schema, "table": f.ref_table, "columns": f.ref_columns },
            })
        })
        .collect();
    let mut out = json!({
        "schema": object.schema,
        "name": object.name,
        "type": kind_text(object.kind),
        "columns": columns,
        "foreignKeys": fks,
    });
    match ddl {
        Ok(text) => out["ddl"] = json!(cut(&text, MAX_DDL_CHARS, true)),
        Err(e) => {
            out["ddl"] = Value::Null;
            out["ddlError"] = json!(e);
        }
    }
    entry.row_count = Some(object.columns.len() as u64);
    entry.summary = format!(
        "Described {}.{} ({} columns)",
        object.schema,
        object.name,
        object.columns.len()
    );
    Ok(out.to_string())
}

/// The one statement of `sql`; an error when there are none or several.
fn single_statement(sql: &str, driver: dbcore::Driver, tool: &str) -> Result<String, ToolErr> {
    let mut stmts = split_statements(sql, driver);
    match stmts.len() {
        0 => Err(ToolErr::error(
            "The statement is empty. Pass one SQL statement in `sql`.",
        )),
        1 => Ok(stmts.remove(0).text),
        n => Err(ToolErr::error(format!(
            "{tool} runs exactly one statement, but `sql` contains {n}. Send them one at a time."
        ))),
    }
}

async fn run_query(
    svc: &Arc<McpService>,
    args: &Map<String, Value>,
    entry: &mut McpLogEntry,
) -> Result<String, ToolErr> {
    let ds = resolve(svc, args, Mode::Read, entry)?;
    let sql = required_str(args, "sql")?;
    let max_rows = match args.get("maxRows") {
        None | Some(Value::Null) => DEFAULT_MAX_ROWS,
        Some(v) => match v.as_u64() {
            Some(n) if n >= 1 => (n as usize).min(MAX_ROWS),
            _ => {
                return Err(ToolErr::error(format!(
                    "`maxRows` must be an integer between 1 and {MAX_ROWS}."
                )))
            }
        },
    };
    let stmt = single_statement(sql, ds.driver, "run_query")?;
    classify::check_read_statement(&stmt, ds.driver).map_err(ToolErr::error)?;
    // auto_commit: on Oracle a query is otherwise followed by an open transaction (`select ... for update` keeps
    // it open for as long as the shared session lives)
    let opts = ExecOptions {
        max_rows,
        stop_on_error: true,
        keep_open_secs: 1,
        auto_commit: true,
    };
    let events = svc
        .db
        .run(&ds.id, Mode::Read, &stmt, opts, QUERY_TIMEOUT, &|| {
            check_access(svc, &ds.id, Mode::Read)
        })
        .await?;
    let got = collect(&events)?;
    let (text, shown) = result_json(&got, None);
    entry.row_count = Some(shown as u64);
    entry.truncated = got.has_more || shown < got.rows.len();
    entry.preview = Some(make_preview(&got.columns, &got.rows));
    entry.summary = format!(
        "Returned {shown} row{}{}{}",
        if shown == 1 { "" } else { "s" },
        got.table_ref
            .as_deref()
            .map(|t| format!(" from {t}"))
            .unwrap_or_default(),
        if entry.truncated {
            " (more rows exist)"
        } else {
            ""
        }
    );
    Ok(text)
}

async fn execute_statement(
    svc: &Arc<McpService>,
    args: &Map<String, Value>,
    entry: &mut McpLogEntry,
) -> Result<String, ToolErr> {
    let ds = resolve(svc, args, Mode::Write, entry)?;
    let sql = required_str(args, "sql")?;
    let stmt = single_statement(sql, ds.driver, "execute_statement")?;
    classify::check_not_transaction_control(&stmt, ds.driver).map_err(ToolErr::error)?;
    let opts = ExecOptions {
        max_rows: DEFAULT_MAX_ROWS,
        stop_on_error: true,
        keep_open_secs: 1,
        auto_commit: true,
    };
    let events = svc
        .db
        .run(&ds.id, Mode::Write, &stmt, opts, WRITE_TIMEOUT, &|| {
            check_access(svc, &ds.id, Mode::Write)
        })
        .await?;
    let got = collect(&events)?;
    // `db::run` fails when the statement left a transaction open (it is rolled back), so a result here is committed
    let extra = json!({ "rowsAffected": got.rows_affected, "committed": true });
    let has_rows = got.has_result_set;
    let (text, shown) = if has_rows {
        result_json(&got, Some(extra))
    } else {
        (extra.to_string(), 0)
    };
    entry.rows_affected = got.rows_affected;
    if has_rows {
        entry.row_count = Some(shown as u64);
        entry.truncated = got.has_more || shown < got.rows.len();
        entry.preview = Some(make_preview(&got.columns, &got.rows));
    }
    entry.summary = match got.rows_affected {
        Some(n) => format!(
            "Changed {n} row{} on {}",
            if n == 1 { "" } else { "s" },
            ds.name
        ),
        None if has_rows => format!("Statement returned {shown} rows on {}", ds.name),
        None => format!("Statement executed on {}", ds.name),
    };
    Ok(text)
}

/// What the events of one statement came to.
#[derive(Debug, Default)]
struct Collected {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    has_more: bool,
    has_result_set: bool,
    rows_affected: Option<u64>,
    /// `schema.table` when every column of the result comes from the same table.
    table_ref: Option<String>,
}

/// The first result set, the rows affected, or the first error.
fn collect(events: &[ExecEvent]) -> Result<Collected, ToolErr> {
    let mut out = Collected::default();
    for ev in events {
        match ev {
            ExecEvent::Error { message, .. } => return Err(ToolErr::error(message.clone())),
            ExecEvent::ResultSet {
                columns,
                rows,
                has_more,
                ..
            } if !out.has_result_set => {
                out.has_result_set = true;
                out.columns = columns.iter().map(|c| c.name.clone()).collect();
                out.rows = rows
                    .iter()
                    .map(|r| r.iter().map(cell_text).collect())
                    .collect();
                out.has_more = *has_more;
                let mut refs = columns.iter().map(|c| c.table_ref.as_deref());
                if let Some(Some(first)) = refs.next() {
                    if refs.all(|r| r == Some(first)) {
                        out.table_ref = Some(first.to_string());
                    }
                }
            }
            ExecEvent::Update { rows_affected, .. } => {
                out.rows_affected = Some(out.rows_affected.unwrap_or(0) + rows_affected);
            }
            _ => {}
        }
    }
    Ok(out)
}

/// A cell as the agent sees it: text, or null.
fn cell_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(_) | Value::Number(_) => Some(v.to_string()),
        Value::Object(o) if o.contains_key("$bin") => {
            let hex = o.get("$bin").and_then(Value::as_str).unwrap_or("");
            let len = o.get("len").and_then(Value::as_u64).unwrap_or(0);
            let more = o.get("truncated").and_then(Value::as_bool).unwrap_or(false);
            Some(format!(
                "<binary, {len} bytes> 0x{hex}{}",
                if more { "..." } else { "" }
            ))
        }
        other => Some(other.to_string()),
    }
}

/// The text for the agent: `{columns, rows, rowCount, truncated}` (+ `extra` fields). Values are cut to
/// [`AGENT_CELL_CHARS`]; rows that do not fit in [`MAX_RESULT_BYTES`] are dropped and `truncated` is set.
/// Returns the text and the number of rows it holds.
fn result_json(got: &Collected, extra: Option<Value>) -> (String, usize) {
    let mut rows: Vec<Value> = Vec::with_capacity(got.rows.len());
    let mut bytes = 0usize;
    for r in &got.rows {
        let row: Vec<Value> = r
            .iter()
            .map(|c| match c {
                Some(s) => Value::String(cut(s, AGENT_CELL_CHARS, true)),
                None => Value::Null,
            })
            .collect();
        let row = Value::Array(row);
        bytes += row.to_string().len() + 1;
        if bytes > MAX_RESULT_BYTES && !rows.is_empty() {
            break;
        }
        rows.push(row);
    }
    let shown = rows.len();
    let truncated = got.has_more || shown < got.rows.len();
    let mut out = json!({
        "columns": got.columns,
        "rows": rows,
        "rowCount": shown,
        "truncated": truncated,
    });
    if truncated {
        out["note"] = json!(
            "More rows exist than are returned. Narrow the query (WHERE, LIMIT / FETCH FIRST) or raise maxRows (at most 1000)."
        );
    }
    if let (Some(extra), Some(o)) = (extra, out.as_object_mut()) {
        if let Some(e) = extra.as_object() {
            o.extend(e.clone());
        }
    }
    (out.to_string(), shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_complete() {
        let defs = definitions();
        let list = defs.as_array().unwrap();
        let names: Vec<&str> = list.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, TOOL_NAMES);
        for t in list {
            assert_eq!(t["inputSchema"]["type"], "object", "{t}");
            assert!(t["description"].as_str().unwrap().len() > 20);
            assert!(t["annotations"]["readOnlyHint"].is_boolean());
            assert!(t.get("outputSchema").is_none());
            for r in t["inputSchema"]["required"]
                .as_array()
                .into_iter()
                .flatten()
            {
                assert!(t["inputSchema"]["properties"]
                    .get(r.as_str().unwrap())
                    .is_some());
            }
        }
        let exec = list
            .iter()
            .find(|t| t["name"] == "execute_statement")
            .unwrap();
        assert_eq!(exec["annotations"]["readOnlyHint"], false);
        assert_eq!(exec["annotations"]["destructiveHint"], true);
    }

    #[test]
    fn access_messages_say_what_is_missing() {
        use super::super::policy::{McpOrigin, McpPerm};
        let perm = |read, write, ro| McpEffectivePerm {
            perm: McpPerm { read, write },
            origin: McpOrigin::Source,
            read_only_source: ro,
        };
        assert_eq!(
            access_error("x", Mode::Read, &perm(true, false, false)),
            None
        );
        assert_eq!(
            access_error("x", Mode::Write, &perm(true, true, false)),
            None
        );
        let m = access_error("shop", Mode::Write, &perm(true, false, false)).unwrap();
        assert!(
            m.contains("No write permission for data source 'shop'") && m.contains("Permissions"),
            "{m}"
        );
        let m = access_error("shop", Mode::Write, &perm(true, false, true)).unwrap();
        assert!(m.contains("read-only in its settings"), "{m}");
        let m = access_error("shop", Mode::Read, &perm(false, true, false)).unwrap();
        assert!(m.contains("No read permission"), "{m}");
    }

    #[test]
    fn in_memory_sqlite_is_recognised() {
        use dbcore::{DataSourceConfig, Driver};
        let lite = |file: &str, url: Option<&str>| DataSourceConfig {
            driver: Driver::Sqlite,
            file: file.into(),
            url_override: url.map(str::to_string),
            ..Default::default()
        };
        assert!(is_memory_sqlite(&lite(":memory:", None)));
        assert!(is_memory_sqlite(&lite("", Some("sqlite::memory:"))));
        assert!(is_memory_sqlite(&lite(
            "",
            Some("sqlite://x?mode=memory&cache=shared")
        )));
        assert!(!is_memory_sqlite(&lite("/tmp/shop.sqlite", None)));
        // another engine is never "in memory"
        let pg = DataSourceConfig {
            driver: Driver::Postgres,
            file: ":memory:".into(),
            ..Default::default()
        };
        assert!(!is_memory_sqlite(&pg));
    }

    #[test]
    fn db_errors_map_to_tool_errors() {
        let d: ToolErr = DbErr::Denied("no".into()).into();
        assert!(d.denied && d.message == "no");
        let f: ToolErr = DbErr::Failed("boom".into()).into();
        assert!(!f.denied);
    }

    #[test]
    fn cells_become_text() {
        assert_eq!(cell_text(&Value::Null), None);
        assert_eq!(cell_text(&json!("a")).as_deref(), Some("a"));
        assert_eq!(cell_text(&json!(12)).as_deref(), Some("12"));
        assert_eq!(cell_text(&json!(1.5)).as_deref(), Some("1.5"));
        assert_eq!(cell_text(&json!(true)).as_deref(), Some("true"));
        assert_eq!(cell_text(&json!([1, 2])).as_deref(), Some("[1,2]"));
        assert_eq!(
            cell_text(&json!({"$bin": "ab12", "len": 9, "truncated": true})).as_deref(),
            Some("<binary, 9 bytes> 0xab12...")
        );
    }

    #[test]
    fn results_are_cut_and_flagged() {
        let got = Collected {
            columns: vec!["a".into(), "b".into()],
            rows: vec![
                vec![Some("x".repeat(AGENT_CELL_CHARS + 50)), None],
                vec![Some("y".into()), Some("z".into())],
            ],
            has_more: true,
            has_result_set: true,
            ..Default::default()
        };
        let (text, shown) = result_json(&got, Some(json!({"rowsAffected": 2})));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(shown, 2);
        assert_eq!(v["rowCount"], 2);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["rowsAffected"], 2);
        assert!(v["rows"][0][0].as_str().unwrap().contains("[cut, "));
        assert!(v["rows"][0][1].is_null());
        assert!(v["note"].is_string());
    }

    #[test]
    fn huge_results_are_cut_at_a_row() {
        let big = "q".repeat(AGENT_CELL_CHARS);
        let rows: Vec<Vec<Option<String>>> =
            (0..1000).map(|_| vec![Some(big.clone()); 5]).collect();
        let got = Collected {
            columns: vec!["a".into(); 5],
            rows,
            has_result_set: true,
            ..Default::default()
        };
        let (text, shown) = result_json(&got, None);
        assert!(shown < 1000 && shown > 10, "{shown}");
        assert!(text.len() < MAX_RESULT_BYTES + 20_000);
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["rowCount"], shown);
    }

    #[test]
    fn exactly_one_statement() {
        use dbcore::Driver;
        assert_eq!(
            single_statement("select 1;", Driver::Sqlite, "run_query")
                .ok()
                .as_deref(),
            Some("select 1")
        );
        let e = single_statement("select 1; select 2", Driver::Sqlite, "run_query")
            .err()
            .unwrap();
        assert!(e.message.contains("exactly one statement") && !e.denied);
        assert!(single_statement("  ", Driver::Sqlite, "run_query").is_err());
        assert!(single_statement("-- nothing", Driver::Oracle, "run_query").is_err());
    }

    #[test]
    fn args_are_described_for_the_log() {
        let mut e = McpLogEntry::new(1, "s", "c", McpLogKind::Tool, "describe_table");
        let args = json!({"dataSourceId": "ds", "sql": "select 1", "table": "t", "maxRows": 5, "x": {"a": 1}});
        describe_args(&mut e, args.as_object().unwrap());
        assert_eq!(e.data_source_id, None);
        assert_eq!(e.sql.as_deref(), Some("select 1"));
        let a = e.args.unwrap();
        assert_eq!(a["table"], "t");
        assert_eq!(a["maxRows"], 5);
        assert_eq!(a["x"], "{\"a\":1}");
        assert_eq!(a["dataSourceId"], "ds");
        assert!(a.get("sql").is_none());
    }
}
