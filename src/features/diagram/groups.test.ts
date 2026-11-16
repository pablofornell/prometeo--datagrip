import { describe, expect, it } from "vitest";
import { RAINBOW_SLOTS, assignColors, clusters, prefixOf } from "./groups";
import { buildDiagram, type DiagramInputObject } from "./model";
import { shopSchema } from "./sample";

const opts = { columns: "all", showTypes: true } as const;

const t = (schema: string, name: string, refs: string[] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: [{ name: "id", typeName: "int", isPk: true }, { name: "x", typeName: "int", isPk: false }],
  foreignKeys: refs.map((r) => ({ name: `fk_${name}_${r}`, columns: ["x"], refSchema: schema, refTable: r, refColumns: ["id"] })),
});

describe("assignColors", () => {
  it("colours nothing in 'none' mode", () => {
    const m = buildDiagram(shopSchema(), opts);
    const c = assignColors(m, "none");
    expect(c.groups).toEqual([]);
    expect(c.groupOf.every((g) => g === -1)).toBe(true);
  });

  it("groups by schema, one colour per schema", () => {
    const m = buildDiagram([t("a", "t1"), t("a", "t2"), t("b", "t3")], opts);
    const c = assignColors(m, "schema");
    expect(c.groups.map((g) => [g.label, g.count])).toEqual([["a", 2], ["b", 1]]);
    expect(c.groupOf[0]).toBe(c.groupOf[1]);
    expect(c.groupOf[0]).not.toBe(c.groupOf[2]);
    expect(new Set(c.groups.map((g) => g.slot)).size).toBe(2);
  });

  it("groups by name prefix and leaves lone tables neutral", () => {
    expect(prefixOf("order_items")).toBe("order");
    expect(prefixOf("Orders")).toBeNull();
    const m = buildDiagram([t("s", "order_items"), t("s", "order_lines"), t("s", "user_roles"), t("s", "user_tokens"), t("s", "settings")], opts);
    const c = assignColors(m, "prefix");
    expect(c.groups.map((g) => g.label).sort()).toEqual(["order_*", "user_*"]);
    expect(c.groupOf[m.nodes.findIndex((n) => n.name === "settings")]).toBe(-1);
  });

  it("clusters related tables together and unrelated components apart, isolated tables neutral", () => {
    const m = buildDiagram([t("s", "a"), t("s", "b", ["a"]), t("s", "c", ["a"]), t("s", "x"), t("s", "y", ["x"]), t("s", "lone")], opts);
    const c = assignColors(m, "cluster");
    const g = (name: string) => c.groupOf[m.nodes.findIndex((n) => n.name === name)];
    expect(g("a")).toBe(g("b"));
    expect(g("a")).toBe(g("c"));
    expect(g("x")).toBe(g("y"));
    expect(g("a")).not.toBe(g("x"));
    expect(g("lone")).toBe(-1);
  });

  it("splits a realistic schema into several clusters with distinct colours, deterministically", () => {
    const m = buildDiagram(shopSchema(), opts);
    const a = assignColors(m, "cluster");
    const b = assignColors(buildDiagram([...shopSchema()].reverse(), opts), "cluster");
    expect(a).toEqual(b);
    expect(a.groups.length).toBeGreaterThanOrEqual(4);
    const slots = a.groups.map((g) => g.slot);
    expect(new Set(slots).size).toBe(slots.length);
    // the order tables stay together, and apart from the identity ones
    const g = (name: string) => a.groupOf[m.nodes.findIndex((n) => n.name === name)];
    expect(g("orders")).toBe(g("payments"));
    expect(g("orders")).not.toBe(g("roles"));
  });

  it("hands out the biggest groups the most distant rainbow slots and reuses slots beyond 12 groups", () => {
    const objs: DiagramInputObject[] = [];
    for (let i = 0; i < 14; i++) objs.push(t("s", `g${i}_a`), t("s", `g${i}_b`, [`g${i}_a`]));
    const c = assignColors(buildDiagram(objs, opts), "cluster");
    expect(c.groups).toHaveLength(14);
    expect(c.groups.every((g) => g.slot >= 0 && g.slot < RAINBOW_SLOTS)).toBe(true);
    expect(new Set(c.groups.map((g) => g.slot)).size).toBe(RAINBOW_SLOTS);
  });
});

describe("clusters", () => {
  it("handles an empty and an edgeless model", () => {
    expect(clusters(buildDiagram([], opts))).toEqual([]);
    const m = buildDiagram([t("s", "a"), t("s", "b")], opts);
    expect(clusters(m)).toEqual([0, 1]);
  });
});
