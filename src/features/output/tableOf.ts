/** The table a result tab reads: the editable target, else the one table of a plain select (null for joins, aggregates...). */
import type { ObjectRef } from "../../api/types";
import { plainSelect } from "../console/editable";
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

/**
 * The table `Generate SQL` writes its statements for: the editable target, else the table of a plain single-table
 * select (not a join, aggregate or expression list; PostgreSQL must report a table for every column). Null when the
 * rows are not one table's. Oracle folds the names of a statement up, so they are written in upper case there.
 */
export function sqlTableRef(tab: ResultTab, host: OutputHost | undefined): ObjectRef | null {
  if (!host) return null;
  if (tab.edit()) return resultTableRef(tab, host);
  if (!plainSelect(tab.sql, host.driver)) return null;
  if (host.driver === "postgres" && tab.meta.some((c) => !c.tableRef)) return null;
  const ref = resultTableRef(tab, host);
  if (!ref || host.driver !== "oracle") return ref;
  return { ...ref, schema: ref.schema?.toUpperCase() ?? null, name: ref.name.toUpperCase() };
}
