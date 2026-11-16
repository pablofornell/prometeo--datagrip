import { describe, expect, it } from "vitest";
import { layoutDiagram, type Direction } from "./layout";
import { buildDiagram, DGM, rowTop, type DiagramInputObject, type DiagramModel, type DiagramOptions } from "./model";
import { STUB, crossesRect, placeLabels, portOffset, routeEdges, type Rect, type RoutedEdge } from "./route";
import { randomSchema, shopSchema } from "./sample";

const opts: DiagramOptions = { columns: "all", showTypes: true };

function scene(objects: DiagramInputObject[], direction: Direction = "LR", o: DiagramOptions = opts): { model: DiagramModel; rects: Rect[]; routes: RoutedEdge[] } {
  const model = buildDiagram(objects, o);
  const layout = layoutDiagram(model, { direction });
  const rects = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
  const routes = routeEdges(model, rects);
  return { model, rects, routes };
}

/** Edges that pass through the interior of a table that is neither their start nor their end. */
function throughBoxes(model: DiagramModel, rects: Rect[], routes: RoutedEdge[]): string[] {
  const bad: string[] = [];
  for (const r of routes) {
    const e = model.edges[r.index];
    if (e.self) continue;
    rects.forEach((rc, i) => {
      if (i !== e.from && i !== e.to && crossesRect(r.points, rc)) bad.push(`${e.label} crosses ${model.nodes[i].name}`);
    });
  }
  return bad;
}

const segments = (r: RoutedEdge) => r.points.slice(1).map((p, i) => ({ a: r.points[i], b: p }));

describe("routeEdges", () => {
  it("draws only horizontal and vertical segments", () => {
    const { routes } = scene(shopSchema());
    for (const r of routes) for (const { a, b } of segments(r)) expect(a.x === b.x || a.y === b.y, `edge ${r.index}`).toBe(true);
  });

  it("never runs an edge through a table it does not connect (shop schema, both directions)", () => {
    for (const direction of ["LR", "TB"] as Direction[]) {
      const { model, rects, routes } = scene(shopSchema(), direction);
      expect(routes).toHaveLength(model.edges.length);
      expect(throughBoxes(model, rects, routes), direction).toEqual([]);
    }
  });

  it("never runs an edge through an unrelated table on random graphs", () => {
    for (let seed = 1; seed <= 5; seed++) {
      for (const direction of ["LR", "TB"] as Direction[]) {
        const { model, rects, routes } = scene(randomSchema(seed * 17, 45, { density: 1 }), direction);
        expect(throughBoxes(model, rects, routes), `seed ${seed} ${direction}`).toEqual([]);
      }
    }
  });

  it("starts and ends on the box sides at the rows of the foreign key columns", () => {
    const { model, rects, routes } = scene(shopSchema());
    const e = model.edges.findIndex((x) => x.label === "orders_customer_id_fkey");
    const r = routes[e];
    const edge = model.edges[e];
    const child = rects[edge.from];
    const parent = rects[edge.to];
    const cy = child.y + portOffset(model.nodes[edge.from], edge.columns);
    const py = parent.y + portOffset(model.nodes[edge.to], edge.refColumns);
    expect(r.points[0].y).toBe(cy);
    expect([child.x, child.x + child.w]).toContain(r.points[0].x);
    expect(r.points[r.points.length - 1].y).toBe(py);
    expect([parent.x, parent.x + parent.w]).toContain(r.points[r.points.length - 1].x);
    // and that row really is the customer_id row of the child
    const row = model.nodes[edge.from].rows.findIndex((c) => c.name === "customer_id");
    expect(cy - child.y).toBe(rowTop(row) + DGM.rowH / 2);
    // the first and last runs are straight stubs out of the boxes
    expect(Math.abs(r.points[1].x - r.points[0].x)).toBeGreaterThanOrEqual(STUB);
  });

  it("attaches to the footer row when the column is not drawn (compact mode)", () => {
    const { model, rects, routes } = scene(shopSchema(), "LR", { columns: "none", showTypes: false });
    const r = routes[0];
    const e = model.edges[0];
    const child = model.nodes[e.from];
    expect(r.points[0].y).toBe(rects[e.from].y + rowTop(child.rows.length) + DGM.rowH / 2);
  });

  it("keeps parallel edges between the same two tables on separate tracks", () => {
    // five children of one parent, stacked on the right: their vertical runs must not share a line
    const parent: DiagramInputObject = { schema: "s", name: "hub", kind: "table", columns: [{ name: "id", typeName: "int", isPk: true }], foreignKeys: [] };
    const kids = Array.from({ length: 5 }, (_, i): DiagramInputObject => ({
      schema: "s",
      name: `kid${i}`,
      kind: "table",
      columns: [{ name: "id", typeName: "int", isPk: true }, { name: "hub_id", typeName: "int", isPk: false }],
      foreignKeys: [{ name: `fk${i}`, columns: ["hub_id"], refSchema: "s", refTable: "hub", refColumns: ["id"] }],
    }));
    const { routes } = scene([parent, ...kids]);
    const vertical: { x: number; y0: number; y1: number; edge: number }[] = [];
    for (const r of routes) for (const { a, b } of segments(r)) if (a.x === b.x && a.y !== b.y) vertical.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), edge: r.index });
    for (let i = 0; i < vertical.length; i++)
      for (let j = i + 1; j < vertical.length; j++) {
        const p = vertical[i];
        const q = vertical[j];
        if (p.edge === q.edge || p.x !== q.x) continue;
        expect(Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0), `edges ${p.edge} and ${q.edge} overlap on x=${p.x}`).toBeLessThanOrEqual(DGM.grid); // at most the cell where they fan out of the shared stub
      }
  });

  it("draws a self reference as a loop on the right of its table", () => {
    const { model, rects, routes } = scene(shopSchema());
    const e = model.edges.findIndex((x) => x.self && model.nodes[x.from].name === "categories");
    const r = routes[e];
    const box = rects[model.edges[e].from];
    expect(r.self).toBe(true);
    expect(r.points).toHaveLength(4);
    expect(r.points[0].x).toBe(box.x + box.w);
    expect(r.points[1].x).toBeGreaterThan(box.x + box.w);
    expect(r.points[0].y).not.toBe(r.points[3].y);
  });

  it("is deterministic", () => {
    const a = scene(shopSchema());
    const b = scene(shopSchema());
    expect(JSON.stringify(a.routes)).toBe(JSON.stringify(b.routes));
  });

  it("re-routes only the requested edges and keeps the others as they were", () => {
    const { model, rects, routes } = scene(shopSchema());
    const node = model.nodes.findIndex((n) => n.name === "orders");
    const only = new Set(model.edges.flatMap((e, i) => (e.from === node || e.to === node ? [i] : [])));
    const moved = rects.map((r, i) => (i === node ? { ...r, y: r.y + 200 } : r));
    const next = routeEdges(model, moved, { only, previous: routes });
    model.edges.forEach((_, i) => {
      if (only.has(i)) expect(next[i]).not.toBe(routes[i]);
      else expect(next[i]).toBe(routes[i]);
    });
    // the moved table's edges follow it
    for (const i of only) {
      const e = model.edges[i];
      const end = e.from === node ? next[i].points[0] : next[i].points[next[i].points.length - 1];
      const box = moved[node];
      expect(end.y).toBeGreaterThanOrEqual(box.y);
      expect(end.y).toBeLessThanOrEqual(box.y + box.h);
    }
    expect(throughBoxes(model, moved, next)).toEqual([]);
  });

  it("falls back to plain orthogonal edges for a diagram too big to search, without freezing", () => {
    const m = buildDiagram(randomSchema(3, 600, { density: 2 }), opts);
    const layout = layoutDiagram(m);
    const rects = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
    const start = performance.now();
    const routes = routeEdges(m, rects);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(routes).toHaveLength(m.edges.length);
    for (const r of routes) for (const { a, b } of segments(r)) expect(a.x === b.x || a.y === b.y).toBe(true);
  });

  it("routes a 150 table diagram quickly", () => {
    const m = buildDiagram(randomSchema(3, 150, { density: 1.2 }), opts);
    const layout = layoutDiagram(m);
    const rects = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
    const start = performance.now();
    const routes = routeEdges(m, rects);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(routes.every((r) => r.points.length >= 2)).toBe(true);
  });
});

describe("placeLabels", () => {
  it("puts labels where they overlap neither a table nor another label", () => {
    const { model, rects, routes } = scene(shopSchema());
    placeLabels(model, routes, rects);
    const placed = routes.filter((r) => r.label);
    expect(placed.length).toBeGreaterThan(model.edges.length / 2);
    const box = (r: RoutedEdge) => ({ x: r.label!.x - r.label!.w / 2, y: r.label!.y - r.label!.h / 2, w: r.label!.w, h: r.label!.h });
    const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const r of placed) for (const rc of rects) expect(hit(box(r), rc), `label of edge ${r.index}`).toBe(false);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(hit(box(placed[i]), box(placed[j]))).toBe(false);
  });
});
