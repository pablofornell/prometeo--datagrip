// @vitest-environment node
/**
 * Contrast guarantee of colour system v2 (docs/ux/theme-tokens.md section 10).
 *
 * The test reads the real stylesheets (dark.css, light.css, tokens-extra.css: no copy of the values), resolves the
 * tokens the way the browser does (`var()`, `color-mix`) and checks, for the dark and the light theme:
 *   - every `--dg-<family>-fg` on every surface, plain and under each wash of its family (>= 4.5:1),
 *   - body text and muted text on the washes and on the selected-row backgrounds (>= 4.5:1),
 *   - non-text indicators: family solids, the rainbow palette, the focus ring (>= 3:1),
 *   - white text on every fill: primary gradient (all states), danger / run / stop buttons (>= 4.5:1),
 *   - notifications, banners, the grid, the title bar and the status bar glow.
 */
import { describe, expect, it } from "vitest";
import darkCss from "./dark.css?raw";
import lightCss from "./light.css?raw";
import extraCss from "../styles/tokens-extra.css?raw";
import { type Rgb, type Rgba, type TokenMap, contrast, expandVars, flatten, resolveColor } from "./contrast";

type Theme = "dark" | "light";

const noComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Custom properties of the blocks of `css` whose selector list contains exactly `selector`. */
function declarations(css: string, selector: string): TokenMap {
  const out: TokenMap = {};
  for (const m of noComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

/** The theme files in load order (src/index.tsx: dark, light, then tokens-extra). */
const THEME_FILES = [darkCss, lightCss, extraCss];

/** Tokens of a theme: the `:root` blocks, then the `:root[data-theme]` blocks (which win, as in the browser). */
function themeTokens(theme: Theme): TokenMap {
  const out: TokenMap = {};
  for (const css of THEME_FILES) Object.assign(out, declarations(css, ":root"));
  for (const css of THEME_FILES) Object.assign(out, declarations(css, `:root[data-theme="${theme}"]`));
  return out;
}

const FAMILIES = ["accent", "success", "warning", "danger", "info", "special", "neutral"] as const;
const WASHES = ["wash-soft", "wash", "wash-strong"] as const;
/** Opaque surfaces that hold coloured text, badges and rows. */
const SURFACES = ["--dg-window-bg", "--dg-island-bg", "--dg-panel-bg", "--dg-layer-1-bg", "--dg-popup-bg", "--dg-dialog-bg", "--dg-editor-bg"];
/** Surfaces that hold selectable rows (trees, lists, menus, dialogs). */
const ROW_SURFACES = ["--dg-island-bg", "--dg-panel-bg", "--dg-popup-bg", "--dg-dialog-bg"];
const AA = 4.5;
const GRAPHIC = 3;

describe.each(["dark", "light"] as Theme[])("%s theme", (theme) => {
  const vars = themeTokens(theme);
  const color = (name: string): Rgba => {
    if (vars[name] === undefined) throw new Error(`${name} is not defined in the ${theme} theme`);
    return resolveColor(vars[name], vars);
  };
  /** An opaque token as RGB. */
  const solid = (name: string): Rgb => {
    const c = color(name);
    if (c.a < 0.999) throw new Error(`${name} is not opaque: ${vars[name]}`);
    return c.rgb;
  };
  /** Token layers (washes) over the opaque surface token `surface`. */
  const on = (surface: string, ...layers: string[]): Rgb => flatten(solid(surface), ...layers.map(color));
  const fails: string[] = [];
  const check = (label: string, fg: Rgb, bg: Rgb, min: number): void => {
    const ratio = contrast(fg, bg);
    if (ratio < min) fails.push(`${label}: ${ratio.toFixed(2)} < ${min}`);
  };
  const done = (): void => {
    const copy = fails.splice(0);
    expect(copy.join("\n")).toBe("");
  };

  it("defines the seven families with every token, and the washes come from the family solid", () => {
    for (const f of FAMILIES) {
      for (const part of ["", "-fill", "-fg"]) expect(solid(`--dg-${f}${part}`), `--dg-${f}${part}`).toHaveLength(3);
      for (const w of [...WASHES, "border"]) {
        const raw = vars[`--dg-${f}-${w}`];
        expect(raw, `--dg-${f}-${w}`).toMatch(new RegExp(`^color-mix\\(in srgb, var\\(--dg-${f}\\) var\\(--dg-wash-[\\w-]+\\), transparent\\)$`));
        const c = color(`--dg-${f}-${w}`);
        expect(c.rgb.map(Math.round), `--dg-${f}-${w}`).toEqual(solid(`--dg-${f}`).map(Math.round));
        expect(c.a).toBeGreaterThan(0);
        expect(c.a).toBeLessThan(0.6);
      }
      // the three washes get stronger in this order
      const [soft, mid, strong] = WASHES.map((w) => color(`--dg-${f}-${w}`).a);
      expect(soft).toBeLessThan(mid);
      expect(mid).toBeLessThan(strong);
    }
  });

  it("family text reads on every surface, plain and under each wash of its family", () => {
    for (const f of FAMILIES) {
      const fg = solid(`--dg-${f}-fg`);
      for (const s of SURFACES) {
        check(`--dg-${f}-fg on ${s}`, fg, solid(s), AA);
        for (const w of WASHES) check(`--dg-${f}-fg on --dg-${f}-${w} over ${s}`, fg, on(s, `--dg-${f}-${w}`), AA);
      }
    }
    done();
  });

  it("family text reads on a selected row, a hovered row, and as a badge on a selected row", () => {
    for (const f of FAMILIES) {
      const fg = solid(`--dg-${f}-fg`);
      for (const s of ROW_SURFACES) {
        for (const sel of ["--dg-row-hover-bg", "--dg-selection-inactive-bg", "--dg-selection-bg"]) {
          check(`--dg-${f}-fg on ${sel} over ${s}`, fg, on(s, sel), AA);
          check(`--dg-${f}-fg on --dg-${f}-wash on ${sel} over ${s}`, fg, on(s, sel, `--dg-${f}-wash`), AA);
        }
      }
    }
    done();
  });

  it("body text and on-wash text read on every wash of every family", () => {
    for (const t of ["--dg-text", "--dg-text-muted-on-wash"]) {
      for (const f of FAMILIES) {
        for (const s of SURFACES) {
          for (const w of WASHES) check(`${t} on --dg-${f}-${w} over ${s}`, solid(t), on(s, `--dg-${f}-${w}`), AA);
        }
      }
    }
    done();
  });

  it("muted and secondary text read on the surfaces; on a selected row they take the on-wash value", () => {
    for (const t of ["--dg-text-muted", "--dg-text-secondary"]) {
      for (const s of SURFACES) check(`${t} on ${s}`, solid(t), solid(s), AA);
      for (const s of ROW_SURFACES) check(`${t} on --dg-row-hover-bg over ${s}`, solid(t), on(s, "--dg-row-hover-bg"), AA);
    }
    for (const s of ROW_SURFACES) {
      for (const sel of ["--dg-selection-inactive-bg", "--dg-selection-bg"]) {
        check(`--dg-text-muted-on-wash on ${sel} over ${s}`, solid("--dg-text-muted-on-wash"), on(s, sel), AA);
        check(`--dg-selection-fg on ${sel} over ${s}`, solid("--dg-selection-fg"), on(s, sel), AA);
        check(`--dg-text on ${sel} over ${s}`, solid("--dg-text"), on(s, sel), AA);
      }
    }
    done();
  });

  it("links and the selected tab / toggled button read on what they sit on", () => {
    for (const s of SURFACES) check(`--dg-link on ${s}`, solid("--dg-link"), solid(s), AA);
    for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-popup-bg", "--dg-dialog-bg"]) {
      check(`--dg-tab-active-fg on --dg-tab-selected-bg over ${s}`, solid("--dg-tab-active-fg"), on(s, "--dg-tab-selected-bg"), AA);
      check(`--dg-toolbar-selected-fg on --dg-toolbar-selected-bg over ${s}`, solid("--dg-toolbar-selected-fg"), on(s, "--dg-toolbar-selected-bg"), AA);
      check(`--dg-text on --dg-tab-selected-bg over ${s}`, solid("--dg-text"), on(s, "--dg-tab-selected-bg"), AA);
    }
    done();
  });

  it("non-text indicators are visible: family solids, rainbow, focus ring (3:1)", () => {
    for (const f of FAMILIES) {
      for (const s of SURFACES) check(`--dg-${f} on ${s}`, solid(`--dg-${f}`), solid(s), GRAPHIC);
      // a dot, an icon or an edge on a selected row
      for (const s of ["--dg-island-bg", "--dg-panel-bg"]) check(`--dg-${f} on a selected row over ${s}`, solid(`--dg-${f}`), on(s, "--dg-selection-bg"), GRAPHIC);
    }
    for (let i = 1; i <= 12; i++) {
      for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-editor-bg", "--dg-window-bg"]) check(`--rainbow-${i} on ${s}`, solid(`--rainbow-${i}`), solid(s), GRAPHIC);
    }
    for (const s of SURFACES) check(`--dg-focus-ring on ${s}`, solid("--dg-focus-ring"), solid(s), GRAPHIC);
    for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-popup-bg"]) check(`--dg-selection-edge on a selected row over ${s}`, solid("--dg-selection-edge"), on(s, "--dg-selection-bg"), GRAPHIC);
    done();
  });

  it("the rainbow has 12 distinct colours", () => {
    const hexes = Array.from({ length: 12 }, (_, i) => vars[`--rainbow-${i + 1}`]);
    expect(hexes.every((h) => /^#[0-9A-F]{6}$/i.test(h))).toBe(true);
    expect(new Set(hexes.map((h) => h.toUpperCase())).size).toBe(12);
  });

  it("white text reads on every fill, button state and gradient end", () => {
    const white = solid("--dg-text-over-accent");
    for (const f of FAMILIES) check(`white on --dg-${f}-fill`, white, solid(`--dg-${f}-fill`), AA);
    const fills = ["--dg-button-primary-bg", "--dg-button-primary-hover-bg", "--dg-button-primary-pressed-bg", "--dg-button-danger-hover-bg", "--dg-toolbar-run-bg", "--dg-toolbar-run-hover-bg", "--dg-toolbar-stop-bg", "--dg-toolbar-stop-hover-bg", "--dg-checkbox-selected-bg", "--dg-toggle-on-bg"];
    for (const t of fills) check(`white on ${t}`, white, solid(t), AA);
    for (const g of ["", "-hover", "-pressed"]) {
      for (const end of ["from", "to"]) check(`white on --dg-accent-grad${g}-${end}`, white, solid(`--dg-accent-grad${g === "" ? "" : g}-${end}`), AA);
    }
    check("--dg-button-primary-fg on --dg-button-primary-bg", solid("--dg-button-primary-fg"), solid("--dg-button-primary-bg"), AA);
    done();
  });

  it("notifications and banners read, per severity", () => {
    for (const [kind, fam] of [["info", "info"], ["success", "success"], ["warning", "warning"], ["error", "danger"]] as const) {
      const bg = solid(`--dg-notification-${kind}-bg`);
      check(`--dg-notification-fg on --dg-notification-${kind}-bg`, solid("--dg-notification-fg"), bg, AA);
      check(`--dg-text-muted-on-wash on --dg-notification-${kind}-bg`, solid("--dg-text-muted-on-wash"), bg, AA);
      check(`--dg-${fam}-fg on --dg-notification-${kind}-bg`, solid(`--dg-${fam}-fg`), bg, AA);
      check(`--dg-notification-link on --dg-notification-${kind}-bg`, solid("--dg-notification-link"), bg, AA);
      // the Notifications tool window paints the same colour as a row of the island
      for (const s of ["--dg-island-bg", "--dg-panel-bg", "--dg-dialog-bg"]) {
        check(`--dg-text on --dg-banner-${kind}-bg over ${s}`, solid("--dg-text"), on(s, `--dg-banner-${kind}-bg`), AA);
        check(`--dg-${fam}-fg on --dg-banner-${kind}-bg over ${s}`, solid(`--dg-${fam}-fg`), on(s, `--dg-banner-${kind}-bg`), AA);
      }
    }
    done();
  });

  it("the data grid reads: header, selection and pending changes", () => {
    const fg = solid("--dg-grid-fg");
    for (const t of ["--dg-grid-bg", "--dg-grid-header-bg", "--dg-grid-selection-bg", "--dg-grid-modified-bg", "--dg-grid-inserted-bg", "--dg-grid-deleted-bg", "--dg-grid-current-row-bg", "--dg-grid-stripe-bg"]) {
      check(`--dg-grid-fg on ${t}`, fg, solid(t), AA);
    }
    check("--dg-grid-header-fg on --dg-grid-header-bg", solid("--dg-grid-header-fg"), solid("--dg-grid-header-bg"), AA);
    done();
  });

  it("the title bar and status bar glow keep their text readable", () => {
    for (const tint of ["--dg-toolbar-tint", "--dg-toolbar-tint-2", "--dg-toolbar-bg"]) {
      for (const t of ["--dg-toolbar-fg", "--dg-text-muted-on-wash", "--dg-accent-fg"]) check(`${t} on ${tint}`, solid(t), solid(tint), AA);
      check(`--dg-accent on ${tint}`, solid("--dg-accent"), solid(tint), GRAPHIC);
      check(`--dg-toolbar-selected-fg on a toggled button over ${tint}`, solid("--dg-toolbar-selected-fg"), flatten(solid(tint), color("--dg-toolbar-selected-bg")), AA);
    }
    for (const tint of ["--dg-statusbar-tint", "--dg-statusbar-tint-2", "--dg-statusbar-bg"]) {
      for (const t of ["--dg-statusbar-fg", "--dg-statusbar-hover-fg", "--dg-statusbar-breadcrumb-fg", "--dg-text-success", "--dg-text-error"]) check(`${t} on ${tint}`, solid(t), solid(tint), AA);
    }
    done();
  });

  it("every token resolves: no var() that points nowhere", () => {
    for (const [name, value] of Object.entries(vars)) expect(() => expandVars(value, vars), name).not.toThrow();
  });
});

describe("resolveColor", () => {
  it("reads hex, var() and color-mix like the browser", () => {
    const vars = { "--a": "#FF0000", "--b": "var(--a)", "--p": "25%", "--w": "color-mix(in srgb, var(--b) var(--p), transparent)", "--o": "color-mix(in srgb, var(--a) 50%, #0000FF)" };
    expect(resolveColor("#0F0")).toEqual({ rgb: [0, 255, 0], a: 1 });
    expect(resolveColor("#00FF0080").a).toBeCloseTo(0.5, 2);
    expect(resolveColor("var(--b)", vars)).toEqual({ rgb: [255, 0, 0], a: 1 });
    expect(resolveColor("var(--w)", vars)).toEqual({ rgb: [255, 0, 0], a: 0.25 });
    expect(resolveColor("var(--o)", vars)).toEqual({ rgb: [127.5, 0, 127.5], a: 1 });
    expect(flatten([0, 0, 0], resolveColor("var(--w)", vars))).toEqual([63.75, 0, 0]);
    expect(() => resolveColor("var(--nope)", vars)).toThrow();
    expect(() => resolveColor("rgb(1 2 3)")).toThrow();
  });
});
