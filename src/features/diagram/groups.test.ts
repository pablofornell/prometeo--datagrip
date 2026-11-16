import { describe, expect, it } from "vitest";
import tokensCss from "../../styles/tokens-extra.css?raw";
import { RAINBOW_SLOTS, assignColors, clusters, prefixOf } from "./groups";
import { buildDiagram, type DiagramInputObject } from "./model";
import { FALLBACK_RAINBOW_DARK, FALLBACK_RAINBOW_LIGHT, parseColor } from "./palette";
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

/** The `--rainbow-1..12` values of one theme block of tokens-extra.css, in token order. */
function tokenRainbow(theme: "dark" | "light"): string[] {
  const css = tokensCss.split("}").find((b) => b.includes(`[data-theme="${theme}"]`) && b.includes("--rainbow-1:")) ?? "";
  return Array.from({ length: 12 }, (_, i) => new RegExp(`--rainbow-${i + 1}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1] ?? "");
}

const hueOf = (hex: string): number => {
  const [r, g, b] = (parseColor(hex) ?? [0, 0, 0]).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a: string, b: string): number => {
  const d = Math.abs(hueOf(a) - hueOf(b));
  return Math.min(d, 360 - d);
};

describe("colour slots against the real rainbow tokens", () => {
  /** Biggest group first: the rainbow colour each of `n` groups gets (they all have a different size). */
  const slotsFor = (n: number): number[] => {
    const objs: DiagramInputObject[] = [];
    for (let g = 0; g < n; g++) {
      objs.push(t("s", `g${g}_a`));
      for (let k = 0; k < n - g; k++) objs.push(t("s", `g${g}_b${k}`, [`g${g}_a`]));
    }
    return assignColors(buildDiagram(objs, opts), "cluster").groups.map((x) => x.slot);
  };

  it("reads both themes of tokens-extra.css (12 colours each), and the diagram fallbacks are the same colours", () => {
    for (const [theme, fallback] of [["dark", FALLBACK_RAINBOW_DARK], ["light", FALLBACK_RAINBOW_LIGHT]] as const) {
      const tokens = tokenRainbow(theme);
      expect(tokens.every((c) => /^#[0-9a-f]{6}$/i.test(c)), theme).toBe(true);
      expect(tokens.map((c) => c.toLowerCase())).toEqual(fallback);
    }
  });

  it("gives the largest groups well separated hues in both themes (no neighbouring magenta / pink or orange / yellow)", () => {
    const slots = slotsFor(8);
    expect(slots).toHaveLength(8);
    expect(new Set(slots).size).toBe(8);
    for (const theme of ["dark", "light"] as const) {
      const colors = slots.map((s) => tokenRainbow(theme)[s]);
      const minGap = (count: number): number => {
        let m = 360;
        for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) m = Math.min(m, hueGap(colors[i], colors[j]));
        return m;
      };
      expect(minGap(2), `${theme} top 2`).toBeGreaterThan(120);
      expect(minGap(4), `${theme} top 4`).toBeGreaterThanOrEqual(65);
      expect(minGap(6), `${theme} top 6`).toBeGreaterThanOrEqual(30);
      expect(minGap(8), `${theme} top 8`).toBeGreaterThanOrEqual(20);
    }
  });

  it("never gives the second and third group, or any group and the next, a similar warm or pink hue", () => {
    const slots = slotsFor(6);
    const dark = tokenRainbow("dark");
    for (let i = 1; i < slots.length; i++) expect(hueGap(dark[slots[i - 1]], dark[slots[i]]), `group ${i} and ${i + 1}`).toBeGreaterThan(55);
  });
});
