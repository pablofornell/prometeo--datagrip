/**
 * Colour groups of the diagram: which tables share a colour. A table's group colours its header and every foreign
 * key that leaves it, so colour reads as meaning (a schema, a cluster of closely related tables, a name prefix)
 * instead of decoration. Pure and deterministic: clusters come from a modularity (Louvain) pass over the FK graph
 * with a fixed visiting order.
 */
import type { DiagramModel } from "./model";

export type ColorMode = "cluster" | "schema" | "prefix" | "none";

export const COLOR_MODES: readonly ColorMode[] = ["cluster", "schema", "prefix", "none"];

/** The rainbow has 12 slots. */
export const RAINBOW_SLOTS = 12;

/**
 * Order in which slots are handed out: neighbours in the rainbow look alike, so the first (largest) groups take
 * slots that are far apart in hue.
 */
const SLOT_ORDER = [0, 7, 3, 9, 5, 11, 1, 8, 4, 10, 6, 2] as const;

export interface ColorGroup {
  id: number;
  label: string;
  count: number;
  /** Rainbow slot 0..11. */
  slot: number;
}

export interface ColorAssignment {
  mode: ColorMode;
  /** Group id per node index, -1 for a node without a group (drawn in the neutral colour). */
  groupOf: number[];
  groups: ColorGroup[];
}

/** Undirected weighted neighbours of every node (parallel edges add up, self references are ignored). */
function neighbours(model: DiagramModel): Map<number, number>[] {
  const adj = model.nodes.map(() => new Map<number, number>());
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    adj[e.from].set(e.to, (adj[e.from].get(e.to) ?? 0) + 1);
    adj[e.to].set(e.from, (adj[e.to].get(e.from) ?? 0) + 1);
  }
  return adj;
}

/** One Louvain level: moves nodes between communities while modularity improves. Returns the community per node. */
function louvainLevel(adj: Map<number, number>[], gamma: number): { comm: number[]; moved: boolean } {
  const n = adj.length;
  const comm = adj.map((_, i) => i);
  const k = adj.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const m2 = k.reduce((a, b) => a + b, 0);
  if (m2 === 0) return { comm, moved: false };
  const tot = [...k];
  let movedAny = false;
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const own = comm[i];
      const links = new Map<number, number>();
      for (const [j, w] of adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + w);
      tot[own] -= k[i];
      let best = own;
      let bestGain = (links.get(own) ?? 0) - (gamma * tot[own] * k[i]) / m2;
      for (const c of [...links.keys()].sort((a, b) => a - b)) {
        const gain = links.get(c)! - (gamma * tot[c] * k[i]) / m2;
        if (gain > bestGain + 1e-9) {
          best = c;
          bestGain = gain;
        }
      }
      tot[best] += k[i];
      comm[i] = best;
      if (best !== own) moved = movedAny = true;
    }
    if (!moved) break;
  }
  return { comm, moved: movedAny };
}

/** Communities of the FK graph (Louvain with aggregation); one array entry per node. */
export function clusters(model: DiagramModel, gamma = 1.5): number[] {
  const n = model.nodes.length;
  let adj = neighbours(model);
  let member = model.nodes.map((_, i) => i); // original node -> current super node
  for (let level = 0; level < 6; level++) {
    const { comm, moved } = louvainLevel(adj, gamma);
    if (!moved) break;
    const dense = new Map<number, number>();
    for (const c of comm) if (!dense.has(c)) dense.set(c, dense.size);
    const next = Array.from({ length: dense.size }, () => new Map<number, number>());
    adj.forEach((m, i) => {
      for (const [j, w] of m) {
        const a = dense.get(comm[i])!;
        const b = dense.get(comm[j])!;
        next[a].set(b, (next[a].get(b) ?? 0) + w); // internal weight stays as a self loop (it counts for the degree)
      }
    });
    member = member.map((s) => dense.get(comm[s])!);
    adj = next;
    if (dense.size === comm.length) break;
  }
  return member.length === n ? member : [];
}

function pickSlots(groups: { count: number; first: number }[]): number[] {
  const order = groups.map((_, i) => i).sort((a, b) => groups[b].count - groups[a].count || groups[a].first - groups[b].first);
  const slot = new Array<number>(groups.length).fill(0);
  order.forEach((g, rank) => (slot[g] = SLOT_ORDER[rank % RAINBOW_SLOTS]));
  return slot;
}

/** Builds groups from a per-node key; keys with fewer than `min` nodes (or an empty key) stay neutral. */
function fromKeys(model: DiagramModel, keys: (string | null)[], label: (key: string, members: number[]) => string, min: number): { groupOf: number[]; groups: ColorGroup[] } {
  const members = new Map<string, number[]>();
  keys.forEach((k, i) => {
    if (k === null) return;
    const list = members.get(k);
    if (list) list.push(i);
    else members.set(k, [i]);
  });
  const kept = [...members.entries()].filter(([, list]) => list.length >= min);
  const slots = pickSlots(kept.map(([, list]) => ({ count: list.length, first: list[0] })));
  const groupOf = model.nodes.map(() => -1);
  const groups: ColorGroup[] = kept.map(([key, list], id) => {
    for (const i of list) groupOf[i] = id;
    return { id, label: label(key, list), count: list.length, slot: slots[id] };
  });
  groups.sort((a, b) => b.count - a.count || a.id - b.id);
  return { groupOf, groups };
}

/** The leading word of a table name (`order_items` -> `order`), or null when it has no separator. */
export function prefixOf(name: string): string | null {
  const m = /^([A-Za-z0-9]+)[_\-.]/.exec(name);
  return m ? m[1].toLowerCase() : null;
}

export function assignColors(model: DiagramModel, mode: ColorMode): ColorAssignment {
  if (mode === "none" || model.nodes.length === 0) return { mode, groupOf: model.nodes.map(() => -1), groups: [] };
  if (mode === "schema") {
    const r = fromKeys(model, model.nodes.map((n) => n.schema), (k) => k, 1);
    return { mode, ...r };
  }
  if (mode === "prefix") {
    const r = fromKeys(model, model.nodes.map((n) => prefixOf(n.name)), (k) => `${k}_*`, 2);
    return { mode, ...r };
  }
  const comm = clusters(model);
  const adj = neighbours(model);
  const hasEdge = adj.map((m) => m.size > 0);
  const r = fromKeys(
    model,
    comm.map((c, i) => (hasEdge[i] ? String(c) : null)),
    (_, list) => {
      // named after its best-connected table
      const hub = [...list].sort((a, b) => adj[b].size - adj[a].size || a - b)[0];
      return list.length > 1 ? `${model.nodes[hub].name} +${list.length - 1}` : model.nodes[hub].name;
    },
    2,
  );
  return { mode, ...r };
}
