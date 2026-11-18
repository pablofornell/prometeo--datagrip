//! Oracle 19c with a single-byte database character set (WE8MSWIN1252, WE8ISO8859P15): what a user sees first
//! (the Database Explorer down to the columns, table data, the console) works and the text comes back unchanged.
//! The driver asks for UTF-8 and the server converts, so a test against an AL32UTF8 server cannot show a fault
//! here. Run with such a server:
//!   PROMETEO_ORACLE_19C_URL=oracle://demo:prometeo@127.0.0.1:15319/ORCL cargo test -p dbcore --test oracle_charset
//! The account needs `CREATE TABLE` and a quota. The test makes its own tables (`CS19_*`); a server with another
//! character set or release can also run it. A 19.3 server (community image built from oracle/docker-images; the
//! first start creates the database, about 15 minutes; the service name is the SID):
//!   docker run -d --name prometeo-oracle19 -p 127.0.0.1:15319:1521 -e ORACLE_SID=ORCL -e ORACLE_PWD=<sys password> \
//!     -e ORACLE_CHARACTERSET=WE8MSWIN1252 doctorkirk/oracle-19c:19.3

mod common;

use common::*;
use dbcore::*;
use serde_json::{json, Value};

/// Text that both single-byte character sets have (`€` too), so the server stores it unchanged.
const LATIN: &str = "Peña año € ü";
/// Text that a single-byte character set does not have: it can only be in the NCHAR (AL16UTF16) column.
const GREEK: &str = "Δέλτα";

fn cfg() -> Option<DataSourceConfig> {
    let mut cfg = oracle_cfg_from_env("PROMETEO_ORACLE_19C_URL")?;
    cfg.id = "ora-19c".into();
    Some(cfg)
}

/// `unistr` text of `s`: SQL text goes through the database character set, so the NCHAR value is written with
/// escapes.
fn unistr(s: &str) -> String {
    let esc: String = s.encode_utf16().map(|u| format!("\\{u:04X}")).collect();
    format!("unistr('{esc}')")
}

fn txt(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "NULL".into(),
        other => other.to_string(),
    }
}

const FIXTURE_DROP: &str = "begin \
    for t in (select table_name from user_tables where table_name like 'CS19\\_%' escape '\\') loop \
      execute immediate 'drop table \"' || t.table_name || '\" cascade constraints purge'; \
    end loop; end;\n/\n";

fn fixture() -> String {
    format!(
        "{FIXTURE_DROP}\
         create table cs19_text (id number primary key, name varchar2(40) not null, nname nvarchar2(40), \
           note clob, status char(1) default 'N' not null, created date default sysdate);\n\
         insert into cs19_text values (1, '{LATIN}', {nname}, to_clob('{LATIN}') || rpad(to_clob('x'), 5000, 'y'), 'S', \
           date '2024-01-02');\n\
         insert into cs19_text (id, name) values (2, 'plain');\n\
         create table \"CS19_AÑO\" (id number primary key, \"AÑO\" number(4) default 2024, \
           \"DESCRIPCIÓN\" varchar2(50));\n\
         comment on table \"CS19_AÑO\" is 'Tabla del año';\n\
         insert into \"CS19_AÑO\" values (1, 2025, 'Año nuevo €');\n\
         commit",
        nname = unistr(GREEK)
    )
}

#[tokio::test]
async fn single_byte_charset_explorer_data_and_console() {
    let Some(cfg) = cfg() else {
        eprintln!("PROMETEO_ORACLE_19C_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let ev = run(
        &mgr,
        &s,
        "select value from nls_database_parameters where parameter = 'NLS_CHARACTERSET'",
    )
    .await;
    assert_ok(&ev);
    let v = mgr.server_version(&cfg.id).unwrap_or_default();
    eprintln!("server: {v}, database character set {}", txt(&scalar(&ev)));
    let ev = mgr
        .execute_collect(
            &s,
            &fixture(),
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_ok(&ev);
    let me = txt(&scalar(&run(&mgr, &s, "select user from dual").await));

    // Database Explorer: the schema level (with and without the system ones), the folders, the tables
    for show_system in [false, true] {
        let root = mgr
            .introspect_with(&cfg.id, &[], &IntrospectOptions { show_system })
            .await
            .unwrap();
        let mine = root
            .iter()
            .find(|n| n.name == me)
            .unwrap_or_else(|| panic!("{me} not in {:?}", names(&root)));
        assert_eq!(mine.extra["system"], json!(false), "{mine:?}");
    }
    let folders = mgr
        .introspect(&cfg.id, std::slice::from_ref(&me))
        .await
        .unwrap();
    assert!(
        names(&folders).contains(&"tables".to_string()),
        "{:?}",
        names(&folders)
    );
    let tables = mgr
        .introspect(&cfg.id, &[me.clone(), "tables".into()])
        .await
        .unwrap();
    let t_names = names(&tables);
    assert!(
        t_names.contains(&"CS19_TEXT".to_string()) && t_names.contains(&"CS19_AÑO".to_string()),
        "{t_names:?}"
    );
    let ano = tables.iter().find(|n| n.name == "CS19_AÑO").unwrap();
    assert_eq!(ano.extra["comment"], json!("Tabla del año"));

    // columns: the names with non-ASCII letters, the defaults (read from the LONG column DATA_DEFAULT before 23)
    let cols = mgr
        .introspect(
            &cfg.id,
            &[
                me.clone(),
                "tables".into(),
                "CS19_AÑO".into(),
                "columns".into(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(names(&cols), ["ID", "AÑO", "DESCRIPCIÓN"]);
    assert_eq!(cols[1].extra["default"], json!("2024"));
    let cols = mgr
        .introspect(
            &cfg.id,
            &[
                me.clone(),
                "tables".into(),
                "CS19_TEXT".into(),
                "columns".into(),
            ],
        )
        .await
        .unwrap();
    assert_eq!(
        names(&cols),
        ["ID", "NAME", "NNAME", "NOTE", "STATUS", "CREATED"]
    );
    assert_eq!(cols[4].extra["default"], json!("'N'"));
    assert_eq!(cols[5].extra["default"], json!("sysdate"));

    // table data
    let page = TableDataRequest {
        where_clause: None,
        order_by: Some("ID".into()),
        offset: 0,
        limit: 100,
        count_total: true,
    };
    let data = mgr
        .table_data(&cfg.id, &ObjectRef::table(Some(&me), "CS19_TEXT"), &page)
        .await
        .unwrap();
    assert_eq!(data.rows.len(), 2);
    assert_eq!(txt(&data.rows[0][1]), LATIN);
    assert_eq!(txt(&data.rows[0][2]), GREEK);
    assert!(txt(&data.rows[0][3]).starts_with(&format!("{LATIN}xyy")));
    assert_eq!(txt(&data.rows[0][3]).len(), LATIN.len() + 5000);
    assert_eq!(txt(&data.rows[1][1]), "plain");
    let data = mgr
        .table_data(&cfg.id, &ObjectRef::table(Some(&me), "CS19_AÑO"), &page)
        .await
        .unwrap();
    assert_eq!(
        data.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["ID", "AÑO", "DESCRIPCIÓN"]
    );
    assert_eq!(txt(&data.rows[0][2]), "Año nuevo €");

    // console: the dictionary, the data and a text literal through the database character set (the Explorer
    // and table data above bind the table names, `CS19_AÑO` too)
    let ev = run(
        &mgr,
        &s,
        "select table_name from user_tables where table_name like 'CS19%' order by table_name",
    )
    .await;
    assert_ok(&ev);
    let (_, rows, _) = first_rs(&ev);
    assert_eq!(
        rows.iter().map(|r| txt(&r[0])).collect::<Vec<_>>(),
        ["CS19_AÑO", "CS19_TEXT"]
    );
    let ev = run(
        &mgr,
        &s,
        "select \"AÑO\", \"DESCRIPCIÓN\" from \"CS19_AÑO\"",
    )
    .await;
    assert_ok(&ev);
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["AÑO", "DESCRIPCIÓN"]
    );
    assert_eq!(
        (txt(&rows[0][0]), txt(&rows[0][1])),
        ("2025".into(), "Año nuevo €".into())
    );
    let ev = run(
        &mgr,
        &s,
        &format!("select '{LATIN}' l, name, nname from cs19_text where id = 1"),
    )
    .await;
    assert_ok(&ev);
    let (_, rows, _) = first_rs(&ev);
    assert_eq!(
        rows[0].iter().map(txt).collect::<Vec<_>>(),
        [LATIN, LATIN, GREEK]
    );

    assert_ok(&run(&mgr, &s, FIXTURE_DROP).await);
    mgr.close_session(&s).await;
    mgr.disconnect(&cfg.id).await;
}
