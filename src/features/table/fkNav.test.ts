// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ObjectRef } from "../../api/types";

vi.mock("../../api/db", () => ({ introspect: async () => [], listDataSources: async () => [] }));
vi.mock("../explorer", () => ({ ensureConnected: async () => {} }));
vi.mock("./commands", () => ({ openTableTab: async () => {} }));

import { referencedTargets, whereOf, type FkDef } from "./fkNav";

const table: ObjectRef = { schema: "shop", name: "orders", kind: "table" };
const single: FkDef = { name: "fk_c", columns: ["customer_id"], refSchema: null, refTable: "customers", refColumns: ["id"] };
const composite: FkDef = { name: "fk_line", columns: ["order_id", "line_no"], refSchema: "billing", refTable: "lines", refColumns: ["oid", "no"] };

describe("referencedTargets", () => {
  it("opens the referenced table of the own schema filtered to the key", () => {
    const open = vi.fn();
    const [t] = referencedTargets([single], "customer_id", "postgres", table, open);
    expect(t.qualified).toBe("shop.customers");
    expect(t.label).toBe("customers (id)");
    t.open({ customer_id: 42 });
    expect(open).toHaveBeenCalledWith({ schema: "shop", name: "customers", kind: "table" }, '"id" = 42');
  });
  it("follows a cross-schema key into the referenced schema", () => {
    const open = vi.fn();
    const [t] = referencedTargets([composite], "order_id", "postgres", table, open);
    expect(t.qualified).toBe("billing.lines");
    t.open({ order_id: 5, line_no: 2 });
    expect(open).toHaveBeenCalledWith({ schema: "billing", name: "lines", kind: "table" }, '"oid" = 5 and "no" = 2');
  });
  it("composite keys answer from every one of their columns and need all values", () => {
    const open = vi.fn();
    for (const col of ["order_id", "line_no"]) {
      const [t] = referencedTargets([composite], col, "postgres", table, open);
      expect(t.columns).toEqual(["order_id", "line_no"]);
      expect(t.enabled?.({ order_id: 1, line_no: null })).toBe(false);
      expect(t.enabled?.({ order_id: 1 })).toBe(false);
      expect(t.enabled?.({ order_id: 1, line_no: 3 })).toBe(true);
    }
  });
  it("lists nothing for a column without a key", () => {
    expect(referencedTargets([single, composite], "note", "postgres", table, vi.fn())).toEqual([]);
  });
  it("quotes Oracle owner names exactly and strings with single quotes", () => {
    const open = vi.fn();
    const fk: FkDef = { ...single, refSchema: "HR", refTable: "EMP", refColumns: ["CODE"] };
    const [t] = referencedTargets([fk], "customer_id", "oracle", { schema: "SALES", name: "ORDERS", kind: "table" }, open);
    t.open({ customer_id: "A'1" });
    expect(open).toHaveBeenCalledWith({ schema: "HR", name: "EMP", kind: "table" }, `"CODE" = 'A''1'`);
  });
});

describe("whereOf", () => {
  it("joins the pairs with and", () => {
    expect(whereOf("mysql", [["a", 1], ["b", "x"]])).toBe("`a` = 1 and `b` = 'x'");
  });
});
