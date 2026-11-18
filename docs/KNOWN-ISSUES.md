# Known issues and limits

This list holds what is not fixed or not built yet, and what is not verified. Each item says what happens and,
where it helps, what to do instead. Update the list when an item is fixed.

## Not verified yet

- **Full Rust test pass of the last fix round.** Each change was tested on its own against live Oracle 23 Free,
  PostgreSQL 16 and MySQL 8.4, and clippy, `cargo fmt --check`, `tsc` and vitest pass. The complete
  `cargo test --workspace` run with the three databases was stopped because the build machine ran out of
  memory. Run `make test-all` (or `cargo test --workspace -- --test-threads=1` with the database URLs set) on a
  machine with about 6 GB free.
- **Manual UI pass.** These screens are covered by unit tests only and nobody has clicked through them yet:
  multi-select in the Database Explorer (mouse and keyboard), Find Usages popup, Compare Schemas tab, value
  viewer tabs (JSON, Image, Hex), Dump to SQL File dialog, Run SQL Script progress, diagram of selected tables,
  data source color settings.
- **Windows installer.** It is not built on the development machine (no MSVC linker there). The CI job on
  `windows-latest` builds it, and only for a version tag.

## Oracle 10g / 11g / 12.1

- **Tested live** on Oracle Database 10g XE 10.2.0.1 and 11g XE 11.2.0.2 (`tests/oracle_legacy.rs`,
  `make db-up-oracle-legacy`): logon, console (many rows, long values, CLOBs, `DBMS_OUTPUT`, errors with their
  position, transaction state, Stop), Database Explorer (tables, columns with defaults, keys, foreign keys, indexes,
  checks, triggers, routines, package members), table data paging, grid edits with CLOB / BLOB values, the value
  viewer, DDL, Find Usages, Explain Plan, the Compare Schemas model, and a SQL dump that is restored on the same
  server. 12.1 to 21c were not tested: the SQL for them is the one of 23 Free where
  the server has the feature, and the dictionary columns are asked of the server instead of guessed from the
  release.
- The driver speaks the older protocol of these servers (see `vendor/oracledb/PATCHES.md`). A server that needs
  native network encryption or data integrity is refused with a "not implemented" error.
- What changes before 12.1: table data is paged with `ROWNUM`; DDL sets the `DBMS_METADATA` transforms in a PL/SQL
  block on the same connection before `GET_DDL` (no `WITH FUNCTION`); Find Usages reads the `LONG` view text; check
  conditions and defaults come from the `LONG` columns. Before 11.2 lists of columns and arguments are built with
  `XMLAGG` instead of `LISTAGG`.
- The schema list, the Database Explorer schema level and Find Usages tell system users apart by a list of Oracle's
  own account names, because `ALL_USERS.ORACLE_MAINTAINED` only exists from 12.2. A custom account that has the name
  of an Oracle-shipped one (`WMSYS`, `XDB`, ...) or starts with `APEX_` / `FLOWS_` shows as a system user there.
- 10g: package members are sorted by name, not in the order of declaration (`ALL_PROCEDURES` has no
  `SUBPROGRAM_ID` / `OVERLOAD` there).
- A `DBMS_OUTPUT` line longer than 32511 bytes is cut to 32511 bytes (a PL/SQL bind holds 32512 bytes before 12.1;
  12.1+ cuts at 32766 bytes). The other lines are shown in full.
- **Server bug, 10.2.0.1 and 11.2.0.2:** a text over 4000 bytes that has characters outside the Basic Multilingual
  Plane (emoji, U+10000 and up) together with other non-ASCII characters is converted wrongly when it is written to a
  CLOB / NCLOB (grid edit, import): 10.2 refuses it with ORA-00600 [kpolcsc1], 11.2 stores a U+FFFD in place of one
  character. Shorter texts, and texts without such characters, are written correctly. The `cell_db` Oracle test
  fails on these servers for that reason.
- Not available on these releases, so not offered: identity columns, `DEFAULT ON NULL`, invisible columns (12.1+),
  virtual columns and interval partitioning (11.1+; Express Edition has no partitioning at all).

## Oracle `LONG` columns

- A SQL dump writes a `LONG` value over 4000 bytes through a PL/SQL `LONG` variable (tested with 6000 bytes on 10g
  and 11g). Such a variable holds at most 32760 bytes, so a longer value fails on restore. `LONG RAW` values over
  2000 bytes were not tested.

## SQL dump and restore

- **Oracle objects that are not dumped:** object tables (`CREATE TABLE .. OF type`), materialized view logs,
  data of collection columns and of object columns with non-scalar attributes (skipped with a warning).
- **Oracle partitioning that is created without partitions:** reference partitioning and composite partitioning
  over HASH. The table is created unpartitioned and the dump has a warning. A GLOBAL partitioned index is created
  as a plain index.
- **Oracle materialized views with FAST refresh** come back as FORCE, because the logs are not dumped. A
  prebuilt-table materialized view keeps its container as a normal table.
- **Oracle object types used by a table in another schema:** a full restore with "drop if exists" stops with
  ORA-02303 instead of forcing the drop (`FORCE` would make that table's columns unusable).
- **Oracle constraints on hidden columns** are skipped whole with a warning. An FK on such a column can still be
  written partially. An FK that references a skipped key fails on restore (ORA-02270).
- **PostgreSQL foreign tables** are skipped with a warning.
- **One file only:** the "file per table" output is not built.
- **Run SQL Script, single transaction (the default):** Oracle and MySQL commit DDL themselves, so a rollback
  cannot undo `CREATE` / `ALTER` / `DROP`. DDL detection uses the first keyword, so DDL inside a PL/SQL block is
  not detected. One statement longer than 64 MB is refused.

## Compare Schemas

- Routine bodies are not migrated: the script gets a note to change them by hand.
- Column order is not migrated (new columns are added at the end).
- A system-named index (Oracle `SYS_…`) is not created; the script gets a note.
- Not read: SQLite CHECK constraints, MySQL / MariaDB sequences, PostgreSQL collations. MariaDB default values
  are not verified (only MySQL 8.4 was available).
- The live apply test covers type, size, nullability, default, dropped column, new tables with FKs, PK change
  with FKs, unnamed keys, unique, check, index and view changes. Disabled constraints and an added NOT NULL
  column without default are covered by unit tests only.

## Find Usages

- SQLite: a primary or unique key target finds nothing.
- Column targets use a word match, so a common column name (for example `ID`) gives false hits.
- PostgreSQL and MySQL routine line numbers count from the start of the body, not of the `CREATE` statement.
- Oracle: units owned by Oracle-maintained users can still appear in the list (only the text search excludes
  them).

## Value viewer

- The JSON tab is read-only; edit JSON in the Text tab.
- The full value is read on a separate connection: changes not yet committed in a manual-transaction console
  are not visible.
- Oracle `LONG` and `LONG RAW` columns are read whole before the 32 MB cap applies.
- An Oracle CLOB with emoji near the piece limits is read piece by piece: about 5 s per MB.
- For an Oracle CLOB / NCLOB that was cut, the size is shown in characters (UTF-16 units), not bytes.
- A 32 MB value crosses the UI bridge as about 43 MB of base64.

## Excel export

- Timestamps with a time zone and dates before 1900-03-01 are written as text.
- Transpose is not available for Excel.
- Peak memory for one million rows is not measured.

## SQL editor

- JOIN ... ON completion from foreign keys does not use derived tables or CTEs as the other side (their columns
  are not known); it uses the nearest earlier base table that has a foreign key with the new table.

## Database Explorer

- After a refresh, children that were selected are not selected again when they come back; only the lead
  node is saved between sessions.
- A multi-table drop orders by the cached schema snapshot: refresh first when tables changed outside the app.
  On SQLite a drop of tables in an FK cycle can fail while foreign keys are on.

## Export

- A cancel that arrives after the last row is written still reports success (the file is complete).

## Security

- On Windows the fallback password file gets a protected ACL with a single entry for the user of the process token (Win32 security API, see `docs/SECURITY.md`). SYSTEM and administrators lose access too, so backup software that runs as SYSTEM skips the file. Not tested with a domain account.
  See [SECURITY.md](SECURITY.md).
- The release build aborts on a panic (`panic = "abort"`): the panic and its backtrace are written to
  `<data dir>/logs/panic.log`, which is not rotated.
- Only one copy of the app runs per user, also when `PROMETEO_DATA_DIR` / `PROMETEO_CONFIG_DIR` point a second copy
  at another profile (the single-instance lock does not look at them).
- Copy / preview of a result as text (`export_query_to_string`, `export_to_string`) is refused above 64 MB; export to
  a file instead.
- The Content Security Policy is not tested against every screen in a packaged build; `freezePrototype` is not
  enabled for the same reason.
