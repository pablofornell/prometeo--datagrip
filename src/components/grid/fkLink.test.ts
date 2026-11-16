// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fkTooltip, isLinkModifier, resolveFkLink } from "./fkLink";
import type { GridNavTarget, GridNavigation } from "./types";

const open = () => {};
const keyed = (columns: string[], label = "customers (id)", qualified = "shop.customers"): GridNavTarget => ({
  label,
  qualified,
  columns,
  open,
  enabled: (rec) => columns.every((c) => rec[c] !== null && rec[c] !== undefined),
});
const nav = (map: Record<string, GridNavTarget[]>): GridNavigation => ({ referenced: (c) => map[c] ?? [], related: () => [] });

describe("link modifier", () => {
  it("is Ctrl on windows / linux and Cmd on mac", () => {
    expect(isLinkModifier({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isLinkModifier({ ctrlKey: false, metaKey: true }, false)).toBe(false);
    expect(isLinkModifier({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isLinkModifier({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  });
});

describe("resolveFkLink", () => {
  const t = keyed(["customer_id"]);
  it("is none without navigation or for a column that holds no foreign key", () => {
    expect(resolveFkLink(undefined, "customer_id", { customer_id: 1 }).kind).toBe("none");
    expect(resolveFkLink(nav({ customer_id: [t] }), "name", { name: "x" }).kind).toBe("none");
  });
  it("goes to the target when the key has a value", () => {
    const r = resolveFkLink(nav({ customer_id: [t] }), "customer_id", { customer_id: 7 });
    expect(r).toEqual({ kind: "go", target: t });
  });
  it("treats 0, empty string and false as values", () => {
    for (const v of [0, "", false]) expect(resolveFkLink(nav({ customer_id: [t] }), "customer_id", { customer_id: v }).kind).toBe("go");
  });
  it("does nothing, with a message, on a NULL key", () => {
    const r = resolveFkLink(nav({ customer_id: [t] }), "customer_id", { customer_id: null });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/NULL/);
  });
  it("needs every column of a composite key", () => {
    const c = keyed(["a", "b"], "t (x, y)", "s.t");
    const n = nav({ a: [c], b: [c] });
    expect(resolveFkLink(n, "a", { a: 1, b: 2 }).kind).toBe("go");
    expect(resolveFkLink(n, "a", { a: 1, b: null }).kind).toBe("blocked");
    expect(resolveFkLink(n, "b", { a: null, b: 2 }).kind).toBe("blocked");
  });
  it("tells a key column missing from a query result from a NULL", () => {
    const c = keyed(["a", "b"]);
    const r = resolveFkLink(nav({ a: [c] }), "a", { a: 1 });
    expect(r.kind === "blocked" && r.reason).toMatch(/b is not in the result/);
  });
  it("picks the first usable target of a column in several keys", () => {
    const first = keyed(["a", "b"], "t1 (x, y)");
    const second = keyed(["a"], "t2 (x)");
    expect(resolveFkLink(nav({ a: [first, second] }), "a", { a: 1, b: null })).toEqual({ kind: "go", target: second });
  });
  it("does not navigate on a DEFAULT / expression value of an unsaved edit", () => {
    expect(resolveFkLink(nav({ customer_id: [t] }), "customer_id", { customer_id: { $default: true } }).kind).toBe("blocked");
    expect(resolveFkLink(nav({ customer_id: [t] }), "customer_id", { customer_id: { $expr: "1+1" } }).kind).toBe("blocked");
  });
});

describe("fkTooltip", () => {
  it("names the schema qualified table", () => {
    expect(fkTooltip(keyed(["a"]), false)).toBe("Ctrl+Click: go to shop.customers");
    expect(fkTooltip(keyed(["a"]), true)).toBe("Cmd+Click: go to shop.customers");
  });
  it("falls back to the label", () => {
    expect(fkTooltip({ label: "t (id)", open }, false)).toBe("Ctrl+Click: go to t (id)");
  });
});
