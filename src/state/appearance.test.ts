// @vitest-environment node
import { describe, expect, it } from "vitest";
import { UI_SCALE_DEFAULT, UI_SCALE_VALUES, effectiveZoom, sanitizeUiScale, stepUiScale, zoomMessage } from "./appearance";

describe("sanitizeUiScale", () => {
  it("keeps valid steps", () => {
    expect(sanitizeUiScale(100)).toBe(100);
    expect(sanitizeUiScale(80)).toBe(80);
    expect(sanitizeUiScale(200)).toBe(200);
  });

  it("rounds to the step and clamps to the range", () => {
    expect(sanitizeUiScale(104)).toBe(100);
    expect(sanitizeUiScale(125)).toBe(130);
    expect(sanitizeUiScale(10)).toBe(80);
    expect(sanitizeUiScale(5000)).toBe(200);
    expect(sanitizeUiScale(-3)).toBe(80);
  });

  it("falls back to the default for anything that is not a finite number", () => {
    for (const v of [undefined, null, "120", NaN, Infinity, {}, []]) expect(sanitizeUiScale(v)).toBe(UI_SCALE_DEFAULT);
  });

  it("lists 13 choices from 80 to 200", () => {
    expect(UI_SCALE_VALUES).toHaveLength(13);
    expect(UI_SCALE_VALUES[0]).toBe(80);
    expect(UI_SCALE_VALUES.at(-1)).toBe(200);
    expect(UI_SCALE_VALUES.every((v) => sanitizeUiScale(v) === v)).toBe(true);
  });
});

describe("stepUiScale", () => {
  it("moves one step", () => {
    expect(stepUiScale(100, 1)).toBe(110);
    expect(stepUiScale(100, -1)).toBe(90);
  });

  it("stops at the limits", () => {
    expect(stepUiScale(200, 1)).toBe(200);
    expect(stepUiScale(80, -1)).toBe(80);
  });

  it("repairs a stored value that is off the grid", () => {
    expect(stepUiScale(105, 1)).toBe(120);
    expect(stepUiScale(NaN, 1)).toBe(110);
  });
});

describe("effectiveZoom", () => {
  it("is the scale as a factor", () => {
    expect(effectiveZoom(100)).toBe(1);
    expect(effectiveZoom(120)).toBe(1.2);
  });

  it("multiplies by the zoom of the custom UI font size", () => {
    expect(effectiveZoom(100, 13)).toBe(1);
    expect(effectiveZoom(100, 16)).toBe(1.23);
    expect(effectiveZoom(150, 13)).toBe(1.5);
  });
});

describe("zoomMessage", () => {
  it("shows the percent and flags the ends of the range", () => {
    expect(zoomMessage(120)).toBe("UI scale 120%");
    expect(zoomMessage(200)).toBe("UI scale 200% (maximum)");
    expect(zoomMessage(80)).toBe("UI scale 80% (minimum)");
  });
});
