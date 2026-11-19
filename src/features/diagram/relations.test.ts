import { describe, expect, it } from "vitest";
import { DRAG_START } from "./drag";
import { buildDiagram, nodeKey, type DiagramInputObject, type DiagramOptions } from "./model";
import { RELATION_MAX_DEPTH, bfsLevels, buildAdjacency, clickOpensRelations, hasRelations, radialLayout } from "./relations";
import { randomSchema, shopSchema } from "./sample";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (name: string, refs: string[] = [], schema = "s"): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: [
    { name: "id", typeName: "int", isPk: true },
    ...refs.map((_, i) => ({ name: `r${i}`, typeName: "int", isPk: false })),
  ],
  foreignKeys: refs.map((ref, i) => ({ name: `${name}_${ref}_${i}`, columns: [`r${i}`], refSchema: schema, refTable: ref, refColumns: ["id"] })),
});

const k = (name: string, schema = "s"): string => nodeKey(schema, name);
const names = (level: string[]): string[] => level.map((x) => x.split("\u0000")[1]);

describe("buildAdjacency / hasRelations", () => {
  it("links both directions of a foreign key", () => {
    const adj = buildAdjacency([obj("order", ["customer"]), obj("customer"), obj("lonely")]);
    expect(adj.get(k("order"))).toEqual([k("customer")]);
    expect(adj.get(k("customer"))).toEqual([k("order")]);
    expect(hasRelations(adj, k("order"))).toBe(true);
    expect(hasRelations(adj, k("customer"))).toBe(true);
    expect(hasRelations(adj, k("lonely"))).toBe(false);
  });

  it("ignores a self reference and a reference to a table that is not there", () => {
    const adj = buildAdjacency([obj("emp", ["emp"]), obj("task", ["ghost"])]);
    expect(hasRelations(adj, k("emp"))).toBe(false);
    expect(hasRelations(adj, k("task"))).toBe(false);
    expect(hasRelations(adj, k("ghost"))).toBe(false);
  });

  it("does not repeat a neighbour reached by several foreign keys", () => {
    const adj = buildAdjacency([obj("a", ["b", "b"]), obj("b", ["a"])]);
    expect(adj.get(k("a"))).toEqual([k("b")]);
  });

  it("keeps schemas apart and follows a foreign key across them", () => {
    const a: DiagramInputObject = { ...obj("t", [], "one"), foreignKeys: [{ name: "x", columns: ["id"], refSchema: "two", refTable: "t", refColumns: ["id"] }] };
    const adj = buildAdjacency([a, obj("t", [], "two")]);
    expect(adj.get(k("t", "one"))).toEqual([k("t", "two")]);
  });
});

describe("bfsLevels", () => {
  // a -> b -> c -> d, e -> b (e references b), f is alone
  const objs = [obj("a", ["b"]), obj("b", ["c"]), obj("c", ["d"]), obj("d"), obj("e", ["b"]), obj("f")];
  const adj = buildAdjacency(objs);

  it("level 1 holds the tables it references and the tables that reference it", () => {
    const levels = bfsLevels(adj, k("b"));
    expect(names(levels[1])).toEqual(["a", "c", "e"]);
  });

  it("each next level adds the neighbours of the previous one", () => {
    const levels = bfsLevels(adj, k("b"));
    expect(levels.map(names)).toEqual([["b"], ["a", "c", "e"], ["d"]]);
  });

  it("stops at maxDepth", () => {
    expect(bfsLevels(adj, k("a"), 1).map(names)).toEqual([["a"], ["b"]]);
    expect(bfsLevels(adj, k("a"), 2).map(names)).toEqual([["a"], ["b"], ["c", "e"]]);
  });

  it("a table without relations has only itself", () => {
    expect(bfsLevels(adj, k("f")).map(names)).toEqual([["f"]]);
  });

  it("a cycle puts every table on its shortest distance, once", () => {
    const ring = buildAdjacency([obj("a", ["b"]), obj("b", ["c"]), obj("c", ["d"]), obj("d", ["e"]), obj("e", ["a"])]);
    expect(bfsLevels(ring, k("a")).map(names)).toEqual([["a"], ["b", "e"], ["c", "d"]]);
    const mutual = buildAdjacency([obj("x", ["y"]), obj("y", ["x"])]);
    expect(bfsLevels(mutual, k("x")).map(names)).toEqual([["x"], ["y"]]);
  });

  it("a self reference does not add a level or repeat the table", () => {
    const self = buildAdjacency([obj("emp", ["emp", "dept"]), obj("dept")]);
    expect(bfsLevels(self, k("emp")).map(names)).toEqual([["emp"], ["dept"]]);
  });

  it("never goes past the depth limit", () => {
    const chain = Array.from({ length: 30 }, (_, i) => obj(`t${i}`, i < 29 ? [`t${i + 1}`] : []));
    expect(bfsLevels(buildAdjacency(chain), k("t0"))).toHaveLength(RELATION_MAX_DEPTH + 1);
  });

  it("works on a schema with views, many to many tables and loops", () => {
    const all = buildAdjacency(shopSchema());
    const levels = bfsLevels(all, k("orders", "shop"));
    expect(names(levels[1]).sort()).toEqual(["addresses", "customers", "invoices", "order_coupons", "order_items", "payments", "shipments"]);
    const seen = levels.flat();
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("clickOpensRelations", () => {
  const press = { index: 3, x: 100, y: 100 };
  it("opens on a click that stayed put on the same table", () => {
    expect(clickOpensRelations(press, { index: 3, x: 101, y: 100, detail: 1 })).toBe(3);
    expect(clickOpensRelations(press, { index: 3, x: 100, y: 100, detail: 1 })).toBe(3);
  });
  it("does not open after a drag, on another table, with no press or on the second click", () => {
    expect(clickOpensRelations(press, { index: 3, x: 100 + DRAG_START, y: 100, detail: 1 })).toBeNull();
    expect(clickOpensRelations(press, { index: 3, x: 100, y: 100 - DRAG_START, detail: 1 })).toBeNull();
    expect(clickOpensRelations(press, { index: 4, x: 100, y: 100, detail: 1 })).toBeNull();
    expect(clickOpensRelations(press, { index: null, x: 100, y: 100, detail: 1 })).toBeNull();
    expect(clickOpensRelations(null, { index: 3, x: 100, y: 100, detail: 1 })).toBeNull();
    expect(clickOpensRelations(press, { index: 3, x: 100, y: 100, detail: 2 })).toBeNull();
  });
});

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function firstOverlap(boxes: readonly Box[]): string {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j])) return `boxes ${i} and ${j} overlap`;
  return "";
}

/** The model and radial layout of the neighbourhood of `center` down to `depth`. */
function radial(objects: DiagramInputObject[], center: string, depth: number, schema = "s", columns: DiagramOptions["columns"] = "all") {
  const adj = buildAdjacency(objects);
  const levels = bfsLevels(adj, k(center, schema), depth);
  const lv = new Map<string, number>();
  levels.forEach((keys, d) => keys.forEach((key) => lv.set(key, d)));
  const model = buildDiagram(objects.filter((o) => lv.has(nodeKey(o.schema, o.name))), { ...opts, columns });
  const c = model.nodes.findIndex((n) => n.key === k(center, schema));
  const layout = radialLayout(model, c, model.nodes.map((n) => lv.get(n.key)!));
  return { model, layout, c, levels };
}

describe("radialLayout", () => {
  const dist = (b: Box, a: Box): number => Math.hypot(b.x + b.width / 2 - (a.x + a.width / 2), b.y + b.height / 2 - (a.y + a.height / 2));

  it("puts a lone table at the origin", () => {
    const { layout } = radial([obj("a")], "a", 1);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].x).toBe(0);
    expect(layout.nodes[0].y).toBe(0);
  });

  it("surrounds the centre with its neighbours without overlaps", () => {
    const objs = [obj("hub"), ...Array.from({ length: 6 }, (_, i) => obj(`spoke${i}`, ["hub"]))];
    const { layout, c } = radial(objs, "hub", 1);
    expect(layout.nodes).toHaveLength(7);
    expect(firstOverlap(layout.nodes)).toBe("");
    // all the spokes are about the same distance from the hub, and on every side of it
    const hub = layout.nodes[c];
    const d = layout.nodes.filter((_, i) => i !== c).map((b) => dist(b, hub));
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(20);
    const hx = hub.x + hub.width / 2;
    const hy = hub.y + hub.height / 2;
    const side = (f: (b: Box) => boolean): boolean => layout.nodes.some((b, i) => i !== c && f(b));
    expect(side((b) => b.x + b.width / 2 < hx)).toBe(true);
    expect(side((b) => b.x + b.width / 2 > hx)).toBe(true);
    expect(side((b) => b.y + b.height / 2 < hy)).toBe(true);
    expect(side((b) => b.y + b.height / 2 > hy)).toBe(true);
  });

  it("puts one table in the middle of two neighbours (one on each side)", () => {
    const { layout, c } = radial([obj("a", ["b"]), obj("b"), obj("c", ["b"])], "b", 1);
    expect(firstOverlap(layout.nodes)).toBe("");
    const mid = layout.nodes[c];
    const others = layout.nodes.filter((_, i) => i !== c);
    expect(Math.abs(dist(others[0], mid) - dist(others[1], mid))).toBeLessThan(20);
  });

  it("puts each level farther from the centre than the one before", () => {
    // chain: a - b - c - d - e, centred on c; levels: c | b d | a e
    const objs = [obj("a", ["b"]), obj("b", ["c"]), obj("c"), obj("d", ["c"]), obj("e", ["d"])];
    const { layout, model, c, levels } = radial(objs, "c", 2);
    expect(levels).toHaveLength(3);
    const centre = layout.nodes[c];
    const at = (name: string): Box => layout.nodes[model.nodes.findIndex((n) => n.name === name)];
    const d1 = Math.min(dist(at("b"), centre), dist(at("d"), centre));
    const d2 = Math.min(dist(at("a"), centre), dist(at("e"), centre));
    expect(d2).toBeGreaterThan(d1);
    expect(firstOverlap(layout.nodes)).toBe("");
  });

  it("keeps a table next to the neighbour it hangs from", () => {
    // two hubs on level 1 with two children each: each pair of children ends up nearer its own parent
    const objs = [obj("c"), obj("p", ["c"]), obj("q", ["c"]), obj("p1", ["p"]), obj("p2", ["p"]), obj("q1", ["q"]), obj("q2", ["q"])];
    const { layout, model } = radial(objs, "c", 2);
    const at = (name: string): Box => layout.nodes[model.nodes.findIndex((n) => n.name === name)];
    for (const [child, own, other] of [["p1", "p", "q"], ["p2", "p", "q"], ["q1", "q", "p"], ["q2", "q", "p"]] as const) expect(dist(at(child), at(own))).toBeLessThan(dist(at(child), at(other)));
  });

  it("handles a cycle and a self reference", () => {
    const { layout } = radial([obj("a", ["b", "a"]), obj("b", ["c"]), obj("c", ["a"])], "a", 2);
    expect(layout.nodes).toHaveLength(3);
    expect(firstOverlap(layout.nodes)).toBe("");
  });

  it("is on the lattice, starts at 0, 0 and covers its boxes", () => {
    const { layout } = radial(shopSchema(), "orders", 2, "shop");
    for (const b of layout.nodes) {
      expect(b.x % 10).toBe(0);
      expect(b.y % 10).toBe(0);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(layout.width);
      expect(b.y + b.height).toBeLessThanOrEqual(layout.height);
    }
    expect(Math.min(...layout.nodes.map((b) => b.x))).toBe(0);
    expect(Math.min(...layout.nodes.map((b) => b.y))).toBe(0);
  });

  it("has no overlaps on a realistic schema at every depth", () => {
    for (const center of ["orders", "users", "products", "countries"]) {
      for (let depth = 1; depth <= 5; depth++) {
        const { layout, model } = radial(shopSchema(), center, depth, "shop");
        expect(firstOverlap(layout.nodes), `${center} at depth ${depth} (${model.nodes.length} tables)`).toBe("");
      }
    }
  });

  it("is deterministic", () => {
    const a = radial(shopSchema(), "users", 3, "shop").layout;
    const b = radial(shopSchema(), "users", 3, "shop").layout;
    expect(a).toEqual(b);
  });

  it("spreads a very crowded level over sub-rings and stays free of overlaps", () => {
    const hub = obj("hub");
    const objs = [hub, ...Array.from({ length: 150 }, (_, i) => obj(`leaf${i}`, ["hub"]))];
    const { layout } = radial(objs, "hub", 1, "s", "keys");
    expect(layout.nodes).toHaveLength(151);
    expect(firstOverlap(layout.nodes)).toBe("");
    // a single ring of 150 boxes would be thousands of pixels wide; sub-rings keep it roughly square and compact
    expect(layout.width).toBeLessThan(6000);
    expect(layout.height).toBeLessThan(6000);
  });

  it("lays out hundreds of tables from a random schema, free of overlaps, in well under a second", () => {
    const objs = randomSchema(7, 400, { density: 2 });
    const centre = objs.reduce((best, o) => ((o.foreignKeys?.length ?? 0) > (best.foreignKeys?.length ?? 0) ? o : best), objs[0]);
    const t0 = performance.now();
    const { layout, model } = radial(objs, centre.name, 4, "s", "keys");
    const ms = performance.now() - t0;
    expect(model.nodes.length).toBeGreaterThan(50);
    expect(firstOverlap(layout.nodes)).toBe("");
    expect(ms).toBeLessThan(1500);
  });
});
