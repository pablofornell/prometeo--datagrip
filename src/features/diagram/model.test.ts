import { describe, expect, it } from "vitest";
import { DGM, buildDiagram, clip, displayRows, hasToggle, measureTable, moreText, nodeKey, prunePositions, subsetOf, toggleKey, toggleText, visibleColumns, type DiagramInputObject, type DiagramOptions } from "./model";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (schema: string, name: string, cols: string[] = [], fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: cols.map((c) => ({ name: c, typeName: "integer", isPk: c === "id" })),
  foreignKeys: fks,
});

describe("buildDiagram", () => {
  it("sorts nodes by (schema, name) and assigns dense indices", () => {
    const m = buildDiagram([obj("b", "t2"), obj("a", "t1"), obj("b", "t1")], opts);
    expect(m.nodes.map((n) => `${n.schema}.${n.name}`)).toEqual(["a.t1", "b.t1", "b.t2"]);
    expect(m.nodes.map((n) => n.index)).toEqual([0, 1, 2]);
  });

  it("builds edges parent->child and marks referencing columns as FK", () => {
    const m = buildDiagram(
      [
        obj("s", "parent", ["id"]),
        obj("s", "child", ["id", "parent_id"], [{ name: "fk1", columns: ["parent_id"], refSchema: "s", refTable: "parent", refColumns: ["id"] }]),
      ],
      opts,
    );
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]).toMatchObject({ from: m.nodes.findIndex((n) => n.name === "child"), to: m.nodes.findIndex((n) => n.name === "parent") });
    const child = m.nodes.find((n) => n.name === "child")!;
    expect(child.columns.find((c) => c.name === "parent_id")!.isFk).toBe(true);
  });

  it("handles composite foreign keys (several columns on one edge)", () => {
    const m = buildDiagram(
      [
        obj("s", "parent", ["a", "b"]),
        obj("s", "child", ["x", "y"], [{ name: "fk2", columns: ["x", "y"], refSchema: "s", refTable: "parent", refColumns: ["a", "b"] }]),
      ],
      opts,
    );
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].columns).toEqual(["x", "y"]);
    expect(m.edges[0].refColumns).toEqual(["a", "b"]);
  });

  it("flags a self-reference without duplicating nodes", () => {
    const m = buildDiagram([obj("s", "t", ["id", "pid"], [{ name: "fk", columns: ["pid"], refSchema: "s", refTable: "t", refColumns: ["id"] }])], opts);
    expect(m.nodes).toHaveLength(1);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].self).toBe(true);
  });

  it("marks columns of an FK whose target is outside the selection but draws no edge", () => {
    const m = buildDiagram([obj("s", "child", ["id", "other_id"], [{ name: "fk", columns: ["other_id"], refSchema: "elsewhere", refTable: "parent", refColumns: ["id"] }])], opts);
    expect(m.edges).toHaveLength(0);
    expect(m.nodes[0].columns.find((c) => c.name === "other_id")!.isFk).toBe(true);
  });

  it("treats a missing foreignKeys field as empty", () => {
    const m = buildDiagram([{ schema: "s", name: "t", kind: "table", columns: [{ name: "id", typeName: "int", isPk: true }] }], opts);
    expect(m.edges).toHaveLength(0);
    expect(m.nodes).toHaveLength(1);
  });

  it("keys nodes by schema and name, independently of their index", () => {
    const m = buildDiagram([obj("b", "t2"), obj("a", "t1")], opts);
    expect(m.nodes.map((n) => n.key)).toEqual([nodeKey("a", "t1"), nodeKey("b", "t2")]);
    expect(m.nodes[1].key).toBe(nodeKey("b", "t2"));
  });

  it("does not mix up names that contain dots", () => {
    expect(nodeKey("a.b", "c")).not.toBe(nodeKey("a", "b.c"));
  });
});

describe("prunePositions", () => {
  it("drops dragged positions of tables that no longer exist", () => {
    const positions = new Map([
      ["a.t1", { x: 1, y: 2 }],
      ["gone.t", { x: 3, y: 4 }],
    ]);
    const out = prunePositions(positions, [{ key: "a.t1" }]);
    expect([...out.keys()]).toEqual(["a.t1"]);
    expect(out.get("a.t1")).toEqual({ x: 1, y: 2 });
  });

  it("returns the same map when every table still exists", () => {
    const positions = new Map([["a.t1", { x: 1, y: 2 }]]);
    expect(prunePositions(positions, [{ key: "a.t1" }])).toBe(positions);
  });
});

describe("visibleColumns / measureTable", () => {
  const cols = () =>
    [
      { name: "id", typeName: "bigint", isPk: true, isFk: false },
      { name: "parent_id", typeName: "bigint", isPk: false, isFk: true },
      { name: "note", typeName: "text", isPk: false, isFk: false },
    ] as const;

  it("filters keys-only and none", () => {
    expect(visibleColumns(cols(), "all")).toHaveLength(3);
    expect(visibleColumns(cols(), "keys").map((c) => c.name)).toEqual(["id", "parent_id"]);
    expect(visibleColumns(cols(), "none")).toHaveLength(0);
  });

  it("measures deterministically and shrinks the box when types are hidden", () => {
    const withTypes = measureTable("long_table_name", cols(), opts);
    const noTypes = measureTable("long_table_name", cols(), { ...opts, showTypes: false });
    expect(noTypes.width).toBeLessThan(withTypes.width);
    expect(noTypes.height).toBe(withTypes.height);
  });

  it("sizes boxes on the routing lattice, within the width cap", () => {
    for (const mode of ["all", "keys", "none"] as const) {
      const { width, height } = measureTable("t".repeat(300), [{ name: "c".repeat(300), typeName: "t".repeat(90), isPk: true, isFk: false }], { columns: mode, showTypes: true });
      expect(width % DGM.grid).toBe(0);
      expect(height % DGM.grid).toBe(0);
      expect(width).toBeLessThanOrEqual(DGM.maxW);
    }
  });
});

describe("displayRows", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, typeName: "int", isPk: i === 0, isFk: i === 45, isRef: i === 50 }));

  it("shows everything up to the row cap", () => {
    const r = displayRows(many(DGM.maxRows), "all");
    expect(r.rows).toHaveLength(DGM.maxRows);
    expect(r.hidden).toBe(0);
  });

  it("past the cap keeps every key and the first other columns, in their original order", () => {
    const r = displayRows(many(80), "all");
    expect(r.rows).toHaveLength(DGM.maxRows);
    expect(r.hidden).toBe(80 - DGM.maxRows);
    const names = r.rows.map((c) => c.name);
    for (const key of ["c0", "c45", "c50"]) expect(names).toContain(key);
    expect(names).toEqual([...names].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  });

  it("keys-only mode also keeps the columns other tables reference, and counts the rest as hidden", () => {
    const r = displayRows(many(60), "keys");
    expect(r.rows.map((c) => c.name)).toEqual(["c0", "c45", "c50"]);
    expect(r.hidden).toBe(57);
    expect(displayRows(many(5), "none")).toEqual({ rows: [], hidden: 5, expanded: false });
  });

  it("builds a footer row into the box height", () => {
    const withFooter = measureTable("t", many(5), { columns: "keys", showTypes: false });
    const none = measureTable("t", [], { columns: "keys", showTypes: false });
    expect(withFooter.height).toBeGreaterThan(none.height);
    expect(moreText(7, 0)).toBe("7 columns");
    expect(moreText(1, 0)).toBe("1 column");
    expect(moreText(7, 3)).toBe("+7 more columns");
    expect(moreText(1, 3)).toBe("+1 more column");
  });
});

describe("expanding a table that leaves out columns", () => {
  const many = (n: number, keys: (i: number) => boolean = (i) => i === 0) => Array.from({ length: n }, (_, i) => ({ name: `column_${i}`, typeName: "int", isPk: keys(i), isFk: false }));
  const names = (cols: readonly { name: string }[]) => cols.map((c) => c.name);

  it("counts the columns the limit cuts, and shows them all when expanded", () => {
    const cut = displayRows(many(80), "all");
    expect(cut).toMatchObject({ hidden: 80 - DGM.maxRows, expanded: false });
    const open = displayRows(many(80), "all", true);
    expect(names(open.rows)).toEqual(names(many(80)));
    expect(open).toMatchObject({ hidden: 0, expanded: true });
  });

  it("expands in keys-only and compact mode too: every column, in the original order, no row limit", () => {
    const cols = many(80, (i) => i === 0 || i === 40);
    expect(displayRows(cols, "keys")).toMatchObject({ hidden: 78, expanded: false });
    expect(names(displayRows(cols, "keys").rows)).toEqual(["column_0", "column_40"]);
    expect(displayRows(cols, "none")).toMatchObject({ rows: [], hidden: 80, expanded: false });
    for (const mode of ["keys", "none"] as const) {
      const open = displayRows(cols, mode, true);
      expect(open).toMatchObject({ hidden: 0, expanded: true });
      expect(names(open.rows)).toEqual(names(cols));
    }
    // a short table that keys-only mode cuts down
    const short = many(5);
    expect(names(displayRows(short, "keys", true).rows)).toEqual(names(short));
    expect(displayRows(short, "none", true)).toMatchObject({ hidden: 0, expanded: true });
  });

  it("does nothing where no column is left out: a short table, a table of keys only, a table with no column", () => {
    expect(displayRows(many(DGM.maxRows), "all", true)).toMatchObject({ hidden: 0, expanded: false });
    expect(displayRows(many(40, () => true), "all", true)).toMatchObject({ hidden: 0, expanded: false });
    expect(displayRows(many(20, () => true), "keys", true)).toMatchObject({ hidden: 0, expanded: false });
    expect(displayRows([], "none", true)).toEqual({ rows: [], hidden: 0, expanded: false });
  });

  it("keeps the box width, so that only the boxes below it move", () => {
    const cols = many(80).map((c, i) => (i === 70 ? { ...c, name: "a_much_longer_column_name_past_the_limit" } : c));
    const closed = measureTable("t", cols, opts);
    const open = measureTable("t", cols, opts, undefined, true);
    expect(open.width).toBe(closed.width);
    expect(open.height - closed.height).toBe((80 - DGM.maxRows) * DGM.rowH);
    // the hidden long name is part of the width already
    expect(closed.width).toBeGreaterThan(measureTable("t", many(80), opts).width);
  });

  it("keeps the box width in keys-only and compact mode too: the width counts every column of the table", () => {
    const cols = many(12).map((c, i) => (i === 7 ? { ...c, name: "a_long_column_name_that_is_no_key", typeName: "character varying(255)" } : c));
    for (const mode of ["keys", "none"] as const) {
      for (const showTypes of [true, false]) {
        const o: DiagramOptions = { columns: mode, showTypes };
        const closed = measureTable("t", cols, o);
        const open = measureTable("t", cols, o, undefined, true);
        expect(open.width, `${mode} ${showTypes}`).toBe(closed.width);
        expect(closed.width, `${mode} ${showTypes}`).toBe(measureTable("t", cols, { ...o, columns: "all" }).width);
        // the header, the drawn rows and the toggle row
        const rows = mode === "keys" ? 1 : 0;
        expect(closed.height).toBe(Math.ceil((DGM.headerH + (rows + 1) * DGM.rowH + DGM.padBottom) / DGM.grid) * DGM.grid);
        expect(open.height).toBe(Math.ceil((DGM.headerH + (12 + 1) * DGM.rowH + DGM.padBottom) / DGM.grid) * DGM.grid);
      }
    }
    // a box with no toggle (every column is a key) counts only what it draws
    const keysOnly = many(3, () => true);
    expect(measureTable("t", keysOnly, { columns: "keys", showTypes: true })).toEqual(measureTable("t", keysOnly, opts));
    expect(measureTable("t", [], { columns: "none", showTypes: true }).width).toBe(DGM.minW);
  });

  it("makes room for the toggle texts in a narrow box", () => {
    const cols = many(3).map((c) => ({ ...c, name: "a" }));
    const w = measureTable("t", cols, { columns: "none", showTypes: false }).width;
    expect(w).toBeGreaterThanOrEqual(DGM.padX * 2 + DGM.iconW + toggleText(0, true).length * DGM.charW);
    expect(w).toBeGreaterThanOrEqual(DGM.padX * 2 + DGM.iconW + toggleText(3, false, 0).length * DGM.charW);
  });

  it("expands the tables of the option set only, and words the toggle row", () => {
    const big = { schema: "s", name: "big", kind: "table" as const, columns: many(60) };
    const other = { ...big, name: "other" };
    const m = buildDiagram([big, other], { ...opts, expanded: new Set([nodeKey("s", "big")]) });
    const [b, o] = m.nodes;
    expect(b).toMatchObject({ name: "big", expanded: true, hidden: 0 });
    expect(b.rows).toHaveLength(60);
    expect(o).toMatchObject({ name: "other", expanded: false, hidden: 60 - DGM.maxRows });
    expect(hasToggle(b) && hasToggle(o)).toBe(true);
    expect(b.height).toBe(DGM.headerH + 61 * DGM.rowH + DGM.padBottom);
    expect(toggleText(32, false)).toBe("Show 32 more columns");
    expect(toggleText(1, false)).toBe("Show 1 more column");
    expect(toggleText(7, false, 0)).toBe("Show 7 columns");
    expect(toggleText(1, false, 0)).toBe("Show 1 column");
    expect(toggleText(0, true)).toBe("Show fewer columns");
  });

  it("expands in keys-only and compact mode, and a key of a table that hides nothing has no effect", () => {
    const big = { schema: "s", name: "big", kind: "table" as const, columns: many(6) };
    const keys = { ...big, name: "keys", columns: many(2, () => true) };
    const expanded = new Set([nodeKey("s", "big"), nodeKey("s", "keys")]);
    for (const mode of ["keys", "none"] as const) {
      const [b, k] = buildDiagram([big, keys], { columns: mode, showTypes: true, expanded }).nodes;
      expect(b, mode).toMatchObject({ expanded: true, hidden: 0 });
      expect(names(b.rows)).toEqual(names(big.columns));
      expect(hasToggle(b)).toBe(true);
      const closed = buildDiagram([big, keys], { columns: mode, showTypes: true }).nodes[0];
      expect(hasToggle(closed)).toBe(true);
      expect(closed.width).toBe(b.width);
      // the keys-only table: nothing hidden in keys-only mode, everything hidden in compact mode
      expect(k).toMatchObject(mode === "keys" ? { expanded: false, hidden: 0 } : { expanded: true, hidden: 0 });
    }
    const small = buildDiagram([big], { ...opts, expanded }).nodes[0];
    expect(small).toMatchObject({ expanded: false, hidden: 0 });
    expect(hasToggle(small)).toBe(false);
  });
});

describe("toggleKey", () => {
  it("decides on the set: two quick toggles cancel out, whatever the model on screen says", () => {
    const none: ReadonlySet<string> = new Set();
    const once = toggleKey(none, "s\u0000big", true);
    expect([...once]).toEqual(["s\u0000big"]);
    // the second toggle comes while the model on screen still shows the box collapsed (expandable)
    expect([...toggleKey(once, "s\u0000big", true)]).toEqual([]);
    expect(toggleKey(none, "s\u0000small", false)).toBe(none); // nothing to expand
    expect([...toggleKey(once, "s\u0000big", false)]).toEqual([]); // an expanded key always collapses
  });
});

describe("referenced columns", () => {
  it("are flagged on the referenced table and stay visible in keys-only mode", () => {
    const m = buildDiagram(
      [
        obj("s", "country", ["code", "name"]),
        obj("s", "city", ["id", "country_code"], [{ name: "fk", columns: ["country_code"], refSchema: "s", refTable: "country", refColumns: ["code"] }]),
      ],
      { columns: "keys", showTypes: true },
    );
    const country = m.nodes.find((n) => n.name === "country")!;
    expect(country.columns.find((c) => c.name === "code")!.isRef).toBe(true);
    expect(country.rows.map((c) => c.name)).toEqual(["code"]);
    expect(country.hidden).toBe(1);
  });
});

describe("clip", () => {
  it("cuts with an ellipsis only when needed", () => {
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 1)).toBe("…");
  });
});

describe("subsetOf", () => {
  const t = (name: string, refs: string[] = []) => ({
    schema: "s",
    name,
    kind: "table" as const,
    columns: [],
    foreignKeys: refs.map((r) => ({ name: `fk_${name}_${r}`, columns: ["x"], refSchema: "s", refTable: r, refColumns: ["id"] })),
  });
  const all = [t("orders", ["customers"]), t("customers"), t("lines", ["orders"]), t("other")];
  it("keeps every object without a table list", () => {
    expect(subsetOf(all, undefined).map((o) => o.name)).toEqual(["orders", "customers", "lines", "other"]);
  });
  it("keeps the selected tables and their direct neighbours in both directions", () => {
    expect(subsetOf(all, ["orders"]).map((o) => o.name)).toEqual(["orders", "customers", "lines"]);
    expect(subsetOf(all, ["customers"]).map((o) => o.name)).toEqual(["orders", "customers"]);
  });
  it("matches the names exactly: another case is another table", () => {
    expect(subsetOf(all, ["ORDERS"])).toEqual([]);
    expect(subsetOf(all, ["Customers", "other"]).map((o) => o.name)).toEqual(["other"]);
  });
});
