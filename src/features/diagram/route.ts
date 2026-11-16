/**
 * Orthogonal edge routing for the diagram. Every foreign key leaves the referencing table at the row of its first
 * foreign key column and enters the referenced table at the row of its first referenced column (the ports), each
 * with a short straight stub, and the part in between is found by an A* search on the `DGM.grid` lattice:
 *
 *  - table boxes (inflated by one lattice step, plus the room of a self-reference loop) are obstacles, so an edge
 *    never runs through a table it does not start or end at;
 *  - bends cost, and so does sharing a lattice point with an edge already routed (parallel edges end up on separate
 *    tracks, one step apart) or crossing one;
 *  - the search runs inside a window around the two ports and widens only when it fails, so a diagram of hundreds of
 *    tables stays fast, and a dragged table re-routes just its own edges (`only`).
 *
 * `routeEdges` routes a whole diagram in one go. A drag uses `Router` instead: it builds the obstacle lattice once,
 * and every frame only moves the dragged box on it (unblock the old rectangle, block the new one, refresh the wall
 * flags around them) and routes the edges that touch the box, so a frame costs a few searches and no allocation.
 *
 * Self references are drawn as a loop on the right of the box. Pure and deterministic (fixed edge order, ties broken
 * by insertion order).
 */
import { DGM, rowTop, type DiagramEdge, type DiagramModel, type DiagramNode } from "./model";
import { LOOP_ROOM } from "./layout";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = "L" | "R";

export interface Port extends Pt {
  side: Side;
}

export interface LabelBox {
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoutedEdge {
  /** Index into `model.edges`. */
  index: number;
  /** From the referencing table's port (the "many" end) to the referenced table's port (the "one" end). */
  points: Pt[];
  from: Port;
  to: Port;
  self: boolean;
  /** Where the foreign key name sits on the line without touching a table or another label, or null (no room). */
  label: LabelBox | null;
}

const G = DGM.grid;
/** Straight run out of a port before the edge may turn. */
export const STUB = 2 * G;

/** Above this many lattice points the router does not search (see `routeEdges`). */
const MAX_LATTICE_POINTS = 3_000_000;

const BEND = 40;
const OVERLAP = 90;
const CROSS = 22;
const NEAR_WALL = 5;
const SOFT_WALL = 700;

const dirX = [1, -1, 0, 0];
const dirY = [0, 0, -1, 1];

// ---------------------------------------------------------------- ports

/** Row indices (into `node.rows`) of the named columns that are drawn. */
export function rowsOf(node: DiagramNode, names: readonly string[]): number[] {
  const out: number[] = [];
  for (const n of names) {
    const i = node.rows.findIndex((r) => r.name === n);
    if (i >= 0) out.push(i);
  }
  return out;
}

/** Vertical offset inside the box where an edge attaches for these columns: their row, the footer row, or the header. */
export function portOffset(node: DiagramNode, names: readonly string[]): number {
  const rows = rowsOf(node, names);
  if (rows.length) return rowTop(rows[0]) + DGM.rowH / 2;
  if (node.hidden > 0) return rowTop(node.rows.length) + DGM.rowH / 2;
  return G;
}

/** The sides an edge should leave the child / enter the parent by, from their relative position. */
function chooseSides(c: Rect, p: Rect): [Side, Side] {
  const options: [Side, Side][] = [
    ["L", "R"],
    ["R", "L"],
    ["L", "L"],
    ["R", "R"],
  ];
  let best = options[0];
  let bestCost = Infinity;
  for (const [cs, ps] of options) {
    const cx = cs === "L" ? c.x - STUB : c.x + c.w + STUB;
    const px = ps === "L" ? p.x - STUB : p.x + p.w + STUB;
    const cd = cs === "L" ? -1 : 1;
    const pd = ps === "L" ? -1 : 1;
    let cost = Math.abs(cx - px);
    if ((px - cx) * cd < 0) cost += 120; // the child's stub points away from the parent
    if ((cx - px) * pd < 0) cost += 120; // and the parent's stub points away from the child
    if (cs === ps) cost += 40; // wraps around a box
    if (cost < bestCost - 1e-9) {
      best = [cs, ps];
      bestCost = cost;
    }
  }
  return best;
}

const portAt = (r: Rect, side: Side, y: number): Port => ({ x: side === "L" ? r.x : r.x + r.w, y, side });
const stubEnd = (p: Port): Pt => ({ x: p.side === "L" ? p.x - STUB : p.x + STUB, y: p.y });

// ---------------------------------------------------------------- A* on the lattice

/** Lattice points whose use count a routing pass raised (so a transient pass can give them back). */
interface Marks {
  h: number[];
  v: number[];
}

class Grid {
  readonly ox: number;
  readonly oy: number;
  readonly nx: number;
  readonly ny: number;
  readonly blocked: Uint8Array;
  readonly near: Uint8Array;
  readonly hUse: Uint8Array;
  readonly vUse: Uint8Array;
  // search scratch, shared by every search of this grid (stamped, never cleared)
  private cost = new Float32Array(0);
  private stamp = new Uint32Array(0);
  private prev = new Int32Array(0);
  private epoch = 0;
  private heapKey = new Float64Array(1 << 14);
  private heapVal = new Int32Array(1 << 14);

  private growHeap(): void {
    const k = new Float64Array(this.heapKey.length * 2);
    k.set(this.heapKey);
    const v = new Int32Array(this.heapVal.length * 2);
    v.set(this.heapVal);
    this.heapKey = k;
    this.heapVal = v;
  }

  /** `alloc` false: only the geometry (a diagram too big to search never reads the lattice). */
  constructor(rects: readonly Rect[], pad: number, alloc = true) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
    this.ox = Math.floor((minX - pad) / G) * G;
    this.oy = Math.floor((minY - pad) / G) * G;
    this.nx = Math.ceil((maxX + pad - this.ox) / G) + 1;
    this.ny = Math.ceil((maxY + pad - this.oy) / G) + 1;
    const n = alloc ? this.nx * this.ny : 0;
    this.blocked = new Uint8Array(n);
    this.near = new Uint8Array(n);
    this.hUse = new Uint8Array(n);
    this.vUse = new Uint8Array(n);
  }

  cx = (x: number): number => Math.round((x - this.ox) / G);
  cy = (y: number): number => Math.round((y - this.oy) / G);

  /** The lattice points strictly inside `r` inflated by one step, as an inclusive range (empty when x1 < x0 or y1 < y0). */
  private span(r: Rect): { x0: number; x1: number; y0: number; y1: number } {
    return {
      x0: Math.max(0, Math.floor((r.x - G - this.ox) / G) + 1),
      x1: Math.min(this.nx - 1, Math.ceil((r.x + r.w + G - this.ox) / G) - 1),
      y0: Math.max(0, Math.floor((r.y - G - this.oy) / G) + 1),
      y1: Math.min(this.ny - 1, Math.ceil((r.y + r.h + G - this.oy) / G) - 1),
    };
  }

  /** Blocks the lattice points strictly inside `r` inflated by one step (a count: boxes may overlap). */
  block(r: Rect, delta = 1): void {
    const { x0, x1, y0, y1 } = this.span(r);
    const { nx, blocked } = this;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * nx + x;
        if (delta > 0) {
          if (blocked[i] < 255) blocked[i]++;
        } else if (blocked[i] > 0) blocked[i]--;
      }
  }

  /** Undoes `block(r)` of the same rectangle (the wall flags are refreshed by `refreshWalls`). */
  unblock(r: Rect): void {
    this.block(r, -1);
  }

  /** Every lattice neighbour of the point is an obstacle (or off the grid). */
  sealed(x: number, y: number): boolean {
    const { nx, ny, blocked } = this;
    const open = (px: number, py: number): boolean => px >= 0 && py >= 0 && px < nx && py < ny && !blocked[py * nx + px];
    return !(open(x - 1, y) || open(x + 1, y) || open(x, y - 1) || open(x, y + 1));
  }

  /** Recomputes `near` (a free point next to an obstacle) in and around the blocked range of `r`; the rest is untouched. */
  refreshWalls(r: Rect): void {
    const { x0, x1, y0, y1 } = this.span(r);
    if (x1 < x0 || y1 < y0) return;
    const { nx, ny, blocked, near } = this;
    const ya = Math.max(0, y0 - 1);
    const yb = Math.min(ny - 1, y1 + 1);
    const xa = Math.max(0, x0 - 1);
    const xb = Math.min(nx - 1, x1 + 1);
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const i = y * nx + x;
        near[i] = !blocked[i] && ((x > 0 && blocked[i - 1] > 0) || (x < nx - 1 && blocked[i + 1] > 0) || (y > 0 && blocked[i - nx] > 0) || (y < ny - 1 && blocked[i + nx] > 0)) ? 1 : 0;
      }
  }

  /** Is `r` (with room for the stubs and a few steps of detour) inside the lattice? */
  contains(r: Rect, steps: number): boolean {
    return this.cx(r.x) - steps >= 0 && this.cy(r.y) - steps >= 0 && this.cx(r.x + r.w) + steps < this.nx && this.cy(r.y + r.h) + steps < this.ny;
  }

  /** Records a routed polyline (lattice points) so later edges keep off it; `undo` collects what `release` takes back. */
  mark(path: readonly number[], undo?: Marks): void {
    for (let k = 1; k < path.length - 1; k++) {
      const a = path[k];
      const horizontal = path[k - 1] === a - 1 || path[k - 1] === a + 1 || path[k + 1] === a - 1 || path[k + 1] === a + 1;
      const vertical = path[k - 1] === a - this.nx || path[k - 1] === a + this.nx || path[k + 1] === a - this.nx || path[k + 1] === a + this.nx;
      if (horizontal && this.hUse[a] < 255) {
        this.hUse[a]++;
        undo?.h.push(a);
      }
      if (vertical && this.vUse[a] < 255) {
        this.vUse[a]++;
        undo?.v.push(a);
      }
    }
  }

  /** Marks one lattice point as crossed by a horizontal run (the stub of a port). */
  markStub(x: number, y: number, undo?: Marks): void {
    if (x < 0 || y < 0 || x >= this.nx || y >= this.ny) return;
    const i = y * this.nx + x;
    if (this.hUse[i] < 255) {
      this.hUse[i]++;
      undo?.h.push(i);
    }
  }

  /** Takes back the marks collected in `undo`. */
  release(undo: Marks): void {
    for (const i of undo.h) this.hUse[i]--;
    for (const i of undo.v) this.vUse[i]--;
    undo.h.length = 0;
    undo.v.length = 0;
  }

  /**
   * Cheapest orthogonal path between two lattice points (start heading `startDir`), as lattice indices, or null.
   * `soft`: obstacles are very expensive instead of impassable (the last resort).
   */
  search(sx: number, sy: number, startDir: number, gx: number, gy: number, margin: number, soft: boolean): number[] | null {
    const { nx, ny, blocked, near, hUse, vUse } = this;
    const wx0 = Math.max(0, Math.min(sx, gx) - margin);
    const wy0 = Math.max(0, Math.min(sy, gy) - margin);
    const wx1 = Math.min(nx - 1, Math.max(sx, gx) + margin);
    const wy1 = Math.min(ny - 1, Math.max(sy, gy) + margin);
    const ww = wx1 - wx0 + 1;
    const wh = wy1 - wy0 + 1;
    const states = ww * wh * 4;
    if (this.cost.length < states) {
      this.cost = new Float32Array(states);
      this.stamp = new Uint32Array(states);
      this.prev = new Int32Array(states);
      this.epoch = 0;
    }
    const { cost, stamp, prev } = this;
    const ep = ++this.epoch;
    const goalCell = gy * nx + gx;
    const startCell = sy * nx + sx;

    // binary heap keyed on f, ties broken by insertion order (deterministic)
    let size = 0;
    let seq = 0;
    const push = (f: number, st: number): void => {
      if (size >= this.heapKey.length) this.growHeap();
      const keys = this.heapKey;
      const vals = this.heapVal;
      const key = f * 4194304 + (4194303 - (seq++ & 4194303)); // among equals the newest first: dives towards the goal
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p];
        vals[i] = vals[p];
        i = p;
      }
      keys[i] = key;
      vals[i] = st;
    };
    const pop = (): number => {
      const keys = this.heapKey;
      const vals = this.heapVal;
      const top = vals[0];
      size--;
      if (size > 0) {
        const key = keys[size];
        const val = vals[size];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= size) break;
          if (c + 1 < size && keys[c + 1] < keys[c]) c++;
          if (keys[c] >= key) break;
          keys[i] = keys[c];
          vals[i] = vals[c];
          i = c;
        }
        keys[i] = key;
        vals[i] = val;
      }
      return top;
    };

    const local = (cell: number): number => ((Math.floor(cell / nx) - wy0) * ww + ((cell % nx) - wx0)) * 4;
    const s0 = local(startCell) + startDir;
    stamp[s0] = ep;
    cost[s0] = 0;
    prev[s0] = -1;
    push((Math.abs(sx - gx) + Math.abs(sy - gy)) * G, startCell * 4 + startDir);

    while (size > 0) {
      const state = pop();
      const cell = state >> 2;
      const d = state & 3;
      const x = cell % nx;
      const y = (cell - x) / nx;
      const g = cost[local(cell) + d];
      if (cell === goalCell) {
        const path: number[] = [];
        let cur = state;
        for (;;) {
          path.push(cur >> 2);
          const p = prev[local(cur >> 2) + (cur & 3)];
          if (p < 0) break;
          cur = p;
        }
        return path.reverse();
      }
      for (let nd = 0; nd < 4; nd++) {
        if ((nd ^ 1) === d) continue;
        const px = x + dirX[nd];
        const py = y + dirY[nd];
        if (px < wx0 || px > wx1 || py < wy0 || py > wy1) continue;
        const n = py * nx + px;
        let c = G;
        if (blocked[n] && n !== goalCell) {
          if (!soft) continue;
          c += SOFT_WALL;
        }
        if (nd !== d) c += BEND;
        if (near[n]) c += NEAR_WALL;
        if (n !== goalCell) {
          if (nd < 2) {
            if (hUse[n]) c += OVERLAP;
            if (vUse[n]) c += CROSS;
          } else {
            if (vUse[n]) c += OVERLAP;
            if (hUse[n]) c += CROSS;
          }
        } else if (nd >= 2) c += BEND;
        const ng = g + c;
        const ns = local(n) + nd;
        if (stamp[ns] === ep && cost[ns] <= ng) continue;
        stamp[ns] = ep;
        cost[ns] = ng;
        prev[ns] = state;
        // Manhattan distance plus the bends the rest of the way needs at least: a horizontal run towards a goal on
        // another row turns twice (the goal is entered horizontally), a vertical one turns once.
        const hy = Math.abs(py - gy);
        push(ng + (Math.abs(px - gx) + hy) * G + (nd < 2 ? (hy > 0 ? 2 * BEND : 0) : BEND), n * 4 + nd);
      }
    }
    return null;
  }
}

/** Drops the points that lie in the middle of a straight run. */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
  }
  return out;
}

// ---------------------------------------------------------------- routing

export interface RouteOptions {
  /** Route only these edge indices; the rest are taken from `previous` (and kept out of the way). */
  only?: ReadonlySet<number>;
  previous?: readonly (RoutedEdge | undefined)[];
}

/** The loop a self-referencing foreign key draws on the right of its table; `k` is the loop's ordinal on that table. */
function selfLoop(e: DiagramEdge, node: DiagramNode, r: Rect, k: number): RoutedEdge["points"] {
  let ya = r.y + portOffset(node, e.columns);
  let yb = r.y + portOffset(node, e.refColumns);
  if (ya === yb) {
    ya -= 6;
    yb += 6;
  }
  const ext = STUB + 4 + Math.min(k, 2) * 8;
  const x = r.x + r.w;
  return [
    { x, y: ya },
    { x: x + ext, y: ya },
    { x: x + ext, y: yb },
    { x, y: yb },
  ];
}

/** Lattice points a stored route passes through (the polyline has corners only: every point in between is added). */
function latticeOf(grid: Grid, points: readonly Pt[]): number[] {
  const lat = points.map((p) => grid.cy(p.y) * grid.nx + grid.cx(p.x));
  const full: number[] = [];
  for (let k = 0; k < lat.length; k++) {
    if (k === 0) {
      full.push(lat[0]);
      continue;
    }
    let a = lat[k - 1];
    const b = lat[k];
    if (Math.floor(a / grid.nx) !== Math.floor(b / grid.nx) && (b - a) % grid.nx !== 0) {
      full.push(b); // off the lattice: not a straight run
      continue;
    }
    const step = Math.abs(b - a) >= grid.nx ? (b > a ? grid.nx : -grid.nx) : b > a ? 1 : -1;
    while (a !== b) {
      a += step;
      full.push(a);
    }
  }
  return full;
}

/** Extra lattice room added around the boxes when a dragged box leaves the lattice and it has to be rebuilt. */
const REBUILD_SLACK = 30 * G;
/** Widest search window (lattice steps around the two ports) of a preview route. */
const PREVIEW_MARGIN = 80;
/** Steps of room a box needs around it inside the lattice (stubs, one wall step, some detour). */
const BOX_ROOM = 6;

/**
 * The router of one diagram: the obstacle lattice (built once) and the routes laid on it. `routeEdges` is the one-shot
 * use; a drag keeps the router, moves the dragged box on it (`moveBox`) and routes just the edges that touch it
 * (`route`, transient) every frame.
 */
export class Router {
  private grid!: Grid;
  private huge = false;
  private readonly loops = new Set<number>();
  /** The boxes (blocked on the lattice) and the same with the room of a self-reference loop (the extent of the lattice). */
  private readonly rects: Rect[];
  private readonly extent: Rect[];
  /** Routes that stay as they are: they occupy their tracks, and come back after a rebuild of the lattice. */
  private held: RoutedEdge[] = [];
  /**
   * A draft for a drag frame: the widest searches (the whole lattice, a walled-in port forcing a soft search across it)
   * are capped at `PREVIEW_MARGIN`, so no single frame can take long. The drop turns it off and routes exactly.
   */
  preview = false;

  constructor(
    private readonly model: DiagramModel,
    rects: readonly Rect[],
  ) {
    for (const e of model.edges) if (e.from === e.to) this.loops.add(e.from);
    this.rects = [...rects];
    this.extent = rects.map((r, i) => this.roomOf(r, i));
    this.build(14 * G);
  }

  private roomOf(r: Rect, i: number): Rect {
    return this.loops.has(i) ? { ...r, w: r.w + LOOP_ROOM } : r;
  }

  private build(pad: number): void {
    // A diagram too big for a lattice search (hundreds of tables, tens of thousands of pixels) gets plain Z-shaped
    // edges: still orthogonal and ported, just not steered around the boxes (and it needs no lattice at all).
    const probe = new Grid(this.extent, pad, false);
    this.huge = probe.nx * probe.ny > MAX_LATTICE_POINTS;
    this.grid = this.huge ? probe : new Grid(this.extent, pad);
    if (this.huge) return;
    // (a self-reference loop is not an obstacle: other edges may cross it, and edges into the same port merge with it)
    for (const r of this.rects) this.grid.block(r);
    for (const r of this.rects) this.grid.refreshWalls(r);
    for (const r of this.held) this.markHeld(r);
  }

  private markHeld(r: RoutedEdge): void {
    if (r.self) return;
    this.grid.mark(latticeOf(this.grid, r.points));
  }

  /** Routes that stay as they were (`previous` minus `except`): they occupy their tracks and are kept out of the way. */
  hold(previous: readonly (RoutedEdge | undefined)[], except: ReadonlySet<number>): void {
    previous.forEach((r, i) => {
      if (!r || except.has(i)) return;
      this.held.push(r);
      if (!this.huge) this.markHeld(r);
    });
  }

  /** Moves a box on the lattice: its old rectangle is freed and the new one blocked. */
  moveBox(index: number, rect: Rect): void {
    const old = this.rects[index];
    this.rects[index] = rect;
    const room = this.roomOf(rect, index);
    this.extent[index] = room;
    if (this.huge) return;
    if (!this.grid.contains(room, BOX_ROOM)) {
      this.build(14 * G + REBUILD_SLACK); // dragged out of the lattice: a bigger one around the new place
      return;
    }
    this.grid.unblock(old);
    this.grid.block(rect);
    this.grid.refreshWalls(old);
    this.grid.refreshWalls(rect);
  }

  /**
   * Routes the edges of `edges` (every edge when absent) between the current boxes. With `transient` the tracks they
   * take are given back afterwards, so the next call starts from the held routes alone (a drag frame).
   */
  route(edges?: ReadonlySet<number>, transient = false): RoutedEdge[] {
    const { model, grid, huge } = this;
    const rects = this.rects;
    const result: RoutedEdge[] = new Array(model.edges.length);
    const undo: Marks | undefined = transient ? { h: [], v: [] } : undefined;

    interface Job {
      index: number;
      child: Rect;
      parent: Rect;
      dist: number;
    }
    const jobs: Job[] = [];
    const loopOrdinal = new Map<number, number>();
    model.edges.forEach((e, index) => {
      if (edges && !edges.has(index)) return;
      const child = rects[e.from];
      const parent = rects[e.to];
      if (e.self) {
        const k = loopOrdinal.get(e.from) ?? 0;
        loopOrdinal.set(e.from, k + 1);
        const pts = selfLoop(e, model.nodes[e.from], child, k);
        result[index] = { index, points: pts, from: { ...pts[0], side: "R" }, to: { ...pts[3], side: "R" }, self: true, label: null };
        return;
      }
      jobs.push({ index, child, parent, dist: Math.abs(child.x - parent.x) + Math.abs(child.y - parent.y) });
    });
    jobs.sort((a, b) => a.dist - b.dist || a.index - b.index);

    for (const job of jobs) {
      const e = model.edges[job.index];
      const [cs, ps] = chooseSides(job.child, job.parent);
      const from = portAt(job.child, cs, job.child.y + portOffset(model.nodes[e.from], e.columns));
      const to = portAt(job.parent, ps, job.parent.y + portOffset(model.nodes[e.to], e.refColumns));
      const a = stubEnd(from);
      const b = stubEnd(to);
      const sx = grid.cx(a.x);
      const sy = grid.cy(a.y);
      const gx = grid.cx(b.x);
      const gy = grid.cy(b.y);

      let path: number[] | null = null;
      if (huge) {
        const mx = Math.round((a.x + b.x) / 2 / G) * G;
        result[job.index] = { index: job.index, points: simplify([from, a, { x: mx, y: a.y }, { x: mx, y: b.y }, b, to]), from, to, self: false, label: null };
        continue;
      }
      // A port whose stub end is walled in cannot be reached by a hard search: go straight to the soft one.
      const full = this.preview ? PREVIEW_MARGIN : Math.max(grid.nx, grid.ny);
      const widening: (readonly [number, boolean])[] = this.preview ? [[24, false], [PREVIEW_MARGIN, false], [PREVIEW_MARGIN, true]] : [[24, false], [80, false], [full, false], [full, true]];
      const tries: (readonly [number, boolean])[] = grid.sealed(sx, sy) || grid.sealed(gx, gy) ? [[full, true]] : widening;
      for (const [margin, soft] of tries) {
        path = grid.search(sx, sy, cs === "L" ? 1 : 0, gx, gy, margin, soft);
        if (path) break;
      }
      const mid: Pt[] = (path ?? [sy * grid.nx + sx, gy * grid.nx + gx]).map((c) => ({ x: grid.ox + (c % grid.nx) * G, y: grid.oy + Math.floor(c / grid.nx) * G }));
      if (path) grid.mark(path, undo);
      grid.markStub(sx, sy, undo);
      grid.markStub(gx, gy, undo);
      // ports off the lattice (hand-placed boxes) join the lattice with a short jog
      const points = simplify([from, { x: mid[0].x, y: from.y }, ...mid, { x: mid[mid.length - 1].x, y: to.y }, to]);
      result[job.index] = { index: job.index, points, from, to, self: false, label: null };
    }
    if (undo) grid.release(undo);
    return result;
  }
}

export function routeEdges(model: DiagramModel, rects: readonly Rect[], opts: RouteOptions = {}): RoutedEdge[] {
  const router = new Router(model, rects);
  const { only, previous } = opts;
  // edges that stay as they were still occupy their tracks
  if (only && previous) router.hold(previous, only);
  const result = router.route(only);
  if (only && previous) {
    for (let i = 0; i < model.edges.length; i++) if (!only.has(i) && previous[i]) result[i] = previous[i]!;
  }
  return result;
}

// ---------------------------------------------------------------- labels

const LABEL_H = 16;
const labelWidth = (text: string): number => Math.ceil(text.length * 6.1) + 12;

const overlaps = (a: LabelBox, b: Rect, pad: number): boolean => Math.abs(a.x - (b.x + b.w / 2)) < a.w / 2 + b.w / 2 + pad && Math.abs(a.y - (b.y + b.h / 2)) < a.h / 2 + b.h / 2 + pad;

/**
 * Gives every routed edge the spot of its label: on a segment long enough to hold it, closest to the middle of the
 * line, where it overlaps neither a table box, nor the markers at the ports, nor another label. Edges whose label
 * finds no room get none. With `only`, just those edges are placed again and every other label stays where it is
 * (and is avoided), so a dragged table does not shuffle the labels of the whole diagram.
 */
export function placeLabels(model: DiagramModel, routes: RoutedEdge[], rects: readonly Rect[], only?: ReadonlySet<number>): void {
  const taken: Rect[] = [];
  if (only) {
    for (const r of routes) {
      if (!r || only.has(r.index) || !r.label) continue;
      taken.push({ x: r.label.x - r.label.w / 2, y: r.label.y - r.label.h / 2, w: r.label.w, h: r.label.h });
    }
  }
  for (const r of routes) {
    if (!r) continue;
    if (only && !only.has(r.index)) continue;
    r.label = null;
    const text = model.edges[r.index].label;
    if (!text) continue;
    const w = labelWidth(text);
    const pts = r.points;
    let length = 0;
    const lens: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
      lens.push(l);
      length += l;
    }
    // candidate centres: the middle of every segment, then points along it, nearest the line's middle first
    const cands: { box: LabelBox; d: number }[] = [];
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const l = lens[i - 1];
      const horizontal = a.y === b.y;
      const room = horizontal ? l - 2 * G - w : l - 2 * G - LABEL_H;
      if (room >= 0) {
        for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          const off = G + (horizontal ? w / 2 : LABEL_H / 2) + room * t;
          const f = l === 0 ? 0 : off / l;
          const box = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w, h: LABEL_H };
          cands.push({ box, d: Math.abs(run + off - length / 2) });
        }
      }
      run += l;
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands) {
      if (rects.some((rc) => overlaps(c.box, rc, 4))) continue;
      if (taken.some((t) => overlaps(c.box, t, 2))) continue;
      r.label = c.box;
      taken.push({ x: c.box.x - c.box.w / 2, y: c.box.y - c.box.h / 2, w: c.box.w, h: c.box.h });
      break;
    }
  }
}

/** Does the polyline pass through the interior of `r`? (Used by the tests and the self-check of the router.) */
export function crossesRect(points: readonly Pt[], r: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true;
  }
  return false;
}
