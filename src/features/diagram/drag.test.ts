import { describe, expect, it } from "vitest";
import { bestOf, budget } from "./bench";
import { DRAG_START, DragSession, clickToggles } from "./drag";
import { layoutDiagram } from "./layout";
import { buildDiagram, type DiagramModel } from "./model";
import { Router, routeEdges, type Rect, type RoutedEdge } from "./route";
import { randomSchema, shopSchema } from "./sample";
import { buildScene, type Scene } from "./svg";

function sceneOf(objects = shopSchema(), columns: "all" | "keys" | "none" = "all"): { model: DiagramModel; scene: Scene } {
  const model = buildDiagram(objects, { columns, showTypes: true });
  return { model, scene: buildScene(model, layoutDiagram(model)) };
}

/** An index whose table has some edges (and a few). */
const busyTable = (model: DiagramModel): number => {
  const deg = model.nodes.map(() => 0);
  for (const e of model.edges) if (e.from !== e.to) deg[e.from]++, deg[e.to]++;
  return deg.indexOf(Math.max(...deg.filter((d) => d <= 4)));
};

const shifted = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });

describe("DragSession", () => {
  it("routes a frame exactly like routing those edges from scratch around the moved box", () => {
    const { model, scene } = sceneOf(randomSchema(5, 80, { density: 1.2 }), "keys");
    const index = busyTable(model);
    const session = new DragSession(model, scene, index);
    session.preview = false;
    const walk = [shifted(scene.rects[index], 30, 20), shifted(scene.rects[index], 110, -60), shifted(scene.rects[index], 40, 90), scene.rects[index], shifted(scene.rects[index], -150, 30)];
    for (const rect of walk) {
      const got = session.move(rect);
      const rects = scene.rects.map((r, i) => (i === index ? rect : r));
      const want = routeEdges(model, rects, { only: session.edges, previous: scene.routes });
      for (const i of session.edges) expect(got[i], `edge ${i}`).toEqual(want[i]);
    }
  });

  it("keeps every other route and label as it was when the box is dropped", () => {
    const { model, scene } = sceneOf();
    const index = model.nodes.findIndex((n) => n.name === "orders");
    const session = new DragSession(model, scene, index);
    const rect = shifted(scene.rects[index], 60, 40);
    session.move(shifted(scene.rects[index], 30, 20));
    const { scene: next, changed } = session.finish(rect);
    expect(next.rects[index]).toEqual(rect);
    expect(next.rects.filter((_, i) => i !== index)).toEqual(scene.rects.filter((_, i) => i !== index));
    expect(next.routes).toHaveLength(scene.routes.length);
    model.edges.forEach((_, i) => {
      if (session.edges.has(i)) {
        expect(next.routes[i].from.y).toBeGreaterThan(0);
        expect(changed.has(i)).toBe(true);
      } else if (!changed.has(i)) {
        expect(next.routes[i]).toBe(scene.routes[i]); // not even copied
      } else {
        expect(next.routes[i].points).toEqual(scene.routes[i].points); // only its label may have moved
      }
    });
    // the dragged table's edges end at its new place
    for (const i of session.edges) {
      const r = next.routes[i];
      const e = model.edges[i];
      if (e.self) continue;
      const end = e.from === index ? r.from : r.to;
      expect(end.x === rect.x || end.x === rect.x + rect.w).toBe(true);
      expect(end.y).toBeGreaterThanOrEqual(rect.y);
      expect(end.y).toBeLessThanOrEqual(rect.y + rect.h);
    }
    expect(next.bounds.width).toBeGreaterThan(0);
  });

  it("never touches the scene it started from", () => {
    const { model, scene } = sceneOf();
    const before = JSON.stringify(scene);
    const index = model.nodes.findIndex((n) => n.name === "users");
    const session = new DragSession(model, scene, index);
    session.move(shifted(scene.rects[index], 200, 100));
    session.finish(shifted(scene.rects[index], 220, 100));
    expect(JSON.stringify(scene)).toBe(before);
  });

  it("copes with a box dragged far outside the lattice it was built on", () => {
    const { model, scene } = sceneOf(randomSchema(2, 40, { density: 1 }), "keys");
    const index = busyTable(model);
    const session = new DragSession(model, scene, index);
    session.preview = false;
    for (const [dx, dy] of [[4000, 0], [4000, 3000], [-3000, -2500], [0, 0]]) {
      const rect = shifted(scene.rects[index], dx, dy);
      const got = session.move(rect);
      const want = routeEdges(model, scene.rects.map((r, i) => (i === index ? rect : r)), { only: session.edges, previous: scene.routes });
      for (const i of session.edges) {
        // same ends and orthogonal; the lattice around a far box is not the one of a from-scratch router, so only the shape is compared
        expect(got[i].from).toEqual(want[i].from);
        expect(got[i].to).toEqual(want[i].to);
        for (let k = 1; k < got[i].points.length; k++) expect(got[i].points[k].x === got[i].points[k - 1].x || got[i].points[k].y === got[i].points[k - 1].y).toBe(true);
      }
    }
  });

  it("leaves the label of an untouched edge where it was, and places the labels of the moved ones", () => {
    const { model, scene } = sceneOf();
    const index = model.nodes.findIndex((n) => n.name === "customers");
    const { scene: next } = new DragSession(model, scene, index).finish(shifted(scene.rects[index], 0, 120));
    model.edges.forEach((e, i) => {
      if (e.from !== index && e.to !== index && next.routes[i] === scene.routes[i]) expect(next.routes[i].label).toBe(scene.routes[i].label);
    });
    expect(next.routes.filter((r) => r.label).length).toBeGreaterThan(0);
  });
});

describe("Router.moveBox", () => {
  it("leaves the lattice exactly as a router built on the moved boxes (walls and counts included)", () => {
    const { model, scene } = sceneOf(randomSchema(9, 70, { density: 1.2 }), "keys");
    const router = new Router(model, scene.rects);
    const rects = [...scene.rects];
    // several boxes, overlapping each other included, go back and forth
    const moves: [number, number, number][] = [[3, 40, 30], [4, -20, 10], [3, -40, -30], [10, 300, 0], [4, 20, -10], [10, -300, 0]];
    for (const [i, dx, dy] of moves) {
      rects[i] = shifted(rects[i], dx, dy);
      router.moveBox(i, rects[i]);
    }
    const fresh = new Router(model, rects);
    const a = router as unknown as { grid: { blocked: Uint8Array; near: Uint8Array; ox: number; oy: number; nx: number; ny: number } };
    const b = fresh as unknown as typeof a;
    expect([a.grid.ox, a.grid.oy, a.grid.nx, a.grid.ny]).toEqual([b.grid.ox, b.grid.oy, b.grid.nx, b.grid.ny]);
    expect([...a.grid.blocked]).toEqual([...b.grid.blocked]);
    expect([...a.grid.near]).toEqual([...b.grid.near]);
  });
});

// ---------------------------------------------------------------- benchmark-style (ratios always, absolute budgets under PROMETEO_BENCH=1)

describe("drag performance", () => {
  it("routes a drag frame in a small fraction of a full routing at 300 tables", () => {
    const model = buildDiagram(randomSchema(7, 300, { density: 1.3 }), { columns: "keys", showTypes: true });
    const scene = buildScene(model, layoutDiagram(model));
    const index = busyTable(model);

    const t0 = performance.now();
    const session = new DragSession(model, scene, index);
    const build = performance.now() - t0;

    const rect = scene.rects[index];
    const frames: number[] = [];
    const warm = 5;
    for (let f = 0; f < 40; f++) {
      const t = performance.now();
      session.move({ ...rect, x: rect.x + (f % 20) * 10, y: rect.y + (f % 12) * 10 });
      if (f >= warm) frames.push(performance.now() - t);
    }
    frames.sort((a, b) => a - b);
    const median = frames[Math.floor(frames.length / 2)];
    const p90 = frames[Math.floor(frames.length * 0.9)];

    const fullMs = bestOf(2, () => routeEdges(model, scene.rects));
    const best = frames[0];

    // What holds on any machine: a frame routes one table's edges, a full routing all of them. The fastest frame is
    // compared with the fastest full routing of the same run, so a busy machine slows both alike.
    const note = `best frame ${best.toFixed(1)} ms, median ${median.toFixed(1)} ms (p90 ${p90.toFixed(1)} ms, build ${build.toFixed(1)} ms, full route ${fullMs.toFixed(0)} ms)`;
    expect(best * 5, note).toBeLessThan(fullMs);
    expect(median * 2, note).toBeLessThan(fullMs);
    // target < 16 ms a frame: absolute budgets only on a quiet machine (PROMETEO_BENCH=1)
    expect(median, note).toBeLessThan(budget(40));
    expect(p90, note).toBeLessThan(budget(120));
    expect(build, note).toBeLessThan(budget(400));
  });

  it("a frame of a diagram too big to search is as cheap as bookkeeping", () => {
    const model = buildDiagram(randomSchema(7, 400, { density: 3 }), { columns: "keys", showTypes: true });
    const scene = buildScene(model, layoutDiagram(model));
    const index = busyTable(model);
    const session = new DragSession(model, scene, index);
    const rect = scene.rects[index];
    let last: RoutedEdge[] = [];
    const t = performance.now();
    for (let f = 0; f < 30; f++) last = session.move({ ...rect, x: rect.x + f * 10, y: rect.y + f * 10 });
    const per = (performance.now() - t) / 30;
    const fullMs = bestOf(2, () => routeEdges(model, scene.rects));
    expect(last.filter(Boolean).length).toBeGreaterThan(0);
    expect(per * 3, `frame ${per.toFixed(1)} ms, full route ${fullMs.toFixed(0)} ms`).toBeLessThan(fullMs);
    expect(per).toBeLessThan(budget(20));
  });
});

describe("clickToggles", () => {
  const press = { index: 4, x: 100, y: 200 };
  const click = (x: number, y: number, detail = 1, index: number | null = 4) => ({ index, x, y, detail });

  it("toggles on a click that did not move, on the row the button went down on", () => {
    expect(clickToggles(press, click(100, 200))).toBe(4);
    expect(clickToggles(press, click(100 + DRAG_START - 1, 200 - DRAG_START + 1))).toBe(4);
  });

  it("does not toggle after a drag, nor on another row, nor without a press on the row", () => {
    expect(clickToggles(press, click(100 + DRAG_START, 200))).toBeNull();
    expect(clickToggles(press, click(100, 200 - 40))).toBeNull();
    expect(clickToggles(press, click(100, 200, 1, 5))).toBeNull();
    expect(clickToggles(press, click(100, 200, 1, null))).toBeNull();
    expect(clickToggles(null, click(100, 200))).toBeNull();
  });

  it("toggles once for a double-click: the second click is left to the dblclick, which opens the table", () => {
    const clicks = [click(100, 200, 1), click(100, 200, 2)].map((c) => clickToggles(press, c));
    expect(clicks).toEqual([4, null]);
    expect(clickToggles(press, click(100, 200, 3))).toBeNull();
  });
});
