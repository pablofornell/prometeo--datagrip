// @vitest-environment node
import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";
import { effectiveZoom } from "./appearance";

/** The inline script of index.html that sets the zoom before first paint. */
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("uiScale"));

/** Runs the pre-paint script against a fake page whose localStorage holds `stored`; returns the `zoom` it set. */
function prepaintZoom(stored: unknown): string | undefined {
  const style: Record<string, string> = {};
  const localStorage = { getItem: (k: string) => (k === "datum.ui.settings" && stored !== undefined ? JSON.stringify(stored) : null) };
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

/** The inline script of index.html that carries the 0.5.x "prometeo.*" keys over to "datum.*". */
const migrateScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('"prometeo."'));

/** Runs it against a fake localStorage holding `initial`; returns the final contents. */
function migrate(initial: Record<string, string>): Record<string, string> {
  const data = new Map(Object.entries(initial));
  const localStorage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  new Function("localStorage", migrateScript!)(localStorage);
  return Object.fromEntries(data);
}

describe("index.html localStorage migration from 0.5.x", () => {
  it("is present", () => {
    expect(migrateScript).toBeDefined();
  });

  it("copies prometeo.* keys to datum.* and keeps the old ones", () => {
    expect(migrate({ "prometeo.ui.theme": '"light"', "prometeo.nav.recent": "[1]", other: "x" })).toEqual({
      "prometeo.ui.theme": '"light"',
      "prometeo.nav.recent": "[1]",
      other: "x",
      "datum.ui.theme": '"light"',
      "datum.nav.recent": "[1]",
      "datum.migrated": "1",
    });
  });

  it("never overwrites a datum.* key and does nothing a second time", () => {
    const once = migrate({ "prometeo.ui.theme": '"light"', "datum.ui.theme": '"dark"' });
    expect(once["datum.ui.theme"]).toBe('"dark"');
    expect(migrate(once)).toEqual(once);
  });

  it("runs only once: a datum.* key removed after the migration does not come back", () => {
    const { ["datum.ui.theme"]: _removed, ...after } = migrate({ "prometeo.ui.theme": '"light"' });
    expect(migrate(after)).toEqual(after);
  });
});
