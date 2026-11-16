/**
 * What the diagram spotlights: a table (it and its direct neighbours), one foreign key (its two tables), or a colour
 * group (its tables and the edges that leave them). Pure, so the sets are testable; the view applies them to the DOM
 * as classes. Also the spatial arrow-key navigation between tables.
 */
import type { ColorAssignment } from "./groups";
import type { DiagramModel } from "./model";

export type Focus = { kind: "node"; index: number } | { kind: "edge"; index: number } | { kind: "group"; id: number };

export function sameFocus(a: Focus | null, b: Focus | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "group") return a.id === (b as typeof a).id;
  return a.index === (b as typeof a).index;
}

/** The tables and edges (indices) that stay lit for a focus; everything else is dimmed. */
export function focusSets(model: DiagramModel, colors: ColorAssignment | undefined, f: Focus): { nodes: Set<number>; edges: Set<number> } {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  if (f.kind === "node") {
    nodes.add(f.index);
    model.edges.forEach((e, i) => {
      if (e.from === f.index || e.to === f.index) {
        edges.add(i);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    });
  } else if (f.kind === "edge") {
    const e = model.edges[f.index];
    if (e) {
      edges.add(f.index);
      nodes.add(e.from);
      nodes.add(e.to);
    }
  } else if (colors) {
    colors.groupOf.forEach((g, i) => {
      if (g === f.id) nodes.add(i);
    });
    model.edges.forEach((e, i) => {
      if (nodes.has(e.from)) edges.add(i);
    });
  }
  return { nodes, edges };
}

/** A one-line description of the focus for screen readers. */
export function describeFocus(model: DiagramModel, f: Focus | null): string {
  if (!f) return "";
  if (f.kind === "node") {
    const n = model.nodes[f.index];
    if (!n) return "";
    const refs = new Set(model.edges.filter((e) => e.from === f.index && !e.self).map((e) => e.to)).size;
    const by = new Set(model.edges.filter((e) => e.to === f.index && !e.self).map((e) => e.from)).size;
    return `${n.name}: ${n.columns.length} columns, references ${refs} table${refs === 1 ? "" : "s"}, referenced by ${by}`;
  }
  if (f.kind === "edge") {
    const e = model.edges[f.index];
    return e ? `${e.label}: ${model.nodes[e.from].name} references ${model.nodes[e.to].name}` : "";
  }
  return "";
}

/**
 * The table to move to from `from` when an arrow key is pressed: the nearest one whose centre lies in that direction
 * (within a 45 degree cone), or null.
 */
export function neighbourInDirection(rects: readonly { x: number; y: number; w: number; h: number }[], from: number, dir: "left" | "right" | "up" | "down"): number | null {
  const a = rects[from];
  if (!a) return null;
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  let best: number | null = null;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === from) return;
    const dx = r.x + r.w / 2 - ax;
    const dy = r.y + r.h / 2 - ay;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) return;
    const score = along + across * 2;
    if (score < bestScore - 1e-9) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
