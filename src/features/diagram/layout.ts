/**
 * Deterministic layered (Sugiyama) layout for the database diagram.
 *
 * Per connected component: cycles are broken by reversing DFS back edges; tables are ranked by longest path and then
 * tightened so a root sits next to its closest child; edges that span several ranks get one dummy node per crossed
 * layer (they reserve a corridor between the real boxes); crossings are reduced by barycenter sweeps plus adjacent
 * transposition, keeping the best order seen; the position across the layer comes from Brandes-Koepf (long edges end
 * up straight, linked tables stay close) with the real box sizes. Components, and the tables without relations, are
 * then packed together with a skyline packer. Every coordinate is a multiple of `DGM.grid`, so edge ports line up
 * with the router's lattice, and a final separation pass guarantees that no two boxes overlap.
 *
 * Referenced tables sit before the tables that reference them (left, or above for `TB`). No layout dependency.
 */
import { DGM, type DiagramModel } from "./model";

export type Direction = "LR" | "TB";

export interface LayoutOptions {
  direction?: Direction;
}

export interface NodeBox {
  index: number;
  /** `schema.name` of the node (the key dragged positions use). */
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** One box per node, sorted by index. */
  nodes: NodeBox[];
  width: number;
  height: number;
  direction: Direction;
}

const G = DGM.grid;
const snap = (v: number): number => Math.round(v / G) * G;
const snapUp = (v: number): number => Math.ceil(v / G) * G;

/** Gap between packed components / unrelated tables. */
const PACK_GAP = 80;
/** Room kept to the right of a table that references itself (the loop is drawn there). */
export const LOOP_ROOM = 40;

const SEP = {
  LR: { real: 40, mixed: 30, dummy: 20 },
  TB: { real: 60, mixed: 40, dummy: 20 },
} as const;

// ---------------------------------------------------------------- helpers

/** A table has a self-referencing foreign key. */
function selfLoops(model: DiagramModel): Set<number> {
  const s = new Set<number>();
  for (const e of model.edges) if (e.from === e.to) s.add(e.from);
  return s;
}

/** Fenwick tree used to count inversions. */
class Fenwick {
  private t: Int32Array;
  constructor(n: number) {
    this.t = new Int32Array(n + 2);
  }
  add(i: number): void {
    for (i++; i < this.t.length; i += i & -i) this.t[i]++;
  }
  /** Count of added values at index >= i. */
  atLeast(i: number, total: number): number {
    let s = 0;
    for (; i > 0; i -= i & -i) s += this.t[i];
    return total - s;
  }
}

// ---------------------------------------------------------------- one component

interface Layered {
  /** Real nodes come first (0..m-1), dummies follow. */
  layers: number[][];
  up: number[][];
  down: number[][];
  isDummy: boolean[];
  size: number[]; // extent along the layer (order axis)
}

/** Crossings between layer `r` and `r + 1`. */
function crossingsBetween(g: Layered, pos: Int32Array, r: number): number {
  const upper = g.layers[r];
  const lower = g.layers[r + 1];
  const pairs: number[] = [];
  const W = lower.length;
  for (const a of upper) for (const b of g.down[a]) pairs.push(pos[a] * W + pos[b]);
  pairs.sort((x, y) => x - y);
  const fw = new Fenwick(W);
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    const b = pairs[i] % W;
    count += fw.atLeast(b + 1, i);
    fw.add(b);
  }
  return count;
}

function totalCrossings(g: Layered, pos: Int32Array): number {
  let c = 0;
  for (let r = 0; r + 1 < g.layers.length; r++) c += crossingsBetween(g, pos, r);
  return c;
}

/** Reduces crossings in place: barycenter sweeps, then adjacent transpositions, keeping the best order seen. */
function minimizeCrossings(g: Layered, budget: number): void {
  const N = g.size.length;
  const pos = new Int32Array(N);
  const reindex = (): void => g.layers.forEach((l) => l.forEach((v, i) => (pos[v] = i)));
  reindex();
  let best = totalCrossings(g, pos);
  let bestOrder = g.layers.map((l) => [...l]);
  if (best === 0) return;

  const orderLayer = (r: number, nbrs: number[][]): void => {
    const layer = g.layers[r];
    const keyed = layer.map((v, i) => {
      const ns = nbrs[v];
      if (ns.length === 0) return { v, k: i, i };
      let sum = 0;
      for (const n of ns) sum += pos[n];
      return { v, k: sum / ns.length, i };
    });
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    keyed.forEach((e, i) => {
      layer[i] = e.v;
      pos[e.v] = i;
    });
  };

  const pairCross = (a: number, b: number): number => {
    // crossings among the edges of a and b towards both neighbouring layers when a is left of b
    let c = 0;
    for (const x of g.up[a]) for (const y of g.up[b]) if (pos[x] > pos[y]) c++;
    for (const x of g.down[a]) for (const y of g.down[b]) if (pos[x] > pos[y]) c++;
    return c;
  };
  const transpose = (): void => {
    for (let round = 0; round < 3; round++) {
      let improved = false;
      for (const layer of g.layers) {
        for (let i = 0; i + 1 < layer.length; i++) {
          const a = layer[i];
          const b = layer[i + 1];
          if (pairCross(b, a) < pairCross(a, b)) {
            layer[i] = b;
            layer[i + 1] = a;
            pos[a] = i + 1;
            pos[b] = i;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  };

  let stale = 0;
  for (let it = 0; it < budget && best > 0 && stale < 5; it++) {
    if (it % 2 === 0) for (let r = 1; r < g.layers.length; r++) orderLayer(r, g.up);
    else for (let r = g.layers.length - 2; r >= 0; r--) orderLayer(r, g.down);
    transpose();
    const c = totalCrossings(g, pos);
    if (c < best) {
      best = c;
      bestOrder = g.layers.map((l) => [...l]);
      stale = 0;
    } else stale++;
  }
  for (let r = 0; r < g.layers.length; r++) g.layers[r] = bestOrder[r];
}

/** Brandes-Koepf coordinates along the layer axis: the centre of every node, for the four alignments averaged. */
function assignOrderAxis(g: Layered, sep: (a: number, b: number) => number): number[] {
  const { layers, up, down, isDummy, size } = g;
  const N = size.length;
  const pos = new Int32Array(N);
  layers.forEach((l) => l.forEach((v, i) => (pos[v] = i)));

  // Type 1 conflicts: a non-inner segment crossing an inner (dummy-dummy) one must not take part in an alignment.
  const conflicts = new Set<number>();
  for (let i = 0; i + 1 < layers.length; i++) {
    const upper = layers[i];
    const lower = layers[i + 1];
    let k0 = 0;
    let l = 0;
    for (let l1 = 0; l1 < lower.length; l1++) {
      const v = lower[l1];
      let inner = -1;
      if (isDummy[v]) for (const u of up[v]) if (isDummy[u]) inner = pos[u];
      if (l1 === lower.length - 1 || inner >= 0) {
        const k1 = inner >= 0 ? inner : upper.length - 1;
        for (; l <= l1; l++) {
          const w = lower[l];
          for (const u of up[w]) {
            const k = pos[u];
            if (k < k0 || k > k1) conflicts.add(u * N + w);
          }
        }
        k0 = k1;
      }
    }
  }

  const variant = (vertUp: boolean, rev: boolean): Float64Array => {
    const seq = (vertUp ? [...layers].reverse() : layers).map((l) => (rev ? [...l].reverse() : l));
    const p = new Int32Array(N);
    seq.forEach((l) => l.forEach((v, i) => (p[v] = i)));
    const nbr = vertUp ? down : up;
    const conflict = (prev: number, cur: number): boolean => (vertUp ? conflicts.has(cur * N + prev) : conflicts.has(prev * N + cur));

    const root = new Int32Array(N).map((_, i) => i);
    const align = new Int32Array(N).map((_, i) => i);
    for (let li = 1; li < seq.length; li++) {
      let r = -1;
      for (const v of seq[li]) {
        const ns = [...nbr[v]].sort((a, b) => p[a] - p[b]);
        if (ns.length === 0) continue;
        const d = ns.length;
        const meds = d % 2 === 1 ? [ns[(d - 1) / 2]] : [ns[d / 2 - 1], ns[d / 2]];
        for (const u of meds) {
          if (align[v] === v && !conflict(u, v) && r < p[u]) {
            align[u] = v;
            root[v] = root[u];
            align[v] = root[v];
            r = p[u];
          }
        }
      }
    }

    const sink = new Int32Array(N).map((_, i) => i);
    const shift = new Float64Array(N).fill(Infinity);
    const x = new Float64Array(N).fill(NaN);
    const predOf = (w: number): number => {
      const i = p[w];
      return i > 0 ? seq[layerOfV[w]][i - 1] : -1;
    };
    const layerOfV = new Int32Array(N);
    seq.forEach((l, li) => l.forEach((v) => (layerOfV[v] = li)));

    const place = (v: number): void => {
      if (!Number.isNaN(x[v])) return;
      x[v] = 0;
      let w = v;
      do {
        const pw = predOf(w);
        if (pw >= 0) {
          const u = root[pw];
          place(u);
          if (sink[v] === v) sink[v] = sink[u];
          const delta = (size[pw] + size[w]) / 2 + sep(pw, w);
          if (sink[v] !== sink[u]) shift[sink[u]] = Math.min(shift[sink[u]], x[v] - x[u] - delta);
          else x[v] = Math.max(x[v], x[u] + delta);
        }
        w = align[w];
      } while (w !== v);
    };
    for (let v = 0; v < N; v++) if (root[v] === v) place(v);

    const out = new Float64Array(N);
    for (let v = 0; v < N; v++) {
      const r = root[v];
      let xv = x[r];
      const s = shift[sink[r]];
      if (s < Infinity) xv += s;
      out[v] = rev ? -xv : xv;
    }
    return out;
  };

  const four = [variant(false, false), variant(false, true), variant(true, false), variant(true, true)];
  const lo = four.map((a) => a.reduce((m, v) => Math.min(m, v), Infinity));
  const hi = four.map((a) => a.reduce((m, v) => Math.max(m, v), -Infinity));
  let ref = 0;
  for (let i = 1; i < 4; i++) if (hi[i] - lo[i] < hi[ref] - lo[ref]) ref = i;
  // left alignments line up on the smallest layout's minimum, right ones on its maximum
  const shifts = four.map((_, i) => (i % 2 === 0 ? lo[ref] - lo[i] : hi[ref] - hi[i]));
  const centre = new Array<number>(N);
  for (let v = 0; v < N; v++) {
    const vals = four.map((a, i) => a[v] + shifts[i]).sort((a, b) => a - b);
    centre[v] = (vals[1] + vals[2]) / 2;
  }
  return centre;
}

/** Local coordinates (top-left of the bounding box at 0,0) of one connected component with 2+ tables. */
function layoutComponent(indices: number[], model: DiagramModel, dir: Direction, loops: Set<number>): { pos: Map<number, { x: number; y: number }>; width: number; height: number } {
  const m = indices.length;
  const local = new Map<number, number>();
  indices.forEach((g, i) => local.set(g, i));

  // Arcs parent -> child, deduplicated (parallel foreign keys count once and carry a weight).
  const weight = new Map<number, number>();
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    const u = local.get(e.to);
    const v = local.get(e.from);
    if (u === undefined || v === undefined) continue;
    weight.set(u * m + v, (weight.get(u * m + v) ?? 0) + 1);
  }
  const arcList = [...weight.keys()].sort((a, b) => a - b).map((k) => [Math.floor(k / m), k % m] as const);
  const out: number[][] = Array.from({ length: m }, () => []);
  const indeg = new Array<number>(m).fill(0);
  for (const [u, v] of arcList) {
    out[u].push(v);
    indeg[v]++;
  }

  // Cycle breaking: iterative DFS, back edges are reversed.
  const dagOut: number[][] = Array.from({ length: m }, () => []);
  const dagKeys = new Set<number>();
  const addDag = (u: number, v: number): void => {
    if (!dagKeys.has(u * m + v)) {
      dagKeys.add(u * m + v);
      dagOut[u].push(v);
    }
  };
  const state = new Uint8Array(m);
  const roots = [...Array(m).keys()].sort((a, b) => (indeg[a] === 0 ? 0 : 1) - (indeg[b] === 0 ? 0 : 1) || a - b);
  for (const s of roots) {
    if (state[s]) continue;
    const stack: [number, number][] = [[s, 0]];
    state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, i] = top;
      if (i >= out[u].length) {
        state[u] = 2;
        stack.pop();
        continue;
      }
      top[1]++;
      const v = out[u][i];
      if (state[v] === 1) addDag(v, u);
      else {
        addDag(u, v);
        if (state[v] === 0) {
          state[v] = 1;
          stack.push([v, 0]);
        }
      }
    }
  }

  // Longest-path ranks over the DAG (Kahn), then tightening.
  const dagIn: number[][] = Array.from({ length: m }, () => []);
  dagOut.forEach((vs, u) => vs.forEach((v) => dagIn[v].push(u)));
  const inCount = dagIn.map((l) => l.length);
  const topo: number[] = [];
  const queue = [...Array(m).keys()].filter((i) => inCount[i] === 0);
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    topo.push(u);
    for (const v of dagOut[u]) if (--inCount[v] === 0) queue.push(v);
  }
  const rank = new Array<number>(m).fill(0);
  for (const u of topo) for (const v of dagOut[u]) rank[v] = Math.max(rank[v], rank[u] + 1);
  const w = (u: number, v: number): number => weight.get(u * m + v) ?? weight.get(v * m + u) ?? 1;
  const sumW = (list: number[], self: number, outward: boolean): number => list.reduce((s, o) => s + (outward ? w(self, o) : w(o, self)), 0);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let t = topo.length - 1; t >= 0; t--) {
      const v = topo[t];
      if (dagOut[v].length === 0) continue;
      if (sumW(dagOut[v], v, true) > sumW(dagIn[v], v, false)) {
        const hi = Math.min(...dagOut[v].map((s) => rank[s])) - 1;
        if (hi > rank[v]) {
          rank[v] = hi;
          changed = true;
        }
      }
    }
    for (const v of topo) {
      if (dagIn[v].length === 0) continue;
      if (sumW(dagIn[v], v, false) > sumW(dagOut[v], v, true)) {
        const lo = Math.max(...dagIn[v].map((p) => rank[p])) + 1;
        if (lo < rank[v]) {
          rank[v] = lo;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const minRank = Math.min(...rank);
  for (let i = 0; i < m; i++) rank[i] -= minRank;
  const R = Math.max(...rank) + 1;

  // Layered graph with dummy nodes for the arcs that span several ranks.
  const LR = dir === "LR";
  const orderSize = (g: number): number => {
    const nd = model.nodes[g];
    return LR ? nd.height : nd.width + (loops.has(g) ? LOOP_ROOM : 0);
  };
  const size: number[] = indices.map((g) => orderSize(g));
  const isDummy: boolean[] = new Array(m).fill(false);
  const layerOf: number[] = [...rank];
  const up: number[][] = Array.from({ length: m }, () => []);
  const down: number[][] = Array.from({ length: m }, () => []);
  const link = (a: number, b: number): void => {
    down[a].push(b);
    up[b].push(a);
  };
  const addDummy = (layer: number): number => {
    const id = size.length;
    size.push(0);
    isDummy.push(true);
    layerOf.push(layer);
    up.push([]);
    down.push([]);
    return id;
  };
  const segCount = new Array<number>(R).fill(0);
  for (let u = 0; u < m; u++) {
    for (const v of dagOut[u]) {
      let prev = u;
      for (let r = rank[u] + 1; r < rank[v]; r++) {
        const d = addDummy(r);
        link(prev, d);
        segCount[r - 1]++;
        prev = d;
      }
      link(prev, v);
      segCount[rank[v] - 1]++;
    }
  }

  // Initial order: DFS discovery from the first layer, children first.
  const N = size.length;
  const seen = new Uint8Array(N);
  const discovery: number[] = [];
  const visit = (s: number): void => {
    const stack = [s];
    while (stack.length) {
      const v = stack.pop()!;
      if (seen[v]) continue;
      seen[v] = 1;
      discovery.push(v);
      for (let i = down[v].length - 1; i >= 0; i--) if (!seen[down[v][i]]) stack.push(down[v][i]);
    }
  };
  for (let v = 0; v < N; v++) if (up[v].length === 0 && layerOf[v] === 0) visit(v);
  for (let v = 0; v < N; v++) visit(v);
  const layers: number[][] = Array.from({ length: R }, () => []);
  for (const v of discovery) layers[layerOf[v]].push(v);

  const g: Layered = { layers, up, down, isDummy, size };
  minimizeCrossings(g, N > 1500 ? 6 : N > 600 ? 12 : 24);

  // Coordinates along the layer axis.
  const table = SEP[dir];
  const sep = (a: number, b: number): number => (isDummy[a] && isDummy[b] ? table.dummy : isDummy[a] || isDummy[b] ? table.mixed : table.real);
  const centre = assignOrderAxis(g, sep);

  // A last pass guarantees the separation (and puts every top edge on the lattice).
  const top = new Array<number>(N).fill(0);
  for (const layer of g.layers) {
    layer.forEach((v, i) => {
      let t = snap(centre[v] - size[v] / 2);
      if (i > 0) {
        const prev = layer[i - 1];
        t = Math.max(t, top[prev] + snapUp(size[prev]) + snapUp(sep(prev, v)));
      }
      top[v] = t;
    });
  }

  // Positions across the layers (rank axis): the gap between two layers grows with the edges that cross it.
  const thick = (v: number): number => (v >= m ? 0 : LR ? model.nodes[indices[v]].width : model.nodes[indices[v]].height);
  const layerThick = layers.map((l) => l.reduce((mx, v) => Math.max(mx, thick(v)), 0));
  const layerStart: number[] = [];
  let cursor = 0;
  for (let r = 0; r < R; r++) {
    layerStart.push(cursor);
    const segs = r < R - 1 ? segCount[r] : 0;
    const base = LR ? 60 : 70;
    let gap = base + 6 * Math.min(segs, 12);
    if (LR && layers[r].some((v) => v < m && loops.has(indices[v]))) gap += LOOP_ROOM;
    cursor += snapUp(layerThick[r]) + snapUp(gap);
  }

  const pos = new Map<number, { x: number; y: number }>();
  let minOrder = Infinity;
  for (let v = 0; v < m; v++) minOrder = Math.min(minOrder, top[v]);
  let width = 0;
  let height = 0;
  for (let v = 0; v < m; v++) {
    const nd = model.nodes[indices[v]];
    const across = layerStart[layerOf[v]] + Math.floor((snapUp(layerThick[layerOf[v]]) - thick(v)) / 2 / G) * G;
    const along = top[v] - minOrder;
    const p = LR ? { x: across, y: along } : { x: along, y: across };
    pos.set(indices[v], p);
    width = Math.max(width, p.x + nd.width + (loops.has(indices[v]) ? LOOP_ROOM : 0));
    height = Math.max(height, p.y + nd.height);
  }
  return { pos, width, height };
}

// ---------------------------------------------------------------- packing

interface Item {
  w: number;
  h: number;
}

/** Skyline packer: places each item at the lowest, then leftmost, position of a strip `targetW` wide. */
export function packItems(items: readonly Item[], targetW: number, gap: number): { x: number; y: number }[] {
  let sky: { x: number; w: number; y: number }[] = [{ x: 0, w: targetW + gap, y: 0 }];
  const out: { x: number; y: number }[] = new Array(items.length);
  for (let k = 0; k < items.length; k++) {
    const W = items[k].w + gap;
    const H = items[k].h + gap;
    let bx = 0;
    let by = Infinity;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x + W > targetW + gap + 1e-9) break;
      let y = 0;
      let covered = 0;
      for (let j = i; j < sky.length && covered < W; j++) {
        y = Math.max(y, sky[j].y);
        covered += sky[j].w;
      }
      if (covered < W - 1e-9) break;
      if (y < by) {
        by = y;
        bx = x;
      }
    }
    if (!Number.isFinite(by)) {
      by = sky.reduce((mx, s) => Math.max(mx, s.y), 0);
      bx = 0;
    }
    out[k] = { x: bx, y: by };
    const next: typeof sky = [];
    for (const s of sky) {
      const end = s.x + s.w;
      if (end <= bx || s.x >= bx + W) next.push(s);
      else {
        if (s.x < bx) next.push({ x: s.x, w: bx - s.x, y: s.y });
        if (end > bx + W) next.push({ x: bx + W, w: end - (bx + W), y: s.y });
      }
    }
    next.push({ x: bx, w: W, y: by + H });
    next.sort((a, b) => a.x - b.x);
    sky = [];
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9 && Math.abs(last.x + last.w - s.x) < 1e-9) last.w += s.w;
      else sky.push({ ...s });
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry point

export function layoutDiagram(model: DiagramModel, opts: LayoutOptions = {}): LayoutResult {
  const dir: Direction = opts.direction ?? "LR";
  const n = model.nodes.length;
  const loops = selfLoops(model);

  // Union-find over the foreign keys: connected components.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const comps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = comps.get(root);
    if (list) list.push(i);
    else comps.set(root, [i]);
  }

  interface Block {
    members: number[];
    local: Map<number, { x: number; y: number }>;
    w: number;
    h: number;
  }
  const blocks: Block[] = [];
  for (const members of [...comps.values()].sort((a, b) => a[0] - b[0])) {
    if (members.length > 1) {
      const r = layoutComponent(members, model, dir, loops);
      blocks.push({ members, local: r.pos, w: r.width, h: r.height });
    } else {
      const nd = model.nodes[members[0]];
      blocks.push({ members, local: new Map([[members[0], { x: 0, y: 0 }]]), w: nd.width + (loops.has(members[0]) ? LOOP_ROOM : 0), h: nd.height });
    }
  }

  // Related components first (largest area), then the single tables, name order within equals.
  const related = (b: Block): number => (b.members.length > 1 ? 0 : 1);
  const order = blocks.map((_, i) => i).sort((a, b) => related(blocks[a]) - related(blocks[b]) || blocks[b].w * blocks[b].h - blocks[a].w * blocks[a].h || a - b);
  const area = blocks.reduce((s, b) => s + (b.w + PACK_GAP) * (b.h + PACK_GAP), 0);
  const maxW = blocks.reduce((mx, b) => Math.max(mx, b.w), 0);
  const targetW = snapUp(Math.max(maxW, Math.sqrt(area * 1.7)));
  const placed = packItems(
    order.map((i) => ({ w: blocks[i].w, h: blocks[i].h })),
    targetW,
    PACK_GAP,
  );

  const pos = new Array<{ x: number; y: number }>(n);
  order.forEach((bi, k) => {
    const b = blocks[bi];
    for (const [g, p] of b.local) pos[g] = { x: snap(placed[k].x + p.x), y: snap(placed[k].y + p.y) };
  });

  let width = 0;
  let height = 0;
  const nodes = model.nodes.map((nd) => {
    const p = pos[nd.index];
    width = Math.max(width, p.x + nd.width);
    height = Math.max(height, p.y + nd.height);
    return { index: nd.index, key: nd.key, x: p.x, y: p.y, width: nd.width, height: nd.height };
  });
  return { nodes, width, height, direction: dir };
}

// ---------------------------------------------------------------- dropping a dragged box

/**
 * The nearest lattice position to `want` where a `width` x `height` box keeps `gap` of clear space around it from
 * every other box, so a dropped table never lands on top of another. `want` itself when it is already free.
 */
export function resolveDrop(
  want: { x: number; y: number },
  size: { width: number; height: number },
  others: readonly { x: number; y: number; width: number; height: number }[],
  gap = G * 2,
): { x: number; y: number } {
  const x0 = snap(want.x);
  const y0 = snap(want.y);
  const free = (x: number, y: number): boolean => others.every((o) => x + size.width + gap <= o.x || o.x + o.width + gap <= x || y + size.height + gap <= o.y || o.y + o.height + gap <= y);
  if (free(x0, y0)) return { x: x0, y: y0 };
  for (let ring = 1; ring < 400; ring++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = x0 + dx * G;
        const y = y0 + dy * G;
        const d = dx * dx + dy * dy;
        if (d < bestD && free(x, y)) {
          best = { x, y };
          bestD = d;
        }
      }
    }
    if (best) return best;
  }
  return { x: x0, y: y0 };
}

// ---------------------------------------------------------------- expanding / collapsing a box

/** A box of the diagram (top-left corner and size), as the scene holds it. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clear space kept between two boxes that `reflowBoxes` moves apart (the same as around a dropped box). */
const REFLOW_GAP = G * 2;

/**
 * The boxes after some tables changed size without a new layout (a table was expanded or collapsed). `home` are the
 * boxes as they were laid out (and dragged), with the sizes of the layout; `sizes` the new sizes, in the same order.
 * Every box keeps its x. A box keeps its vertical gap to the box right above it in its column, so the boxes below a
 * table move down by as much as it grew, and up by as much as it shrank below its laid-out height (Expand All,
 * Re-layout, Collapse All leaves no holes). The result depends on `home` and `sizes` only, so going back to the old
 * sizes gives back the old boxes. A `pinned` box (the user moved it) stays where it was put, unless a box now covers
 * it. Afterwards no two boxes that share a column overlap. `home` itself when no size changed.
 */
export function reflowBoxes(home: Box[], sizes: readonly { width: number; height: number }[], pinned: (i: number) => boolean = () => false): Box[] {
  if (home.every((r, i) => r.w === sizes[i].width && r.h === sizes[i].height)) return home;
  const order = home.map((_, i) => i).sort((a, b) => home[a].y - home[b].y || home[a].x - home[b].x || a - b);
  const out: Box[] = new Array(home.length);
  const placed: number[] = [];
  const across = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w;
  /** `a` is fully above `b`, and they share a column. */
  const above = (a: Box, b: Box): boolean => across(a, b) && a.y + a.h <= b.y;
  for (const i of order) {
    const h0 = home[i];
    const box: Box = { x: h0.x, y: h0.y, w: sizes[i].width, h: sizes[i].height };
    if (!pinned(i)) {
      // It follows the box right above it in its column (also a pinned one; with ties, the lowest after the reflow),
      // up or down, at the same gap. Boxes further up only keep it clear (below).
      let nearest = -Infinity;
      let follow = -Infinity;
      for (const j of placed) {
        if (!above(home[j], h0)) continue;
        const bottom = home[j].y + home[j].h;
        const y = out[j].y + out[j].h + (h0.y - bottom);
        if (bottom > nearest) [nearest, follow] = [bottom, y];
        else if (bottom === nearest) follow = Math.max(follow, y);
      }
      if (follow > -Infinity) box.y = follow;
    }
    // Then below every box it would cover (a box that grew, a pinned box in the way). A gap of the home layout that is
    // smaller than the reflow gap stays as it is.
    for (let moved = true; moved; ) {
      moved = false;
      for (const j of placed) {
        const o = out[j];
        if (!across(o, box)) continue;
        const gap = above(home[j], h0) ? Math.min(REFLOW_GAP, h0.y - home[j].y - home[j].h) : REFLOW_GAP;
        if (box.y < o.y + o.h + gap && o.y < box.y + box.h + gap) {
          box.y = o.y + o.h + gap;
          moved = true;
        }
      }
    }
    out[i] = box;
    placed.push(i);
  }
  return out;
}
