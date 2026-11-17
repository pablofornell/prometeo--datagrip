// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FONT_MAX, FONT_MIN, WHEEL_STEP, type WheelAccumulator, clampFontSize, wheelFontStep, wheelPixels } from "./wheelZoom";

const fresh = (): WheelAccumulator => ({ sum: 0, time: 0 });

describe("wheel pixels", () => {
  it("turns line and page units into pixels", () => {
    expect(wheelPixels(-100, 0)).toBe(-100);
    expect(wheelPixels(-3, 1)).toBe(-120);
    expect(wheelPixels(1, 2)).toBe(800);
  });
});

describe("wheel font step", () => {
  it("wheel up grows and wheel down shrinks, one step for each mouse notch", () => {
    const acc = fresh();
    expect(wheelFontStep(acc, -100, 0, 1000)).toBe(1);
    expect(wheelFontStep(acc, -100, 0, 1050)).toBe(1);
    expect(wheelFontStep(acc, 100, 0, 1100)).toBe(-1);
  });

  it("does not jump on a fast spin: at most one step for each event", () => {
    expect(wheelFontStep(fresh(), -900, 0, 1000)).toBe(1);
    expect(wheelFontStep(fresh(), 3, 2, 1000)).toBe(-1);
  });

  it("adds up the small deltas of a trackpad pinch", () => {
    const acc = fresh();
    let steps = 0;
    for (let i = 0; i < 20; i++) steps += wheelFontStep(acc, -5, 0, 1000 + i * 16);
    // 20 x 5 px = 100 px = two steps, not twenty
    expect(steps).toBe(2);
    expect(WHEEL_STEP).toBe(50);
  });

  it("starts again after a pause or a change of direction", () => {
    const acc = fresh();
    expect(wheelFontStep(acc, -30, 0, 1000)).toBe(0);
    expect(wheelFontStep(acc, -30, 0, 2000)).toBe(0); // the pause dropped the first 30 px
    expect(wheelFontStep(acc, -30, 0, 2016)).toBe(1);
    expect(wheelFontStep(acc, -30, 0, 2032)).toBe(0);
    expect(wheelFontStep(acc, 30, 0, 2048)).toBe(0); // the other direction dropped the 30 px up
    expect(wheelFontStep(acc, 30, 0, 2064)).toBe(-1);
  });

  it("ignores an event without vertical distance", () => {
    expect(wheelFontStep(fresh(), 0, 0, 1000)).toBe(0);
  });
});

describe("clamp font size", () => {
  it("steps by 1 px inside the range", () => {
    expect(clampFontSize(13, 1)).toBe(14);
    expect(clampFontSize(13, -1)).toBe(12);
  });

  it("stops at the limits", () => {
    expect(clampFontSize(FONT_MAX, 1)).toBe(FONT_MAX);
    expect(clampFontSize(FONT_MIN, -1)).toBe(FONT_MIN);
    expect(FONT_MIN).toBe(8);
    expect(FONT_MAX).toBe(40);
  });
});
