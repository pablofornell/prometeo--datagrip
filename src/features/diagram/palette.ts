/**
 * Palette resolution for the diagram renderer. Colours come from the theme CSS variables; the font stacks are
 * resolved to concrete family lists here because the exported SVG / PNG is rendered outside the app, where
 * `var(--dg-font-mono, monospace)` does not resolve.
 *
 * The rainbow (12 categorical colours) is read from `--dgd-c1..12`, which diagram.css derives from the shared
 * `--rainbow-N` tokens with its own fallbacks, so the diagram looks right whether or not those tokens exist. The
 * text drawn on a rainbow colour is picked for WCAG contrast (`inkOn`).
 */
import type { DiagramPalette } from "./svg";

export const FALLBACK_FONT_MONO = '"JetBrains Mono", ui-monospace, "DejaVu Sans Mono", monospace';
export const FALLBACK_FONT_UI = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

/** The rainbow the diagram uses when the theme defines none: vivid on a dark canvas, deeper on a light one. */
export const FALLBACK_RAINBOW_DARK = ["#e05652", "#e08f52", "#e0bf52", "#a3e052", "#52e086", "#52e0c4", "#52c9e0", "#5294e0", "#5256e0", "#9452e0", "#e052e0", "#e05294"];
export const FALLBACK_RAINBOW_LIGHT = ["#bf2722", "#bf6622", "#bf9a22", "#7bbf22", "#22bf5b", "#22bf9f", "#22a5bf", "#226bbf", "#2227bf", "#6b22bf", "#bf22bf", "#bf226b"];

/** Reads a custom property of `<html>`; empty outside the DOM (unit tests). */
const cssVar = (name: string): string => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

// ---------------------------------------------------------------- colour maths

export type Rgb = [number, number, number];

/** Parses `#rgb`, `#rrggbb`, `rgb()/rgba()` and `hsl()/hsla()` (comma or space separated); null for anything else. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as Rgb;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as Rgb;
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (m) {
    const h = (Number(m[1]) % 360) / 360;
    const sat = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const f = (t: number): number => {
      t = (t + 1) % 1;
      const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
      return Math.round(v * 255);
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  return null;
}

const toHex = (c: Rgb): string => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** WCAG relative luminance. */
export function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours (1..21); 1 when either cannot be parsed. */
export function contrast(a: string, b: string): number {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The better-reading of two inks on `bg` (WCAG contrast), so a header text stays legible on any rainbow colour. */
export function inkOn(bg: string, light: string, dark: string): string {
  return contrast(bg, light) >= contrast(bg, dark) ? light : dark;
}

/** Mixes `a` towards `b` by `t` (0..1) in sRGB; `a` unchanged when either is not parseable. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  return toHex(ca.map((v, i) => v + (cb[i] - v) * t) as Rgb);
}

/** Any other CSS colour syntax (oklch, color-mix, named ...): paint one pixel and read it back as sRGB. */
function probeColor(raw: string): Rgb | null {
  if (typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = raw;
  const first = ctx.fillStyle;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = raw;
  if (ctx.fillStyle !== first) return null; // the browser rejected it (it kept the previous style)
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return d[3] === 0 ? null : [d[0], d[1], d[2]];
}

// ---------------------------------------------------------------- resolution

/** Concrete colours / fonts read from the theme CSS variables at render time (the export string is self-contained). */
export function resolvePalette(read: (name: string) => string = cssVar): DiagramPalette {
  const pick = (name: string, fallback: string): string => read(name) || fallback;
  const background = pick("--dg-editor-bg", "#191a1c");
  const bg = parseColor(background);
  const isDark = bg ? luminance(bg) < 0.4 : true;
  const fallbackRainbow = isDark ? FALLBACK_RAINBOW_DARK : FALLBACK_RAINBOW_LIGHT;
  const rainbow = fallbackRainbow.map((fb, i) => {
    const raw = read(`--dgd-c${i + 1}`);
    const c = raw ? (parseColor(raw) ?? probeColor(raw)) : null;
    return c ? toHex(c) : fb;
  });
  return {
    background,
    nodeBg: pick("--dg-island-bg", "#1f2024"),
    nodeBorder: pick("--dg-separator", "#33353b"),
    headerBg: pick("--dg-layer-1-bg", "#26282c"),
    headerFg: pick("--dg-text", "#d1d3d9"),
    viewHeaderBg: pick("--dg-banner-info-bg", "#233558"),
    viewFg: pick("--dg-text", "#d1d3d9"),
    text: pick("--dg-grid-fg", "#bcbec4"),
    typeText: pick("--dg-text-secondary", "#73767c"),
    pk: pick("--dg-editor-sql-synthetic", "#e0bb65"),
    fk: pick("--dg-editor-function-declaration", "#56a8f5"),
    edge: pick("--dg-text-secondary", "#73767c"),
    edgeLabel: pick("--dg-text-muted", "#9fa2a8"),
    selection: pick("--dg-accent", "#3871e1"),
    rowLine: pick("--dg-editor-indent-guide", "#323438"),
    fontMono: pick("--dg-font-mono", FALLBACK_FONT_MONO),
    fontUi: pick("--dg-font-ui", FALLBACK_FONT_UI),
    isDark,
    rainbow,
    inkLight: "#ffffff",
    inkDark: "#15171b",
  };
}
