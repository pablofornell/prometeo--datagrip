import { describe, expect, it } from "vitest";
import { layoutDiagram } from "./layout";
import { buildDiagram, type DiagramInputObject, type DiagramOptions } from "./model";
import { resolvePalette } from "./palette";
import { renderDiagramSvg } from "./svg";
import { MAX_ZOOM, MIN_ZOOM, centerOn, fitView, minimapFrame, revealRect, visibleRect, zoomAt } from "./view";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (name: string): DiagramInputObject => ({
  schema: "shop",
  name,
  kind: "table",
  columns: [{ name: "id", typeName: "bigint", isPk: true }],
});

/** Corners of `bounds` after the fit transform, in stage coordinates. */
const corners = (b: { x: number; y: number; width: number; height: number }, v: { zoom: number; tx: number; ty: number }) => ({
  left: v.tx + b.x * v.zoom,
  top: v.ty + b.y * v.zoom,
  right: v.tx + (b.x + b.width) * v.zoom,
  bottom: v.ty + (b.y + b.height) * v.zoom,
});

describe("fitView", () => {
  it("puts the whole padded box inside the stage and centers it", () => {
    const bounds = { x: -48, y: -76, width: 600, height: 400 };
    const stage = { width: 1000, height: 700 };
    const v = fitView(bounds, stage)!;
    const c = corners(bounds, v);
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.top).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeLessThanOrEqual(stage.width);
    expect(c.bottom).toBeLessThanOrEqual(stage.height);
    expect(c.left).toBeCloseTo(stage.width - c.right, 6);
    expect(c.top).toBeCloseTo(stage.height - c.bottom, 6);
  });

  it("never zooms in past 2x", () => {
    const v = fitView({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 })!;
    expect(v.zoom).toBeLessThanOrEqual(2);
  });

  it("clamps to the minimum zoom for a huge diagram", () => {
    const v = fitView({ x: 0, y: 0, width: 100000, height: 100000 }, { width: 800, height: 600 })!;
    expect(v.zoom).toBe(0.1);
  });

  it("returns null when the stage or the bounds are empty", () => {
    expect(fitView({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(fitView({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toBeNull();
  });

  it("agrees with the bounds the SVG emits as its viewBox", () => {
    const model = buildDiagram([obj("orders"), obj("customers"), obj("products")], opts);
    const layout = layoutDiagram(model);
    const svg = renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, resolvePalette(() => ""));
    const m = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    const bounds = { x: Number(m![1]), y: Number(m![2]), width: Number(m![3]), height: Number(m![4]) };
    const stage = { width: 900, height: 600 };
    const v = fitView(bounds, stage)!;
    const c = corners(bounds, v);
    expect(c.left).toBeGreaterThanOrEqual(-1e-9);
    expect(c.top).toBeGreaterThanOrEqual(-1e-9);
    expect(c.right).toBeLessThanOrEqual(stage.width + 1e-9);
    expect(c.bottom).toBeLessThanOrEqual(stage.height + 1e-9);
    expect(c.left).toBeCloseTo(stage.width - c.right, 6);
    expect(c.top).toBeCloseTo(stage.height - c.bottom, 6);
  });
});

describe("zoomAt", () => {
  it("keeps the diagram point under the cursor fixed", () => {
    const v = { zoom: 1, tx: 30, ty: -20 };
    const px = 400;
    const py = 250;
    const before = { x: (px - v.tx) / v.zoom, y: (py - v.ty) / v.zoom };
    const z = zoomAt(v, 1.8, px, py);
    expect(z.zoom).toBeCloseTo(1.8, 9);
    expect((px - z.tx) / z.zoom).toBeCloseTo(before.x, 9);
    expect((py - z.ty) / z.zoom).toBeCloseTo(before.y, 9);
  });

  it("clamps the zoom", () => {
    expect(zoomAt({ zoom: 3.9, tx: 0, ty: 0 }, 5, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ zoom: 0.11, tx: 0, ty: 0 }, 0.1, 0, 0).zoom).toBe(MIN_ZOOM);
  });
});

describe("visibleRect / centerOn / revealRect", () => {
  const stage = { width: 800, height: 600 };
  it("reports the diagram rectangle in view and centres on a point", () => {
    const v = centerOn({ zoom: 2, tx: 0, ty: 0 }, stage, 500, 300);
    const r = visibleRect(v, stage);
    expect(r.x + r.width / 2).toBeCloseTo(500, 9);
    expect(r.y + r.height / 2).toBeCloseTo(300, 9);
    expect(r.width).toBe(400);
  });

  it("pans only as much as needed to reveal a box, and not at all when it is visible", () => {
    const v = { zoom: 1, tx: 0, ty: 0 };
    expect(revealRect(v, stage, { x: 100, y: 100, width: 100, height: 50 })).toBe(v);
    const moved = revealRect(v, stage, { x: 900, y: 100, width: 100, height: 50 });
    expect(moved.tx).toBeLessThan(0);
    expect(moved.ty).toBe(0);
    const r = visibleRect(moved, stage);
    expect(r.x + r.width).toBeGreaterThanOrEqual(1000);
  });
});

describe("minimapFrame", () => {
  it("fits the bounds into the box keeping the aspect ratio", () => {
    const f = minimapFrame({ x: -48, y: -48, width: 2000, height: 1000 }, { width: 200, height: 140 });
    expect(f.width).toBe(200);
    expect(f.height).toBe(100);
    expect(f.scale).toBeCloseTo(0.1, 9);
  });
  it("is empty for empty bounds", () => {
    expect(minimapFrame({ x: 0, y: 0, width: 0, height: 0 }, { width: 200, height: 140 })).toEqual({ width: 0, height: 0, scale: 0 });
  });
});
