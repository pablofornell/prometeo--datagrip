/**
 * Quick column search of the grid ("Find Column"): a temporary view filter over the visible columns. Pure logic,
 * the grid owns the state and the bar (`ColumnSearchBar`) draws it. The saved column visibility (Manage Columns) is
 * never touched: the search only narrows the columns that Manage Columns leaves visible.
 */
import { type Range, matchRanges } from "../ui/speedMatch";

export interface ColumnMatch {
  /** Column index in `GridColumn[]`. */
  ci: number;
  /** Matched character ranges of the column name (sorted, not overlapping). */
  ranges: Range[];
}

/** Sorts the ranges and merges the ones that touch or overlap. */
function mergeRanges(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Matches one column name. Case-insensitive; the query is split on whitespace and every word has to match
 * (substring first, then word initials, like the speed search: "oi" finds `order_items`), so "user id" finds `user_id`.
 * Returns the highlighted ranges, or null when the name does not match. A blank query matches with no ranges.
 */
export function matchColumnName(name: string, query: string): Range[] | null {
  const words = query.split(/\s+/).filter(Boolean);
  const all: Range[] = [];
  for (const w of words) {
    const r = matchRanges(name, w);
    if (!r) return null;
    all.push(...r);
  }
  return mergeRanges(all);
}

/**
 * The columns among `candidates` (indexes into `columns`, in display order) whose name matches `query`; the order of
 * `candidates` is kept. A blank query matches every candidate.
 */
export function matchColumns(columns: readonly { name: string }[], candidates: readonly number[], query: string): ColumnMatch[] {
  const out: ColumnMatch[] = [];
  for (const ci of candidates) {
    const col = columns[ci];
    if (!col) continue;
    const ranges = matchColumnName(col.name, query);
    if (ranges) out.push({ ci, ranges });
  }
  return out;
}

/** `n of m columns` while a search narrows the list, `m columns` otherwise. */
export function columnSearchHint(shown: number, total: number, searching: boolean): string {
  const noun = total === 1 ? "column" : "columns";
  return searching ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

/** Position (among the shown columns) the next / previous step lands on, wrapping around; -1 when nothing is shown. */
export function stepColumnPos(count: number, current: number | null, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current === null || current < 0 || current >= count) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}
