//! SQL the app generates for awkward tables: names that need quotes, generated and identity columns, defaults,
//! comments. SQLite always runs; PostgreSQL and MySQL run with `DATUM_PG_URL` / `DATUM_MYSQL_URL`
//! (`DATUM_PG_URL=postgres://postgres:pw@localhost:5432/postgres cargo test -p dbcore --test sql_generation`).

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn change(kind: ChangeKind, key: Value, values: Value) -> RowChange {
    let map = |v: Value| -> BTreeMap<String, Value> {
        v.as_object()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    };
    RowChange {
        kind,
        key: map(key),
        values: map(values),
        row_locator: None,
    }
}

fn object(schema: Option<&str>, name: &str, kind: NodeKind, table: Option<&str>) -> ObjectRef {
    ObjectRef {
        schema: schema.map(str::to_string),
        name: name.into(),
        kind,
        table: table.map(str::to_string),
        signature: None,
    }
}

async fn dump_text(
    mgr: &ConnectionManager,
    ds: &str,
    schema: &str,
    target: Option<&str>,
) -> String {
    let mut buf = Vec::new();
    mgr.dump_schema(
        ds,
        schema,
        &DumpOptions {
            target_schema: target.map(str::to_string),
            ..Default::default()
        },
        &CancellationToken::new(),
        &|_| {},
        &mut buf,
    )
    .await
    .unwrap();
    String::from_utf8(buf).unwrap()
}

async fn run_script(mgr: &ConnectionManager, s: &SessionId, sql: &str) {
    let ev = mgr
        .execute_collect(
            s,
            sql,
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_ok(&ev);
}

// ------------------------------------------------------------------------------------------------ SQLite

const LITE_SCHEMA: &str = r#"
create table "Order Items" (
    id integer primary key autoincrement,
    "Order Id" int not null,
    "select" text default 'it''s' not null,
    price numeric default 0,
    total numeric generated always as (price * 2) stored,
    half numeric generated always as (price / 2) virtual,
    note text
);
create table sqliteXtable (a int);
create index "ix 1" on "Order Items" ("select" desc, "Order Id");
insert into "Order Items" ("Order Id", "select", price, note) values (1, 'O''Hara \ x
newline', 2.5, null), (2, 'plain', 4, 'n');
"#;

#[tokio::test]
async fn sqlite_dump_leaves_generated_columns_out_and_restores_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    mgr.connect(&lite_cfg(&dir.path().join("src.db")))
        .await
        .unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    run_script(&mgr, &s, LITE_SCHEMA).await;

    let dump = dump_text(&mgr, "lite", "main", None).await;
    // generated columns take no value; the table that only looks like a system table is dumped
    assert!(
        dump.contains(
            "insert into \"Order Items\" (\"id\", \"Order Id\", \"select\", \"price\", \"note\") values"
        ),
        "{dump}"
    );
    assert!(dump.contains("Name: sqliteXtable; Type: TABLE"), "{dump}");
    // the index block is a paragraph of its own
    assert!(
        dump.contains("(\"select\" desc, \"Order Id\");\n\n"),
        "{dump}"
    );

    // restores into an empty database, the generated columns computed again
    let dst = DataSourceConfig {
        id: "dst".into(),
        name: "dst".into(),
        driver: Driver::Sqlite,
        file: dir.path().join("dst.db").to_string_lossy().into_owned(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    mgr.connect(&dst).await.unwrap();
    let d = mgr.open_session("dst").await.unwrap();
    run_script(&mgr, &d, &dump).await;
    let ev = run(
        &mgr,
        &d,
        "select id, \"select\", total, half from \"Order Items\" order by id",
    )
    .await;
    let rows = first_rs(&ev).1;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][1], json!("O'Hara \\ x\nnewline"));
    assert_eq!(
        (rows[0][2].as_f64(), rows[0][3].as_f64()),
        (Some(5.0), Some(1.25))
    );
}

#[tokio::test]
async fn sqlite_update_to_default_uses_the_columns_default_or_null() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    mgr.connect(&lite_cfg(&dir.path().join("d.db")))
        .await
        .unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    run_script(
        &mgr,
        &s,
        "create table t (id integer primary key, a text default 'dflt', b text);\n\
         insert into t values (1, 'x', 'y');",
    )
    .await;
    let t = object(None, "t", NodeKind::Table, None);
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"a": {"$default": true}, "b": {"$default": true}}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let ev = run(&mgr, &s, "select a, b from t").await;
    let row = first_rs(&ev).1.remove(0);
    assert_eq!(
        (row[0].clone(), row[1].clone()),
        (json!("dflt"), Value::Null)
    );
}

// ------------------------------------------------------------------------------------------------ PostgreSQL

const PG_SCHEMA: &str = r#"
create table __S__."Order Items" (
    id bigint generated always as identity (start with 10 increment by 5),
    "Order Id" integer not null,
    "select" varchar(50) default 'it''s' not null,
    price numeric(10,2) default 0.00 check (price >= 0),
    total numeric generated always as (price * 2) stored,
    primary key (id, "Order Id"),
    constraint uq_id unique (id)
);
comment on table __S__."Order Items" is 'it''s a table';
comment on column __S__."Order Items"."select" is 'a "quoted" col';
create table __S__.plain (id serial primary key, label text default 'x');
insert into __S__."Order Items" ("Order Id", "select", price) values (1, 'O''Hara \ x
newline', 2.5);
insert into __S__.plain (label) values ('a'), ('b');
"#;

#[tokio::test]
async fn pg_dump_restores_identity_generated_columns_and_comments() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("DATUM_PG_URL not set: skipping");
        return;
    };
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("pg").await.unwrap();
    let (src, dst) = ("sqlgen_src", "sqlgen_dst");
    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop schema if exists {dst} cascade; drop schema if exists {src} cascade; create schema {src}; create schema {dst};"),
        )
        .await,
    );
    run_script(mgr, &s, &PG_SCHEMA.replace("__S__", src)).await;

    // the DDL keeps the options of the identity column
    let ddl = mgr
        .ddl(
            "pg",
            &object(Some(src), "Order Items", NodeKind::Table, None),
        )
        .await
        .unwrap();
    assert!(
        ddl.contains("generated always as identity (start with 10 increment by 5)"),
        "{ddl}"
    );
    assert!(
        ddl.contains("comment on table sqlgen_src.\"Order Items\" is 'it''s a table';"),
        "{ddl}"
    );

    // the dump restores: GENERATED ALWAYS values go in with `overriding system value`, the stored generated
    // column is left out, the sequence of a mixed-case table is found again
    let dump = dump_text(mgr, "pg", src, Some(dst)).await;
    assert!(dump.contains("overriding system value values"), "{dump}");
    assert!(
        dump.contains("generated always as identity (start with 10 increment by 5)"),
        "{dump}"
    );
    assert!(
        dump.contains(
            "comment on column \"sqlgen_dst\".\"Order Items\".\"select\" is 'a \"quoted\" col';"
        ),
        "{dump}"
    );
    assert!(
        dump.contains("pg_get_serial_sequence('\"sqlgen_dst\".\"Order Items\"', 'id')"),
        "{dump}"
    );
    run_script(mgr, &s, &dump).await;

    // the identity goes on from the restored value with its own increment
    run_script(
        mgr,
        &s,
        &format!("insert into {dst}.\"Order Items\" (\"Order Id\") values (2)"),
    )
    .await;
    let ev = run(
        mgr,
        &s,
        &format!("select id, total from {dst}.\"Order Items\" order by id"),
    )
    .await;
    let rows = first_rs(&ev).1;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0], json!(10));
    assert_eq!(rows[1][0], json!(15), "increment by 5 survives the restore");
    assert_eq!(rows[0][1].to_string().trim_matches('"'), "5.00");
    let ev = run(
        mgr,
        &s,
        &format!("select col_description('{dst}.\"Order Items\"'::regclass, 3)"),
    )
    .await;
    assert_eq!(scalar(&ev), json!("a \"quoted\" col"));
    let ev = run(
        mgr,
        &s,
        &format!("insert into {dst}.plain (label) values ('c') returning id"),
    )
    .await;
    assert_eq!(first_rs(&ev).1[0][0], json!(3));

    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop schema {dst} cascade; drop schema {src} cascade;"),
        )
        .await,
    );
}

#[tokio::test]
async fn pg_update_to_default_writes_the_keyword() {
    let Some(cfg) = pg_cfg() else {
        return;
    };
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(
        &run(
            mgr,
            &s,
            "drop schema if exists sqlgen_def cascade; create schema sqlgen_def; \
             create table sqlgen_def.t (id int primary key, a text default 'dflt'); \
             insert into sqlgen_def.t values (1, 'x');",
        )
        .await,
    );
    let t = object(Some("sqlgen_def"), "t", NodeKind::Table, None);
    let r = mgr
        .apply_changes(
            "pg",
            &t,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"a": {"$default": true}}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let ev = run(mgr, &s, "select a from sqlgen_def.t").await;
    assert_eq!(scalar(&ev), json!("dflt"));
    assert_ok(&run(mgr, &s, "drop schema sqlgen_def cascade").await);
}

// ------------------------------------------------------------------------------------------------ MySQL

const MY_SCHEMA: &str = r#"
create table `Order Items` (
    id bigint unsigned not null auto_increment,
    `Order Id` int not null,
    `select` varchar(50) default 'it''s' not null,
    price decimal(10,2) default 0.00,
    total decimal(12,2) generated always as (price * 2) stored,
    primary key (id, `Order Id`),
    unique key uq (`select`(10)),
    key ix_exp ((lower(`select`)), price desc),
    fulltext key ft (`select`)
) engine=InnoDB;
insert into `Order Items` (`Order Id`, `select`, price) values (1, 'O''Hara \\ x
newline 😀', 2.5);
"#;

#[tokio::test]
async fn mysql_index_ddl_keeps_prefix_length_desc_expression_and_kind() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("DATUM_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(
        &run(
            mgr,
            &s,
            "drop database if exists sqlgen_my; drop database if exists sqlgen_my2; create database sqlgen_my; create database sqlgen_my2; use sqlgen_my;",
        )
        .await,
    );
    for stmt in MY_SCHEMA.split(";\n").filter(|x| !x.trim().is_empty()) {
        assert_ok(&run(mgr, &s, stmt).await);
    }
    let ddl = |name: &str| {
        let o = object(
            Some("sqlgen_my"),
            name,
            NodeKind::Index,
            Some("Order Items"),
        );
        async move { mgr.ddl("my", &o).await.unwrap() }
    };
    assert_eq!(
        ddl("uq").await,
        "create unique index `uq` on `sqlgen_my`.`Order Items` (`select`(10));"
    );
    assert_eq!(
        ddl("ix_exp").await,
        "create index `ix_exp` on `sqlgen_my`.`Order Items` ((lower(`select`)), `price` desc);"
    );
    assert_eq!(
        ddl("ft").await,
        "create fulltext index `ft` on `sqlgen_my`.`Order Items` (`select`);"
    );

    // the dump: utf8mb4 names, the generated column is not inserted, the 4-byte character survives
    let dump = dump_text(mgr, "my", "sqlgen_my", Some("sqlgen_my2")).await;
    assert!(dump.contains("SET NAMES utf8mb4;"), "{dump}");
    assert!(
        dump.contains("(`id`, `Order Id`, `select`, `price`) values"),
        "{dump}"
    );
    run_script(mgr, &s, &dump).await;
    let ev = run(
        mgr,
        &s,
        "select `select`, total from sqlgen_my2.`Order Items`",
    )
    .await;
    let row = first_rs(&ev).1.remove(0);
    assert_eq!(row[0], json!("O'Hara \\ x\nnewline 😀"));
    assert_ok(&run(mgr, &s, "drop database sqlgen_my; drop database sqlgen_my2").await);
}
