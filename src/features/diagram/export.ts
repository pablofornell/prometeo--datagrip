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
 * The PNG is the SVG drawn on a canvas. The image is loaded from a `data:` URL (it never taints the canvas, also not
 * under the `tauri://` origin of WebKitGTK), and the scale drops until the file fits the backend's file cap.
 */
import { chooseValueSavePath, isTauri, writeValueFile } from "../../api/db";
import { MAX_VALUE_BYTES, bytesToBase64 } from "../../components/grid/value/bytes";

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

/**
 * Saves `bytes` as `<name>.<ext>` in a file the user picks. Resolves the path written (the file name in a plain
 * browser), or null when the user cancelled the dialog.
 */
export async function saveExport(name: string, ext: string, mime: string, bytes: Uint8Array): Promise<string | null> {
  const file = `${name}.${ext}`;
  if (!isTauri()) {
    download(bytes, file, mime);
    return file;
  }
  if (bytes.length > MAX_VALUE_BYTES) throw new Error(`The ${ext.toUpperCase()} file is larger than ${Math.round(MAX_VALUE_BYTES / (1024 * 1024))} MB.`);
  const path = await chooseValueSavePath(file, ext);
  if (!path) return null;
  await writeValueFile(path, bytesToBase64(bytes));
  return path;
}
