import { describe, expect, it } from "vitest";
import { buildDiagram, DGM, type ColumnsMode, type DiagramInputObject, type DiagramOptions } from "./model";
import { LOOP_ROOM, layoutDiagram, packItems, reflowBoxes, resolveDrop, type Direction, type LayoutResult } from "./layout";
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

describe("reflowBoxes", () => {
  // a column of three boxes, a box beside the column, and a box below all of them
  const home = () => [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 0, y: 140, w: 100, h: 60 },
    { x: 0, y: 240, w: 100, h: 60 },
    { x: 200, y: 0, w: 100, h: 300 },
    { x: 50, y: 400, w: 200, h: 40 },
  ];
  const sizes = (boxes: { w: number; h: number }[], over: Record<number, number> = {}) => boxes.map((b, i) => ({ width: b.w, height: over[i] ?? b.h }));

  it("gives back the same boxes when no size changed", () => {
    const h = home();
    expect(reflowBoxes(h, sizes(h))).toBe(h);
  });

  it("moves the boxes below a grown box down by as much as it grew, and nothing beside it", () => {
    const h = home();
    const out = reflowBoxes(h, sizes(h, { 0: 300 }));
    expect(out.map((b) => b.y)).toEqual([0, 340, 440, 0, 600]);
    expect(out.map((b) => b.x)).toEqual(h.map((b) => b.x));
    expect(out[0].h).toBe(300);
  });

  it("depends on the home boxes and the sizes only: back at the home sizes, the boxes are home again", () => {
    const h = home();
    const snapshot = JSON.stringify(h);
    expect(reflowBoxes(h, sizes(h, { 0: 300, 1: 200 })).map((b) => b.y)).toEqual([0, 340, 580, 0, 740]);
    expect(JSON.stringify(h)).toBe(snapshot); // the home boxes are not touched
    expect(reflowBoxes(h, sizes(h, { 1: 200 })).map((b) => b.y)).toEqual([0, 140, 380, 0, 540]);
    expect(reflowBoxes(h, sizes(h))).toBe(h);
  });

  it("moves the boxes below a table up when it is smaller than it was laid out (expanded, re-laid out, collapsed)", () => {
    const h = home();
    // the box below the whole column also stays clear of the box beside the column, which did not move
    expect(reflowBoxes(h, sizes(h, { 0: 40 })).map((b) => b.y)).toEqual([0, 80, 180, 0, 400]);
    expect(reflowBoxes(h, sizes(h, { 0: 40, 3: 100 })).map((b) => b.y)).toEqual([0, 80, 180, 0, 340]);
  });

  it("keeps pinned boxes where they are when the boxes above them shrink, and the boxes below them follow them", () => {
    const h = home();
    const out = reflowBoxes(h, sizes(h, { 0: 40 }), (i) => i === 1);
    expect(out.map((b) => b.y)).toEqual([0, 140, 240, 0, 400]);
  });

  it("keeps a pinned box where the user put it unless a box now covers it", () => {
    const h = home();
    const pinned = (i: number) => i === 2;
    expect(reflowBoxes(h, sizes(h, { 0: 120 }), pinned)[2].y).toBe(240); // the column grew by 20: still clear
    const out = reflowBoxes(h, sizes(h, { 0: 300 }), pinned);
    expect(out[1].y).toBe(340);
    expect(out[2].y).toBe(340 + 60 + 20); // covered: it goes below with the reflow gap
  });

  it("never makes two boxes overlap on a real layout, whichever tables grow", () => {
    const m = buildDiagram(randomSchema(7, 120, { density: 1.2 }), opts);
    const l = layoutDiagram(m);
    const h = l.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
    const rand = rng(3);
    for (let round = 0; round < 5; round++) {
      const out = reflowBoxes(h, h.map((b) => ({ width: b.w, height: rand() < 0.2 ? b.h + 20 * Math.ceil(rand() * 40) : b.h })));
      expect(firstOverlap(out.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h })))).toBe("");
      out.forEach((b, i) => expect(b.y).toBeGreaterThanOrEqual(h[i].y));
    }
    // laid out with big boxes, then some of them shrink (and some grow), also with dragged boxes
    for (let round = 0; round < 5; round++) {
      const pinned = new Set([...h.keys()].filter(() => rand() < 0.1));
      const out = reflowBoxes(h, h.map((b) => ({ width: b.w, height: rand() < 0.3 ? Math.max(40, b.h - 20 * Math.ceil(rand() * 20)) : rand() < 0.1 ? b.h + 200 : b.h })), (i) => pinned.has(i));
      expect(firstOverlap(out.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h })))).toBe("");
      pinned.forEach((i) => expect(out[i].y).toBeGreaterThanOrEqual(h[i].y));
    }
  });
  it("moves the boxes after a box that grew wider to the right by as much as it grew, and back when it shrinks", () => {
    // a row of three boxes (three ranks of "LR", or one rank of "TB"), and a box below the first one
    const row = [
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 160, y: 0, w: 100, h: 60 },
      { x: 320, y: 20, w: 100, h: 60 },
      { x: 0, y: 120, w: 100, h: 60 },
    ];
    const wider = (over: Record<number, { width: number; height: number }>) => row.map((b, i) => over[i] ?? { width: b.w, height: b.h });
    const out = reflowBoxes(row, wider({ 0: { width: 200, height: 60 } }));
    expect(out.map((b) => b.x)).toEqual([0, 260, 420, 0]);
    expect(out.map((b) => b.y)).toEqual(row.map((b) => b.y)); // they stay in their rank
    // wider and taller (an expanded box): the boxes beside its new rows move right, the box below it moves down
    const open = reflowBoxes(row, wider({ 0: { width: 200, height: 160 } }));
    expect(open.map((b) => b.x)).toEqual([0, 260, 420, 0]);
    expect(open.map((b) => b.y)).toEqual([0, 0, 20, 220]);
    // back at the home sizes: the home boxes
    expect(reflowBoxes(row, wider({}))).toBe(row);
    // laid out wide, then narrower: the boxes after it move left again, and keep their home gap
    const narrow = reflowBoxes(row, wider({ 0: { width: 60, height: 60 } }));
    expect(narrow.map((b) => b.x)).toEqual([0, 120, 280, 0]);
  });

  it("keeps a pinned box where the user put it when a box beside it grows wider, unless the box now covers it", () => {
    const row = [
      { x: 0, y: 0, w: 100, h: 60 },
      { x: 160, y: 0, w: 100, h: 60 },
      { x: 320, y: 0, w: 100, h: 60 },
    ];
    const pinned = (i: number) => i === 1;
    expect(reflowBoxes(row, [{ width: 140, height: 60 }, ...row.slice(1).map((b) => ({ width: b.w, height: b.h }))], pinned).map((b) => b.x)).toEqual([0, 160, 320]);
    const covered = reflowBoxes(row, [{ width: 250, height: 60 }, ...row.slice(1).map((b) => ({ width: b.w, height: b.h }))], pinned);
    expect(covered.map((b) => b.x)).toEqual([0, 270, 430]); // after the box with the reflow gap; the next box follows it
  });

  it.each(["keys", "none"] as ColumnsMode[])("keeps the collapsed widths of %s mode on a real layout, and reflows wider expanded boxes without overlap", (columns) => {
    const objects = randomSchema(11, 80, { density: 1.2 });
    const o: DiagramOptions = { columns, showTypes: true };
    const closed = buildDiagram(objects, o);
    const l = layoutDiagram(closed);
    const h = l.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
    const rand = rng(5);
    const some = new Set(closed.nodes.filter((n) => n.hidden > 0 && rand() < 0.3).map((n) => n.key));
    const every = new Set(closed.nodes.filter((n) => n.hidden > 0).map((n) => n.key));
    expect(some.size).toBeGreaterThan(0);
    for (const expanded of [some, every]) {
      const open = buildDiagram(objects, { ...o, expanded });
      // only the expanded boxes change width, and none gets narrower
      open.nodes.forEach((n, i) => (expanded.has(n.key) ? expect(n.width).toBeGreaterThanOrEqual(closed.nodes[i].width) : expect(n.width).toBe(closed.nodes[i].width)));
      expect(open.nodes.some((n, i) => n.width > closed.nodes[i].width)).toBe(true);
      const out = reflowBoxes(h, open.nodes);
      expect(firstOverlap(out.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h }))), `${columns} ${expanded.size}`).toBe("");
      out.forEach((b, i) => {
        expect(b.x).toBeGreaterThanOrEqual(h[i].x);
        expect(b.y).toBeGreaterThanOrEqual(h[i].y);
      });
    }
    expect(reflowBoxes(h, closed.nodes)).toBe(h);
  });

  it.each([
    ["keys", "LR"],
    ["keys", "TB"],
    ["none", "LR"],
    ["none", "TB"],
  ] as [ColumnsMode, Direction][])("never makes two boxes overlap when random tables expand and collapse (%s, %s), and restores the boxes exactly", (columns, direction) => {
    const objects = randomSchema(23, 120, { density: 1.2 });
    const o: DiagramOptions = { columns, showTypes: true };
    const rand = rng(columns === "keys" ? 41 : 43);
    const pick = (nodes: { key: string; hidden: number }[], p: number) => new Set(nodes.filter((n) => n.hidden > 0 && rand() < p).map((n) => n.key));
    const closed = buildDiagram(objects, o);
    // laid out collapsed, and laid out with some tables expanded (Re-layout while they were open)
    const homes: { model: ReturnType<typeof buildDiagram> }[] = [{ model: closed }, { model: buildDiagram(objects, { ...o, expanded: pick(closed.nodes, 0.3) }) }];
    for (const { model } of homes) {
      const l = layoutDiagram(model, { direction });
      const h = l.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
      const pinnedSet = new Set([...h.keys()].filter(() => rand() < 0.1));
      const pinned = (i: number) => pinnedSet.has(i);
      const first = reflowBoxes(h, closed.nodes, pinned);
      for (let round = 0; round < 6; round++) {
        const open = buildDiagram(objects, { ...o, expanded: pick(closed.nodes, round % 2 ? 0.6 : 0.15) });
        const out = reflowBoxes(h, open.nodes, pinned);
        expect(firstOverlap(out.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h }))), `${columns} ${direction} round ${round}`).toBe("");
        out.forEach((b, i) => expect([b.w, b.h]).toEqual([open.nodes[i].width, open.nodes[i].height]));
        // a pinned box moves only away from a box that covers it (right or down)
        pinnedSet.forEach((i) => {
          expect(out[i].x).toBeGreaterThanOrEqual(h[i].x);
          expect(out[i].y).toBeGreaterThanOrEqual(h[i].y);
        });
      }
      // Collapse All: exactly the boxes of the first collapse, whatever happened in between
      expect(reflowBoxes(h, closed.nodes, pinned)).toEqual(first);
      expect(firstOverlap(first.map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h })))).toBe("");
    }
  });
});
