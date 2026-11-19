//! A small keyword classifier for `run_query`.
//!
//! This is a pre-filter, not the guard: it turns an obvious mistake into a clear message that points the agent
//! to `execute_statement`, and refuses a few well-known statements and functions with side effects. The
//! protection is the connection (read-only session; on PostgreSQL every query also runs in its own
//! `BEGIN READ ONLY` transaction, see `db.rs`). Neither stops everything: a function with side effects
//! (an Oracle autonomous transaction, a PL/pgSQL function that writes through `dblink`) can still write, so the hard
//! guarantee is a database user that only has SELECT rights. The classifier is deliberately simple: it looks at
//! the words of the statement outside comments, quotes and dollar-quoted bodies.

use dbcore::Driver;

/// One word of a statement, with the parenthesis depth it sits at.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    /// Upper-case.
    word: String,
    depth: usize,
}

/// Words outside comments and quoted text. Quoted text, quoted identifiers and comments are skipped, `(` `)` only
/// move the depth. Punctuation that matters to the classifier (`=`) is kept as a word.
fn tokens(sql: &str) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    let n = chars.len();
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$' || c == '#';
    while i < n {
        let c = chars[i];
        match c {
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < n && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            '\'' | '"' | '`' => i = skip_quoted(&chars, i, c),
            '(' => {
                depth += 1;
                i += 1;
            }
            ')' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            '=' => {
                out.push(Token {
                    word: "=".into(),
                    depth,
                });
                i += 1;
            }
            '$' => {
                // PostgreSQL dollar quoting: $tag$ ... $tag$ ($1 is a parameter, not a quote)
                let mut j = i + 1;
                while j < n && (chars[j].is_alphanumeric() || chars[j] == '_') {
                    j += 1;
                }
                if j < n && chars[j] == '$' {
                    let tag: String = chars[i..=j].iter().collect();
                    let tag_chars: Vec<char> = tag.chars().collect();
                    let mut k = j + 1;
                    while k < n && chars[k..].len() >= tag_chars.len() {
                        if chars[k..k + tag_chars.len()] == tag_chars[..] {
                            break;
                        }
                        k += 1;
                    }
                    i = (k + tag_chars.len()).min(n);
                } else {
                    i += 1;
                }
            }
            c if is_word(c) => {
                let start = i;
                while i < n && is_word(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                // Oracle alternative quoting: q'[ ... ]' (also nq'...')
                if matches!(word.to_ascii_uppercase().as_str(), "Q" | "NQ")
                    && chars.get(i) == Some(&'\'')
                    && i + 1 < n
                {
                    let close = match chars[i + 1] {
                        '[' => ']',
                        '{' => '}',
                        '(' => ')',
                        '<' => '>',
                        other => other,
                    };
                    let mut k = i + 2;
                    while k + 1 < n && !(chars[k] == close && chars[k + 1] == '\'') {
                        k += 1;
                    }
                    i = (k + 2).min(n);
                    continue;
                }
                out.push(Token {
                    word: word.to_ascii_uppercase(),
                    depth,
                });
            }
            _ => i += 1,
        }
    }
    out
}

/// Index after the closing `quote` of the quoted text that starts at `start` (a doubled quote stays inside).
fn skip_quoted(chars: &[char], start: usize, quote: char) -> usize {
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == quote {
            if chars.get(i + 1) == Some(&quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    chars.len()
}

/// Words that start a statement; `EXPLAIN` options end where one of these begins the explained statement.
const STATEMENT_STARTS: &[&str] = &[
    "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "VALUES", "TABLE", "CREATE", "ALTER",
    "DROP", "FOR",
];

const DATA_CHANGE: &[&str] = &["INSERT", "UPDATE", "DELETE", "MERGE"];

/// Functions and packages `run_query` refuses by name: they cancel or kill sessions, change settings, read or
/// write server files, call out to other servers or schedule work. (A quoted or dynamically built name is not
/// caught here: see the module comment.)
const SIDE_EFFECT_WORDS: &[&str] = &[
    // PostgreSQL
    "SET_CONFIG",
    "PG_TERMINATE_BACKEND",
    "PG_CANCEL_BACKEND",
    "PG_RELOAD_CONF",
    "PG_ROTATE_LOGFILE",
    "PG_FILE_WRITE",
    "PG_FILE_RENAME",
    "PG_FILE_UNLINK",
    "PG_READ_FILE",
    "PG_READ_BINARY_FILE",
    "PG_LS_DIR",
    "PG_SWITCH_WAL",
    "PG_CREATE_RESTORE_POINT",
    "PG_LOGICAL_EMIT_MESSAGE",
    "PG_PROMOTE",
    "LO_IMPORT",
    "LO_EXPORT",
    "LO_CREATE",
    "LO_UNLINK",
    "LO_PUT",
    "NEXTVAL",
    "SETVAL",
    // MySQL
    "LOAD_FILE",
    "GET_LOCK",
    // Oracle
    "DBMS_SCHEDULER",
    "DBMS_JOB",
    "DBMS_LOCK",
    "DBMS_PIPE",
    "DBMS_AQ",
    "DBMS_SQL",
    "DBMS_ADVISOR",
    "DBMS_XMLSTORE",
    "DBMS_RLS",
    "UTL_HTTP",
    "UTL_FILE",
    "UTL_TCP",
    "UTL_SMTP",
    "UTL_MAIL",
    "UTL_INADDR",
    "UTL_URL",
];

/// `dblink`, `dblink_exec`, `dblink_connect`, ... (the PostgreSQL extension)
const SIDE_EFFECT_PREFIXES: &[&str] = &["DBLINK"];

fn check_side_effects(toks: &[Token], driver: Driver) -> Result<(), String> {
    for (i, t) in toks.iter().enumerate() {
        let w = t.word.as_str();
        // Oracle: a sequence's NEXTVAL is a pseudo-column, not a function that is refused here
        let oracle_nextval = driver == Driver::Oracle && w == "NEXTVAL";
        let named = (SIDE_EFFECT_WORDS.contains(&w) && !oracle_nextval)
            || SIDE_EFFECT_PREFIXES.iter().any(|p| w.starts_with(p));
        if named {
            return Err(format!(
                "run_query refuses `{}`: it can change the server, its files or other databases. \
                 Use execute_statement if the user has allowed writes for this data source.",
                w.to_lowercase()
            ));
        }
        if w == "INTO" {
            let next = toks.get(i + 1).map(|n| n.word.as_str());
            let why = match next {
                Some("OUTFILE") | Some("DUMPFILE") => "writes a file on the database server",
                _ => "creates a table or assigns variables",
            };
            return Err(format!(
                "run_query refuses SELECT ... INTO: it {why}. Use execute_statement for statements that write."
            ));
        }
    }
    Ok(())
}

fn not_a_read(first: &str) -> String {
    format!(
        "run_query only runs read statements (SELECT, WITH, VALUES, TABLE, SHOW, DESCRIBE, EXPLAIN, PRAGMA); \
         this statement starts with {first}. To change data or the schema use execute_statement \
         (it needs write permission for the data source)."
    )
}

/// `Ok` when `sql` (one statement) looks like a read statement; `Err` with a message for the agent otherwise.
pub fn check_read_statement(sql: &str, driver: Driver) -> Result<(), String> {
    let toks = tokens(sql);
    let Some(first) = toks.first().map(|t| t.word.as_str()) else {
        return Err("The statement is empty. Pass one SQL statement in `sql`.".into());
    };
    let verdict = match first {
        "SELECT" | "VALUES" | "TABLE" | "SHOW" | "DESCRIBE" | "DESC" => Ok(()),
        "WITH" => {
            // a data-modifying CTE (`WITH x AS (DELETE ... RETURNING *) SELECT ...`) sits inside parentheses
            for (i, t) in toks.iter().enumerate() {
                if !DATA_CHANGE.contains(&t.word.as_str()) {
                    continue;
                }
                // `SELECT ... FOR UPDATE` / `FOR NO KEY UPDATE` is a lock, the server decides about it
                let lock = t.word == "UPDATE"
                    && i > 0
                    && matches!(toks[i - 1].word.as_str(), "FOR" | "KEY");
                if !lock {
                    return Err(format!(
                        "run_query refuses a WITH statement that contains {}. To change data use \
                         execute_statement (it needs write permission for the data source).",
                        t.word
                    ));
                }
            }
            Ok(())
        }
        // Oracle's EXPLAIN PLAN INSERTs the plan into PLAN_TABLE, a write the read-only gate may not catch
        "EXPLAIN" if driver == Driver::Oracle => Err(
            "run_query refuses EXPLAIN PLAN on Oracle: it writes the plan into PLAN_TABLE. \
             Query V$SQL_PLAN or use execute_statement if the user allowed writes."
                .into(),
        ),
        "EXPLAIN" => {
            let analyzes = toks
                .iter()
                .skip(1)
                .take_while(|t| !STATEMENT_STARTS.contains(&t.word.as_str()))
                .any(|t| t.word == "ANALYZE" || t.word == "ANALYSE");
            if analyzes {
                Err("EXPLAIN ANALYZE runs the statement, so run_query refuses it. Use a plain EXPLAIN, \
                     or execute_statement if you really want to run it."
                    .into())
            } else {
                Ok(())
            }
        }
        "PRAGMA" => {
            if toks.iter().any(|t| t.word == "=") {
                Err(
                    "run_query only runs PRAGMA statements that read a value; a PRAGMA with `=` \
                     changes a setting. Use execute_statement for that."
                        .into(),
                )
            } else {
                Ok(())
            }
        }
        other => Err(not_a_read(other)),
    };
    verdict.and_then(|()| check_side_effects(&toks, driver))
}

/// `Ok` unless `sql` (one statement) controls a transaction. `execute_statement` commits every statement itself;
/// a `BEGIN` or `SET autocommit` would leave the shared connection in a transaction nobody finishes.
/// (On Oracle `BEGIN` starts a PL/SQL block and is allowed.)
pub fn check_not_transaction_control(sql: &str, driver: Driver) -> Result<(), String> {
    let toks = tokens(sql);
    let Some(first) = toks.first().map(|t| t.word.as_str()) else {
        return Ok(());
    };
    let words = || toks.iter().skip(1).map(|t| t.word.as_str());
    let control = match first {
        "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "ABORT" | "START" => true,
        "BEGIN" | "END" => driver != Driver::Oracle,
        "PREPARE" => words().next() == Some("TRANSACTION"),
        "SET" => words().any(|w| matches!(w, "TRANSACTION" | "AUTOCOMMIT" | "CHARACTERISTICS")),
        _ => false,
    };
    if control {
        Err(format!(
            "execute_statement cannot run transaction-control statements ({first} ...): every statement is \
             committed on its own when it succeeds. Send the data-changing statement by itself."
        ))
    } else {
        Ok(())
    }
}

/// The first word of the statement (upper-case), for messages and the log.
pub fn first_word(sql: &str) -> Option<String> {
    tokens(sql).into_iter().next().map(|t| t.word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(sql: &str) {
        assert_eq!(check_read_statement(sql, Driver::Postgres), Ok(()), "{sql}");
    }

    fn refused(sql: &str) -> String {
        check_read_statement(sql, Driver::Postgres).expect_err(sql)
    }

    #[test]
    fn plain_reads_pass() {
        for sql in [
            "select 1",
            "SELECT * FROM orders WHERE id = 5",
            "  \n\tselect\n1",
            "(select 1) union (select 2)",
            "((SELECT 1))",
            "values (1), (2)",
            "table orders",
            "show tables",
            "SHOW search_path",
            "describe orders",
            "DESC orders",
            "select * from dual",
            "select 1;",
        ] {
            ok(sql);
        }
    }

    #[test]
    fn comments_and_whitespace_are_ignored() {
        ok("-- hello\nselect 1");
        ok("/* a */ /* b */ select 1");
        ok("/* DELETE */ -- UPDATE\n  select 1");
        ok("/*+ hint */ select /*+ INDEX(t i) */ * from t");
        assert!(refused("-- select\ndelete from t").contains("DELETE"));
        assert!(refused("/* select */ drop table t").contains("DROP"));
    }

    #[test]
    fn words_inside_quotes_do_not_count() {
        ok("select 'delete from t' as x");
        ok("select \"update\" from t");
        ok("select `insert` from t");
        ok("with t as (select 'it''s insert' as x) select * from t");
        ok("select $$ delete from t $$");
        ok("select $q$ it's delete $q$");
        ok("select q'[it's an update]' from dual");
        ok("with a as (select 1 from dual where 'x' = q'{ delete }') select * from a");
        ok("select $1 from t");
    }

    #[test]
    fn writes_are_refused_with_a_pointer_to_execute_statement() {
        for (sql, word) in [
            ("insert into t values (1)", "INSERT"),
            ("UPDATE t set a = 1", "UPDATE"),
            ("delete from t", "DELETE"),
            (
                "merge into t using s on (t.a = s.a) when matched then delete",
                "MERGE",
            ),
            ("create table t (a int)", "CREATE"),
            ("drop table t", "DROP"),
            ("alter table t add b int", "ALTER"),
            ("truncate table t", "TRUNCATE"),
            ("grant select on t to u", "GRANT"),
            ("begin delete from t; end;", "BEGIN"),
            ("call do_it()", "CALL"),
            ("vacuum", "VACUUM"),
            ("set role admin", "SET"),
            ("copy t from '/x'", "COPY"),
            ("lock table t", "LOCK"),
            ("(delete from t)", "DELETE"),
        ] {
            let msg = refused(sql);
            assert!(msg.contains(word), "{sql}: {msg}");
            assert!(msg.contains("execute_statement"), "{sql}: {msg}");
        }
    }

    #[test]
    fn empty_statement_is_refused() {
        assert!(refused("").contains("empty"));
        assert!(refused("  -- nothing\n /* x */ ").contains("empty"));
        assert!(refused(";").contains("empty"));
    }

    #[test]
    fn with_accepts_selects_and_refuses_data_modifying_ctes() {
        ok("with t as (select 1) select * from t");
        ok("WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r");
        ok("with t as (select 1 as a) select a from t for update");
        ok("with t as (select 1 as a) select a from t for no key update");
        for sql in [
            "with d as (delete from t returning *) select * from d",
            "with u as (update t set a = 1 returning *) select * from u",
            "WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM i",
            "with m as (merge into t using s on true when matched then delete returning *) select * from m",
            "with t as (select 1) insert into x select * from t",
            "with t as (select 1) delete from x",
        ] {
            let msg = refused(sql);
            assert!(msg.contains("WITH") && msg.contains("execute_statement"), "{sql}: {msg}");
        }
    }

    #[test]
    fn explain_without_analyze_passes() {
        ok("explain select 1");
        ok("EXPLAIN (FORMAT JSON) SELECT * FROM t");
        ok("explain verbose select 1");
        ok("explain query plan select 1");
        ok("explain delete from t");
        ok("explain select 'analyze' from t");
        ok("explain select analyze from t");
        for sql in [
            "explain analyze select 1",
            "EXPLAIN ANALYSE SELECT 1",
            "explain (analyze, buffers) select 1",
            "explain (format json, analyze true) delete from t",
            "explain analyze verbose select 1",
        ] {
            let msg = refused(sql);
            assert!(msg.contains("EXPLAIN ANALYZE"), "{sql}: {msg}");
        }
    }

    #[test]
    fn pragma_must_not_assign() {
        ok("pragma table_info(orders)");
        ok("PRAGMA foreign_keys");
        ok("pragma index_list('t')");
        ok("pragma table_info('a=b')");
        for sql in [
            "pragma foreign_keys = on",
            "PRAGMA journal_mode=wal",
            "pragma main.user_version = 3",
        ] {
            assert!(refused(sql).contains("PRAGMA"), "{sql}");
        }
    }

    #[test]
    fn side_effect_functions_are_refused() {
        for sql in [
            "select set_config('default_transaction_read_only', 'off', false)",
            "SELECT pg_catalog.set_config('a','b',true)",
            "select pg_terminate_backend(123)",
            "select pg_cancel_backend(pid) from pg_stat_activity",
            "select lo_import('/etc/passwd')",
            "select lo_export(1, '/tmp/x')",
            "select pg_reload_conf()",
            "select pg_rotate_logfile()",
            "select * from dblink('host=x', 'select 1') as t(a int)",
            "select dblink_exec('host=x', 'drop table t')",
            "select pg_file_write('/tmp/x', 'y', false)",
            "select pg_read_file('/etc/passwd')",
            "with t as (select pg_terminate_backend(1)) select * from t",
            "select nextval('s')",
            "select setval('s', 1)",
            "select load_file('/etc/passwd')",
            "select utl_http.request('http://x') from dual",
            "select dbms_scheduler.create_job('x') from dual",
        ] {
            let msg = refused(sql);
            assert!(
                msg.contains("refuses") && msg.contains("execute_statement"),
                "{sql}: {msg}"
            );
        }
        // names inside strings or comments are not function calls
        ok("select 'set_config' as x");
        ok("select 1 -- pg_terminate_backend(1)");
        ok("select /* dblink */ 1");
        // a column that merely contains the word is fine
        ok("select my_set_config from t");
        // Oracle sequences are pseudo-columns
        assert_eq!(
            check_read_statement("select s.nextval from dual", Driver::Oracle),
            Ok(())
        );
    }

    #[test]
    fn select_into_is_refused() {
        let m = refused("select * into stolen from orders");
        assert!(m.contains("INTO"), "{m}");
        let m = check_read_statement("select * from t into outfile '/tmp/x'", Driver::MySql)
            .unwrap_err();
        assert!(m.contains("file"), "{m}");
        let m = check_read_statement("SELECT * FROM t INTO DUMPFILE '/tmp/x'", Driver::MySql)
            .unwrap_err();
        assert!(m.contains("file"), "{m}");
        assert!(check_read_statement("select a from t into @v", Driver::MySql).is_err());
        ok("select 'into outfile' from t");
    }

    #[test]
    fn oracle_explain_plan_is_refused() {
        for sql in [
            "explain plan for select 1 from dual",
            "EXPLAIN PLAN SET STATEMENT_ID = 'x' FOR select 1 from dual",
        ] {
            let m = check_read_statement(sql, Driver::Oracle).unwrap_err();
            assert!(m.contains("PLAN_TABLE"), "{m}");
        }
        for d in [Driver::Postgres, Driver::MySql, Driver::Sqlite] {
            assert_eq!(check_read_statement("explain select 1", d), Ok(()));
        }
    }

    #[test]
    fn transaction_control_is_refused_for_writes() {
        for sql in [
            "begin",
            "BEGIN TRANSACTION",
            "begin work",
            "start transaction",
            "commit",
            "COMMIT AND CHAIN",
            "rollback",
            "rollback to savepoint a",
            "savepoint a",
            "release savepoint a",
            "end",
            "abort",
            "set transaction read only",
            "set session transaction isolation level serializable",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            "set autocommit = 0",
            "set @@autocommit = 0",
            "prepare transaction 'x'",
        ] {
            let m = check_not_transaction_control(sql, Driver::Postgres).unwrap_err();
            assert!(m.contains("transaction-control"), "{sql}: {m}");
        }
        for sql in [
            "insert into t values (1)",
            "update t set a = 1",
            "set search_path = x",
            "set role admin",
            "create table t (a int)",
            "do $$ begin perform 1; end $$",
            "select 'commit'",
            "-- commit\ndelete from t",
            "",
        ] {
            assert_eq!(
                check_not_transaction_control(sql, Driver::Postgres),
                Ok(()),
                "{sql}"
            );
        }
        // Oracle: BEGIN is a PL/SQL block, COMMIT and friends are not allowed
        assert_eq!(
            check_not_transaction_control("begin do_it; end;", Driver::Oracle),
            Ok(())
        );
        assert!(check_not_transaction_control("commit", Driver::Oracle).is_err());
        assert!(check_not_transaction_control("rollback", Driver::Oracle).is_err());
        assert!(check_not_transaction_control("savepoint a", Driver::Oracle).is_err());
        assert!(
            check_not_transaction_control("set transaction read only", Driver::Oracle).is_err()
        );
    }

    #[test]
    fn first_word_is_upper_case() {
        assert_eq!(first_word("  /* x */ select 1").as_deref(), Some("SELECT"));
        assert_eq!(first_word(" ").as_deref(), None);
    }

    #[test]
    fn unterminated_quotes_and_comments_do_not_panic() {
        let _ = check_read_statement("select 'abc", Driver::Postgres);
        let _ = check_read_statement("select /* abc", Driver::Postgres);
        let _ = check_read_statement("select $a$ abc", Driver::Postgres);
        let _ = check_read_statement("select q'[abc", Driver::Postgres);
        let _ = check_read_statement("select q'", Driver::Postgres);
        let _ = check_read_statement("select 1 -- x", Driver::Postgres);
        let _ = check_read_statement("é ü 日本語 select", Driver::Postgres);
    }
}
