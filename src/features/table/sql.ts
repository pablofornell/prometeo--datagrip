/**
 * Pure helpers of the table data editor: identifier quoting, the `select * from ...` behind the view,
 * ORDER BY <-> header sort, column-filter conditions, the pending-changes SQL preview and the mapping of
 * grid changes to dbcore `RowChange`s (with the hidden row locators of tables without a primary key).
 */
import { isKeyword } from "../schema-editor/keywords";
import type { Cell as ApiCell, ColumnMeta, Driver, ObjectRef, RowChange } from "../../api/types";
// direct module paths: the grid barrel pulls in the Solid components (not loadable in the node test environment)
import { classifyType, isBinaryCell, isDefaultCell, isExprCell } from "../../components/grid/format";
import { NEW_ROW, type Cell, type GridChange, type SortSpec } from "../../components/grid/types";

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;
const ORACLE_IDENT = /^[A-Z][A-Z0-9_$#]*$/;

/**
 * Written without quotes: lower case and not a keyword of the dialect (`order`, `user`, `group` need quotes); upper
 * case, and not a reserved word, in Oracle, which folds unquoted names up.
 */
const isSimple = (driver: Driver, name: string): boolean =>
  (driver === "oracle" ? ORACLE_IDENT.test(name) : SIMPLE_IDENT.test(name)) && !isKeyword(driver, name);

export function quoteIdent(driver: Driver, name: string): string {
  return driver === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

/** `schema.table`, both parts quoted when needed (`always`: quote every part). */
export function qualifiedName(driver: Driver, ref: Pick<ObjectRef, "schema" | "name">, always = false): string {
  const q = (s: string) => (always || !isSimple(driver, s) ? quoteIdent(driver, s) : s);
  return ref.schema ? `${q(ref.schema)}.${q(ref.name)}` : q(ref.name);
}

/** The query behind the table editor, as exported (`select * from <table> where ... order by ...`). */
export function selectSql(driver: Driver, ref: ObjectRef, where: string, orderBy: string, quoteAll = true): string {
  let sql = "select * from " + qualifiedName(driver, ref, quoteAll);
  if (where.trim()) sql += " where " + where.trim();
  if (orderBy.trim()) sql += " order by " + orderBy.trim();
  return sql;
}

/** `sql` limited to its first `n` rows: `limit n` (PostgreSQL, MySQL, SQLite) or `fetch first n rows only` (Oracle has no LIMIT: ORA-03047). */
export function limitedSql(driver: Driver, sql: string, n: number): string {
  const body = sql.replace(/[\s;]+$/, "");
  return driver === "oracle" ? `${body} fetch first ${n} rows only` : `${body} limit ${n}`;
}

/**
 * The query behind a table editor page as DataGrip logs it: `SELECT t.* FROM sales.clients t LIMIT 501` (one more
 * row than the page, to know whether there is a next page). `all` has no LIMIT. Oracle pages with
 * `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (the same text `table.rs` builds).
 */
export function tableQuerySql(driver: Driver, ref: ObjectRef, where: string, orderBy: string, pageSize: number | "all", page: number): string {
  let sql = `SELECT t.* FROM ${qualifiedName(driver, ref)} t`;
  if (where.trim()) sql += " WHERE " + where.trim();
  if (orderBy.trim()) sql += " ORDER BY " + orderBy.trim();
  if (pageSize !== "all" && driver === "oracle") {
    sql += ` OFFSET ${page * pageSize} ROWS FETCH NEXT ${pageSize + 1} ROWS ONLY`;
  } else if (pageSize !== "all") {
    sql += ` LIMIT ${pageSize + 1}`;
    if (page > 0) sql += ` OFFSET ${page * pageSize}`;
  }
  return sql;
}

// ---------------------------------------------------------------- ORDER BY <-> header sort

/** `"name" desc, id` for the header sort state. */
export function sortToOrderBy(driver: Driver, columns: { name: string }[], sort: SortSpec[]): string {
  return sort
    .filter((s) => columns[s.col])
    .map((s) => quoteIdent(driver, columns[s.col].name) + (s.dir === "desc" ? " desc" : ""))
    .join(", ");
}

/** Header sort state of a plain `col [asc|desc], ...` list; anything else (expressions, nulls first...) gives `[]`. */
export function orderByToSort(orderBy: string, columns: { name: string }[]): SortSpec[] {
  const text = orderBy.trim();
  if (!text) return [];
  const out: SortSpec[] = [];
  for (const part of splitTop(text)) {
    const m = /^\s*(?:(?:"[^"]*"|`[^`]*`|\w+)\s*\.\s*)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|[\w$]+)\s*(asc|desc)?\s*$/i.exec(part);
    if (!m) return [];
    let name = m[1];
    if (name[0] === '"' || name[0] === "`") name = name.slice(1, -1).replace(name[0] + name[0], name[0]);
    let col = columns.findIndex((c) => c.name === name);
    if (col < 0) col = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (col < 0) return [];
    out.push({ col, dir: m[2]?.toLowerCase() === "desc" ? "desc" : "asc" });
  }
  return out;
}

/** Splits on top-level commas (outside quotes and parentheses). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- literals and column filter

/**
 * `'...'` string literal. MySQL reads `\` inside it as an escape (`'C:\temp'` is a TAB), so it is doubled there;
 * PostgreSQL writes a string with a backslash as `E'...'` (the same text dbcore's `quote_literal` makes, right whatever
 * `standard_conforming_strings` is); SQLite and Oracle take it literally.
 */
export function quoteString(driver: Driver | undefined, v: string): string {
  const q = v.replace(/'/g, "''");
  if (driver === "mysql") return "'" + q.replace(/\\/g, "\\\\") + "'";
  if (driver === "postgres" && v.includes("\\")) return "E'" + q.replace(/\\/g, "\\\\") + "'";
  return "'" + q + "'";
}

/** SQL literal of a cell (preview and filter conditions). */
export function literal(v: Cell, typeName: string, driver?: Driver): string {
  if (v === null || v === undefined) return "null";
  if (isDefaultCell(v)) return "DEFAULT";
  if (isExprCell(v)) return v.$expr;
  const kind = classifyType(typeName);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  // Oracle (before 23ai) has no boolean: dbcore binds 1 / 0 there
  if (typeof v === "boolean") return driver === "oracle" ? (v ? "1" : "0") : v ? "true" : "false";
  if (typeof v === "string") {
    if (kind === "number" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return v.trim();
    if (kind === "bool" && /^(true|false)$/i.test(v.trim())) {
      const on = v.trim().toLowerCase() === "true";
      return driver === "oracle" ? (on ? "1" : "0") : on ? "true" : "false";
    }
    if (driver === "oracle") {
      // a quoted string meets DATE / TIMESTAMP columns through NLS_*_FORMAT: ANSI literals do not
      const t = v.trim();
      if (kind === "date" && /^\d{4}-\d\d-\d\d$/.test(t)) return `date '${t}'`;
      if ((kind === "date" || kind === "datetime") && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?(\s*[+-]\d\d:\d\d)?$/.test(t)) return `timestamp '${t.replace("T", " ")}'`;
    }
    return quoteString(driver, v);
  }
  if (isBinaryCell(v)) {
    // the hex text comes from the server, but it is only ever pasted when it is hex
    const hex = /^[0-9a-fA-F]*$/.test(v.$bin) ? v.$bin : "";
    if (driver === "oracle") return `hextoraw('${hex}')`;
    if (driver === "mysql" || driver === "sqlite") return `X'${hex}'`;
    return `'\\x${hex}'`;
  }
  // PG arrays arrive as JSON arrays: written back as an array literal ('{1,2}'), like dbcore does
  if (Array.isArray(v) && driver === "postgres") return quoteString(driver, pgArrayLiteral(v));
  return quoteString(driver, JSON.stringify(v));
}

/** One element (or nested array) of a PG array literal `{..}` (the same text as dbcore's `pg_array_element`). */
function pgArrayLiteral(v: Cell): string {
  const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `{${v.map(pgArrayLiteral).join(",")}}`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return quote(v);
  if (isBinaryCell(v)) return quote(`\\x${v.$bin}`);
  return quote(JSON.stringify(v));
}

export type FilterOp = "=" | "<>" | "<" | ">" | "<=" | ">=" | "like" | "not like" | "is null" | "is not null";

export const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "=", label: "=" },
  { value: "<>", label: "<>" },
  { value: "<", label: "<" },
  { value: ">", label: ">" },
  { value: "<=", label: "<=" },
  { value: ">=", label: ">=" },
  { value: "like", label: "like" },
  { value: "not like", label: "not like" },
  { value: "is null", label: "is null" },
  { value: "is not null", label: "is not null" },
];

/** `"col" = 5` for the column filter popup. */
export function buildCondition(driver: Driver, col: ColumnMeta, op: FilterOp, value: string): string {
  const name = quoteIdent(driver, col.name);
  if (op === "is null" || op === "is not null") return `${name} ${op}`;
  const kind = classifyType(col.typeName);
  let lit: string;
  if (op === "like" || op === "not like") lit = quoteString(driver, value);
  else if ((kind === "number" || kind === "bool") && value.trim() !== "" && literal(value, col.typeName)[0] !== "'") lit = literal(value, col.typeName);
  else lit = quoteString(driver, value);
  return `${name} ${op} ${lit}`;
}

/** Appends `cond` to an existing WHERE text with AND. */
export function appendCondition(where: string, cond: string): string {
  const w = where.trim();
  if (!w) return cond;
  return /\b(or)\b/i.test(w) ? `(${w}) and ${cond}` : `${w} and ${cond}`;
}

// ---------------------------------------------------------------- pending changes -> RowChange

const ORDER: Record<GridChange["kind"], number> = { delete: 0, update: 1, insert: 2 };

/**
 * Grid changes in the order DataGrip applies and previews them (DELETE, UPDATE, INSERT), as dbcore `RowChange`s.
 * Without a primary key (`locatorOf` given) update / delete carry the hidden locator of the row at `change.row`
 * (index in the row source) and `key` is dropped.
 * Throws if the original row of an update / delete is not known (its page was evicted).
 */
export function toRowChanges(
  changes: GridChange[],
  columns: { name: string; isPk?: boolean }[],
  locatorOf?: (row: number) => Cell | undefined,
): RowChange[] {
  const hasPk = columns.some((c) => c.isPk);
  return [...changes]
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    .map<RowChange>((c) => {
      if (c.kind === "insert") return { kind: "insert", values: c.values as Record<string, ApiCell> };
      if (Object.keys(c.key).length === 0) throw new Error("The original row is no longer loaded. Reload the page and repeat the change.");
      const out: RowChange = { kind: c.kind, key: c.key as Record<string, ApiCell> };
      if (c.kind === "update") out.values = c.values as Record<string, ApiCell>;
      if (!hasPk && locatorOf) {
        const loc = locatorOf(c.row);
        if (loc !== undefined) {
          out.rowLocator = loc as ApiCell;
          delete out.key;
        }
      }
      return out;
    });
}

// ---------------------------------------------------------------- preview

/** The statements Submit would run (one text each, formatted like DataGrip's "Preview Pending Changes" popup). */
export function changeStatements(driver: Driver, ref: ObjectRef, columns: Pick<ColumnMeta, "name" | "typeName" | "default">[], changes: GridChange[]): string[] {
  const table = qualifiedName(driver, ref);
  const id = (s: string) => (isSimple(driver, s) ? s : quoteIdent(driver, s));
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.typeName ?? "";
  // a NULL key value is `is null` (`= null` never matches); an empty string is NULL in Oracle
  const isNull = (v: Cell) => v === null || v === undefined || (driver === "oracle" && v === "");
  // the columns in the order of the table, as dbcore writes them (not in the order they were edited): a column the
  // table does not have goes last, and equal positions fall back to the name (dbcore keeps its maps in key order)
  const pos = (name: string) => {
    const i = columns.findIndex((m) => m.name === name);
    return i < 0 ? columns.length : i;
  };
  const inColumnOrder = <T,>(m: Record<string, T>): [string, T][] =>
    Object.entries(m).sort(([a], [b]) => pos(a) - pos(b) || (a < b ? -1 : a > b ? 1 : 0));
  // `col = DEFAULT` is not valid in SQLite: dbcore writes the column's default expression, or null
  const setValue = (k: string, v: Cell) => {
    if (isExprCell(v)) return `(${v.$expr.trim()})`;
    if (isDefaultCell(v) && driver === "sqlite") {
      const def = columns.find((m) => m.name === k)?.default?.trim();
      return def ? `(${def})` : "null";
    }
    return literal(v, typeOf(k), driver);
  };
  const where = (key: Record<string, Cell>) =>
    inColumnOrder(key)
      .map(([k, v]) => (isNull(v) ? `${id(k)} is null` : `${id(k)} = ${literal(v, typeOf(k), driver)}`))
      .join(" AND ");
  const out: string[] = [];
  for (const c of [...changes].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    let entries = inColumnOrder(c.values);
    if (c.kind === "delete") out.push(`DELETE\nFROM ${table}\nWHERE ${where(c.key)};`);
    else if (c.kind === "update")
      out.push(`UPDATE ${table}\nSET ${entries.map(([k, v]) => `${id(k)} = ${setValue(k, v)}`).join(",\n    ")}\nWHERE ${where(c.key)};`);
    else {
      // SQLite has no DEFAULT keyword in VALUES: dbcore leaves such a column out
      if (driver === "sqlite") entries = entries.filter(([, v]) => !isDefaultCell(v));
      if (entries.length === 0) {
        // no `default values` clause in MySQL (`() VALUES ()`) and Oracle (name one column and give it its default)
        if (driver === "mysql") out.push(`INSERT INTO ${table} ()\nVALUES ();`);
        else if (driver === "oracle" && columns.length) out.push(`INSERT INTO ${table} (${id(columns[0].name)})\nVALUES (DEFAULT);`);
        else out.push(`INSERT INTO ${table}\nDEFAULT VALUES;`);
      } else out.push(`INSERT INTO ${table} (${entries.map(([k]) => id(k)).join(", ")})\nVALUES (${entries.map(([k, v]) => setValue(k, v)).join(", ")});`);
    }
  }
  return out;
}

/** The statements Submit would run, formatted like DataGrip's "Preview Pending Changes" popup. */
export function previewSql(driver: Driver, ref: ObjectRef, columns: Pick<ColumnMeta, "name" | "typeName" | "default">[], changes: GridChange[]): string {
  return changeStatements(driver, ref, columns, changes).join("\n\n");
}

// ---------------------------------------------------------------- Generate SQL (row menu of the grid)

export type RowSqlKind = "select" | "insert" | "update" | "delete";

/** A grid column as `rowStatements` reads it: `isPk` marks the key (primary or unique), `readOnly` an expression / generated column. */
export interface RowSqlColumn {
  name: string;
  typeName: string;
  isPk?: boolean;
  readOnly?: boolean;
  default?: string | null;
}

/** A grid row for `Generate SQL`: the values as shown (pending edits applied) and the stored ones (null: not loaded / not saved). */
export interface RowSqlRow {
  /** What INSERT writes and UPDATE sets. */
  values: Cell[];
  /** What the WHERE of SELECT / UPDATE / DELETE compares against: the row as the server stores it, never a pending edit. */
  original: Cell[] | null;
  /** False when the grid has not loaded the row yet: it is skipped for every statement, INSERT included. */
  loaded?: boolean;
}

/** A binary value the grid only holds the start of: writing it would store / compare a cut-off value. */
const isTruncatedBinary = (v: Cell): boolean => isBinaryCell(v) && (v.truncated === true || (v.len !== undefined && v.len * 2 > v.$bin.length));
/** Types a `col = value` comparison is unreliable or impossible for (LOBs, JSON, floating point, arrays, XML, geometry). */
const NOT_COMPARABLE = /lob|json|float|double|\breal\b|array|\[\]|^_|xml|^long\b|geom|geog/i;
/** A value usable as a WHERE term (never `DEFAULT` / an expression, a cut-off binary, an array or an object). */
const isPlainValue = (v: Cell): boolean => !isTruncatedBinary(v) && !Array.isArray(v) && (typeof v !== "object" || v === null || isBinaryCell(v));
const NO_KEY = "-- No primary key: this statement can match more than one row";

/**
 * One `SELECT` / `INSERT` / `UPDATE` / `DELETE` per row, written like the preview of the pending changes
 * (`changeStatements`: same quoting, literals and layout). The WHERE of SELECT / UPDATE / DELETE is the key, always taken
 * from the stored row (`original`), so it names the row the user picked even when it has pending edits; UPDATE sets the
 * non-key columns to the shown values. When the key is missing (none, not in the result, a NULL / cut-off part) the
 * WHERE uses every comparable column (not LOBs, JSON, floating point, arrays, cut-off binaries) and a comment above the
 * statement says it can match more than one row; with nothing comparable the statement is replaced by a comment.
 * Read-only columns (aliases, generated) are left out; an UPDATE of a table with nothing but key columns sets them all.
 * A binary value cut off by the grid is never written (a `-- col: binary value too large, left out` comment says so).
 * Rows without an `original` (not loaded, or new and unsaved) have no statement except INSERT; `skipped` counts them.
 */
export function generateRowSql(driver: Driver, ref: ObjectRef, kind: RowSqlKind, columns: RowSqlColumn[], rows: (Cell[] | RowSqlRow)[]): { statements: string[]; skipped: number } {
  const used = columns.map((_, j) => j).filter((j) => !columns[j].readOnly || columns[j].isPk);
  const keyCols = used.filter((j) => columns[j].isPk);
  const pick = (row: Cell[], js: number[]): Record<string, Cell> => {
    const o: Record<string, Cell> = {};
    for (const j of js) o[columns[j].name] = row[j] ?? null;
    return o;
  };
  const statements: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    const { values, original, loaded } = Array.isArray(r) ? { values: r, original: r, loaded: true } : r;
    if (loaded === false || (kind !== "insert" && !original)) {
      skipped++;
      continue;
    }
    const notes: string[] = [];
    const left = new Set<string>();
    // a cut-off binary is left out of what is written (`values`) and of what is compared (`original`)
    const writable = (js: number[]) => js.filter((j) => (isTruncatedBinary(values[j]) ? (left.add(columns[j].name), false) : true));
    let text: string | null;
    if (kind === "insert") {
      const cols = writable(used);
      text = cols.length === 0 && used.length > 0 ? null : changeStatements(driver, ref, columns, [{ kind: "insert", row: NEW_ROW, key: {}, values: pick(values, cols) }])[0];
      if (text === null) notes.push("-- Nothing to insert");
    } else {
      const orig = original!;
      const keyed = keyCols.length > 0 && keyCols.every((j) => orig[j] !== null && orig[j] !== undefined && isPlainValue(orig[j]));
      const whereCols = keyed
        ? keyCols
        : used.filter((j) => !NOT_COMPARABLE.test(columns[j].typeName) && isPlainValue(orig[j]));
      if (!keyed) {
        // the truncated binaries of the stored row are reported too: they would have been compared
        for (const j of used) if (isTruncatedBinary(orig[j])) left.add(columns[j].name);
        notes.push(NO_KEY);
      }
      if (whereCols.length === 0) {
        notes.push("-- No comparable column: statement not generated");
        text = null;
      } else if (kind === "update") {
        const rest = keyed ? used.filter((j) => !keyCols.includes(j)) : used;
        const sets = writable(rest.length ? rest : used);
        // a pending change of the key is not written (the WHERE names the stored row): say so
        if (keyed && rest.length)
          for (const j of keyCols)
            if (JSON.stringify(values[j] ?? null) !== JSON.stringify(orig[j] ?? null)) notes.push(`-- ${columns[j].name}: the pending key change is not included`);
        text = sets.length === 0 ? null : changeStatements(driver, ref, columns, [{ kind: "update", row: 0, key: pick(orig, whereCols), values: pick(values, sets) }])[0];
        if (text === null) notes.push("-- Nothing to update");
      } else {
        const [del] = changeStatements(driver, ref, columns, [{ kind: "delete", row: 0, key: pick(orig, whereCols), values: {} }]);
        // a SELECT is the DELETE of the same row with another verb
        text = kind === "select" ? del.replace(/^DELETE\n/, "SELECT *\n") : del;
      }
    }
    const head = [...notes.filter((n) => n === NO_KEY), ...[...left].map((n) => `-- ${n}: binary value too large, left out`), ...notes.filter((n) => n !== NO_KEY)];
    statements.push([...head, ...(text === null ? [] : [text])].join("\n"));
  }
  return { statements, skipped };
}

/** `generateRowSql` for rows whose shown and stored values are the same (`rows[i][j]` is the value of `columns[j]`). */
export function rowStatements(driver: Driver, ref: ObjectRef, kind: RowSqlKind, columns: RowSqlColumn[], rows: Cell[][]): string[] {
  return generateRowSql(driver, ref, kind, columns, rows).statements;
}

/** Notification text after `Generate SQL` copied `count` statements. */
export function sqlCopiedNotice(kind: RowSqlKind, count: number, skipped = 0): { title: string; body: string } {
  const miss = skipped > 0 ? `${skipped} ${skipped === 1 ? "row" : "rows"} not loaded or not saved ${skipped === 1 ? "was" : "were"} skipped` : "";
  if (count === 0) return { title: "Nothing copied", body: miss || `No ${kind.toUpperCase()} statement for the selection` };
  return {
    title: `Copied ${count} ${count === 1 ? "statement" : "statements"}`,
    body: miss ? `${kind.toUpperCase()} to the clipboard; ${miss}` : `${kind.toUpperCase()} to the clipboard`,
  };
}
