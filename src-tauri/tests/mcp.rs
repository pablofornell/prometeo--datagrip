//! Integration test of the embedded MCP server (`docs/MCP.md`): a real SQLite data source, the HTTP endpoint on a
//! free port, and a hand-written HTTP client over a TCP socket.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbcore::{DataSourceConfig, Driver, ExecEvent, ExecOptions};
use prometeo_datagrip_lib::mcp::log::{McpLogQuery, McpLogStatus};
use prometeo_datagrip_lib::mcp::policy::{McpPerm, McpPolicyInput};
use prometeo_datagrip_lib::mcp::McpEvent;
use prometeo_datagrip_lib::store::NoKeyring;
use prometeo_datagrip_lib::AppState;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Resp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
}

/// One request on its own connection (`Connection: close`).
async fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        req.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut raw))
        .await
        .expect("no response")
        .unwrap();
    let text = String::from_utf8(raw).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("no header block");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap();
            (k.trim().to_string(), v.trim().to_string())
        })
        .collect();
    Resp {
        status,
        headers,
        body: body.to_string(),
    }
}

struct Client {
    port: u16,
    token: Option<String>,
    session: Option<String>,
    next_id: u64,
}

impl Client {
    fn new(port: u16, token: Option<&str>) -> Self {
        Client {
            port,
            token: token.map(str::to_string),
            session: None,
            next_id: 1,
        }
    }

    async fn post(&self, body: &Value) -> Resp {
        let auth = self.token.as_ref().map(|t| format!("Bearer {t}"));
        let mut headers: Vec<(&str, &str)> = vec![
            ("Content-Type", "application/json"),
            ("Accept", "application/json, text/event-stream"),
        ];
        if let Some(a) = &auth {
            headers.push(("Authorization", a));
        }
        if let Some(s) = &self.session {
            headers.push(("Mcp-Session-Id", s));
        }
        http(self.port, "POST", "/mcp", &headers, &body.to_string()).await
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let res = self
            .post(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        assert_eq!(res.status, 200, "{method}: {}", res.body);
        assert_eq!(res.header("content-type"), Some("application/json"));
        let v = res.json();
        assert_eq!(v["id"], id);
        v
    }

    async fn initialize(&mut self, name: &str) -> Value {
        let res = self
            .post(
                &json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": name, "version": "9.9"}
                }}),
            )
            .await;
        assert_eq!(res.status, 200, "{}", res.body);
        self.session = Some(
            res.header("mcp-session-id")
                .expect("session id")
                .to_string(),
        );
        res.json()
    }

    /// `(isError, text)` of a tool call.
    async fn tool(&mut self, name: &str, args: Value) -> (bool, String) {
        let v = self
            .rpc("tools/call", json!({"name": name, "arguments": args}))
            .await;
        let r = &v["result"];
        assert!(v.get("error").is_none(), "{v}");
        let content = r["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "{r}");
        assert_eq!(content[0]["type"], "text");
        let is_error = r["isError"].as_bool().unwrap();
        if is_error {
            assert!(r.get("structuredContent").is_none(), "{r}");
        }
        (is_error, content[0]["text"].as_str().unwrap().to_string())
    }

    async fn ok(&mut self, name: &str, args: Value) -> Value {
        let (err, text) = self.tool(name, args).await;
        assert!(!err, "{name} failed: {text}");
        serde_json::from_str(&text).unwrap()
    }
}

fn perm(read: bool, write: bool) -> McpPerm {
    McpPerm { read, write }
}

fn policy(ds: &str, read: bool, write: bool) -> McpPolicyInput {
    McpPolicyInput {
        source_rules: [(ds.to_string(), perm(read, write))].into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn mcp_server_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let st = AppState::with_secrets(
        dir.path().join("config"),
        dir.path().join("data"),
        Arc::new(NoKeyring),
    )
    .unwrap();

    // ---- a SQLite data source with a little data, prepared through the user's own connection
    let db_file = dir.path().join("shop.sqlite");
    let cfg = DataSourceConfig {
        name: "shop".into(),
        driver: Driver::Sqlite,
        file: db_file.display().to_string(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    let view = st.save_data_source(cfg).await.unwrap();
    let ds = view.cfg.id.clone();
    st.mgr.connect(&view.cfg).await.unwrap();
    let sid = st.mgr.open_session(&ds).await.unwrap();
    let ev = st
        .mgr
        .execute_collect(
            &sid,
            "create table orders (id integer primary key, customer text not null, total real); \
             insert into orders (customer, total) values ('ann', 10.5), ('bob', 20), ('cy', null)",
            ExecOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        !ev.iter().any(|e| matches!(e, ExecEvent::Error { .. })),
        "{ev:?}"
    );
    st.mgr.close_session(&sid).await;
    st.disconnect(&ds).await.unwrap();

    // ---- live events
    let events: Arc<Mutex<Vec<McpEvent>>> = Arc::default();
    let sink = events.clone();
    let sub = st.mcp.subscribe(Arc::new(move |e: &McpEvent| {
        sink.lock().unwrap().push(e.clone());
        true
    }));
    let dead = st.mcp.subscribe(Arc::new(|_: &McpEvent| false));
    assert_ne!(sub, dead);

    // ---- off by default; the port is validated by the command layer; first enable makes the token
    let st0 = st.mcp.status();
    assert!(!st0.enabled && !st0.running && st0.token.is_empty());
    assert_eq!(st0.log_retention_days, 30);
    assert!(st.mcp_configure(true, 80).await.is_err());
    assert!(st.mcp_configure(true, 70000).await.is_err());
    let status = st.mcp.configure(true, 0).await.unwrap();
    assert!(status.enabled && status.running && status.error.is_none());
    assert!(status.token.starts_with("pdg_") && status.token.len() == 68);
    assert_eq!(
        status.endpoint,
        format!("http://127.0.0.1:{}/mcp", status.port)
    );
    assert!(status.started_at_ms.is_some());
    let (port, token) = (status.port, status.token.clone());
    // the token file is private
    let settings_path = dir.path().join("config").join("mcp.json");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(saved["token"], token.as_str());
    assert_eq!(saved["enabled"], true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&settings_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "mcp.json must be owner-only: {mode:o}");
    }
    // a dead subscriber was dropped, the live one got the status
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, McpEvent::Status { status } if status.running)));

    // ---- transport rules
    let p = http(port, "GET", "/mcp", &[], "").await;
    assert_eq!(p.status, 405);
    let p = http(
        port,
        "GET",
        "/.well-known/oauth-authorization-server",
        &[],
        "",
    )
    .await;
    assert_eq!(p.status, 404);
    assert!(p.json().is_object());
    assert_eq!(http(port, "POST", "/nothing", &[], "{}").await.status, 404);
    let origin = [
        ("Origin", "http://evil.example"),
        ("Authorization", &format!("Bearer {token}")),
    ];
    assert_eq!(http(port, "POST", "/mcp", &origin, "{}").await.status, 403);
    let host = [("Host", "evil.example")];
    assert_eq!(http(port, "POST", "/mcp", &host, "{}").await.status, 403);
    assert_eq!(
        http(port, "POST", "/mcp", &[], "{not json").await.status,
        400
    );

    // ---- initialize, tools/list
    let mut c = Client::new(port, Some(&token));
    let init = c.initialize("claude-test").await;
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "prometeo-datagrip");
    assert_eq!(
        init["result"]["capabilities"]["tools"]["listChanged"],
        false
    );
    assert!(init["result"]["instructions"].is_string());
    let res = c
        .post(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await;
    assert_eq!(res.status, 202);
    assert!(res.body.is_empty());
    let tools = c.rpc("tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_data_sources",
            "list_schemas",
            "list_tables",
            "describe_table",
            "run_query",
            "execute_statement"
        ]
    );
    assert_eq!(c.rpc("ping", json!({})).await["result"], json!({}));
    let v = c.rpc("resources/list", json!({})).await;
    assert_eq!(v["error"]["code"], -32601);
    let v = c.rpc("tools/call", json!({"name": "no_such_tool"})).await;
    assert_eq!(v["error"]["code"], -32602);
    // a batch
    let res = c
        .post(&json!([
            {"jsonrpc": "2.0", "id": 11, "method": "ping"},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 12, "method": "ping"}
        ]))
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.json().as_array().unwrap().len(), 2);

    // ---- no policy: nothing is visible, nothing is allowed
    let list = c.ok("list_data_sources", json!({})).await;
    assert_eq!(list["dataSources"], json!([]));
    let (err, text) = c
        .tool("run_query", json!({"dataSourceId": ds, "sql": "select 1"}))
        .await;
    // a data source without any permission looks like one that does not exist: its name is not revealed
    assert!(
        err && text.contains("Unknown data source") && !text.contains("shop"),
        "{text}"
    );
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": "nope", "sql": "select 1"}),
        )
        .await;
    assert!(err && text.contains("Unknown data source"), "{text}");

    // ---- read only
    let pol = st.mcp.set_policy(policy(&ds, true, false)).await.unwrap();
    assert!(pol.effective[&ds].perm.read && !pol.effective[&ds].perm.write);
    let list = c.ok("list_data_sources", json!({})).await;
    assert_eq!(list["dataSources"][0]["id"], ds.as_str());
    assert_eq!(list["dataSources"][0]["driver"], "sqlite");
    assert_eq!(list["dataSources"][0]["read"], true);
    assert_eq!(list["dataSources"][0]["write"], false);

    let schemas = c.ok("list_schemas", json!({"dataSourceId": ds})).await;
    assert!(
        schemas
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "main"),
        "{schemas}"
    );
    let tables = c.ok("list_tables", json!({"dataSourceId": ds})).await;
    assert_eq!(tables["tables"][0]["name"], "orders");
    assert_eq!(tables["tables"][0]["columns"], 3);
    assert_eq!(tables["truncated"], false);
    let d = c
        .ok(
            "describe_table",
            json!({"dataSourceId": ds, "table": "orders"}),
        )
        .await;
    assert_eq!(d["columns"][0]["name"], "id");
    assert_eq!(d["columns"][0]["primaryKey"], true);
    assert!(
        d["ddl"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("create table"),
        "{d}"
    );
    // by name of the data source, and the table in another case
    let d = c
        .ok(
            "describe_table",
            json!({"dataSourceId": "SHOP", "table": "main.ORDERS"}),
        )
        .await;
    assert_eq!(d["name"], "orders");
    let (err, text) = c
        .tool(
            "describe_table",
            json!({"dataSourceId": ds, "table": "nope"}),
        )
        .await;
    assert!(err && text.contains("not found"), "{text}");

    let q = c
        .ok("run_query", json!({"dataSourceId": ds, "sql": "select id, customer, total from orders order by id"}))
        .await;
    assert_eq!(q["columns"], json!(["id", "customer", "total"]));
    assert_eq!(q["rowCount"], 3);
    assert_eq!(q["truncated"], false);
    assert_eq!(q["rows"][0], json!(["1", "ann", "10.5"]));
    assert_eq!(q["rows"][2][2], Value::Null);
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select * from orders order by id;", "maxRows": 2}),
        )
        .await;
    assert_eq!(q["rowCount"], 2);
    assert_eq!(q["truncated"], true);
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "with t as (select 1 as a) select a from t"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "1");

    // refusals: a write through run_query, several statements, a bad maxRows, a SQL error
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "delete from orders"}),
        )
        .await;
    assert!(err && text.contains("execute_statement"), "{text}");
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select 1; select 2"}),
        )
        .await;
    assert!(err && text.contains("exactly one statement"), "{text}");
    let (err, _) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select 1", "maxRows": 0}),
        )
        .await;
    assert!(err);
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select * from missing_table"}),
        )
        .await;
    assert!(err && text.contains("missing_table"), "{text}");
    let (err, text) = c.tool("run_query", json!({"dataSourceId": ds})).await;
    assert!(err && text.contains("`sql`"), "{text}");

    // writing is denied, and the data did not change
    let (err, text) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "delete from orders"}),
        )
        .await;
    assert!(
        err && text.contains("No write permission for data source 'shop'"),
        "{text}"
    );
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select count(*) from orders"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "3");

    // ---- write allowed
    st.mcp.set_policy(policy(&ds, true, true)).await.unwrap();
    let w = c
        .ok("execute_statement", json!({"dataSourceId": ds, "sql": "insert into orders (customer, total) values ('dee', 1)"}))
        .await;
    assert_eq!(w["rowsAffected"], 1);
    assert_eq!(w["committed"], true);
    let (err, text) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "update orders set total = 0; delete from orders"}),
        )
        .await;
    assert!(err && text.contains("exactly one statement"), "{text}");
    let (err, _) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "insert into orders (customer) values (null)"}),
        )
        .await;
    assert!(err, "NOT NULL violation");
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select count(*) from orders"}),
        )
        .await;
    assert_eq!(
        q["rows"][0][0], "4",
        "the write is visible on the read connection"
    );
    // the user's own connection sees it too (it was committed)
    st.connect(&ds).await.unwrap();
    let sid = st.mgr.open_session(&ds).await.unwrap();
    let ev = st
        .mgr
        .execute_collect(&sid, "select count(*) from orders", ExecOptions::default())
        .await
        .unwrap();
    let seen = ev.iter().find_map(|e| match e {
        ExecEvent::ResultSet { rows, .. } => Some(rows[0][0].clone()),
        _ => None,
    });
    assert!(
        seen == Some(json!(4)) || seen == Some(json!("4")),
        "{seen:?}"
    );
    st.mgr.close_session(&sid).await;
    st.disconnect(&ds).await.unwrap();

    // ---- the data source is marked read-only: no write whatever the rule says; connections follow the change
    let mut ro_cfg = st.sources.get(&ds).unwrap();
    ro_cfg.read_only = true;
    st.save_data_source(ro_cfg.clone()).await.unwrap();
    let pol = st.mcp.policy();
    assert!(pol.effective[&ds].read_only_source && !pol.effective[&ds].perm.write);
    let (err, text) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "delete from orders"}),
        )
        .await;
    assert!(err && text.contains("read-only"), "{text}");
    let list = c.ok("list_data_sources", json!({})).await;
    assert_eq!(list["dataSources"][0]["write"], false);
    assert_eq!(list["dataSources"][0]["readOnlySource"], true);
    ro_cfg.read_only = false;
    st.save_data_source(ro_cfg).await.unwrap();
    let w = c
        .ok(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "delete from orders where customer = 'dee'"}),
        )
        .await;
    assert_eq!(w["rowsAffected"], 1);

    // ---- the user's data sources do not show the MCP connections
    assert!(st.connected_data_sources().is_empty());
    assert_eq!(st.list_data_sources().await.unwrap().len(), 1);

    // ---- token problems are tool errors with HTTP 200, never 401
    for token in [Some("pdg_wrong"), None] {
        let mut bad = Client::new(port, token);
        let res = bad.post(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"intruder"}}})).await;
        assert_eq!(res.status, 200, "initialize works without a valid token");
        bad.session = res.header("mcp-session-id").map(str::to_string);
        let tools = bad.rpc("tools/list", json!({})).await;
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 6);
        let (err, text) = bad
            .tool("run_query", json!({"dataSourceId": ds, "sql": "select 1"}))
            .await;
        assert!(err && text.contains("bearer token"), "{text}");
        let (err, _) = bad.tool("list_data_sources", json!({})).await;
        assert!(err);
    }
    // a rotated token ends the old one
    let rotated = st.mcp.regenerate_token().await.unwrap();
    assert_ne!(rotated.token, token);
    let (err, text) = c.tool("list_data_sources", json!({})).await;
    assert!(err && text.contains("bearer token"), "{text}");
    c.token = Some(rotated.token.clone());
    c.ok("list_data_sources", json!({})).await;

    // ---- ending the session
    let auth = format!("Bearer {}", rotated.token);
    let sess = c.session.clone().unwrap();
    let no_session = http(port, "DELETE", "/mcp", &[("Authorization", &auth)], "").await;
    assert_eq!(no_session.status, 400);
    let no_auth = http(port, "DELETE", "/mcp", &[("Mcp-Session-Id", &sess)], "").await;
    assert_eq!(no_auth.status, 403);
    let del = http(
        port,
        "DELETE",
        "/mcp",
        &[("Authorization", &auth), ("Mcp-Session-Id", &sess)],
        "",
    )
    .await;
    assert_eq!(del.status, 200);

    // ---- the log
    let all = st
        .mcp
        .log_query(McpLogQuery {
            limit: Some(1000),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        all.windows(2).all(|w| w[0].ts_ms >= w[1].ts_ms),
        "newest first"
    );
    let mine: Vec<_> = all.iter().filter(|e| e.session_id == sess).collect();
    assert_eq!(mine.first().unwrap().tool, "end");
    assert_eq!(mine.last().unwrap().tool, "initialize");
    assert_eq!(mine.last().unwrap().client_name, "claude-test");
    let denied = st
        .mcp
        .log_query(McpLogQuery {
            status: Some(McpLogStatus::Denied),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(denied.iter().any(|e| e.tool == "execute_statement"
        && e.sql.as_deref() == Some("delete from orders")
        && e.error
            .as_deref()
            .is_some_and(|m| m.contains("No write permission"))));
    // the refusal of a data source nobody may use is logged as denied, with the id as the caller gave it
    assert!(denied.iter().any(|e| e.tool == "run_query"
        && e.session_id == sess
        && e.data_source_id.is_none()
        && e.data_source_name.is_none()
        && e.args
            .as_ref()
            .is_some_and(|a| a["dataSourceId"] == ds.as_str())));
    // callers without the token: a fixed pseudo-session, no SQL, no arguments, nothing they claimed
    let strangers: Vec<_> = denied
        .iter()
        .filter(|e| e.session_id == "unauthorized")
        .collect();
    assert!(strangers.len() >= 4, "{}", strangers.len());
    assert!(strangers
        .iter()
        .all(|e| e.client_name == "unauthorized caller"
            && e.sql.is_none()
            && e.args.is_none()
            && e.data_source_id.is_none()
            && e.error
                .as_deref()
                .is_some_and(|m| m.contains("bearer token"))));
    assert!(!denied.iter().any(|e| e.client_name == "intruder"));
    let reads = st
        .mcp
        .log_query(McpLogQuery {
            session_id: Some(sess.clone()),
            data_source_id: Some(ds.clone()),
            text: Some("ORDER BY ID".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let first = reads
        .iter()
        .find(|e| e.sql.as_deref() == Some("select id, customer, total from orders order by id"))
        .unwrap();
    assert_eq!(first.status, McpLogStatus::Ok);
    assert_eq!(first.tool, "run_query");
    assert_eq!(first.data_source_name.as_deref(), Some("shop"));
    assert_eq!(first.row_count, Some(3));
    assert!(!first.truncated);
    let pv = first.preview.as_ref().unwrap();
    assert_eq!(pv.columns, ["id", "customer", "total"]);
    assert_eq!(
        pv.rows[0],
        [
            Some("1".to_string()),
            Some("ann".to_string()),
            Some("10.5".to_string())
        ]
    );
    assert_eq!(pv.rows[2][2], None);
    assert!(
        first.summary.contains("Returned 3 rows"),
        "{}",
        first.summary
    );
    let writes = st
        .mcp
        .log_query(McpLogQuery {
            text: Some("insert into orders".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let w = writes
        .iter()
        .find(|e| e.status == McpLogStatus::Ok)
        .unwrap();
    assert_eq!(
        (w.tool.as_str(), w.rows_affected),
        ("execute_statement", Some(1))
    );
    assert!(w.summary.contains("Changed 1 row"), "{}", w.summary);
    // paging
    let page = st
        .mcp
        .log_query(McpLogQuery {
            limit: Some(2),
            before_ts_ms: Some(all[0].ts_ms + 1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.len(), 2);
    // neither the token nor a password reaches the log file
    let log_text =
        std::fs::read_to_string(dir.path().join("data").join("mcp").join("log.jsonl")).unwrap();
    assert!(!log_text.contains(&token) && !log_text.contains(&rotated.token));
    assert!(log_text
        .lines()
        .all(|l| serde_json::from_str::<Value>(l).is_ok()));

    // ---- sessions
    let sessions = st.mcp.sessions().await.unwrap();
    let s = sessions.iter().find(|s| s.id == sess).unwrap();
    assert_eq!(s.client_name, "claude-test");
    assert_eq!(s.client_version.as_deref(), Some("9.9"));
    assert!(!s.active, "ended");
    assert!(s.action_count >= 20, "{}", s.action_count);
    assert!(s.error_count >= 8, "{}", s.error_count);
    assert!(s.write_count >= 4, "{}", s.write_count);
    assert_eq!(s.data_source_ids, std::slice::from_ref(&ds));
    assert!(s.started_at_ms <= s.last_seen_ms);

    // ---- events reached the subscriber
    {
        let ev = events.lock().unwrap();
        let entries = ev
            .iter()
            .filter(|e| matches!(e, McpEvent::Entry { .. }))
            .count();
        assert!(entries >= 20, "{entries}");
        assert!(ev.iter().any(|e| matches!(e, McpEvent::Sessions)));
        let json = serde_json::to_value(&ev[0]).unwrap();
        assert!(json["type"].is_string());
    }
    st.mcp.unsubscribe(sub);
    let before = events.lock().unwrap().len();
    let mut again = Client::new(port, Some(&rotated.token));
    again.initialize("second").await;
    assert_eq!(events.lock().unwrap().len(), before, "unsubscribed");
    // a session started without Mcp-Session-Id state: unknown ids are accepted and keep their client name
    again.session = Some(sess.clone());
    let l = again.ok("list_data_sources", json!({})).await;
    assert_eq!(l["dataSources"].as_array().unwrap().len(), 1);
    let revived = st
        .mcp
        .log_query(McpLogQuery {
            session_id: Some(sess.clone()),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(revived[0].client_name, "claude-test");
    assert!(st.mcp.status().active_sessions >= 1);

    // ---- port in use, stop, start again, clear
    let blocker = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let busy = blocker.local_addr().unwrap().port();
    let status = st.mcp.configure(true, busy).await.unwrap();
    assert!(!status.running && status.enabled);
    assert_eq!(
        status.error.as_deref(),
        Some(format!("Port {busy} is in use").as_str())
    );
    assert!(
        TcpStream::connect(("127.0.0.1", port)).await.is_err(),
        "the old listener is closed"
    );
    drop(blocker);
    let status = st.mcp.configure(true, busy).await.unwrap();
    assert!(
        status.running && status.error.is_none() && status.port == busy,
        "{status:?}"
    );
    assert_eq!(status.token, rotated.token, "the token survives restarts");
    let after = Client::new(busy, Some(&rotated.token));
    assert_eq!(
        after
            .post(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .status,
        200
    );
    let status = st.mcp.configure(false, busy).await.unwrap();
    assert!(!status.running && !status.enabled && status.error.is_none());
    assert!(TcpStream::connect(("127.0.0.1", busy)).await.is_err());

    st.mcp.clear_log().await.unwrap();
    assert!(st
        .mcp
        .log_query(McpLogQuery::default())
        .await
        .unwrap()
        .is_empty());
    st.shutdown().await;
}

/// The settings (enabled, port, token, policy) are read back by the next start.
#[tokio::test]
async fn mcp_settings_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let open = || {
        AppState::with_secrets(
            dir.path().join("config"),
            dir.path().join("data"),
            Arc::new(NoKeyring),
        )
        .unwrap()
    };
    let first = open();
    let free = {
        let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        l.local_addr().unwrap().port()
    };
    let token = first
        .mcp_configure(true, i64::from(free))
        .await
        .unwrap()
        .token;
    let input = McpPolicyInput {
        folder_rules: [("Prod".to_string(), perm(true, false))].into(),
        source_rules: [("x".to_string(), perm(true, true))].into(),
        groups: [("x".to_string(), "Prod".to_string())].into(),
    };
    first.mcp.set_policy(input.clone()).await.unwrap();
    first.shutdown().await;
    assert!(!first.mcp.status().running);

    let second = open();
    assert!(
        !second.mcp.status().running,
        "nothing listens before start_if_enabled"
    );
    second.mcp.start_if_enabled().await;
    let status = second.mcp.status();
    assert!(
        status.enabled && status.running && status.port == free,
        "{status:?}"
    );
    assert_eq!(status.token, token);
    let c = Client::new(free, Some(&token));
    assert_eq!(
        c.post(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
            .await
            .status,
        200
    );
    let policy = second.mcp.policy();
    assert_eq!(policy.input, input);
    assert!(policy.effective.is_empty(), "no data source exists");
    second.shutdown().await;
}

fn state_in(dir: &tempfile::TempDir) -> AppState {
    AppState::with_secrets(
        dir.path().join("config"),
        dir.path().join("data"),
        Arc::new(NoKeyring),
    )
    .unwrap()
}

/// A SQLite data source with an `orders` table (3 rows), read and write granted, and the server running.
async fn sqlite_fixture(st: &AppState, dir: &tempfile::TempDir) -> (String, u16, String) {
    let cfg = DataSourceConfig {
        name: "shop".into(),
        driver: Driver::Sqlite,
        file: dir.path().join("shop.sqlite").display().to_string(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    let view = st.save_data_source(cfg).await.unwrap();
    let ds = view.cfg.id.clone();
    st.mgr.connect(&view.cfg).await.unwrap();
    let sid = st.mgr.open_session(&ds).await.unwrap();
    st.mgr
        .execute_collect(
            &sid,
            "create table orders (id integer primary key, customer text); \
             insert into orders (customer) values ('ann'), ('bob'), ('cy')",
            ExecOptions::default(),
        )
        .await
        .unwrap();
    st.mgr.close_session(&sid).await;
    st.disconnect(&ds).await.unwrap();
    st.mcp.set_policy(policy(&ds, true, true)).await.unwrap();
    let status = st.mcp.configure(true, 0).await.unwrap();
    (ds, status.port, status.token)
}

#[tokio::test]
async fn mcp_refuses_what_the_pre_checks_know_and_never_leaves_a_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir);
    let (ds, port, token) = sqlite_fixture(&st, &dir).await;
    let mut c = Client::new(port, Some(&token));
    c.initialize("hardening").await;

    // SELECT ... INTO and side-effect functions are refused with a pointer to execute_statement
    for sql in [
        "select * into stolen from orders",
        "select pg_terminate_backend(1)",
        "select set_config('a', 'b', false)",
        "select * from orders into outfile '/tmp/x'",
    ] {
        let (err, text) = c
            .tool("run_query", json!({"dataSourceId": ds, "sql": sql}))
            .await;
        assert!(err && text.contains("execute_statement"), "{sql}: {text}");
    }
    // transaction control is refused for writes; the statement did not run
    for sql in [
        "begin",
        "BEGIN TRANSACTION",
        "commit",
        "rollback",
        "savepoint a",
        "release a",
        "end",
        "set transaction read only",
        "set autocommit = 0",
    ] {
        let (err, text) = c
            .tool("execute_statement", json!({"dataSourceId": ds, "sql": sql}))
            .await;
        assert!(err && text.contains("transaction-control"), "{sql}: {text}");
    }
    // after all that the shared write session is not inside a transaction: a statement commits at once
    let w = c
        .ok(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "insert into orders (customer) values ('dee')"}),
        )
        .await;
    assert_eq!(
        (w["rowsAffected"].as_u64(), w["committed"].as_bool()),
        (Some(1), Some(true))
    );
    // visible from the user's own connection, which proves the commit
    st.connect(&ds).await.unwrap();
    let sid = st.mgr.open_session(&ds).await.unwrap();
    let ev = st
        .mgr
        .execute_collect(&sid, "select count(*) from orders", ExecOptions::default())
        .await
        .unwrap();
    assert!(ev
        .iter()
        .any(|e| matches!(e, ExecEvent::ResultSet { rows, .. }
        if rows[0][0] == json!(4) || rows[0][0] == json!("4"))));
    st.mgr.close_session(&sid).await;
    st.disconnect(&ds).await.unwrap();

    // ---- an in-memory SQLite data source cannot be used
    let mem = st
        .save_data_source(DataSourceConfig {
            name: "scratch".into(),
            driver: Driver::Sqlite,
            file: ":memory:".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .cfg
        .id;
    let mut input = policy(&ds, true, true);
    input.source_rules.insert(mem.clone(), perm(true, true));
    st.mcp.set_policy(input).await.unwrap();
    let (err, text) = c
        .tool("run_query", json!({"dataSourceId": mem, "sql": "select 1"}))
        .await;
    assert!(err && text.contains("in-memory"), "{text}");
    st.shutdown().await;
}

#[tokio::test]
async fn mcp_log_entries_are_bounded_and_strangers_cannot_flood_it() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir);
    let (ds, port, token) = sqlite_fixture(&st, &dir).await;
    let mut c = Client::new(port, Some(&token));
    c.initialize("big").await;

    // a huge statement and many arguments from an authorized client: the entry is cut, the call still works
    let long_sql = format!("select 1 as a /* {} */", "x".repeat(1_000_000));
    let q = c
        .ok("run_query", json!({"dataSourceId": ds, "sql": long_sql}))
        .await;
    assert_eq!(q["rows"][0][0], "1");
    let mut args = serde_json::Map::new();
    for i in 0..3000 {
        args.insert(format!("k{i}"), json!("v".repeat(100)));
    }
    args.insert("dataSourceId".into(), json!(ds));
    args.insert("sql".into(), json!("select 2"));
    let (_, _) = c.tool("run_query", Value::Object(args)).await;
    let log_path = dir.path().join("data").join("mcp").join("log.jsonl");
    let text = std::fs::read_to_string(&log_path).unwrap();
    assert!(text.lines().count() >= 3);
    assert!(
        text.lines().all(|l| l.len() <= 16 * 1024),
        "longest line: {}",
        text.lines().map(str::len).max().unwrap()
    );

    // strangers: 200 calls with big SQL, a claimed session id and a made-up client name
    let mut stranger = Client::new(port, None);
    stranger.session = Some("claimed-session-id".into());
    let before = std::fs::metadata(&log_path).unwrap().len();
    for _ in 0..200 {
        let (err, _) = stranger
            .tool(
                "run_query",
                json!({"dataSourceId": ds, "sql": "select 1 /* 0123456789 */".repeat(300)}),
            )
            .await;
        assert!(err);
    }
    let all = st
        .mcp
        .log_query(McpLogQuery {
            limit: Some(1000),
            ..Default::default()
        })
        .await
        .unwrap();
    let strangers: Vec<_> = all
        .iter()
        .filter(|e| e.session_id == "unauthorized")
        .collect();
    assert!(
        !strangers.is_empty() && strangers.len() <= 60,
        "{} stranger entries",
        strangers.len()
    );
    assert!(strangers
        .iter()
        .all(|e| e.sql.is_none() && e.args.is_none() && e.client_name == "unauthorized caller"));
    assert!(!all.iter().any(|e| e.session_id == "claimed-session-id"));
    let grown = std::fs::metadata(&log_path).unwrap().len() - before;
    assert!(grown < 60 * 1024, "the log grew by {grown} bytes");
    st.shutdown().await;
}

#[tokio::test]
async fn mcp_rechecks_the_permission_after_waiting_for_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let st = Arc::new(state_in(&dir));
    let (ds, port, token) = sqlite_fixture(&st, &dir).await;
    let mut slow = Client::new(port, Some(&token));
    slow.initialize("slow").await;
    let mut waiting = Client::new(port, Some(&token));
    waiting.initialize("waiting").await;

    // A keeps the read connection busy for a few seconds; B queues behind it; the read permission goes away
    let ds_a = ds.clone();
    let a = tokio::spawn(async move {
        slow.tool(
            "run_query",
            json!({"dataSourceId": ds_a, "sql":
                "with recursive c(x) as (select 1 union all select x + 1 from c where x < 40000000) select count(*) from c"}),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    let ds_b = ds.clone();
    let b = tokio::spawn(async move {
        waiting
            .tool(
                "run_query",
                json!({"dataSourceId": ds_b, "sql": "select 1"}),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    st.mcp.set_policy(policy(&ds, false, false)).await.unwrap();
    let (err, text) = b.await.unwrap();
    assert!(err, "{text}");
    assert!(
        text.contains("Unknown data source") || text.contains("No read permission"),
        "{text}"
    );
    let _ = a.await.unwrap();
    // the call that waited did not reopen a connection: it is denied and logged as such
    let denied = st
        .mcp
        .log_query(McpLogQuery {
            status: Some(McpLogStatus::Denied),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        denied.iter().any(|e| e.client_name == "waiting"),
        "{denied:?}"
    );
    st.shutdown().await;
}

fn pg_ds() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_PG_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    // postgres://user:pass@host:port/db
    let rest = url.split("://").nth(1)?;
    let (auth, tail) = rest.split_once('@')?;
    let (user, pass) = auth.split_once(':')?;
    let (hostport, db) = tail.split_once('/')?;
    let (host, port) = hostport.split_once(':')?;
    Some(DataSourceConfig {
        name: "pg".into(),
        driver: Driver::Postgres,
        host: host.into(),
        port: port.parse().ok()?,
        database: db.into(),
        user: user.into(),
        password: Some(pass.into()),
        ..Default::default()
    })
}

/// `PROMETEO_PG_URL=postgres://postgres:prometeo@127.0.0.1:54329/postgres cargo test -p prometeo-datagrip --test mcp`
/// A statement cannot switch the read-only connection to read-write: `set_config` is turned off by the
/// classifier, and a quoted name that gets past it still cannot write because the query runs in `BEGIN READ ONLY`.
#[tokio::test]
async fn postgres_read_connection_cannot_be_made_read_write() {
    let Some(cfg) = pg_ds() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir);
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let user = st.mgr.open_session(&ds).await.unwrap();
    let setup = |sql: &'static str| {
        let (st, user) = (&st, &user);
        async move {
            let ev = st
                .mgr
                .execute_collect(user, sql, ExecOptions::default())
                .await
                .unwrap();
            assert!(
                !ev.iter().any(|e| matches!(e, ExecEvent::Error { .. })),
                "{sql}: {ev:?}"
            );
            ev
        }
    };
    setup("drop table if exists mcp_probe").await;
    setup("drop sequence if exists mcp_probe_seq").await;
    setup("create table mcp_probe (a int)").await;
    setup("create sequence mcp_probe_seq").await;

    st.mcp.set_policy(policy(&ds, true, true)).await.unwrap();
    let status = st.mcp.configure(true, 0).await.unwrap();
    let mut c = Client::new(status.port, Some(&status.token));
    c.initialize("pg-guard").await;

    // 1. the classifier refuses the plain bypass
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select set_config('default_transaction_read_only','off',false)"}),
        )
        .await;
    assert!(err && text.contains("set_config"), "{text}");
    // 2. a quoted name gets past the classifier; it runs, but the transaction stays read-only
    let _ = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select \"set_config\"('default_transaction_read_only','off',false)"}),
        )
        .await;
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select \"nextval\"('mcp_probe_seq')"}),
        )
        .await;
    assert!(err && text.to_lowercase().contains("read-only"), "{text}");
    // the setting did not stick either: the next query is read-only again
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "show default_transaction_read_only"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "on", "{q}");
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select \"nextval\"('mcp_probe_seq')"}),
        )
        .await;
    assert!(err && text.to_lowercase().contains("read-only"), "{text}");
    // the sequence was not touched
    let ev = setup("select is_called from mcp_probe_seq").await;
    let called = ev.iter().find_map(|e| match e {
        ExecEvent::ResultSet { rows, .. } => Some(rows[0][0].clone()),
        _ => None,
    });
    assert!(
        called == Some(json!(false))
            || called == Some(json!("f"))
            || called == Some(json!("false")),
        "{called:?}"
    );

    // 3. a result with more rows than asked for is cut short; the session is clean afterwards
    let started = std::time::Instant::now();
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select generate_series(1, 500000000)", "maxRows": 5}),
        )
        .await;
    assert_eq!(q["rowCount"], 5);
    assert_eq!(q["truncated"], true);
    eprintln!("BENCH cut-short result took {:?}", started.elapsed());
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select current_setting('transaction_read_only')"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "on");
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select count(*) from mcp_probe"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "0");

    // 4. the write connection commits; transaction control is refused
    let (err, text) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "begin"}),
        )
        .await;
    assert!(err && text.contains("transaction-control"), "{text}");
    let w = c
        .ok(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "insert into mcp_probe (a) values (1)"}),
        )
        .await;
    assert_eq!(
        (w["rowsAffected"].as_u64(), w["committed"].as_bool()),
        (Some(1), Some(true))
    );
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select count(*) from mcp_probe"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "1");

    st.mcp.configure(false, status.port).await.unwrap();
    setup("drop table mcp_probe").await;
    setup("drop sequence mcp_probe_seq").await;
    st.shutdown().await;
}

fn oracle_ds() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_ORACLE_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    // oracle://user:password@host:port/service
    let rest = url.strip_prefix("oracle://")?;
    let (cred, target) = rest.rsplit_once('@')?;
    let (user, password) = cred.split_once(':').unwrap_or((cred, ""));
    let (hostport, service) = target.split_once('/')?;
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "1521"));
    Some(DataSourceConfig {
        name: "ora".into(),
        driver: Driver::Oracle,
        host: host.into(),
        port: port.parse().ok()?,
        user: user.into(),
        password: Some(password.into()),
        database: service.into(),
        options: [("oracleConnType".to_string(), "service".to_string())].into(),
        ..Default::default()
    })
}

/// `PROMETEO_ORACLE_URL=oracle://demo:prometeo@127.0.0.1:15219/FREEPDB1 cargo test -p prometeo-datagrip --test mcp`
/// `EXPLAIN PLAN` is refused, a read leaves no transaction (and no row lock) behind, writes are committed.
#[tokio::test]
async fn oracle_reads_leave_no_transaction_and_writes_commit() {
    let Some(cfg) = oracle_ds() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir);
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let user = st.mgr.open_session(&ds).await.unwrap();
    let run = |sql: &'static str| {
        let (st, user) = (&st, &user);
        async move {
            let ev = st
                .mgr
                .execute_collect(
                    user,
                    sql,
                    ExecOptions {
                        auto_commit: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert!(
                !ev.iter().any(|e| matches!(e, ExecEvent::Error { .. })),
                "{sql}: {ev:?}"
            );
        }
    };
    let _ = st
        .mgr
        .execute_collect(&user, "drop table mcp_probe", ExecOptions::default())
        .await;
    run("create table mcp_probe (a number)").await;
    run("insert into mcp_probe values (1)").await;

    st.mcp.set_policy(policy(&ds, true, true)).await.unwrap();
    let status = st.mcp.configure(true, 0).await.unwrap();
    let mut c = Client::new(status.port, Some(&status.token));
    c.initialize("ora-guard").await;

    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select 1 as a from dual"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "1");
    let (err, text) = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "explain plan for select 1 from dual"}),
        )
        .await;
    assert!(err && text.contains("PLAN_TABLE"), "{text}");
    // a FOR UPDATE on the shared read session must not keep the row locked after the call
    let _ = c
        .tool(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select a from mcp_probe for update"}),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(20), run("update mcp_probe set a = 2"))
        .await
        .expect("the user's update was blocked by a lock left by run_query");
    let w = c
        .ok(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "insert into mcp_probe values (3)"}),
        )
        .await;
    assert_eq!(
        (w["rowsAffected"].as_u64(), w["committed"].as_bool()),
        (Some(1), Some(true))
    );
    // committed: another session sees it
    let q = c
        .ok(
            "run_query",
            json!({"dataSourceId": ds, "sql": "select count(*) from mcp_probe"}),
        )
        .await;
    assert_eq!(q["rows"][0][0], "2");
    let (err, text) = c
        .tool(
            "execute_statement",
            json!({"dataSourceId": ds, "sql": "commit"}),
        )
        .await;
    assert!(err && text.contains("transaction-control"), "{text}");

    st.mcp.configure(false, status.port).await.unwrap();
    run("drop table mcp_probe").await;
    st.shutdown().await;
}

#[tokio::test]
async fn mcp_shutdown_is_bounded_while_a_call_is_running() {
    let dir = tempfile::tempdir().unwrap();
    let st = Arc::new(state_in(&dir));
    let (ds, port, token) = sqlite_fixture(&st, &dir).await;
    let mut c = Client::new(port, Some(&token));
    c.initialize("busy").await;
    let running = tokio::spawn(async move {
        c.tool(
            "run_query",
            json!({"dataSourceId": ds, "sql":
                "with recursive c(x) as (select 1 union all select x + 1 from c where x < 400000000) select count(*) from c"}),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    st.shutdown().await;
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "shutdown took {:?}",
        started.elapsed()
    );
    assert!(!st.mcp.status().running);
    // the listener is gone, so the call ends (it fails or is cut off)
    let _ = tokio::time::timeout(Duration::from_secs(15), running).await;
}
