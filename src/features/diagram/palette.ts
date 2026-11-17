/**
 * Palette resolution for the diagram renderer. Colours come from the theme CSS variables; the font stacks are
 * resolved to concrete family lists here because the exported SVG / PNG is rendered outside the app, where
 * `var(--dg-font-mono, monospace)` does not resolve.
 *
 * The rainbow (12 categorical colours) is read from `--dgd-c1..12`, which diagram.css derives from the shared
 * `--rainbow-N` tokens with its own fallbacks, so the diagram looks right whether or not those tokens exist. The
 * text drawn on a rainbow colour is picked for WCAG contrast (`inkOn`).
 */
import { flatten, resolveColor as resolveToken } from "../../theme/contrast";
import type { DiagramPalette } from "./svg";

export const FALLBACK_FONT_MONO = '"JetBrains Mono", ui-monospace, "DejaVu Sans Mono", monospace';
export const FALLBACK_FONT_UI = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * The rainbow the diagram uses when the theme defines none: the same twelve colours, in the same order, as the shared
 * `--rainbow-1..12` tokens (src/styles/tokens-extra.css), so the slot order of `groups.ts` holds with or without them.
 */
export const FALLBACK_RAINBOW_DARK = ["#4a86ff", "#ff9f3d", "#2ed98a", "#e36bff", "#ffd23f", "#22d3ee", "#ff5c6c", "#a3e635", "#b57bff", "#ff7ab8", "#2dd4bf", "#c8a27a"];
export const FALLBACK_RAINBOW_LIGHT = ["#2563f5", "#c85a00", "#07844a", "#b72fd6", "#9a7100", "#06819d", "#dc2f45", "#5e8400", "#8b45f2", "#d6277f", "#0c8f7e", "#8a6a3f"];

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

/**
 * Any other CSS colour syntax (oklch, color-mix, named ...): paint one pixel and read it back as sRGB. With `under`,
 * the pixel is first filled with that opaque colour, so a translucent colour comes back as what it looks like on it.
 */
function probeColor(raw: string, under?: Rgb): Rgb | null {
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
  if (under) {
    ctx.fillStyle = toHex(under);
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = raw;
  }
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return d[3] === 0 ? null : [d[0], d[1], d[2]];
}

/**
 * `raw` as an opaque `#rrggbb` painted over `under`, or null when it is not a colour. The theme gives hex, `rgb()`,
 * `hsl()` and translucent `color-mix(in srgb, ...)` washes; the exported SVG / PNG must hold plain sRGB values, because
 * an SVG viewer outside the app does not know `color-mix()`, `oklch()` or `var()`.
 */
export function solidColor(raw: string, under: Rgb): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    return toHex([...flatten(under, resolveToken(s))] as Rgb); // hex (also with alpha), transparent, color-mix
  } catch {
    /* another syntax: below */
  }
  const c = parseColor(s) ?? probeColor(s, under);
  return c ? toHex(c) : null;
}

// ---------------------------------------------------------------- resolution

/**
 * Concrete colours / fonts read from the theme CSS variables at render time (the export string is self-contained):
 * every colour is an opaque `#rrggbb`, a translucent one is flattened onto the surface it is drawn on.
 */
export function resolvePalette(read: (name: string) => string = cssVar): DiagramPalette {
  const pick = (name: string, fallback: string): string => read(name) || fallback;
  const background = solidColor(read("--dg-editor-bg"), [255, 255, 255]) ?? "#191a1c";
  const bg = parseColor(background) ?? [25, 26, 28];
  const isDark = luminance(bg) < 0.4;
  const nodeBg = solidColor(read("--dg-island-bg"), bg) ?? "#1f2024";
  const card = parseColor(nodeBg) ?? bg;
  /** A colour drawn on the canvas (`on` = bg) or inside a table box (`on` = card). */
  const color = (name: string, fallback: string, on: Rgb): string => solidColor(read(name), on) ?? fallback;
  const fallbackRainbow = isDark ? FALLBACK_RAINBOW_DARK : FALLBACK_RAINBOW_LIGHT;
  const rainbow = fallbackRainbow.map((fb, i) => {
    const raw = read(`--dgd-c${i + 1}`);
    const c = raw ? (parseColor(raw) ?? probeColor(raw)) : null;
    return c ? toHex(c) : fb;
  });
  return {
    background,
    nodeBg,
    nodeBorder: color("--dg-separator", "#33353b", bg),
    headerBg: color("--dg-layer-1-bg", "#26282c", card),
    headerFg: color("--dg-text", "#d1d3d9", card),
    viewHeaderBg: color("--dg-banner-info-bg", "#233558", card),
    viewFg: color("--dg-text", "#d1d3d9", card),
    text: color("--dg-grid-fg", "#bcbec4", card),
    typeText: color("--dg-text-secondary", "#73767c", card),
    pk: color("--dg-editor-sql-synthetic", "#e0bb65", card),
    fk: color("--dg-editor-function-declaration", "#56a8f5", card),
    edge: color("--dg-text-secondary", "#73767c", bg),
    edgeLabel: color("--dg-text-muted", "#9fa2a8", bg),
    selection: color("--dg-accent", "#3871e1", bg),
    rowLine: color("--dg-editor-indent-guide", "#323438", card),
    fontMono: pick("--dg-font-mono", FALLBACK_FONT_MONO),
    fontUi: pick("--dg-font-ui", FALLBACK_FONT_UI),
    isDark,
    rainbow,
    inkLight: "#ffffff",
    inkDark: "#15171b",
  };
}
