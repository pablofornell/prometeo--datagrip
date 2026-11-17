// @vitest-environment node
import { describe, expect, it } from "vitest";
import darkCss from "../../theme/dark.css?raw";
import lightCss from "../../theme/light.css?raw";
import extraCss from "../../styles/tokens-extra.css?raw";
import diagramCss from "./diagram.css?raw";
import { expandVars, type TokenMap } from "../../theme/contrast";
import { DIAGRAM_FONTS, PNG_MAX_AREA, PNG_MAX_SIDE, PNG_MIN_SCALE, XML_PROLOG, embedFonts, exportFile, loadFontCss, pngScale, pngSize, svgDataUrl, svgFileText, type ExportTarget } from "./export";
import { assignColors } from "./groups";
import { layoutDiagram } from "./layout";
import { buildDiagram } from "./model";
import { resolvePalette } from "./palette";
import { shopSchema } from "./sample";
import { renderDiagramSvg } from "./svg";

type Theme = "dark" | "light";

/** The part of `node:fs` / `node:os` the file test uses (the project has no Node type declarations). */
interface NodeFs {
  mkdtempSync(prefix: string): string;
  writeFileSync(path: string, text: string, encoding: "utf8"): void;
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
}
const nodeModule = (name: string): Promise<unknown> => import(/* @vite-ignore */ name);

/** Custom properties of the blocks of `css` whose selector list contains exactly `selector`. */
function declarations(css: string, selector: string): TokenMap {
  const out: TokenMap = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

/**
 * What `getComputedStyle(<html>).getPropertyValue(name)` gives in a theme: the token with its `var()` references
 * replaced (a `color-mix()` stays as it is). The theme files load in the order of src/index.tsx, diagram.css last.
 */
function computedStyle(theme: Theme): (name: string) => string {
  const files = [darkCss, lightCss, extraCss, diagramCss];
  const vars: TokenMap = {};
  for (const css of files) Object.assign(vars, declarations(css, ":root"));
  for (const css of files) Object.assign(vars, declarations(css, `:root[data-theme="${theme}"]`));
  return (name) => {
    if (vars[name] === undefined) return "";
    try {
      return expandVars(vars[name], vars);
    } catch {
      return vars[name]; // `var(--x, fallback)`: the resolver of the test does not do fallbacks
    }
  };
}

/**
 * A strict check that `text` is well-formed XML: one root element, every tag closed in order, attribute values
 * quoted and unique, and no `&` that is not one of the escapes the renderer writes. Throws on the first error.
 */
function checkXml(text: string): { root: string; elements: number } {
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;
  let rest = text.startsWith("<?xml") ? text.slice(text.indexOf("?>") + 2) : text;
  rest = rest.trim();
  const stack: string[] = [];
  let root = "";
  let elements = 0;
  for (const m of rest.matchAll(/<[^>]*>|[^<]+/g)) {
    const tok = m[0];
    if (!tok.startsWith("<")) {
      if (stack.length === 0) throw new Error(`text outside the root: ${tok.slice(0, 40)}`);
      if (entity.test(tok)) throw new Error(`bad entity in text: ${tok.slice(0, 40)}`);
      continue;
    }
    const close = /^<\/([\w:-]+)\s*>$/.exec(tok);
    if (close) {
      const open = stack.pop();
      if (open !== close[1]) throw new Error(`</${close[1]}> closes <${open}>`);
      continue;
    }
    const open = /^<([\w:-]+)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>$/.exec(tok);
    if (!open) throw new Error(`malformed tag: ${tok.slice(0, 80)}`);
    if (stack.length === 0) {
      if (root) throw new Error("a second root element");
      root = open[1];
    }
    const names = new Set<string>();
    for (const a of open[2].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (names.has(a[1])) throw new Error(`duplicate attribute ${a[1]} in <${open[1]}>`);
      names.add(a[1]);
      if (entity.test(a[2])) throw new Error(`bad entity in ${a[1]}="${a[2]}"`);
    }
    elements++;
    if (!open[3]) stack.push(open[1]);
  }
  if (stack.length) throw new Error(`<${stack.join("> <")}> not closed`);
  return { root, elements };
}

describe("checkXml (the test's own parser)", () => {
  it("accepts well-formed XML and rejects the usual mistakes", () => {
    expect(checkXml('<?xml version="1.0"?>\n<svg a="1"><g><text>a &amp; b</text></g><rect/></svg>')).toEqual({ root: "svg", elements: 4 });
    expect(() => checkXml("<svg><g></svg>")).toThrow();
    expect(() => checkXml('<svg a="1" a="2"/>')).toThrow();
    expect(() => checkXml("<svg><text>a & b</text></svg>")).toThrow();
    expect(() => checkXml("<svg/><svg/>")).toThrow();
  });
});

describe.each(["dark", "light"] as Theme[])("exported SVG file, %s theme", (theme) => {
  const palette = resolvePalette(computedStyle(theme));
  const model = buildDiagram(shopSchema(), { columns: "all", showTypes: true });
  const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, colors: assignColors(model, "cluster"), edgeLabels: true }, palette);

  it("has a palette of concrete sRGB colours (no var(), no color-mix())", () => {
    const colours = Object.entries(palette).flatMap(([k, v]) => (k === "rainbow" ? (v as string[]) : typeof v === "string" && !k.startsWith("font") ? [v] : []));
    expect(colours.length).toBeGreaterThan(20);
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(palette.isDark).toBe(theme === "dark");
  });

  it("is written as a well-formed, self-contained XML file", async () => {
    const fs = (await nodeModule("node:fs")) as NodeFs;
    const { tmpdir } = (await nodeModule("node:os")) as { tmpdir(): string };
    const dir = fs.mkdtempSync(`${tmpdir()}/dg-export-`);
    try {
      const file = `${dir}/diagram.svg`;
      fs.writeFileSync(file, svgFileText(svg), "utf8");
      const text = fs.readFileSync(file, "utf8");
      expect(text.startsWith(XML_PROLOG)).toBe(true);
      const xml = checkXml(text);
      expect(xml.root).toBe("svg");
      expect(xml.elements).toBeGreaterThan(model.nodes.length * 4);
      expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(text).not.toContain("var(");
      expect(text).not.toContain("color-mix(");
      expect(text).not.toMatch(/(?:href|url)\s*[=(]/); // no external resource the file depends on
      for (const o of shopSchema()) expect(text).toContain(`>${o.name}<`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paints with hex colours only", () => {
    const paints = [...svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
    expect(paints.length).toBeGreaterThan(100);
    for (const p of paints) expect(p).toMatch(/^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|none)$/);
    for (const m of svg.matchAll(/(?:stroke|fill):([^;}]+)/g)) expect(m[1]).toMatch(/^(?:#[0-9a-f]{6}|transparent|none)$/);
  });
});

describe("PNG size", () => {
  it("is 2x for a normal diagram", () => {
    expect(pngScale(1200, 800)).toBe(2);
    expect(pngSize(1200, 800, 2)).toEqual({ width: 2400, height: 1600 });
  });

  it("stays within the side and area that a webview canvas holds", () => {
    for (const [w, h] of [
      [30000, 400],
      [9000, 9000],
      [20000, 20000],
    ]) {
      const s = pngScale(w, h);
      const px = pngSize(w, h, s);
      expect(Math.max(px.width, px.height)).toBeLessThanOrEqual(PNG_MAX_SIDE + 1);
      expect(px.width * px.height).toBeLessThanOrEqual(PNG_MAX_AREA * 1.001);
    }
    expect(pngScale(1e7, 1e7)).toBe(PNG_MIN_SCALE);
    expect(pngSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  });

  it("loads the SVG from a data: URL (it does not taint the canvas)", () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>#1 & 100%</text></svg>');
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(url.slice(url.indexOf(",") + 1)).not.toMatch(/[# <>"]/); // "#" would end the URL at the fragment
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toContain("#1 & 100%");
  });
});

describe("exportFile", () => {
  const run = (choose: ExportTarget | null, make: () => Promise<Uint8Array>) => {
    const log: string[] = [];
    const result = exportFile(
      "shop",
      "png",
      "image/png",
      async () => {
        log.push("make");
        return make();
      },
      () => {
        log.push("busy");
        return () => log.push("done");
      },
      {
        choose: async (name, ext) => {
          log.push(`choose ${name}.${ext}`);
          return choose;
        },
        write: async (t, mime, bytes) => {
          log.push(`write ${t.path} ${mime} ${bytes.length}`);
          return t.path ?? t.name;
        },
      },
    );
    return { log, result };
  };

  it("opens the Save dialog first, then makes and writes the file while busy", async () => {
    const { log, result } = run({ name: "shop.png", path: "/tmp/shop.png" }, async () => new Uint8Array(3));
    expect(await result).toBe("/tmp/shop.png");
    expect(log).toEqual(["choose shop.png", "busy", "make", "write /tmp/shop.png image/png 3", "done"]);
  });

  it("makes nothing when the dialog is cancelled", async () => {
    const { log, result } = run(null, async () => new Uint8Array(3));
    expect(await result).toBeNull();
    expect(log).toEqual(["choose shop.png"]);
  });

  it("ends the busy state when making the file fails", async () => {
    const { log, result } = run({ name: "shop.png", path: "/tmp/shop.png" }, async () => {
      throw new Error("too large");
    });
    await expect(result).rejects.toThrow("too large");
    expect(log).toEqual(["choose shop.png", "busy", "make", "done"]);
  });
});

describe("fonts of the PNG", () => {
  it("are the bundled faces the diagram draws with", () => {
    expect(DIAGRAM_FONTS.map((f) => `${f.family} ${f.weight} ${f.style}`)).toEqual(["Inter 400 normal", "Inter 400 italic", "Inter 600 normal", "JetBrains Mono 400 normal", "JetBrains Mono 700 normal"]);
    for (const f of DIAGRAM_FONTS) expect(f.url).toMatch(/\.ttf/);
  });

  it("go into the SVG as @font-face rules with data: URLs, and the SVG stays well-formed", async () => {
    const css = await loadFontCss(async (url) => `data:font/ttf;base64,${btoa(url)}`);
    expect(css.match(/@font-face/g)).toHaveLength(DIAGRAM_FONTS.length);
    expect(css).toContain('font-family:"JetBrains Mono"');
    expect(css).toContain("src:url(data:font/ttf;base64,");
    const model = buildDiagram(shopSchema(), { columns: "all", showTypes: true });
    const svg = renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, exporting: true }, resolvePalette(computedStyle("dark")));
    const withFonts = embedFonts(svg, css);
    expect(withFonts.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(withFonts).toContain(`<style>${css}`);
    expect(checkXml(withFonts).root).toBe("svg");
    expect(embedFonts('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>', css)).toBe(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><g/></svg>`);
    expect(embedFonts(svg, "")).toBe(svg);
  });

  it("are left out when a font file cannot be read (the fallback fonts draw the PNG)", async () => {
    expect(
      await loadFontCss(async () => {
        throw new Error("404");
      }),
    ).toBe("");
  });
});
