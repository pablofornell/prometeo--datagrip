/**
 * "Copy as" formatters (TSV is the DataGrip default for Ctrl+C). Pure functions, no DOM.
 * Input is a rectangular block of already-selected cells: `columns[j]` describes `rows[i][j]`.
 */
import type { Driver } from "../../api/types";
import { literal, qualifiedName } from "../../features/table/sql";
import { classifyType, editText, isBinaryCell, isDefaultCell } from "./format";
import type { Cell, CopyFormat } from "./types";

export interface CopyColumn {
  name: string;
  typeName: string;
}

export interface CopyOptions {
  /** Target table for SQL INSERT output (`schema.table`). */
  tableName?: string;
  /** SQL dialect of the SQL INSERT output (identifier quoting, literals). Default: PostgreSQL. */
  dialect?: Driver;
  /** Text for NULL in TSV/CSV/Markdown (JSON/SQL always use null). Default: empty. */
  nullText?: string;
  /** Include the header row (TSV/CSV; Markdown always has one). Default false for TSV (like DataGrip), true for CSV. */
  header?: boolean;
}

function plain(v: Cell, nullText: string): string {
  if (v === null || v === undefined) return nullText;
  if (isDefaultCell(v)) return "<default>";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isBinaryCell(v)) return "0x" + v.$bin;
  return editText(v).replace(/\s*\n\s*/g, " ");
}

function quoteIfNeeded(s: string, special: RegExp): string {
  return special.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function formatTsv(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const lines: string[] = [];
  if (o.header) lines.push(columns.map((c) => quoteIfNeeded(c.name, /[\t\r\n"]/)).join("\t"));
  for (const r of rows) lines.push(r.map((v) => quoteIfNeeded(plain(v, nul), /[\t\r\n"]/)).join("\t"));
  return lines.join("\n");
}

export function formatCsv(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const lines: string[] = [];
  if (o.header ?? true) lines.push(columns.map((c) => quoteIfNeeded(c.name, /[,\r\n"]/)).join(","));
  for (const r of rows) lines.push(r.map((v) => quoteIfNeeded(plain(v, nul), /[,\r\n"]/)).join(","));
  return lines.join("\n");
}

const NUM_TOKEN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function jsonValue(v: Cell, numeric: boolean): string {
  if (v === null || v === undefined) return "null";
  if (isDefaultCell(v)) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return numeric && NUM_TOKEN.test(v) ? v : JSON.stringify(v);
  if (isBinaryCell(v)) return JSON.stringify("0x" + v.$bin);
  return JSON.stringify(v);
}

export function formatJson(columns: CopyColumn[], rows: Cell[][]): string {
  const numeric = columns.map((c) => classifyType(c.typeName) === "number");
  const names = columns.map((c) => JSON.stringify(c.name));
  const objs = rows.map((r) => "  {\n" + r.map((v, j) => `    ${names[j]}: ${jsonValue(v, numeric[j])}`).join(",\n") + "\n  }");
  return objs.length ? "[\n" + objs.join(",\n") + "\n]" : "[]";
}

/**
 * `[schema.]table` as SQL of the dialect. The name comes already quoted (`"my table"`, the table editor) or raw
 * (`public.clients`, the result tab): it is split on the dots outside quotes, unquoted, and written again with the
 * same quoting rule as the rest of the app (quotes only where the dialect needs them).
 */
function tableSql(driver: Driver, text: string): string {
  const parts: string[] = [];
  let cur = "";
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q && text[i + 1] === q) cur += text[++i];
      else if (ch === q) q = "";
      else cur += ch;
    } else if (ch === '"' || ch === "`") q = ch;
    else if (ch === ".") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const name = parts.pop() as string;
  return qualifiedName(driver, { schema: parts.length ? parts.join(".") : null, name });
}

const column = (driver: Driver, name: string): string => qualifiedName(driver, { schema: null, name });

/** SQL literal of a cell, as the table editor's preview writes it (`features/table/sql.ts`), with lower case keywords. */
function sqlValue(driver: Driver, v: Cell, typeName: string): string {
  if (isDefaultCell(v)) return "default";
  const text = literal(v, typeName, driver);
  // an untyped '\x..' literal is only accepted where a bytea is expected: say what it is
  return driver === "postgres" && isBinaryCell(v) ? `${text}::bytea` : text;
}

/**
 * One `insert into t (cols) values (...);` per row, each on its own line, the last one ended by a newline.
 * SQLite has no `default` in VALUES: a column set to it is left out of that row.
 */
export function formatSqlInsert(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const driver = o.dialect ?? "postgres";
  const table = tableSql(driver, o.tableName || "table_name");
  const names = columns.map((c) => column(driver, c.name));
  const lines = rows.map((r) => {
    const used = columns.map((_, j) => j).filter((j) => !(driver === "sqlite" && isDefaultCell(r[j])));
    if (used.length === 0) {
      // no `default values` clause in MySQL (`() values ()`) and Oracle (one column set to its default)
      if (driver === "mysql") return `insert into ${table} () values ();`;
      if (driver === "oracle" && columns.length) return `insert into ${table} (${names[0]}) values (default);`;
      return `insert into ${table} default values;`;
    }
    const cols = used.map((j) => names[j]).join(", ");
    return `insert into ${table} (${cols}) values (${used.map((j) => sqlValue(driver, r[j], columns[j].typeName)).join(", ")});`;
  });
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function formatMarkdown(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = "| " + columns.map((c) => esc(c.name)).join(" | ") + " |";
  const align = "| " + columns.map((c) => (classifyType(c.typeName) === "number" ? "---:" : "---")).join(" | ") + " |";
  const body = rows.map((r) => "| " + r.map((v) => esc(plain(v, nul))).join(" | ") + " |");
  return [head, align, ...body].join("\n");
}

export function formatRows(format: CopyFormat, columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  switch (format) {
    case "tsv":
      return formatTsv(columns, rows, o);
    case "csv":
      return formatCsv(columns, rows, o);
    case "json":
      return formatJson(columns, rows);
    case "sql":
      return formatSqlInsert(columns, rows, o);
    case "markdown":
      return formatMarkdown(columns, rows, o);
  }
}

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: "TSV",
  csv: "CSV",
  json: "JSON",
  sql: "SQL INSERT",
  markdown: "Markdown",
};
