/**
 * Fit-to-stage math for the diagram. The bounds passed in are the padded diagram box that `renderDiagramSvg` bakes
 * into the exported SVG's width / height / viewBox, so Fit and the SVG agree: the whole padded box (including the
 * outer margin and the self-loop headroom) ends up inside the stage, centered.
 */
import type { Bounds } from "./svg";

export interface StageSize {
  width: number;
  height: number;
}

export interface View {
  zoom: number;
  tx: number;
  ty: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

/** Fit never zooms in past 2x: a two-table diagram should not fill the screen. */
const FIT_MAX_ZOOM = 2;
/** 5% breathing room around the fitted diagram. */
const FIT_MARGIN = 0.95;

/**
 * The view (zoom + translation) that centers `bounds` in `stage` with a small margin, or null when either box is
 * empty (a 0x0 stage at startup, or no diagram yet).
 */
export function fitView(bounds: Bounds, stage: StageSize, margin = FIT_MARGIN, maxZoom = FIT_MAX_ZOOM): View | null {
  if (!(stage.width > 0) || !(stage.height > 0) || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const zoom = Math.max(MIN_ZOOM, Math.min(stage.width / bounds.width, stage.height / bounds.height, maxZoom) * margin);
  return {
    zoom,
    tx: (stage.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    ty: (stage.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

// ---------------------------------------------------------------- zoom, pan, minimap

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zooms by `factor` keeping the diagram point under the stage point (`px`, `py`) fixed (zoom to the cursor). */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const k = zoom / v.zoom;
  return { zoom, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

/** The diagram-space rectangle currently visible in the stage. */
export function visibleRect(v: View, stage: StageSize): { x: number; y: number; width: number; height: number } {
  return { x: -v.tx / v.zoom, y: -v.ty / v.zoom, width: stage.width / v.zoom, height: stage.height / v.zoom };
}

/** The view that puts the diagram point (`wx`, `wy`) in the middle of the stage at the current zoom. */
export function centerOn(v: View, stage: StageSize, wx: number, wy: number): View {
  return { zoom: v.zoom, tx: stage.width / 2 - wx * v.zoom, ty: stage.height / 2 - wy * v.zoom };
}

/** Pans just enough to bring `rect` (diagram space) inside the stage with `margin` px to spare; the same view when it is. */
export function revealRect(v: View, stage: StageSize, rect: { x: number; y: number; width: number; height: number }, margin = 40): View {
  let { tx, ty } = v;
  const left = rect.x * v.zoom + tx;
  const right = (rect.x + rect.width) * v.zoom + tx;
  const top = rect.y * v.zoom + ty;
  const bottom = (rect.y + rect.height) * v.zoom + ty;
  if (left < margin) tx += margin - left;
  else if (right > stage.width - margin) tx -= right - (stage.width - margin);
  if (top < margin) ty += margin - top;
  else if (bottom > stage.height - margin) ty -= bottom - (stage.height - margin);
  return tx === v.tx && ty === v.ty ? v : { zoom: v.zoom, tx, ty };
}

/** Where the minimap draws the diagram: `bounds` scaled to fit `max`, and the scale (minimap px per diagram px). */
export function minimapFrame(bounds: Bounds, max: StageSize): { width: number; height: number; scale: number } {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return { width: 0, height: 0, scale: 0 };
  const scale = Math.min(max.width / bounds.width, max.height / bounds.height);
  return { width: Math.max(1, Math.round(bounds.width * scale)), height: Math.max(1, Math.round(bounds.height * scale)), scale };
}
