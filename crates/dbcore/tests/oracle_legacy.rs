//! Oracle servers before 12.1 (10g, 11g): the SQL that these releases do not know is replaced (ROWNUM paging, no
//! `WITH FUNCTION`, no `CROSS APPLY`, `XMLAGG` for `LISTAGG`, the `LONG` dictionary columns for the `*_VC` ones) and
//! the driver speaks their older protocol. Run with a 10g or 11g server:
//!   PROMETEO_ORACLE_10G_URL=oracle://demo:prometeo@127.0.0.1:15210/XE cargo test -p dbcore --test oracle_legacy -- --test-threads=1
//! (`make db-up-oracle-legacy` starts such a server.) The fixture is `fixtures/oracle_legacy_seed.sql` (objects
//! `LG_*`), loaded once per run.

mod common;

use std::collections::BTreeMap;

use common::*;
use dbcore::cell::{CellContent, CellKind};
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::{json, Value};
use tokio::sync::OnceCell;

const LEGACY_SEED: &str = include_str!("fixtures/oracle_legacy_seed.sql");
static SEEDED: OnceCell<()> = OnceCell::const_new();

fn legacy_cfg() -> Option<DataSourceConfig> {
    let mut cfg = oracle_cfg_from_env("PROMETEO_ORACLE_10G_URL")?;
    cfg.id = "ora-old".into();
    Some(cfg)
}

/// Connected manager, fixture loaded (once per test binary).
macro_rules! setup {
    () => {{
        let Some(cfg) = legacy_cfg() else {
            eprintln!("PROMETEO_ORACLE_10G_URL not set: skipping");
            return;
        };
        SEEDED
            .get_or_init(|| async {
                let mgr = connected(&cfg).await;
                let s = mgr.open_session(&cfg.id).await.unwrap();
                let ev = mgr
                    .execute_collect(
                        &s,
                        LEGACY_SEED,
                        ExecOptions {
                            max_rows: 10,
                            stop_on_error: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                assert_ok(&ev);
                mgr.close_session(&s).await;
                mgr.disconnect(&cfg.id).await;
            })
            .await;
        let mgr = connected(&cfg).await;
        (cfg, mgr)
    }};
}

fn txt(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "NULL".into(),
        other => other.to_string(),
    }
}

fn node<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
    nodes
        .iter()
        .find(|n| n.name == name)
        .unwrap_or_else(|| panic!("{name} not in {:?}", names(nodes)))
}

fn obj(name: &str, kind: NodeKind, table: Option<&str>) -> ObjectRef {
    ObjectRef {
        schema: Some("DEMO".into()),
        name: name.into(),
        kind,
        table: table.map(str::to_string),
        signature: None,
    }
}

fn page(offset: u64, limit: u64, order_by: Option<&str>) -> TableDataRequest {
    TableDataRequest {
        where_clause: None,
        order_by: order_by.map(str::to_string),
        offset,
        limit,
        count_total: false,
    }
}

#[tokio::test]
async fn version_console_and_transactions() {
    let (cfg, mgr) = setup!();
    let t = mgr.test_connection(&cfg).await;
    assert!(t.ok, "{}", t.message);
    let v = t.server_version.unwrap();
    assert!(
        v.starts_with("Oracle Database 10g") || v.starts_with("Oracle Database 11g"),
        "{v}"
    );

    let s = mgr.open_session(&cfg.id).await.unwrap();
    // more rows than one fetch, long values (more than one chunk), a CLOB
    let ev = run_n(
        &mgr,
        &s,
        "select level n, rpad('x', 3000, 'y') s, to_clob(rpad('a', 4000, 'b')) || rpad('c', 4000, 'd') c \
         from dual connect by level <= 1500",
        2000,
    )
    .await;
    assert_ok(&ev);
    let (cols, rows, more) = first_rs(&ev);
    assert_eq!(cols.len(), 3);
    assert_eq!((rows.len(), more), (1500, false));
    assert_eq!(txt(&rows[1499][0]), "1500");
    assert_eq!(txt(&rows[0][1]).len(), 3000);
    assert_eq!(txt(&rows[0][2]).len(), 8000);

    // DBMS_OUTPUT, an error with its position, a long statement text (sent in chunks)
    let ev = run(
        &mgr,
        &s,
        "begin dbms_output.put_line('hello from 10g'); end;\n/\nselect nosuch from dual",
    )
    .await;
    assert!(
        ev.iter().any(
            |e| matches!(e, ExecEvent::Message { text, .. } if text.contains("hello from 10g"))
        ),
        "{ev:#?}"
    );
    let err = errors(&ev);
    assert_eq!(err.len(), 1, "{ev:#?}");
    assert!(err[0].contains("ORA-00904"), "{err:?}");
    let long_sql = format!("select '{}' x from dual", "z".repeat(3000));
    assert_eq!(txt(&scalar(&run(&mgr, &s, &long_sql).await)).len(), 3000);

    // binds longer than one chunk go through the grid editing path below; here the transaction state
    assert_ok(&run(&mgr, &s, "insert into lg_nopk values (99, 'tx')").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    mgr.close_session(&s).await;
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

/// A `DBMS_OUTPUT` line longer than a PL/SQL bind holds before 12.1 (32512 bytes) is cut, and the lines after it
/// still come (the drain does not fail with ORA-06502).
#[tokio::test]
async fn long_dbms_output_line_is_cut() {
    let (cfg, mgr) = setup!();
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let ev = run(
        &mgr,
        &s,
        "declare v varchar2(32767) := rpad('x', 32767, 'y'); \
         begin dbms_output.put_line('before'); dbms_output.put_line(v); dbms_output.put_line('after'); end;\n/",
    )
    .await;
    assert_ok(&ev);
    let lines: Vec<&str> = ev
        .iter()
        .filter_map(|e| match e {
            ExecEvent::Message { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .flat_map(|t| t.split('\n'))
        .collect();
    let long = lines
        .iter()
        .find(|l| l.starts_with("xyy"))
        .unwrap_or_else(|| panic!("{:?}", lines.iter().map(|l| l.len()).collect::<Vec<_>>()));
    // 32512-byte binds before 12.1, 32767 from 12.1 (a line keeps one byte less: the line feed)
    let v = mgr.server_version(&cfg.id).unwrap();
    let old = v.contains(" 10g ") || v.contains(" 11g ");
    assert_eq!(long.len(), if old { 32511 } else { 32766 }, "{v}");
    let at = |w: &str| lines.iter().position(|l| *l == w);
    assert!(at("before") < lines.iter().position(|l| l.starts_with("xyy")));
    assert!(
        at("after").is_some(),
        "{:?}",
        lines.iter().map(|l| l.len()).collect::<Vec<_>>()
    );
    mgr.close_session(&s).await;
    mgr.disconnect(&cfg.id).await;
}

/// DDL on a read-only data source: the `DBMS_METADATA` setup block is ours and no write, so it opens no read-only
/// transaction (the pooled connection stays in the pool) and `GET_DDL` works.
#[tokio::test]
async fn ddl_on_a_read_only_data_source() {
    let (cfg, mgr) = setup!();
    mgr.disconnect(&cfg.id).await;
    let mut ro = cfg.clone();
    ro.id = "ora-old-ro".into();
    ro.read_only = true;
    // logons of the instance, read on a session of the normal data source
    let watch = connected(&cfg).await;
    let ws = watch.open_session(&cfg.id).await.unwrap();
    let logons_sql = "select value from v$sysstat where name = 'logons cumulative'";
    let mgr = connected(&ro).await;
    let mut logons = Vec::new();
    for _ in 0..3 {
        let ddl = mgr
            .ddl(&ro.id, &obj("LG_EMP", NodeKind::Table, None))
            .await
            .unwrap();
        assert!(ddl.contains("CREATE TABLE \"DEMO\".\"LG_EMP\""), "{ddl}");
        assert!(!ddl.contains("TABLESPACE"), "{ddl}");
        logons.push(txt(&scalar(&run(&watch, &ws, logons_sql).await)));
    }
    // the first DDL opened the pooled connection; the next ones used it again
    assert_eq!(logons[0], logons[2], "{logons:?}");
    watch.close_session(&ws).await;
    watch.disconnect(&cfg.id).await;
    // the read-only gate still refuses writes on the same data source
    let s = mgr.open_session(&ro.id).await.unwrap();
    let ev = run(&mgr, &s, "create table lg_ro_x (a number)").await;
    assert_eq!(errors(&ev).len(), 1, "{ev:?}");
    mgr.close_session(&s).await;
    mgr.disconnect(&ro.id).await;
}

/// The Stop button: the break marker goes out with the 16-bit packet length of these servers.
#[tokio::test]
async fn cancel_running_statements() {
    use std::time::{Duration, Instant};
    let (cfg, mgr) = setup!();
    let s = mgr.open_session(&cfg.id).await.unwrap();
    for (sql, max_rows) in [
        // busy on the server, no row yet
        (
            "select count(*) from all_objects a, all_objects b, all_objects c",
            0,
        ),
        // a stream of rows
        (
            "select a.object_id, b.object_name from all_objects a, all_objects b",
            100_000_000,
        ),
    ] {
        let t0 = Instant::now();
        let mut opts = ExecOptions::default();
        if max_rows > 0 {
            opts.max_rows = max_rows;
        }
        let mut h = mgr.execute(&s, sql, opts).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        mgr.cancel(&h.id).unwrap();
        let ev = wait_done(&mut h).await;
        assert!(
            errors(&ev).iter().any(|e| e.starts_with("ORA-01013")),
            "{sql}: {:?}",
            errors(&ev)
        );
        assert!(t0.elapsed() < Duration::from_secs(15), "{:?}", t0.elapsed());
        // the connection is still good
        assert_eq!(
            txt(&scalar(&run(&mgr, &s, "select 42 from dual").await)),
            "42"
        );
    }
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn introspection() {
    let (cfg, mgr) = setup!();
    let ds = cfg.id.as_str();
    let schemas = children(&mgr, ds, &[]).await;
    assert_eq!(schemas[0].name, "DEMO", "{:?}", names(&schemas));
    assert!(!names(&schemas).contains(&"SYS".to_string()));

    let tables = children(&mgr, ds, &["DEMO", "tables"]).await;
    for t in ["LG_DEPT", "LG_EMP", "LG_NOTES", "LG_NOPK"] {
        node(&tables, t);
    }

    let folders = children(&mgr, ds, &["DEMO", "tables", "LG_EMP"]).await;
    assert_eq!(
        names(&folders),
        [
            "columns",
            "keys",
            "foreign keys",
            "indexes",
            "checks",
            "triggers"
        ]
    );
    // the NOT NULL constraint on NAME is no check of its own
    assert_eq!(node(&folders, "checks").extra["count"], json!(1));

    let cols = children(&mgr, ds, &["DEMO", "tables", "LG_DEPT", "columns"]).await;
    assert_eq!(names(&cols), ["ID", "NAME", "CREATED", "NOTE"]);
    let note = node(&cols, "NOTE");
    assert_eq!(note.extra["default"], json!("'none'"));
    assert_eq!(note.extra["identity"], json!(false));
    assert_eq!(note.extra["nullable"], json!(false));
    assert_eq!(
        node(&cols, "NAME").extra["comment"],
        json!("Department name")
    );
    assert_eq!(node(&cols, "ID").extra["isPk"], json!(true));

    let keys = children(&mgr, ds, &["DEMO", "tables", "LG_DEPT", "keys"]).await;
    assert_eq!(names(&keys), ["LG_DEPT_PK", "LG_DEPT_NAME_UQ"]);
    assert_eq!(node(&keys, "LG_DEPT_PK").extra["columns"], json!(["ID"]));

    let fks = children(&mgr, ds, &["DEMO", "tables", "LG_EMP", "foreign_keys"]).await;
    let fk = node(&fks, "LG_EMP_DEPT_FK");
    assert_eq!(fk.extra["columns"], json!(["DEPT_ID"]));
    assert_eq!(
        (fk.extra["refTable"].clone(), fk.extra["refColumns"].clone()),
        (json!("LG_DEPT"), json!(["ID"]))
    );
    assert_eq!(fk.extra["onDelete"], json!("CASCADE"));

    let idx = children(&mgr, ds, &["DEMO", "tables", "LG_EMP", "indexes"]).await;
    // a descending key part is an expression in the dictionary of these releases
    let ix = node(&idx, "LG_EMP_NAME_IX");
    assert!(
        ix.extra["columns"].as_str().unwrap().starts_with("NAME, "),
        "{:?}",
        ix.extra
    );
    assert!(
        ix.extra["columns"].as_str().unwrap().ends_with(" DESC"),
        "{:?}",
        ix.extra
    );

    let checks = children(&mgr, ds, &["DEMO", "tables", "LG_EMP", "checks"]).await;
    assert_eq!(names(&checks), ["LG_EMP_SALARY_CK"]);
    assert_eq!(checks[0].extra["definition"], json!("salary > 0"));

    let trg = children(&mgr, ds, &["DEMO", "tables", "LG_EMP", "triggers"]).await;
    assert_eq!(names(&trg), ["LG_EMP_TRG"]);

    let routines = children(&mgr, ds, &["DEMO", "routines"]).await;
    let f = node(&routines, "LG_COUNT");
    assert_eq!(f.extra["signature"], json!("P_DEPT NUMBER"));
    assert_eq!(f.extra["returns"], json!("NUMBER"));
    assert_eq!(
        node(&routines, "LG_RAISE").extra["signature"],
        json!("P_ID NUMBER, P_PCT NUMBER")
    );

    // package members (no SUBPROGRAM_ID before 11.1: sorted by name there)
    let members = children(&mgr, ds, &["DEMO", "packages", "LG_PKG"]).await;
    let mut m = names(&members);
    m.sort();
    assert_eq!(m, ["ALPHA", "ZETA"]);
    assert_eq!(
        node(&members, "ALPHA").extra["signature"],
        json!("B VARCHAR2")
    );

    // the search / completion snapshot of the schema
    let snap = mgr.schema_snapshot(ds, Some("DEMO")).await.unwrap();
    let emp = snap
        .iter()
        .find(|o| o.name == "LG_EMP")
        .expect("LG_EMP in the snapshot");
    assert_eq!(emp.columns.len(), 6);
    assert_eq!(emp.foreign_keys.len(), 1);
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

#[tokio::test]
async fn table_data_pages_with_rownum() {
    let (cfg, mgr) = setup!();
    let t = ObjectRef::table(Some("DEMO"), "LG_EMP");
    let first = mgr
        .table_data(&cfg.id, &t, &page(0, 100, Some("ID")))
        .await
        .unwrap();
    assert_eq!(
        first
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["ID", "DEPT_ID", "NAME", "SALARY", "HIRED", "BIO"],
        "the row number column of the paging is not shown"
    );
    assert_eq!((first.rows.len(), first.has_more), (100, true));
    assert_eq!(txt(&first.rows[0][0]), "1");

    let middle = mgr
        .table_data(&cfg.id, &t, &page(500, 100, Some("ID desc")))
        .await
        .unwrap();
    assert_eq!((middle.rows.len(), middle.has_more), (100, true));
    assert_eq!(txt(&middle.rows[0][0]), "700");

    let last = mgr
        .table_data(&cfg.id, &t, &page(1150, 100, Some("ID")))
        .await
        .unwrap();
    assert_eq!((last.rows.len(), last.has_more), (50, false));
    assert_eq!(txt(&last.rows[49][0]), "1200");
    assert!(last.rows.iter().all(|r| r.len() == 6));

    // a table without primary key: rows come with their ROWID locator, not the row number
    let nopk = mgr
        .table_data(
            &cfg.id,
            &ObjectRef::table(Some("DEMO"), "LG_NOPK"),
            &page(1, 10, Some("A")),
        )
        .await
        .unwrap();
    assert_eq!(nopk.columns.len(), 2);
    assert_eq!(nopk.rows.len(), 2);
    assert_eq!(txt(&nopk.rows[0][0]), "2");
    let locs = nopk.row_locators.expect("ROWID locators");
    assert_eq!(locs.len(), 2);
    assert!(txt(&locs[0]).len() >= 18, "{locs:?}");

    // a LONG column through the wrapped query
    let notes = mgr
        .table_data(
            &cfg.id,
            &ObjectRef::table(Some("DEMO"), "LG_NOTES"),
            &page(0, 10, Some("ID")),
        )
        .await
        .unwrap();
    assert_eq!(notes.rows.len(), 2);
    assert_eq!(txt(&notes.rows[1][1]).len(), 6000);
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

#[tokio::test]
async fn ddl_without_with_function() {
    let (cfg, mgr) = setup!();
    let ddl = mgr
        .ddl(&cfg.id, &obj("LG_EMP", NodeKind::Table, None))
        .await
        .unwrap();
    assert!(ddl.contains("CREATE TABLE \"DEMO\".\"LG_EMP\""), "{ddl}");
    // the transforms were in effect: no storage clauses, statements end with ';'
    assert!(
        !ddl.contains("TABLESPACE") && !ddl.contains("STORAGE("),
        "{ddl}"
    );
    assert!(
        ddl.contains("CREATE INDEX \"DEMO\".\"LG_EMP_NAME_IX\""),
        "{ddl}"
    );
    assert!(ddl.contains(';'), "{ddl}");

    let dept = mgr
        .ddl(&cfg.id, &obj("LG_DEPT", NodeKind::Table, None))
        .await
        .unwrap();
    assert!(
        dept.contains("COMMENT ON COLUMN \"DEMO\".\"LG_DEPT\".\"NAME\""),
        "{dept}"
    );

    let pkg = mgr
        .ddl(&cfg.id, &obj("LG_PKG", NodeKind::Package, None))
        .await
        .unwrap();
    assert!(pkg.contains("PACKAGE \"DEMO\".\"LG_PKG\""), "{pkg}");
    assert!(pkg.contains("PACKAGE BODY \"DEMO\".\"LG_PKG\""), "{pkg}");

    let view = mgr
        .ddl(&cfg.id, &obj("LG_EMP_V", NodeKind::View, None))
        .await
        .unwrap();
    assert!(view.contains("VIEW \"DEMO\".\"LG_EMP_V\""), "{view}");

    let err = mgr
        .ddl(&cfg.id, &obj("LG_NOSUCH", NodeKind::Table, None))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("ORA-31603"), "{err}");
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

#[tokio::test]
async fn find_usages_reads_long_view_text() {
    let (cfg, mgr) = setup!();
    let us = mgr
        .find_usages(&cfg.id, &obj("NAME", NodeKind::Column, Some("LG_DEPT")))
        .await
        .unwrap();
    assert!(
        us.iter().any(|u| u.kind == UsageKind::View
            && u.name == "LG_EMP_V"
            && u.detail == "references column NAME"),
        "{us:#?}"
    );
    let us = mgr
        .find_usages(&cfg.id, &obj("LG_EMP", NodeKind::Table, None))
        .await
        .unwrap();
    let f = us
        .iter()
        .find(|u| u.kind == UsageKind::Function && u.name == "LG_COUNT")
        .unwrap_or_else(|| panic!("{us:#?}"));
    assert_eq!(f.line, Some(4));
    assert!(
        us.iter()
            .any(|u| u.kind == UsageKind::View && u.name == "LG_EMP_V"),
        "{us:#?}"
    );
    assert!(
        us.iter()
            .any(|u| u.kind == UsageKind::Trigger && u.name == "LG_EMP_TRG"),
        "{us:#?}"
    );
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

/// No error in the events of a script; a failure names the statement that failed.
fn assert_restored(ev: &[ExecEvent]) {
    for e in ev {
        if let ExecEvent::Error { index, message, .. } = e {
            let sql = ev.iter().find_map(|x| match x {
                ExecEvent::Statement { index: i, sql, .. } if i == index => Some(sql.as_str()),
                _ => None,
            });
            panic!(
                "statement {index} failed: {message}\n{}",
                sql.unwrap_or("?")
            );
        }
    }
}

fn text_of(c: &CellContent) -> &str {
    assert_eq!(c.kind, CellKind::Text, "{c:?}");
    c.text.as_deref().expect("text")
}

#[tokio::test]
async fn edits_and_lob_cells() {
    let (cfg, mgr) = setup!();
    let t = ObjectRef::table(Some("DEMO"), "LG_EDIT");
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, "delete from lg_edit").await);
    assert_ok(&run(&mgr, &s, "commit").await);
    mgr.close_session(&s).await;

    // bound values longer than one chunk (one-byte chunk lengths on these servers)
    let text: String = (0..3990)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();
    let clob: String = "0123456789".repeat(10_000);
    let blob: Vec<u8> = (0..60_000u32).map(|i| (i % 251) as u8).collect();
    let m = |v: Value| -> BTreeMap<String, Value> {
        v.as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect()
    };
    let ins = RowChange {
        kind: ChangeKind::Insert,
        key: BTreeMap::new(),
        values: m(
            json!({"ID": 1, "T": text, "C": clob, "B": {"$bin": dbcore::quote::hex_encode(&blob), "len": blob.len()}}),
        ),
        row_locator: None,
    };
    let r = mgr.apply_changes(&cfg.id, &t, &[ins]).await.unwrap();
    assert!(r.committed, "{:?}", r.results);

    let key: BTreeMap<String, Value> = [("ID".to_string(), json!(1))].into();
    let c = mgr.fetch_cell(&cfg.id, &t, &key, "C", 0).await.unwrap();
    assert_eq!(
        (text_of(&c).len(), c.len, c.truncated),
        (100_000, 100_000, false)
    );
    assert_eq!(text_of(&c), clob);
    let cut = mgr.fetch_cell(&cfg.id, &t, &key, "C", 2500).await.unwrap();
    assert_eq!((text_of(&cut), cut.truncated), (&clob[..2500], true));
    let b = mgr.fetch_cell(&cfg.id, &t, &key, "B", 0).await.unwrap();
    assert_eq!(b.kind, CellKind::Binary);
    assert_eq!(
        dbcore::cell::base64_decode(b.base64.as_deref().unwrap()).unwrap(),
        blob
    );
    let tv = mgr.fetch_cell(&cfg.id, &t, &key, "T", 0).await.unwrap();
    assert_eq!(text_of(&tv), text);

    let upd = RowChange {
        kind: ChangeKind::Update,
        key: key.clone(),
        values: m(json!({"T": "short"})),
        row_locator: None,
    };
    let del = RowChange {
        kind: ChangeKind::Delete,
        key: key.clone(),
        values: BTreeMap::new(),
        row_locator: None,
    };
    let r = mgr.apply_changes(&cfg.id, &t, &[upd]).await.unwrap();
    assert!(r.committed, "{:?}", r.results);
    let page = mgr
        .table_data(&cfg.id, &t, &page(0, 10, None))
        .await
        .unwrap();
    assert_eq!(txt(&page.rows[0][1]), "short");
    let r = mgr.apply_changes(&cfg.id, &t, &[del]).await.unwrap();
    assert!(r.committed, "{:?}", r.results);
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

#[tokio::test]
async fn explain_plan() {
    let (cfg, mgr) = setup!();
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let plan = mgr
        .explain(&s, "select * from lg_emp where id = 5", false)
        .await
        .unwrap();
    assert_eq!(plan.root.operation, "Select", "{plan:#?}");
    let access = &plan.root.children[0];
    assert_eq!(access.operation, "TABLE ACCESS BY INDEX ROWID", "{plan:#?}");
    assert!(access.params.contains("DEMO.LG_EMP"), "{plan:#?}");
    assert!(
        !access.children.is_empty(),
        "the index access below: {plan:#?}"
    );
    mgr.close_session(&s).await;
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

#[tokio::test]
async fn schema_model_for_compare() {
    let (cfg, mgr) = setup!();
    let m = mgr
        .schema_model(&cfg.id, "DEMO", Some("LG_"))
        .await
        .unwrap();
    let names: Vec<&str> = m.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        ["LG_DEPT", "LG_EDIT", "LG_EMP", "LG_NOPK", "LG_NOTES"]
    );
    let dept = &m.tables[0];
    let note = dept.columns.iter().find(|c| c.name == "NOTE").unwrap();
    assert_eq!(note.default.as_deref(), Some("'none'"));
    assert!(!note.nullable);
    assert_eq!(note.extra, None);
    let emp = m.tables.iter().find(|t| t.name == "LG_EMP").unwrap();
    assert_eq!(emp.checks.len(), 1, "{:?}", emp.checks);
    assert_eq!(emp.foreign_keys.len(), 1);
    assert_eq!(emp.indexes.len(), 1, "{:?}", emp.indexes);
    assert!(m.views.iter().any(|v| v.name == "LG_EMP_V"));
    assert!(m.sequences.iter().any(|q| q.name == "LG_SEQ"));
    assert!(m.routines.iter().any(|r| r.name == "LG_PKG"));
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}

/// Named to run last (the tests run in name order with `--test-threads=1`): the restore drops and creates the
/// fixture's objects again.
#[tokio::test]
async fn zz_dump_and_restore() {
    let (cfg, mgr) = setup!();
    let opts = DumpOptions {
        data: true,
        drop_if_exists: true,
        include_routines: true,
        ..Default::default()
    };
    let mut buf = Vec::new();
    let res = mgr
        .dump_schema(
            &cfg.id,
            "DEMO",
            &opts,
            &CancellationToken::new(),
            &|_| {},
            &mut buf,
        )
        .await
        .unwrap();
    assert!(!res.cancelled);
    let dump = String::from_utf8(buf).unwrap();
    assert!(dump.contains("CREATE TABLE LG_EMP"), "{dump}");
    assert!(
        dump.contains("CREATE OR REPLACE FORCE VIEW LG_EMP_V"),
        "{dump}"
    );
    // 10g / 11g have neither (on a newer server the schema may hold such tables)
    let v = mgr.server_version(&cfg.id).unwrap();
    assert!(
        !(v.contains(" 10g ") || v.contains(" 11g "))
            || (!dump.contains("IDENTITY") && !dump.contains("INVISIBLE")),
        "{dump}"
    );

    // the dump runs on the same server: all objects and rows come back
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let ev = mgr
        .execute_collect(
            &s,
            &dump,
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_restored(&ev);
    assert_eq!(
        txt(&scalar(&run(&mgr, &s, "select count(*) from lg_emp").await)),
        "1200"
    );
    // a LONG value has no length() in SQL: it is read whole
    let body = txt(&scalar(
        &run(&mgr, &s, "select body from lg_notes where id = 2").await,
    ));
    assert_eq!((body.len(), body.starts_with("long x")), (6000, true));
    assert_eq!(
        txt(&scalar(
            &run(&mgr, &s, "select note from lg_dept where id = 2").await
        )),
        "x"
    );
    assert_eq!(
        txt(&scalar(
            &run(&mgr, &s, "select count(*) from user_objects where status <> 'VALID' and object_name like 'LG\\_%' escape '\\'").await
        )),
        "0"
    );
    assert_eq!(
        txt(&scalar(
            &run(
                &mgr,
                &s,
                "select count(*) from user_triggers where trigger_name = 'LG_EMP_TRG'"
            )
            .await
        )),
        "1"
    );
    assert_eq!(
        txt(&scalar(
            &run(&mgr, &s, "select lg_count(1) from dual").await
        )),
        "600"
    );
    mgr.close_session(&s).await;
    // the pool's sessions count against the small process limit of XE
    mgr.disconnect(&cfg.id).await;
}
