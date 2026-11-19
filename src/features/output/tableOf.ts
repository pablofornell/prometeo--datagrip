/** The table a result tab reads: the editable target, else the one table of a plain select (null for joins, aggregates...). */
import type { ObjectRef } from "../../api/types";
import { lex } from "../../components/editor/lexer";
import { plainSelect, selectItems, tableOf } from "../console/editable";
import type { RowSqlKind } from "../table/sql";
import { resultTable } from "../console/title";
import type { OutputHost, ResultTab } from "./model";

export function resultTableRef(tab: ResultTab, host: OutputHost | undefined): ObjectRef | null {
  if (!host) return null;
  const e = tab.edit();
  if (e) return e.table;
  const parts = resultTable(tab.meta, tab.sql, host.driver);
  if (!parts) return null;
  const schema = parts.length > 1 ? parts[0] : host.driver === "sqlite" ? "main" : (host.schema?.() ?? null);
  return { schema, name: parts[parts.length - 1], kind: "table" };
}

/** What `Generate SQL` may write for a result: the table and the statements that are safe for its rows. */
export interface SqlTarget {
  table: ObjectRef;
  kinds: RowSqlKind[];
}

const lower = (x: string) => x.toLowerCase();

/** Whether each part of the table after the first top-level FROM is written quoted (Oracle upper-cases only the unquoted ones). */
function fromQuoted(sql: string, dialect: OutputHost["driver"]): boolean[] {
  const toks = lex(sql, dialect)
    .filter((t) => t.kind !== "comment")
    .map((t) => ({ kind: t.kind, text: sql.slice(t.from, t.to) }));
  let depth = 0;
  let i = toks.findIndex((t) => {
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    return depth === 0 && t.kind === "word" && lower(t.text) === "from";
  });
  const out: boolean[] = [];
  for (i++; i > 0 && i < toks.length && (toks[i].kind === "word" || toks[i].kind === "qident"); i += 2) {
    out.push(toks[i].kind === "qident");
    if (toks[i + 1]?.text !== ".") break;
  }
  return out;
}

/**
 * Whether the result columns `names` are plain, unrenamed columns of the one table of `sql`: every select item is `*`
 * (at most one) or `col` / `t.col` / `col as col`, and the names line up with the list. Aliases (`customer_id as id`)
 * and expressions (`id + 1 as id`) make the names mean something else than the table's columns.
 */
function plainColumns(sql: string, dialect: OutputHost["driver"], names: string[]): boolean {
  const items = selectItems(sql, dialect);
  if (!items || items.length === 0) return false;
  if (new Set(names.map(lower)).size !== names.length) return false; // a.id, b.id cannot be told apart
  const star = items.findIndex((i) => i.star);
  if (items.some((i, k) => i.star && k !== star)) return false;
  const matches = (it: (typeof items)[number], name: string) => {
    if (it.star || it.column === null) return false;
    return it.alias !== null ? it.alias === it.column && it.alias === name : lower(it.column) === lower(name);
  };
  if (star < 0) return items.length === names.length && items.every((it, k) => matches(it, names[k]));
  const before = items.slice(0, star);
  const after = items.slice(star + 1);
  if (names.length < before.length + after.length + 1) return false;
  return before.every((it, k) => matches(it, names[k])) && after.every((it, k) => matches(it, names[names.length - after.length + k]));
}

/**
 * What `Generate SQL` writes for a result tab, or null when its rows are not one known table's (the menu entries are
 * disabled). An editable result (`tab.edit()`: the table, key and columns are resolved against the metadata) gets all four
 * statements. Otherwise only a plain single-table select qualifies (no join, comma list, subquery, aggregate, alias or
 * expression; PostgreSQL must report a table for every column; the column names are unique) and only for SELECT and
 * INSERT: the key of the table is not known, so a statement that changes rows by value could hit other rows.
 */
export function sqlTableRef(tab: ResultTab, host: OutputHost | undefined): SqlTarget | null {
  if (!host) return null;
  const e = tab.edit();
  if (e) return { table: e.table, kinds: ["select", "insert", "update", "delete"] };
  const driver = host.driver;
  if (tab.meta.length === 0 || !plainSelect(tab.sql, driver)) return null;
  if (driver === "postgres" && tab.meta.some((c) => !c.tableRef)) return null;
  const parts = tableOf(tab.meta, tab.sql, driver);
  if (!parts) return null;
  if (!plainColumns(tab.sql, driver, tab.meta.map((c) => c.name))) return null;
  const name = parts[parts.length - 1];
  let schema = parts.length > 1 ? parts[parts.length - 2] : driver === "sqlite" ? "main" : (host.schema?.() ?? null);
  let tname = name;
  if (driver === "oracle") {
    // an unquoted name is folded to upper case by the server, a quoted one keeps its case (only when the table is read from the text)
    const q = fromQuoted(tab.sql, driver);
    if (parts.length > 1 && !q[q.length - 2]) schema = schema?.toUpperCase() ?? null;
    if (!q[q.length - 1]) tname = name.toUpperCase();
  }
  return { table: { schema, name: tname, kind: "table" }, kinds: ["select", "insert"] };
}
