import { describe, expect, it } from "vitest";
import { assignColors } from "./groups";
import { describeFocus, focusSets, neighbourInDirection, sameFocus } from "./focus";
import { buildDiagram } from "./model";
import { shopSchema } from "./sample";

const model = buildDiagram(shopSchema(), { columns: "all", showTypes: true });
const idx = (name: string) => model.nodes.findIndex((n) => n.name === name);

describe("focusSets", () => {
  it("a table lights itself, its neighbours in both directions and the edges between", () => {
    const s = focusSets(model, undefined, { kind: "node", index: idx("orders") });
    const names = [...s.nodes].map((i) => model.nodes[i].name).sort();
    expect(names).toEqual(["addresses", "customers", "invoices", "order_coupons", "order_items", "orders", "payments", "shipments"]);
    for (const i of s.edges) {
      const e = model.edges[i];
      expect([e.from, e.to]).toContain(idx("orders"));
    }
    expect(s.edges.size).toBe(model.edges.filter((e) => e.from === idx("orders") || e.to === idx("orders")).length);
  });

  it("an edge lights its two tables", () => {
    const i = model.edges.findIndex((e) => e.label === "order_items_product_id_fkey");
    const s = focusSets(model, undefined, { kind: "edge", index: i });
    expect([...s.nodes].map((n) => model.nodes[n].name).sort()).toEqual(["order_items", "products"]);
    expect([...s.edges]).toEqual([i]);
  });

  it("a colour group lights its tables and the edges that leave them", () => {
    const colors = assignColors(model, "cluster");
    const g = colors.groupOf[idx("orders")];
    const s = focusSets(model, colors, { kind: "group", id: g });
    expect(s.nodes.has(idx("orders"))).toBe(true);
    expect(s.nodes.has(idx("roles"))).toBe(false);
    for (const i of s.edges) expect(s.nodes.has(model.edges[i].from)).toBe(true);
  });
});

describe("sameFocus / describeFocus", () => {
  it("compares foci", () => {
    expect(sameFocus(null, null)).toBe(true);
    expect(sameFocus({ kind: "node", index: 1 }, { kind: "node", index: 1 })).toBe(true);
    expect(sameFocus({ kind: "node", index: 1 }, { kind: "edge", index: 1 })).toBe(false);
    expect(sameFocus({ kind: "group", id: 2 }, { kind: "group", id: 3 })).toBe(false);
    expect(sameFocus(null, { kind: "node", index: 0 })).toBe(false);
  });

  it("describes a table for screen readers", () => {
    expect(describeFocus(model, { kind: "node", index: idx("orders") })).toBe("orders: 7 columns, references 2 tables, referenced by 5");
    expect(describeFocus(model, null)).toBe("");
  });
});

describe("neighbourInDirection", () => {
  const rects = [
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 300, y: 10, w: 100, h: 50 },
    { x: 20, y: 300, w: 100, h: 50 },
    { x: 600, y: 500, w: 100, h: 50 },
  ];
  it("walks to the nearest table in the direction pressed", () => {
    expect(neighbourInDirection(rects, 0, "right")).toBe(1);
    expect(neighbourInDirection(rects, 0, "down")).toBe(2);
    expect(neighbourInDirection(rects, 1, "left")).toBe(0);
    expect(neighbourInDirection(rects, 2, "up")).toBe(0);
  });
  it("returns null when nothing lies that way", () => {
    expect(neighbourInDirection(rects, 0, "left")).toBeNull();
    expect(neighbourInDirection(rects, 3, "down")).toBeNull();
  });
});
