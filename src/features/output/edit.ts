/**
 * Editable query results: which table and key a result maps to, and the grid changes turned into changes keyed
 * by that key. Pure helpers (the metadata lookup is `console/editable.ts`).
 */
import type { Cell, ColumnMeta, ObjectRef } from "../../api/types";
import type { GridChange } from "../../components/grid/types";
import { rowsAffected } from "./format";

/**
 * `sql` on one line: the line breaks (and the indentation around them) between tokens become one space. A line
 * break inside a string literal or a quoted name is part of the value and stays, so the logged text is still what ran.
 */
export function oneLine(sql: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = "";
      out += ch;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "\n" || ch === "\r") {
      out = out.replace(/[ \t]+$/, "");
      while (i + 1 < sql.length && /\s/.test(sql[i + 1])) i++;
      out += " ";
    } else out += ch;
  }
  return out;
}

/**
 * The Output lines of a grid Submit, like the ones of a console statement: each UPDATE / INSERT / DELETE on one
 * line, then `N rows affected in T ms` (or the failure). `statements` come from `changeStatements`.
 */
export function logSubmitted(
  log: (kind: "sql" | "text" | "error", text: string, prompt?: string) => unknown,
  prompt: string,
  statements: string[],
  outcome: { rowsAffected: number; ms: number } | { error: string },
): void {
  for (const s of statements) log("sql", oneLine(s), prompt);
  if ("error" in outcome) log("error", outcome.error);
  else log("text", rowsAffected(outcome.rowsAffected, outcome.ms));
}

export interface EditTarget {
  table: ObjectRef;
  /** Column names that identify a row: the primary key or the first unique key fully contained in the result. */
  key: string[];
  /** Per result column: it is a column of the table that may be edited (not an expression, alias or generated). */
  editable: boolean[];
}

/**
 * The key of an update / delete is rebuilt from the loaded row and the table's key columns: the grid's own key
 * would contain every column of the result (expressions included) when the result has no `isPk` column.
 * Throws when the original row is no longer loaded.
 */
export function keyedChanges(edit: EditTarget, meta: Pick<ColumnMeta, "name">[], rows: Cell[][], changes: GridChange[]): GridChange[] {
  const idx = edit.key.map((k) => meta.findIndex((m) => m.name === k));
  return changes.map((c) => {
    if (c.kind === "insert") return c;
    const row = rows[c.row];
    if (!row) throw new Error("The original row is no longer loaded. Reload the result and repeat the change.");
    const key: Record<string, Cell> = {};
    edit.key.forEach((k, i) => (key[k] = (row[idx[i]] ?? null) as Cell));
    return { ...c, key };
  });
}
