// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EDITOR_FONT_MAX, EDITOR_FONT_MIN } from "../../state/settings";
import { WHEEL_STEP, type WheelAccumulator, type WheelLike, clampFontSize, handleWheel, isWheelNotch, wheelFontStep } from "./wheelZoom";

const fresh = (): WheelAccumulator => ({ sum: 0, time: 0 });
/** A mouse notch as an engine reports it: `deltaY` in px and `wheelDeltaY` (120 for each notch, opposite sign). */
const notch = (deltaY: number) => ({ deltaY, deltaMode: 0, wheelDeltaY: deltaY < 0 ? 120 : -120 });
/** A smooth (trackpad) delta. */
const smooth = (deltaY: number) => ({ deltaY, deltaMode: 0, wheelDeltaY: Math.round(-deltaY * 3) });

describe("wheel notch", () => {
  it("knows a mouse notch whatever its size in px", () => {
    expect(isWheelNotch(notch(-100))).toBe(true); // Chromium
    expect(isWheelNotch(notch(40))).toBe(true); // WebKitGTK
    expect(isWheelNotch(notch(-33))).toBe(true); // WebView2, 1 line for each notch
    expect(isWheelNotch(notch(100 / 1.5))).toBe(true); // Chromium divides by the page zoom
    expect(isWheelNotch({ deltaY: -3, deltaMode: 1 })).toBe(true); // lines
    expect(isWheelNotch({ deltaY: 1, deltaMode: 2 })).toBe(true); // pages
  });

  it("knows a smooth delta", () => {
    expect(isWheelNotch(smooth(-5))).toBe(false);
    expect(isWheelNotch(smooth(-0.5))).toBe(false);
    expect(isWheelNotch({ deltaY: 0, deltaMode: 0, wheelDeltaY: 0 })).toBe(false);
  });

  it("falls back on the delta when the engine has no wheelDeltaY", () => {
    expect(isWheelNotch({ deltaY: -40, deltaMode: 0 })).toBe(true);
    expect(isWheelNotch({ deltaY: -33, deltaMode: 0 })).toBe(true);
    expect(isWheelNotch({ deltaY: -4, deltaMode: 0 })).toBe(false);
    expect(isWheelNotch({ deltaY: -40.5, deltaMode: 0 })).toBe(false);
  });
});

describe("wheel font step", () => {
  it("wheel up grows and wheel down shrinks, exactly one step for each notch on every platform", () => {
    for (const px of [100, 53, 40, 33, 16]) {
      const acc = fresh();
      expect(wheelFontStep(acc, notch(-px), 1000)).toBe(1);
      expect(wheelFontStep(acc, notch(px), 1500)).toBe(-1);
    }
  });

  it("does not lose a slow notch after a long pause, nor use the accumulator for it", () => {
    const acc = fresh();
    expect(wheelFontStep(acc, notch(-40), 1000)).toBe(1);
    expect(wheelFontStep(acc, notch(-40), 9000)).toBe(1);
    expect(wheelFontStep(acc, notch(-40), 9010)).toBe(1);
    expect(acc.sum).toBe(0);
  });

  it("does not jump on a fast spin: one step for each event", () => {
    expect(wheelFontStep(fresh(), notch(-900), 1000)).toBe(1);
    expect(wheelFontStep(fresh(), { deltaY: 3, deltaMode: 2 }, 1000)).toBe(-1);
  });

  it("adds up the small deltas of a trackpad pinch", () => {
    const acc = fresh();
    let steps = 0;
    for (let i = 0; i < 20; i++) steps += wheelFontStep(acc, smooth(-5), 1000 + i * 16);
    // 20 x 5 px = 100 px = two steps, not twenty
    expect(steps).toBe(2);
    expect(WHEEL_STEP).toBe(50);
  });

  it("starts again after a pause or a change of direction", () => {
    const acc = fresh();
    expect(wheelFontStep(acc, smooth(-12), 1000)).toBe(0);
    expect(wheelFontStep(acc, smooth(-12), 2000)).toBe(0); // the pause dropped the first 12 px
    expect(wheelFontStep(acc, smooth(-12), 2016)).toBe(0);
    expect(wheelFontStep(acc, smooth(-12), 2032)).toBe(0);
    expect(wheelFontStep(acc, smooth(-12), 2048)).toBe(0);
    expect(wheelFontStep(acc, smooth(-12), 2064)).toBe(1); // 60 px
    expect(wheelFontStep(acc, smooth(-12), 2080)).toBe(0);
    expect(wheelFontStep(acc, smooth(12), 2096)).toBe(0); // the other direction dropped the 12 px up
    expect(wheelFontStep(acc, smooth(39), 2112)).toBe(-1);
  });

  it("ignores an event without vertical distance", () => {
    expect(wheelFontStep(fresh(), { deltaY: 0, deltaMode: 0 }, 1000)).toBe(0);
  });
});

describe("clamp font size", () => {
  it("steps by 1 px inside the range, which is the range of the settings import", () => {
    expect(clampFontSize(13, 1)).toBe(14);
    expect(clampFontSize(13, -1)).toBe(12);
    expect(EDITOR_FONT_MIN).toBe(8);
    expect(EDITOR_FONT_MAX).toBe(48);
  });

  it("stops at the limits", () => {
    expect(clampFontSize(EDITOR_FONT_MAX, 1)).toBe(EDITOR_FONT_MAX);
    expect(clampFontSize(EDITOR_FONT_MIN, -1)).toBe(EDITOR_FONT_MIN);
    expect(clampFontSize(47, 1)).toBe(48);
  });

  it("never moves against the step when the stored size is outside the range", () => {
    expect(clampFontSize(60, 1)).toBe(60);
    expect(clampFontSize(60, -1)).toBe(59);
    expect(clampFontSize(5, -1)).toBe(5);
    expect(clampFontSize(5, 1)).toBe(6);
  });
});

describe("wheel handler", () => {
  type Ev = WheelLike & { prevented: number };
  const event = (over: Partial<WheelLike> = {}): Ev => {
    const e: Ev = {
      ...notch(-100),
      ctrlKey: true,
      metaKey: false,
      timeStamp: 1000,
      prevented: 0,
      preventDefault() {
        e.prevented++;
      },
      ...over,
    };
    return e;
  };
  /** A host whose size `setSize` changes; read it back with `h.now`. */
  const host = (start: number, enabled = true) => {
    const h = { now: start, enabled: () => enabled, size: () => h.now, setSize: (n: number) => void (h.now = n) };
    return h;
  };

  it("Ctrl or Cmd + wheel changes the size and stops the page zoom", () => {
    const h = host(13);
    const e = event();
    expect(handleWheel(e, h, fresh())).toBe(true);
    expect(h.now).toBe(14);
    expect(e.prevented).toBe(1);
    const m = event({ ctrlKey: false, metaKey: true, ...notch(100) });
    expect(handleWheel(m, h, fresh())).toBe(true);
    expect(h.now).toBe(13);
  });

  it("leaves a wheel without Ctrl or Cmd alone", () => {
    const h = host(13);
    const e = event({ ctrlKey: false });
    expect(handleWheel(e, h, fresh())).toBe(false);
    expect(h.now).toBe(13);
    expect(e.prevented).toBe(0);
  });

  it("does nothing when it is not enabled (the setting is off, or a Settings preview)", () => {
    const h = host(13, false);
    const e = event();
    expect(handleWheel(e, h, fresh())).toBe(false);
    expect(h.now).toBe(13);
    expect(e.prevented).toBe(0);
  });

  it("stops the page zoom at the end of the range too, and wheel up does not shrink a stored size above it", () => {
    const h = host(48);
    const e = event();
    expect(handleWheel(e, h, fresh())).toBe(true);
    expect(h.now).toBe(48);
    expect(e.prevented).toBe(1);
    const big = host(60);
    handleWheel(event(), big, fresh());
    expect(big.now).toBe(60);
  });
});
