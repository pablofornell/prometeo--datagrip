import { describe, expect, it } from "vitest";
import { FALLBACK_FONT_MONO, FALLBACK_FONT_UI, FALLBACK_RAINBOW_DARK, FALLBACK_RAINBOW_LIGHT, alphaOf, contrast, inkOn, luminance, mix, parseColor, resolvePalette } from "./palette";

const read = (vars: Record<string, string>) => (name: string): string => vars[name] ?? "";

describe("resolvePalette", () => {
  it("resolves colours and concrete font stacks from the theme variables", () => {
    const p = resolvePalette(
      read({
        "--dg-editor-bg": "#010203",
        "--dg-font-mono": '"Test Mono", monospace',
        "--dg-font-ui": '"Test UI", sans-serif',
      }),
    );
    expect(p.background).toBe("#010203");
    expect(p.fontMono).toBe('"Test Mono", monospace');
    expect(p.fontUi).toBe('"Test UI", sans-serif');
  });

  it("flattens a translucent wash onto the surface it is drawn on (an exported file cannot resolve color-mix)", () => {
    const p = resolvePalette(
      read({
        "--dg-editor-bg": "#000000",
        "--dg-island-bg": "#ffffff",
        "--dg-banner-info-bg": "color-mix(in srgb, #0000ff 50%, transparent)",
        "--dg-accent": "rgb(255, 0, 0)",
        "--dg-text": "#ABCDEF",
        "--dg-separator": "var(--dg-unknown)",
      }),
    );
    expect(p.viewHeaderBg).toBe("#8080ff"); // half blue over the white card
    expect(p.selection).toBe("#ff0000");
    expect(p.headerFg).toBe("#abcdef");
    expect(p.nodeBorder).toBe("#33353b"); // not a colour: the fallback
  });

  it("keeps the alpha of rgba() and hsla() values: they are flattened onto the surface under them", () => {
    const p = resolvePalette(
      read({
        "--dg-editor-bg": "#000000",
        "--dg-island-bg": "#ffffff",
        "--dg-layer-1-bg": "rgba(0, 0, 255, 0.5)",
        "--dg-accent": "rgb(255 0 0 / 50%)",
        "--dg-text": "hsla(0, 0%, 0%, 0.25)",
        "--dg-grid-fg": "#0000ff80",
      }),
    );
    expect(p.headerBg).toBe("#8080ff"); // on the white card
    expect(p.selection).toBe("#800000"); // on the black canvas
    expect(p.headerFg).toBe("#bfbfbf");
    expect(p.text).toBe("#7f7fff");
    expect(alphaOf("rgba(1, 2, 3, 0.4)")).toBe(0.4);
    expect(alphaOf("hsl(120 100% 25% / 30%)")).toBe(0.3);
    expect(alphaOf("rgb(1, 2, 3)")).toBe(1);
    expect(alphaOf("#ffffff")).toBe(1);
  });

  it("falls back to concrete fonts when the variables are missing", () => {
    const p = resolvePalette(() => "");
    expect(p.fontMono).toBe(FALLBACK_FONT_MONO);
    expect(p.fontUi).toBe(FALLBACK_FONT_UI);
    expect(p.fontMono).not.toContain("var(");
    expect(p.fontUi).not.toContain("var(");
  });

  it("has a 12 colour rainbow: the dark fallback on a dark canvas, the light one on a light canvas", () => {
    const dark = resolvePalette(() => "");
    expect(dark.isDark).toBe(true);
    expect(dark.rainbow).toEqual(FALLBACK_RAINBOW_DARK);
    const light = resolvePalette(read({ "--dg-editor-bg": "#ffffff" }));
    expect(light.isDark).toBe(false);
    expect(light.rainbow).toEqual(FALLBACK_RAINBOW_LIGHT);
    expect(light.rainbow).toHaveLength(12);
    expect(new Set(light.rainbow).size).toBe(12);
  });

  it("takes the rainbow from the --dgd-cN variables (which follow --rainbow-N) in any css colour syntax", () => {
    const p = resolvePalette(read({ "--dgd-c1": "#123456", "--dgd-c2": "rgb(255, 0, 0)", "--dgd-c3": "hsl(120 100% 25%)", "--dgd-c4": "not a colour" }));
    expect(p.rainbow[0]).toBe("#123456");
    expect(p.rainbow[1]).toBe("#ff0000");
    expect(p.rainbow[2]).toBe("#008000");
    expect(p.rainbow[3]).toBe(FALLBACK_RAINBOW_DARK[3]);
  });
});

describe("colour maths", () => {
  it("parses hex, rgb and hsl", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#10203040")).toEqual([16, 32, 48]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual([255, 0, 0]);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it("picks the ink with the better contrast", () => {
    expect(inkOn("#ffe066", "#ffffff", "#15171b")).toBe("#15171b");
    expect(inkOn("#1b3a8a", "#ffffff", "#15171b")).toBe("#ffffff");
  });

  it("mixes colours", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("nope", "#ffffff", 0.5)).toBe("nope");
  });
});
