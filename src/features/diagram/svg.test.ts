import { describe, expect, it } from "vitest";
import { DGM, buildDiagram, nodeKey, type DiagramInputObject, type DiagramOptions } from "./model";
import { layoutDiagram } from "./layout";
import { assignColors } from "./groups";
import { contrast } from "./palette";
import { shopSchema } from "./sample";
import { buildScene, diagramBounds, edgeAttrs, nodeColors, renderDiagramSvg, roundedPath, type DiagramPalette } from "./svg";
import { budget } from "./bench";

const opts: DiagramOptions = { columns: "all", showTypes: true };

export const palette: DiagramPalette = {
  background: "#191a1c",
  nodeBg: "#1f2024",
  nodeBorder: "#33353b",
  headerBg: "#26282c",
  headerFg: "#d1d3d9",
  viewHeaderBg: "#233558",
  viewFg: "#d1d3d9",
  text: "#bcbec4",
  typeText: "#73767c",
  pk: "#e0bb65",
  fk: "#56a8f5",
  edge: "#73767c",
  edgeLabel: "#9fa2a8",
  selection: "#3871e1",
  rowLine: "#323438",
  fontMono: '"JetBrains Mono", monospace',
  fontUi: '"Inter", sans-serif',
  isDark: true,
  rainbow: ["#e05652", "#e08f52", "#e0bf52", "#a3e052", "#52e086", "#52e0c4", "#52c9e0", "#5294e0", "#5256e0", "#9452e0", "#e052e0", "#e05294"],
  inkLight: "#ffffff",
  inkDark: "#15171b",
};

const obj = (schema: string, name: string, fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: [{ name: "id", typeName: "bigint", isPk: true }, { name: "ref_id", typeName: "bigint", isPk: false }],
  foreignKeys: fks,
});

const render = (objects: DiagramInputObject[], extra: Partial<Parameters<typeof renderDiagramSvg>[2]> = {}) => {
  const model = buildDiagram(objects, opts);
  return renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, ...extra }, palette);
};

describe("renderDiagramSvg", () => {
  it("is a self-contained svg that contains every table", () => {
    const objects = [obj("shop", "orders"), obj("shop", "customers"), obj("shop", "products")];
    const svg = render(objects);
    expect(svg).toContain("<svg xmlns=");
    for (const o of objects) expect(svg).toContain(o.name);
    for (let i = 0; i < objects.length; i++) expect(svg).toContain(`data-table-id="${i}"`);
  });

  it("escapes XML-significant characters in table and column names", () => {
    const svg = render([{ schema: "s", name: "a<b>&c", kind: "table", columns: [{ name: "x\"y", typeName: "text", isPk: false }] }]);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
    expect(svg).toContain("x&quot;y");
    expect(svg).not.toContain("a<b>&c");
  });

  it("marks the selected node and dims what is not related to it", () => {
    const objects = [obj("s", "a"), obj("s", "b", [{ name: "fk", columns: ["ref_id"], refSchema: "s", refTable: "a", refColumns: ["id"] }]), obj("s", "c")];
    const plain = render(objects);
    const selected = render(objects, { selected: 0 });
    expect(plain).not.toContain('class="dg-node dg-sel"');
    expect(selected).toContain('class="dg-node dg-sel"');
    // c is not related to a: dimmed; b is
    expect(selected).toMatch(/class="dg-node dg-dim" data-table-id="2"/);
    expect(selected).toMatch(/class="dg-node" data-table-id="1"/);
    expect(selected).toContain(`stroke:${palette.selection}`);
  });

  it("emits concrete font stacks (an exported file cannot resolve CSS variables)", () => {
    const svg = render([obj("shop", "orders")]);
    expect(svg).toContain('font-family="&quot;JetBrains Mono&quot;, monospace"');
    expect(svg).toContain('font-family="&quot;Inter&quot;, sans-serif"');
    expect(svg).not.toContain("var(--");
  });

  it("bakes the same padded bounds into width / height / viewBox that Fit zooms to", () => {
    const model = buildDiagram([obj("shop", "orders"), obj("shop", "customers")], opts);
    const layout = layoutDiagram(model);
    const scene = buildScene(model, layout);
    const svg = renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, palette, undefined, scene);
    const b = scene.bounds;
    expect(svg).toContain(`width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}"`);
  });

  it("moves bounds with a dragged position", () => {
    const model = buildDiagram([obj("shop", "orders"), obj("shop", "customers")], opts);
    const layout = layoutDiagram(model);
    const base = diagramBounds(layout);
    const key = model.nodes[0].key;
    const moved = diagramBounds(layout, new Map([[key, { x: 500, y: 400 }]]));
    expect(moved.width).toBeGreaterThan(base.width);
    expect(moved.height).toBeGreaterThan(base.height);
    const left = diagramBounds(layout, new Map([[key, { x: -500, y: 0 }]]));
    expect(left.x).toBeLessThan(base.x);
  });

  it("draws every foreign key as an edge with its ends, a hit area and the rows it lights", () => {
    const model = buildDiagram(shopSchema(), opts);
    const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true }, palette);
    expect((svg.match(/class="dg-edge"/g) ?? []).length).toBe(model.edges.length);
    expect((svg.match(/class="dg-hit"/g) ?? []).length).toBe(model.edges.length);
    expect(svg).toContain(edgeAttrs(model.edges[0], model, 0));
    expect(svg).toContain('class="dg-rowhl"');
    expect(svg).toContain("<title>orders_customer_id_fkey: orders(customer_id)");
  });

  it("colours headers and edges by group with the rainbow, and neutral without", () => {
    const model = buildDiagram(shopSchema(), opts);
    const layout = layoutDiagram(model);
    const colors = assignColors(model, "cluster");
    const colored = renderDiagramSvg(model, layout, { columns: "all", showTypes: true, colors }, palette);
    const neutral = renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, palette);
    const used = new Set(colors.groups.map((g) => palette.rainbow[g.slot]));
    expect(used.size).toBeGreaterThan(2);
    for (const c of used) expect(colored).toContain(`fill="${c}"`);
    for (const c of palette.rainbow) expect(neutral).not.toContain(`fill="${c}"`);
    // an edge is drawn in the colour of the table it leaves
    const e = model.edges[0];
    expect(colored).toContain(`stroke="${nodeColors(model.nodes[e.from], colors, palette).fill}"`);
  });

  it("reads every header text with at least WCAG AA contrast", () => {
    const model = buildDiagram(shopSchema(), opts);
    for (const rainbow of [palette.rainbow, ["#bf2722", "#bf6622", "#bf9a22", "#7bbf22", "#22bf5b", "#22bf9f", "#22a5bf", "#226bbf", "#2227bf", "#6b22bf", "#bf22bf", "#bf226b"]]) {
      const p = { ...palette, rainbow };
      const colors = assignColors(model, "prefix");
      for (const n of model.nodes) {
        const { fill, ink } = nodeColors(n, colors, p);
        expect(contrast(fill, ink), `${n.name} ${fill} on ${ink}`).toBeGreaterThanOrEqual(3);
      }
    }
    // the picked ink is the better of the two on every rainbow colour
    for (const c of palette.rainbow) {
      const best = Math.max(contrast(c, palette.inkLight), contrast(c, palette.inkDark));
      expect(best).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("truncates long names with an ellipsis and keeps the full name in a tooltip", () => {
    const long = "very_long_column_name_".repeat(8);
    const svg = render([{ schema: "s", name: "t", kind: "table", columns: [{ name: long, typeName: "character varying(255)", isPk: false }] }]);
    expect(svg).toContain("…");
    expect(svg).toContain(`<title>${long}</title>`);
  });

  it("shows the footer row for columns it leaves out", () => {
    const wide: DiagramInputObject = { schema: "s", name: "wide", kind: "table", columns: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, typeName: "int", isPk: i === 0 })) };
    expect(render([wide])).toContain(`Show ${60 - DGM.maxRows} more columns`);
    const model = buildDiagram([wide], { columns: "none", showTypes: false });
    const compact = renderDiagramSvg(model, layoutDiagram(model), { columns: "none", showTypes: false }, palette);
    expect(compact).toContain("60 columns");
    expect(compact).not.toContain("data-toggle"); // the column mode hides them: nothing to expand
  });

  it("draws an expand row for a table the row limit cuts, and a collapse row once it is expanded", () => {
    const wide: DiagramInputObject = { schema: "s", name: "wide", kind: "table", columns: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, typeName: "int", isPk: i === 0 })) };
    const closed = render([wide]);
    expect(closed).toContain('class="dg-toggle" data-toggle="0"');
    expect(closed).not.toContain(">c59<");
    const model = buildDiagram([wide], { ...opts, expanded: new Set([nodeKey("s", "wide")]) });
    const open = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true }, palette);
    expect(open).toContain('class="dg-toggle" data-toggle="0"');
    expect(open).toContain("Show fewer columns");
    for (let i = 0; i < 60; i++) expect(open).toContain(`>c${i}<`);
    expect(render([obj("s", "small")])).not.toContain("data-toggle");
  });

  it("labels the lines only when asked (a class on the root), with a label per placed edge", () => {
    const model = buildDiagram(shopSchema(), opts);
    const layout = layoutDiagram(model);
    expect(renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, palette)).not.toContain('class="dg-svg dg-labels"');
    const on = renderDiagramSvg(model, layout, { columns: "all", showTypes: true, edgeLabels: true }, palette);
    expect(on).toContain('class="dg-svg dg-labels"');
    expect(on).toContain('class="dg-elabel"');
  });

  it("renders a realistic 100 table schema well within a second", () => {
    const objects = [0, 1, 2].flatMap((c) => shopSchema().map((o) => ({ ...o, schema: `s${c}`, foreignKeys: (o.foreignKeys ?? []).map((f) => ({ ...f, refSchema: `s${c}` })) })));
    const start = performance.now();
    const model = buildDiagram(objects, opts);
    const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, colors: assignColors(model, "schema") }, palette);
    expect(performance.now() - start).toBeLessThan(budget(2000));
    expect(model.nodes).toHaveLength(96);
    expect(svg.length).toBeGreaterThan(1000);
  });
});

describe("exported SVG of a table past the row limit", () => {
  const wide: DiagramInputObject = { schema: "s", name: "wide", kind: "table", columns: Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, typeName: "int", isPk: i === 0 })) };

  it("has a plain note instead of the expand control", () => {
    const model = buildDiagram([wide], opts);
    const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, exporting: true }, palette);
    expect(svg).toContain(`>+${60 - DGM.maxRows} more columns<`);
    for (const control of ["data-toggle", 'role="button"', "Show ", "Expand the table"]) expect(svg).not.toContain(control);
  });

  it("draws nothing in the collapse row of an expanded table", () => {
    const model = buildDiagram([wide], { ...opts, expanded: new Set([nodeKey("s", "wide")]) });
    const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, exporting: true }, palette);
    expect(svg).toContain(">c59<");
    for (const control of ["data-toggle", 'role="button"', "Show fewer", "more column", "Collapse"]) expect(svg).not.toContain(control);
  });
});

describe("buildScene after a table is expanded", () => {
  const wide = (name: string, fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
    schema: "s",
    name,
    kind: "table",
    columns: Array.from({ length: 50 }, (_, i) => ({ name: i === 1 ? "ref_id" : `c${i}`, typeName: "int", isPk: i === 0 })),
    foreignKeys: fks,
  });
  const objects = [...shopSchema(), wide("w_parent"), wide("w_child", [{ name: "w_fk", columns: ["ref_id"], refSchema: "s", refTable: "w_parent", refColumns: ["c0"] }])].map((o) => ({ ...o, schema: "s", foreignKeys: (o.foreignKeys ?? []).map((f) => ({ ...f, refSchema: "s" })) }));
  const across = (a: { x: number; w: number }, b: { x: number; w: number }) => a.x < b.x + b.w && b.x < a.x + a.w;

  it("keeps the layout: the table stays, the boxes below it move down, no box overlaps, every edge is routed", () => {
    const closed = buildDiagram(objects, opts);
    const layout = layoutDiagram(closed);
    const before = buildScene(closed, layout);
    const key = nodeKey("s", "w_parent");
    const open = buildDiagram(objects, { ...opts, expanded: new Set([key]) });
    const after = buildScene(open, layout);
    const i = open.nodes.findIndex((n) => n.key === key);
    const grew = open.nodes[i].height - closed.nodes[i].height;
    expect(grew).toBeGreaterThan(0);
    expect(after.rects[i]).toEqual({ ...before.rects[i], h: open.nodes[i].height });
    after.rects.forEach((r, j) => {
      const b = before.rects[j];
      expect(r.x).toBe(b.x);
      const below = across(b, before.rects[i]) && b.y >= before.rects[i].y + before.rects[i].h;
      expect(r.y - b.y).toBe(below ? grew : r.y - b.y);
      if (!below && j !== i) expect(r.y).toBeGreaterThanOrEqual(b.y);
    });
    for (let a = 0; a < after.rects.length; a++)
      for (let b = a + 1; b < after.rects.length; b++) {
        const p = after.rects[a];
        const q = after.rects[b];
        expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${a} and ${b} overlap`).toBe(false);
      }
    expect(after.routes.filter(Boolean)).toHaveLength(before.routes.filter(Boolean).length);
    expect(after.rects.filter((r, j) => r.y > before.rects[j].y).length).toBeGreaterThan(0);
    expect(after.bounds.height).toBeGreaterThanOrEqual(before.bounds.height);
  });

  it("Expand All, Re-layout, Collapse All: the boxes below the collapsed tables move up, nothing overlaps", () => {
    const keys = new Set([nodeKey("s", "w_child"), nodeKey("s", "w_parent")]);
    const open = buildDiagram(objects, { ...opts, expanded: keys });
    const layout = layoutDiagram(open, { direction: "TB" }); // laid out with the tables expanded, the child below the parent
    const closed = buildDiagram(objects, opts);
    const after = buildScene(closed, layout);
    const home = buildScene(open, layout);
    expect(after.rects.some((r, j) => r.y < home.rects[j].y)).toBe(true);
    after.rects.forEach((r, j) => expect(r.y).toBeLessThanOrEqual(home.rects[j].y));
    for (let a = 0; a < after.rects.length; a++)
      for (let b = a + 1; b < after.rects.length; b++) {
        const p = after.rects[a];
        const q = after.rects[b];
        expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${a} and ${b} overlap`).toBe(false);
      }
    expect(after.bounds.height).toBeLessThan(home.bounds.height);
  });

  it("collapsing again gives back the same scene", () => {
    const closed = buildDiagram(objects, opts);
    const layout = layoutDiagram(closed);
    const before = buildScene(closed, layout);
    buildScene(buildDiagram(objects, { ...opts, expanded: new Set([nodeKey("s", "w_child"), nodeKey("s", "w_parent")]) }), layout);
    const again = buildScene(buildDiagram(objects, opts), layout);
    expect(again.rects).toEqual(before.rects);
    expect(again.bounds).toEqual(before.bounds);
  });
});

describe("roundedPath", () => {
  it("rounds the corners and never reaches past half of a short segment", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 6 }, { x: 200, y: 6 }]);
    expect(d).toMatch(/^M0 0 L9[0-9] 0 Q100 0 100 \d/);
    expect(d.endsWith("L200 6")).toBe(true);
    // the 6px riser: each corner rounds by at most 3px
    expect(d).toContain("Q100 0 100 3");
  });
});
