// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIN_OVERSCAN_ROWS, measuredViewport, overscanRows, rowWindow } from "./viewport";
import { prefixSums, windowOf } from "./transpose";

// the table editor's customers table: id 124px, email 228px, name 160px, vip 134px, created_at 266px
const X = prefixSums([124, 228, 160, 134, 266]);
const GUTTER = 32;
const OVERSCAN = 280;
const colWindow = (viewW: number) => windowOf(X, -OVERSCAN, viewW - GUTTER + OVERSCAN);

describe("viewport measurement", () => {
  it("a hidden pane (0 x 0) keeps the last real size", () => {
    const real = { w: 1180, h: 480 };
    expect(measuredViewport(0, 0, real)).toBe(real);
    expect(measuredViewport(0, 480, real)).toBe(real);
    expect(measuredViewport(1180, 0, real)).toBe(real);
  });

  it("a displayed pane replaces the size", () => {
    expect(measuredViewport(900, 300, { w: 800, h: 600 })).toEqual({ w: 900, h: 300 });
  });

  it("windowing a hidden pane's size would cut the columns from the third on (the blank cells)", () => {
    const hidden = colWindow(0);
    const shown = colWindow(1180);
    expect(hidden).toEqual([0, 1]);
    expect(shown[1]).toBe(4);
    // the size the grid windows on after the fix
    const v = measuredViewport(0, 0, { w: 1180, h: 480 });
    expect(colWindow(v.w)).toEqual(shown);
  });
});

describe("row window", () => {
  const ROW = 27;

  it("keeps half a screen of rows built beyond each edge, at least MIN_OVERSCAN_ROWS", () => {
    expect(overscanRows(100, ROW)).toBe(MIN_OVERSCAN_ROWS);
    expect(overscanRows(0, ROW)).toBe(MIN_OVERSCAN_ROWS);
    expect(overscanRows(-27, ROW)).toBe(MIN_OVERSCAN_ROWS);
    expect(overscanRows(573, ROW)).toBe(22); // 21.2 visible rows
    expect(overscanRows(1620, ROW)).toBe(60); // 60 visible rows
  });

  it("the buffer is larger than one wheel flick of a few hundred px (it was 4 rows = 108px)", () => {
    expect(overscanRows(573, ROW) * ROW).toBeGreaterThan(573);
  });

  it("windows the visible rows plus the overscan at both ends", () => {
    // 600px of data from row 100: rows 100..122 visible
    expect(rowWindow(100 * ROW, 600, 10_000, ROW, 10)).toEqual([90, 133]);
  });

  it("clamps to the first and the last row", () => {
    expect(rowWindow(0, 600, 10_000, ROW, 10)).toEqual([0, 33]);
    expect(rowWindow(9_990 * ROW, 600, 10_000, ROW, 10)).toEqual([9_980, 9_999]);
  });

  it("a short result is entirely built, none gives an empty window", () => {
    expect(rowWindow(0, 600, 5, ROW, 10)).toEqual([0, 4]);
    expect(rowWindow(0, 600, 0, ROW, 10)).toEqual([0, -1]);
  });

  it("a partly scrolled first row is still built", () => {
    expect(rowWindow(100 * ROW + 5, 600, 10_000, ROW, 0)).toEqual([100, 123]);
  });
});
