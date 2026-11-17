/**
 * File export of the diagram (Export as SVG / PNG).
 *
 * The desktop app saves through the backend: its native Save dialog gives the path (`chooseValueSavePath`) and the
 * backend writes the bytes there (`writeValueFile`), as the value viewer does. A click on an `<a download>` with a
 * `blob:` URL is not a Save in the Tauri webview: the app registers no download handler, so there is no Save dialog.
 * WebKitGTK writes the file silently into the XDG Downloads folder under a fixed name, WebView2 into its Downloads
 * folder, and the app tells the user nothing. That path is kept for a plain browser (the mock), with the URL revoked
 * later.
 *
 * The Save dialog opens first; the file is made after the user picked where it goes (a big PNG takes a moment, and
 * the caller shows that it is busy meanwhile).
 *
 * The PNG is the SVG drawn on a canvas. The image is loaded from a `data:` URL (it never taints the canvas, also not
 * under the `tauri://` origin of WebKitGTK), and the scale drops until the file fits the backend's file cap. An SVG
 * drawn as an image cannot use the fonts of the page, so the faces of the bundled Inter and JetBrains Mono that the
 * diagram uses go into it as `data:` URLs (about 2.4 MB, for the PNG only: the `.svg` file names the fonts and stays
 * small).
 */
import { chooseValueSavePath, isTauri, writeValueFile } from "../../api/db";
import { MAX_VALUE_BYTES, bytesToBase64 } from "../../components/grid/value/bytes";
import interItalic from "../../theme/fonts/Inter-Italic.ttf?url";
import interRegular from "../../theme/fonts/Inter-Regular.ttf?url";
import interSemiBold from "../../theme/fonts/Inter-SemiBold.ttf?url";
import monoBold from "../../theme/fonts/JetBrainsMono-Bold.ttf?url";
import monoRegular from "../../theme/fonts/JetBrainsMono-Regular.ttf?url";

/** The XML declaration that starts an exported `.svg` file (the renderer emits the `<svg>` element only). */
export const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Text of the `.svg` file for a rendered diagram. */
export const svgFileText = (svg: string): string => XML_PROLOG + svg;

/** A `data:` URL of the SVG, for an `<img>` to rasterize. */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Largest PNG side and area, in pixels, that the canvases of WebKitGTK and WebView2 hold reliably. */
export const PNG_MAX_SIDE = 16000;
export const PNG_MAX_AREA = 120_000_000;
/** The PNG is never drawn smaller than this (a scale below it gives an unreadable image). */
export const PNG_MIN_SCALE = 0.1;

/** Pixels per diagram unit of the PNG: 2x for a crisp image, less when a 2x canvas would be too large. */
export function pngScale(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.max(PNG_MIN_SCALE, Math.min(2, PNG_MAX_SIDE / Math.max(w, h), Math.sqrt(PNG_MAX_AREA / (w * h))));
}

/** The canvas size of the PNG for a diagram of `width` x `height` at `scale`. */
export const pngSize = (width: number, height: number, scale: number): { width: number; height: number } => ({
  width: Math.max(1, Math.round(width * scale)),
  height: Math.max(1, Math.round(height * scale)),
});

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The webview could not load the diagram as an image."));
    img.src = url;
  });

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The diagram is too large to make a PNG of it."))), "image/png"),
  );

/** Draws the SVG (`width` x `height` diagram units) on a canvas at `scale` over `background`, as PNG bytes. */
export async function rasterize(svg: string, width: number, height: number, scale: number, background: string): Promise<Blob> {
  const img = await loadImage(svgDataUrl(svg));
  const size = pngSize(width, height, scale);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The webview has no canvas to draw the diagram on.");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(img, 0, 0, size.width, size.height);
  return canvasBlob(canvas);
}

/**
 * The PNG of the SVG: at `pngScale`, then at half that scale (and so on) while the file is larger than `maxBytes`
 * or the canvas cannot be encoded.
 */
export async function renderPng(svg: string, width: number, height: number, background: string, maxBytes = MAX_VALUE_BYTES): Promise<Uint8Array> {
  let scale = pngScale(width, height);
  let failure: unknown = null;
  for (;;) {
    try {
      const blob = await rasterize(svg, width, height, scale, background);
      if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
      failure = new Error(`The PNG is larger than ${Math.round(maxBytes / (1024 * 1024))} MB at any readable size: export it as SVG.`);
    } catch (e) {
      failure = e;
    }
    if (scale / 2 < PNG_MIN_SCALE) throw failure;
    scale /= 2;
  }
}

/** A plain browser has no Save dialog of the app: the file is downloaded. The URL stays valid until the download read it. */
function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Where an export goes: a path from the Save dialog, or (`path` null) a download in a plain browser. */
export interface ExportTarget {
  name: string;
  path: string | null;
}

/** The Save dialog for `<name>.<ext>`; null when the user cancelled it. A plain browser has no dialog: a download. */
export async function chooseExportTarget(name: string, ext: string): Promise<ExportTarget | null> {
  const file = `${name}.${ext}`;
  if (!isTauri()) return { name: file, path: null };
  const path = await chooseValueSavePath(file, ext);
  return path ? { name: file, path } : null;
}

/** Writes `bytes` to the target; resolves the path written (the file name of a download). */
export async function writeExport(target: ExportTarget, mime: string, bytes: Uint8Array): Promise<string> {
  if (!target.path) {
    download(bytes, target.name, mime);
    return target.name;
  }
  if (bytes.length > MAX_VALUE_BYTES) throw new Error(`The file is larger than ${Math.round(MAX_VALUE_BYTES / (1024 * 1024))} MB.`);
  await writeValueFile(target.path, bytesToBase64(bytes));
  return target.path;
}

export interface ExportSteps {
  choose: (name: string, ext: string) => Promise<ExportTarget | null>;
  write: (target: ExportTarget, mime: string, bytes: Uint8Array) => Promise<string>;
}

/**
 * One export: the Save dialog first, then `make` the bytes and write them, with `busy` on (it returns its "done") from
 * the moment the dialog closed until the file is written or the export failed. Resolves the path written, or null when
 * the dialog was cancelled (nothing is made then).
 */
export async function exportFile(
  name: string,
  ext: string,
  mime: string,
  make: () => Promise<Uint8Array>,
  busy: () => () => void = () => () => {},
  steps: ExportSteps = { choose: chooseExportTarget, write: writeExport },
): Promise<string | null> {
  const target = await steps.choose(name, ext);
  if (!target) return null;
  const done = busy();
  try {
    return await steps.write(target, mime, await make());
  } finally {
    done();
  }
}

// ---------------------------------------------------------------- fonts of the PNG

/** The faces of the bundled fonts (theme/fonts.css) that the diagram draws with. */
export const DIAGRAM_FONTS: readonly { family: string; weight: number; style: "normal" | "italic"; url: string }[] = [
  { family: "Inter", weight: 400, style: "normal", url: interRegular },
  { family: "Inter", weight: 400, style: "italic", url: interItalic },
  { family: "Inter", weight: 600, style: "normal", url: interSemiBold },
  { family: "JetBrains Mono", weight: 400, style: "normal", url: monoRegular },
  { family: "JetBrains Mono", weight: 700, style: "normal", url: monoBold },
];

/** `@font-face` rules for the faces, each with its font file as a `data:` URL. */
export const fontFaceCss = (faces: readonly { family: string; weight: number; style: string; dataUrl: string }[]): string =>
  faces.map((f) => `@font-face{font-family:"${f.family}";src:url(${f.dataUrl}) format("truetype");font-weight:${f.weight};font-style:${f.style}}`).join("");

/** The SVG with `css` at the start of its first `<style>` (a new one when it has none). */
export function embedFonts(svg: string, css: string): string {
  if (!css) return svg;
  const at = svg.indexOf("<style>");
  if (at >= 0) return svg.slice(0, at + 7) + css + svg.slice(at + 7);
  const end = svg.indexOf(">", svg.indexOf("<svg")) + 1;
  return `${svg.slice(0, end)}<style>${css}</style>${svg.slice(end)}`;
}

/** A font file as a `data:` URL. */
async function fetchDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return `data:font/ttf;base64,${bytesToBase64(new Uint8Array(await res.arrayBuffer()))}`;
}

/**
 * The `@font-face` CSS of `DIAGRAM_FONTS` with the font files inline. "" when a file cannot be read: the PNG then
 * uses the fallback fonts of the stacks, which is better than no PNG.
 */
export async function loadFontCss(load: (url: string) => Promise<string> = fetchDataUrl): Promise<string> {
  try {
    const urls = await Promise.all(DIAGRAM_FONTS.map((f) => load(f.url)));
    return fontFaceCss(DIAGRAM_FONTS.map((f, i) => ({ ...f, dataUrl: urls[i] })));
  } catch {
    return "";
  }
}

let fontCss: Promise<string> | null = null;
/** `loadFontCss`, read once per session (read again after a failure). */
export const diagramFontCss = (): Promise<string> =>
  (fontCss ??= loadFontCss().then((css) => {
    if (!css) fontCss = null;
    return css;
  }));
