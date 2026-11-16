/**
 * Ctrl+Click (Cmd+Click on mac) on a foreign key cell: the pure decisions of the grid. Which target a click leads
 * to, why it leads nowhere (NULL key, key column missing in a query result) and the tooltip of the hovered cell.
 */
import type { Cell, GridNavTarget, GridNavigation } from "./types";

/** The modifier that turns a click on a foreign key cell into navigation: Cmd on mac, Ctrl elsewhere. */
export function isLinkModifier(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");

export type FkLink =
  /** The cell is not a foreign key column (or the host knows no target). */
  | { kind: "none" }
  /** Navigable: `target.open(record)` goes to the referenced row. */
  | { kind: "go"; target: GridNavTarget }
  /** A foreign key cell that points nowhere: `reason` is the subtle message of a click. */
  | { kind: "blocked"; reason: string };

const isDefaultOrExpr = (v: Cell): boolean => typeof v === "object" && v !== null && ("$default" in v || "$expr" in v);

/** What Ctrl+Click on the cell of `column` in the record `rec` does. */
export function resolveFkLink(nav: GridNavigation | undefined, column: string, rec: Record<string, Cell>): FkLink {
  if (!nav) return { kind: "none" };
  const targets = nav.referenced(column);
  if (!targets.length) return { kind: "none" };
  const usable = targets.find((t) => !t.enabled || t.enabled(rec));
  if (usable) {
    // an inserted / edited row may hold a value that is not data yet (DEFAULT, expression): it points nowhere
    const cols = usable.columns ?? [column];
    if (cols.some((c) => isDefaultOrExpr(rec[c]))) return { kind: "blocked", reason: "The value is not saved yet: there is no row to go to" };
    return { kind: "go", target: usable };
  }
  const absent = (targets[0].columns ?? []).filter((c) => !(c in rec));
  if (absent.length) return { kind: "blocked", reason: `Key column ${absent.join(", ")} is not in the result: cannot find the referenced row` };
  return { kind: "blocked", reason: "NULL: there is no referenced row" };
}

/** Tooltip of a hovered foreign key cell. */
export function fkTooltip(t: GridNavTarget, mac: boolean): string {
  return `${mac ? "Cmd" : "Ctrl"}+Click: go to ${t.qualified ?? t.label}`;
}
