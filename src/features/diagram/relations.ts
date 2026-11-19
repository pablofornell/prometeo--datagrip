/**
 * The relations focus of the diagram: the neighbourhood of one table in the foreign key graph, by level, and a radial
 * layout of it (the table in the middle, each level on a ring around it). Pure, so both are testable; the modal
 * (`RelationsModal.tsx`) builds the model of the neighbourhood with `buildDiagram`, lays it out with `radialLayout`
 * and hands the layout to the same engine (routing) and renderer the main diagram uses.
 *
 * The graph is the whole schema snapshot, not what the diagram on screen shows: a diagram of a few tables only has
 * their direct neighbours, but the focus can reach further.
 */
import { DRAG_START } from "./drag";
import type { LayoutResult, NodeBox } from "./layout";
import { DGM, nodeKey, type DiagramInputObject, type DiagramModel } from "./model";

/** The deepest level the focus offers. */
export const RELATION_MAX_DEPTH = 10;

/** Table key (`nodeKey`) -> keys of the tables it has a foreign key to or from, sorted. */
export type Adjacency = Map<string, string[]>;

/**
 * The undirected foreign key graph of `objects`. A foreign key to a table that is not among the objects is ignored, and
 * so is a self reference (it relates a table to nothing else).
 */
export function buildAdjacency(objects: readonly DiagramInputObject[]): Adjacency {
  const sets = new Map<string, Set<string>>();
  for (const o of objects) sets.set(nodeKey(o.schema, o.name), new Set());
  for (const o of objects) {
    const from = nodeKey(o.schema, o.name);
    for (const fk of o.foreignKeys ?? []) {
      const to = nodeKey(fk.refSchema, fk.refTable);
      if (to === from || !sets.has(to)) continue;
      sets.get(from)!.add(to);
      sets.get(to)!.add(from);
    }
  }
  const adj: Adjacency = new Map();
  for (const [k, s] of sets) adj.set(k, [...s].sort());
  return adj;
}

/** The table has a foreign key to, or from, another table. */
export const hasRelations = (adj: Adjacency, key: string): boolean => (adj.get(key)?.length ?? 0) > 0;

/**
 * Breadth first search over the undirected graph: `levels[0]` is `[start]`, `levels[d]` the tables whose shortest
 * distance to it is `d` (both directions of a foreign key count, so a table that references the start and one that is
 * referenced by it are both on level 1). Stops after `maxDepth` levels, or when nothing new is reached; every level is
 * sorted. A table that is not in the graph has no neighbours.
 */
export function bfsLevels(adj: Adjacency, start: string, maxDepth = RELATION_MAX_DEPTH): string[][] {
  const levels: string[][] = [[start]];
  const seen = new Set<string>([start]);
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = [];
    for (const k of levels[d - 1]) {
      for (const n of adj.get(k) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    if (next.length === 0) break;
    levels.push(next.sort());
  }
  return levels;
}

// ---------------------------------------------------------------- click or drag

/** The button went down on table `index` at client point `x`, `y`. */
export interface NodePress {
  index: number;
  x: number;
  y: number;
}

/**
 * The table a click opens the relations focus of, or null. Only a click that stayed where the button went down (less
 * than `DRAG_START` away on both axes, the same table under the pointer) counts: a table that was dragged does not
 * open it. `detail` is the click count: the second click of a double-click does not open it again.
 */
export function clickOpensRelations(press: NodePress | null, click: { index: number | null; x: number; y: number; detail: number }): number | null {
  if (!press || click.index !== press.index || click.detail > 1) return null;
  if (Math.abs(click.x - press.x) >= DRAG_START || Math.abs(click.y - press.y) >= DRAG_START) return null;
  return press.index;
}

// ---------------------------------------------------------------- radial layout

/** Free space kept between two boxes of the same ring. */
const NODE_GAP = 70;
/** Free space between the boxes of one ring and those of the next (edges run through it). */
const RING_GAP = 130;
/** The same, between the sub-rings a crowded level is split into. */
const TRACK_GAP = 70;

const G = DGM.grid;
const snap = (v: number): number => Math.round(v / G) * G;

/** Smallest angle that keeps two circles of diameters `a` and `b` apart by `gap`, on a ring of radius `r`. */
const stepAngle = (a: number, b: number, r: number): number => 2 * Math.asin(Math.min(1, ((a + b) / 2 + NODE_GAP) / (2 * r)));

/** Angular steps between consecutive boxes (the last one back to the first) that fit on a ring of radius `r`. */
function steps(d: readonly number[], r: number): number[] {
  return d.map((v, i) => stepAngle(v, d[(i + 1) % d.length], r));
}

/** The smallest radius at which the boxes of diameters `d` fit side by side on one ring, not below `rMin`. */
function ringRadius(d: readonly number[], rMin: number): number {
  if (d.length < 2) return rMin;
  const fits = (r: number): boolean => steps(d, r).reduce((a, b) => a + b, 0) <= 2 * Math.PI;
  if (fits(rMin)) return rMin;
  let lo = rMin;
  let hi = Math.max(rMin * 2, d.reduce((a, b) => a + b + NODE_GAP, 0)); // the chord is shorter than the arc: always fits
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Mean of angles (radians), or 0 for none. */
function meanAngle(angles: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (const a of angles) {
    s += Math.sin(a);
    c += Math.cos(a);
  }
  return s === 0 && c === 0 ? 0 : Math.atan2(s, c);
}

/** The shortest signed difference between two angles. */
const angleDiff = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * Lays the model out as concentric rings: the table `center` in the middle and, on ring `n`, the tables of level
 * `level[i]` = `n`. The boxes of a ring are spaced so that no two touch (each box counts as the circle around it), a
 * ring is as far from the previous one as both need, and the boxes are ordered by where their neighbours on the
 * previous ring are, so related tables sit close and the lines between rings stay short. A level that would make a ring
 * much wider than its inner neighbour is split into a few sub-rings, so hundreds of tables spread over an annulus
 * instead of one huge circle. Deterministic, O(n log n) apart from the radius search, and every coordinate is a
 * multiple of `DGM.grid` (the router's lattice). The result starts at 0, 0 like `layoutDiagram`'s.
 */
export function radialLayout(model: DiagramModel, center: number, level: readonly number[]): LayoutResult {
  const n = model.nodes.length;
  const diam = model.nodes.map((nd) => Math.hypot(nd.width, nd.height));
  const cx = new Array<number>(n).fill(0);
  const cy = new Array<number>(n).fill(0);
  const angle = new Array<number>(n).fill(0);

  const parents: number[][] = model.nodes.map(() => []);
  for (const e of model.edges) {
    if (e.from === e.to) continue;
    if (level[e.from] === level[e.to] + 1) parents[e.from].push(e.to);
    else if (level[e.to] === level[e.from] + 1) parents[e.to].push(e.from);
  }

  const byLevel = new Map<number, number[]>();
  model.nodes.forEach((_, i) => {
    if (i === center) return;
    const l = level[i];
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(i);
  });

  let inner = diam[center] / 2; // outer reach of everything placed so far, from the centre
  for (const l of [...byLevel.keys()].sort((a, b) => a - b)) {
    const members = byLevel.get(l)!;
    // desired angle: towards the neighbours on the previous ring (the first ring has no preference: by name)
    const want = new Map<number, number>();
    for (const i of members) want.set(i, meanAngle(parents[i].map((p) => angle[p])));
    members.sort((a, b) => want.get(a)! - want.get(b)! || model.nodes[a].name.localeCompare(model.nodes[b].name) || a - b);

    const maxD = Math.max(...members.map((i) => diam[i]));
    const meanD = members.reduce((s, i) => s + diam[i], 0) / members.length;
    const rMin = inner + RING_GAP + maxD / 2;
    const single = ringRadius(members.map((i) => diam[i]), rMin);

    // sub-rings (tracks): one ring when it is not much wider than the room before it, else just enough of them
    const pitch = maxD + TRACK_GAP;
    const capacity = (r: number): number => Math.max(1, Math.floor((2 * Math.PI * r) / (meanD + NODE_GAP)));
    const radii: number[] = [rMin];
    if (single > rMin + 1.5 * pitch) {
      let total = capacity(rMin);
      while (total < members.length) {
        radii.push(rMin + radii.length * pitch);
        total += capacity(radii[radii.length - 1]);
      }
    }
    const tracks: number[][] = radii.map(() => []);
    if (radii.length === 1) tracks[0] = members;
    else {
      // deal the members to the tracks in proportion to their capacity, evenly along the order (each track spans the circle)
      const caps = radii.map(capacity);
      const sum = caps.reduce((a, b) => a + b, 0);
      const acc = caps.map(() => 0);
      for (const i of members) {
        let best = 0;
        caps.forEach((c, t) => {
          acc[t] += c / sum;
          if (acc[t] > acc[best] + 1e-9) best = t;
        });
        acc[best] -= 1;
        tracks[best].push(i);
      }
    }

    let reach = inner;
    let prev = inner; // outer edge of the previous track (or ring)
    radii.forEach((r0, t) => {
      const ids = tracks[t];
      if (ids.length === 0) return;
      const d = ids.map((i) => diam[i]);
      const tMax = Math.max(...d);
      const r = ringRadius(d, Math.max(r0, prev + (t === 0 ? RING_GAP : TRACK_GAP) + tMax / 2));
      const st = steps(d, r);
      const total = st.reduce((a, b) => a + b, 0);
      // spread the free angle evenly (an angle never goes past a half turn: the chord would shrink again)
      const extra = ids.length > 1 ? Math.max(0, 2 * Math.PI - total) / ids.length : 0;
      const at: number[] = [];
      let a = 0;
      ids.forEach((_, k) => {
        at.push(a);
        a += Math.min(Math.PI, st[k] + extra);
      });
      // turn the ring so that the boxes face the neighbours they want to be near (the first ring starts at the top, or at the sides when it holds one or two boxes)
      const turn = l === 1 ? (ids.length <= 2 ? 0 : -Math.PI / 2) : meanAngle(ids.map((i, k) => angleDiff(want.get(i)!, at[k])));
      ids.forEach((i, k) => {
        angle[i] = at[k] + turn;
        cx[i] = r * Math.cos(angle[i]);
        cy[i] = r * Math.sin(angle[i]);
      });
      prev = r + tMax / 2;
      reach = Math.max(reach, prev);
    });
    inner = reach;
  }

  // top-left corners on the lattice, shifted so that the layout starts at 0, 0
  const left = model.nodes.map((nd, i) => snap(cx[i] - nd.width / 2));
  const top = model.nodes.map((nd, i) => snap(cy[i] - nd.height / 2));
  const minX = n ? Math.min(...left) : 0;
  const minY = n ? Math.min(...top) : 0;
  const nodes: NodeBox[] = model.nodes.map((nd, i) => ({ index: nd.index, key: nd.key, x: left[i] - minX, y: top[i] - minY, width: nd.width, height: nd.height }));
  const width = nodes.reduce((m, b) => Math.max(m, b.x + b.width), 0);
  const height = nodes.reduce((m, b) => Math.max(m, b.y + b.height), 0);
  return { nodes, width, height, direction: "LR" };
}
