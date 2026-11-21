//! The User/Schema selector: `list_schemas` and `set_session_schema` on SQLite (always runs, temp file), PostgreSQL,
//! MySQL and Oracle (each skips when its URL is not set). Run with:
//!   DATUM_PG_URL=... DATUM_MYSQL_URL=... DATUM_ORACLE_URL=oracle://demo:<password>@127.0.0.1:15219/FREEPDB1 \
//!     cargo test -p dbcore --test schema_select_db -- --nocapture

mod common;

use common::*;
use dbcore::*;
use serde_json::Value;

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[tokio::test]
async fn sqlite_lists_main_first_and_has_nothing_to_switch() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = lite_cfg(&dir.path().join("a.db"));
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();

    let list = mgr.list_schemas("lite").await.unwrap();
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0].name, "main");
    assert!(list[0].default && !list[0].system);
    assert_eq!(list[0].has_objects, None);

    let s = mgr.open_session("lite").await.unwrap();
    let err = mgr.set_session_schema(&s, "main").await.unwrap_err();
    assert!(matches!(err, DbError::Unsupported(_)), "{err:?}");
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn an_unknown_session_is_an_error_not_a_panic() {
    let mgr = ConnectionManager::new();
    let err = mgr
        .set_session_schema(&SessionId("nope".into()), "X")
        .await
        .unwrap_err();
    assert!(matches!(err, DbError::NoSession(_)), "{err:?}");
}

#[tokio::test]
async fn postgres_switch_is_per_session_and_reaches_every_listed_schema() {
    let Some(cfg) = pg_cfg() else { return };
    let mgr = connected(&cfg).await;
    let list = mgr.list_schemas("pg").await.unwrap();
    assert!(list.iter().any(|c| c.name == "public"), "{list:?}");
    assert!(list.first().is_some_and(|c| c.default));
    assert!(list.iter().any(|c| c.name == "pg_catalog" && c.system));

    let a = mgr.open_session("pg").await.unwrap();
    let b = mgr.open_session("pg").await.unwrap();
    // a name that needs quoting: created through the same quoting rules
    assert_ok(&run(&mgr, &a, "drop schema if exists \"Sel Test\" cascade").await);
    assert_ok(&run(&mgr, &a, "create schema \"Sel Test\"").await);
    mgr.set_session_schema(&a, "Sel Test").await.unwrap();
    let cur = scalar(&run(&mgr, &a, "select current_schema()").await);
    assert_eq!(text(&cur), "Sel Test");
    // the other session is untouched
    let other = scalar(&run(&mgr, &b, "select current_schema()").await);
    assert_ne!(text(&other), "Sel Test");
    // a name that is not a schema is the server's search_path business: it is accepted, but never executed as SQL
    mgr.set_session_schema(&a, "x\"; drop schema \"Sel Test\" cascade; --")
        .await
        .unwrap();
    let still = run(
        &mgr,
        &b,
        "select count(*) from information_schema.schemata where schema_name = 'Sel Test'",
    )
    .await;
    assert_eq!(text(&scalar(&still)), "1");
    assert_ok(&run(&mgr, &b, "drop schema \"Sel Test\" cascade").await);
    mgr.close_session(&a).await;
    mgr.close_session(&b).await;
}

#[tokio::test]
async fn mysql_switch_uses_the_database() {
    let Some(cfg) = mysql_cfg() else { return };
    let mgr = connected(&cfg).await;
    let list = mgr.list_schemas("my").await.unwrap();
    assert!(list.iter().any(|c| c.system), "{list:?}");
    let s = mgr.open_session("my").await.unwrap();
    let target = list
        .iter()
        .find(|c| !c.system)
        .expect("a user database")
        .name
        .clone();
    mgr.set_session_schema(&s, &target).await.unwrap();
    let cur = scalar(&run(&mgr, &s, "select database()").await);
    assert_eq!(text(&cur), target);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn oracle_lists_all_users_and_switches_the_current_schema() {
    let Some(cfg) = oracle_cfg() else { return };
    let mgr = connected(&cfg).await;
    let list = mgr.list_schemas("ora").await.unwrap();
    // ALL_USERS, not only owners of objects: the login user comes first, and SYS is there flagged as system
    assert!(list.first().is_some_and(|c| c.default), "{list:?}");
    assert!(list.iter().any(|c| c.name == "SYS" && c.system), "{list:?}");
    assert!(list.iter().all(|c| c.has_objects.is_some()));
    assert!(list.iter().any(|c| c.has_objects == Some(true)));

    let s = mgr.open_session("ora").await.unwrap();
    let target = list
        .iter()
        .find(|c| !c.default && c.name == "SYSTEM")
        .or_else(|| list.iter().find(|c| !c.default))
        .expect("a second user")
        .name
        .clone();
    mgr.set_session_schema(&s, &target).await.unwrap();
    let cur = scalar(
        &run(
            &mgr,
            &s,
            "select sys_context('USERENV', 'CURRENT_SCHEMA') from dual",
        )
        .await,
    );
    assert_eq!(text(&cur), target);
    // a name that is no user is the server's error, with nothing else run
    let err = mgr
        .set_session_schema(&s, "NO\"; DROP USER X; --")
        .await
        .unwrap_err();
    // ORA-01435 "user does not exist"; Oracle 23.26 and later refuse the quote in the identifier first (ORA-25716)
    let msg = err.to_string();
    assert!(
        msg.contains("ORA-01435") || msg.contains("ORA-25716"),
        "{err}"
    );
    mgr.close_session(&s).await;
}
