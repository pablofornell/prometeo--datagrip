// @vitest-environment node
import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { effectiveZoom } from "./appearance";

/** The inline script of index.html that sets the zoom before first paint. */
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("uiScale"));

/** Runs the pre-paint script against a fake page whose localStorage holds `stored`; returns the `zoom` it set. */
function prepaintZoom(stored: unknown): string | undefined {
  const style: Record<string, string> = {};
  const localStorage = { getItem: (k: string) => (k === "prometeo.ui.settings" && stored !== undefined ? JSON.stringify(stored) : null) };
  new Function("document", "localStorage", script!)({ documentElement: { style } }, localStorage);
  return style.zoom;
}

describe("index.html pre-paint zoom", () => {
  it("is present", () => {
    expect(script).toBeDefined();
  });

  it("does nothing without stored settings or at 100 %", () => {
    expect(prepaintZoom(undefined)).toBeUndefined();
    expect(prepaintZoom({ uiScale: 100 })).toBeUndefined();
    expect(prepaintZoom({ uiScale: "bad" })).toBeUndefined();
  });

  it.each([
    [{ uiScale: 120 }, effectiveZoom(120)],
    [{ uiScale: 80 }, effectiveZoom(80)],
    [{ uiScale: 5000 }, effectiveZoom(200)],
    [{ uiScale: 124 }, effectiveZoom(120)],
    [{ uiScale: 150, uiCustomFont: true, uiFontSize: 16 }, effectiveZoom(150, 16)],
    [{ uiScale: 100, uiCustomFont: true, uiFontSize: 15 }, effectiveZoom(100, 15)],
    // the font size only counts while the custom font is on
    [{ uiScale: 110, uiCustomFont: false, uiFontSize: 20 }, effectiveZoom(110)],
  ])("matches effectiveZoom for %j", (stored, expected) => {
    expect(prepaintZoom(stored)).toBe(String(expected));
  });
});
