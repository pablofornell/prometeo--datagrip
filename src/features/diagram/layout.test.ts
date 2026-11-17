import { describe, expect, it } from "vitest";
import { buildDiagram, DGM, type ColumnsMode, type DiagramInputObject, type DiagramOptions } from "./model";
import { LOOP_ROOM, layoutDiagram, packItems, resolveDrop, type Direction, type LayoutResult } from "./layout";
import { randomSchema, rng, shopSchema } from "./sample";
import { budget } from "./bench";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (schema: string, name: string, ncols = 3, fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: Array.from({ length: ncols }, (_, i) => ({ name: `col_${i}`, typeName: "varchar(40)", isPk: i === 0 })),
  foreignKeys: fks,
});

const fk = (name: string, ref: string, col = "col_1") => ({ name, columns: [col], refSchema: "s", refTable: ref, refColumns: ["col_0"] });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The first pair of overlapping boxes as a message, or "" (a sweep over x keeps this fast on big layouts). */
function firstOverlap(boxes: readonly Box[]): string {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].x - boxes[b].x);
  for (let a = 0; a < order.length; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const p = boxes[order[a]];
      const q = boxes[order[b]];
      if (q.x >= p.x + p.width) break;
      if (overlaps(p, q)) return `boxes ${order[a]} and ${order[b]} overlap`;
    }
  }
  return "";
}

const byName = (l: LayoutResult, m: ReturnType<typeof buildDiagram>, name: string) => l.nodes[m.nodes.findIndex((n) => n.name === name)];

describe("layoutDiagram", () => {
  it("is deterministic for the same model, whatever the input order", () => {
    const objects = [obj("s", "parent"), obj("s", "child", 3, [fk("fk", "parent")]), obj("s", "orphan")];
    const a = layoutDiagram(buildDiagram(objects, opts));
    const b = layoutDiagram(buildDiagram([...objects].reverse(), opts));
    expect(a.nodes.map((n) => `${n.x},${n.y}`)).toEqual(b.nodes.map((n) => `${n.x},${n.y}`));
    const big = shopSchema();
    expect(layoutDiagram(buildDiagram(big, opts))).toEqual(layoutDiagram(buildDiagram(big, opts)));
  });

  it("places referenced tables before the tables that reference them (left for LR, above for TB)", () => {
    const m = buildDiagram([obj("s", "parent"), obj("s", "child", 3, [fk("fk", "parent")])], opts);
    const lr = layoutDiagram(m);
    expect(byName(lr, m, "parent").x + byName(lr, m, "parent").width).toBeLessThan(byName(lr, m, "child").x);
    const tb = layoutDiagram(m, { direction: "TB" });
    expect(byName(tb, m, "parent").y + byName(tb, m, "parent").height).toBeLessThan(byName(tb, m, "child").y);
    expect(tb.direction).toBe("TB");
  });

  it("handles reference cycles without failing", () => {
    const a = obj("s", "a", 3, [fk("fk", "b")]);
    const b = obj("s", "b", 3, [fk("fk", "a")]);
    const l = layoutDiagram(buildDiagram([a, b], opts));
    expect(l.nodes).toHaveLength(2);
    expect(Number.isFinite(l.width)).toBe(true);
    expect(firstOverlap(l.nodes)).toBe("");
  });

  it("keeps room on the right of a self-referencing table", () => {
    const m = buildDiagram([obj("s", "emp", 3, [fk("mgr", "emp")]), obj("s", "other")], opts);
    const l = layoutDiagram(m);
    const emp = byName(l, m, "emp");
    const other = byName(l, m, "other");
    // the loop (LOOP_ROOM wide) must not run into the neighbour
    expect(overlaps({ ...emp, width: emp.width + LOOP_ROOM }, other)).toBe(false);
  });

  it("puts a many-to-many join table after both of its parents", () => {
    const m = buildDiagram([obj("s", "a"), obj("s", "b"), obj("s", "ab", 3, [fk("fa", "a"), fk("fb", "b", "col_2")])], opts);
    const l = layoutDiagram(m);
    const j = byName(l, m, "ab");
    expect(byName(l, m, "a").x).toBeLessThan(j.x);
    expect(byName(l, m, "b").x).toBeLessThan(j.x);
  });

  it("puts every coordinate on the routing lattice", () => {
    const m = buildDiagram(shopSchema(), opts);
    for (const direction of ["LR", "TB"] as Direction[])
      for (const n of layoutDiagram(m, { direction }).nodes) {
        for (const v of [n.x, n.y, n.width, n.height]) expect(v % DGM.grid, `${n.key} ${v}`).toBe(0);
      }
  });

  it("never overlaps two boxes on random graphs, in both directions and every column mode", () => {
    const modes: ColumnsMode[] = ["all", "keys", "none"];
    for (let seed = 1; seed <= 6; seed++) {
      for (const n of [12, 40, 90]) {
        const objects = randomSchema(seed * 31 + n, n, { density: 0.8 + (seed % 3) * 0.6 });
        for (const direction of ["LR", "TB"] as Direction[]) {
          const mode = modes[(seed + n) % 3];
          const m = buildDiagram(objects, { columns: mode, showTypes: seed % 2 === 0 });
          const l = layoutDiagram(m, { direction });
          expect(l.nodes).toHaveLength(n);
          expect(firstOverlap(l.nodes), `seed ${seed} n ${n} ${direction} ${mode}`).toBe("");
        }
      }
    }
  });

  it("lays out 300 tables without overlap (and within budget on a quiet machine)", () => {
    const objects = randomSchema(7, 300, { density: 1.2 });
    const m = buildDiagram(objects, opts);
    const start = performance.now();
    const layout = layoutDiagram(m);
    const elapsed = performance.now() - start;
    expect(layout.nodes).toHaveLength(300);
    expect(firstOverlap(layout.nodes)).toBe("");
    expect(elapsed).toBeLessThan(budget(1500));
  });

  it("copes with a table that has a long column list and long names", () => {
    const wide: DiagramInputObject = { schema: "s", name: "w".repeat(80), kind: "table", columns: Array.from({ length: 120 }, (_, i) => ({ name: `column_${"n".repeat(i % 50)}`, typeName: "numeric(18,4)", isPk: i === 0 })), foreignKeys: [] };
    const m = buildDiagram([wide, obj("s", "x", 3, [fk("f", wide.name)])], opts);
    const l = layoutDiagram(m);
    expect(firstOverlap(l.nodes)).toBe("");
    expect(m.nodes[0].width).toBeLessThanOrEqual(DGM.maxW);
    expect(m.nodes[0].rows.length).toBeLessThanOrEqual(DGM.maxRows);
  });

  it("packs unrelated tables into a compact block without overlap", () => {
    const objects = Array.from({ length: 30 }, (_, i) => obj("s", `iso_${i}`, 2 + (i % 5)));
    const l = layoutDiagram(buildDiagram(objects, opts));
    expect(l.nodes).toHaveLength(30);
    expect(firstOverlap(l.nodes)).toBe("");
    // roughly landscape, not a tall strip
    expect(l.width).toBeGreaterThan(l.height * 0.8);
  });

  it("keeps separate components apart", () => {
    const objects = [obj("s", "a"), obj("s", "b", 3, [fk("f", "a")]), obj("s", "c"), obj("s", "d", 3, [fk("g", "c")])];
    const l = layoutDiagram(buildDiagram(objects, opts));
    expect(firstOverlap(l.nodes)).toBe("");
  });

  it("keeps linked tables close: a chain stays on one row", () => {
    const names = Array.from({ length: 6 }, (_, i) => `t${i}`);
    const objects = names.map((n, i) => obj("s", n, 3, i ? [fk(`f${i}`, names[i - 1])] : []));
    const m = buildDiagram(objects, opts);
    const l = layoutDiagram(m);
    const ys = new Set(l.nodes.map((n) => n.y));
    expect(ys.size).toBe(1);
  });
});

describe("packItems", () => {
  it("never overlaps and stays inside the strip width", () => {
    const r = rng(5);
    const items = Array.from({ length: 80 }, () => ({ w: 50 + Math.floor(r() * 300), h: 40 + Math.floor(r() * 400) }));
    const target = 1400;
    const pos = packItems(items, target, 20);
    const boxes = pos.map((p, i) => ({ x: p.x, y: p.y, width: items[i].w, height: items[i].h }));
    expect(firstOverlap(boxes)).toBe("");
    for (const b of boxes) expect(b.x + b.width).toBeLessThanOrEqual(target + 1e-9);
  });
});

describe("resolveDrop", () => {
  const others = [{ x: 0, y: 0, width: 200, height: 100 }];
  const size = { width: 100, height: 60 };
  it("keeps a free spot (on the lattice)", () => {
    expect(resolveDrop({ x: 503, y: 297 }, size, others)).toEqual({ x: 500, y: 300 });
  });
  it("moves a spot that lands on another box to the nearest free one", () => {
    const p = resolveDrop({ x: 50, y: 30 }, size, others);
    expect(overlaps({ ...p, ...size }, others[0])).toBe(false);
    expect(p.x % DGM.grid).toBe(0);
    expect(p.y % DGM.grid).toBe(0);
  });
});
