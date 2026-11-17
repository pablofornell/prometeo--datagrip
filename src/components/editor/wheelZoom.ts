import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Allowed editor font size in px (the same range as the Settings > Editor > Font field and the font size actions). */
export const FONT_MIN = 8;
export const FONT_MAX = 40;

/** Wheel distance (px) that counts as one step. A mouse notch (50 px or more) is one step; a trackpad pinch adds up to it. */
export const WHEEL_STEP = 50;
/** A pause longer than this (ms) drops the distance that was added up and did not make a step. */
const WHEEL_IDLE = 250;

export interface WheelAccumulator {
  sum: number;
  time: number;
}

/** Wheel distance in px: line and page units (`deltaMode` 1 and 2) become pixels. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
}

/**
 * Adds one wheel event to the accumulator and returns the font size step it causes: -1, 0 or +1 (wheel up = +1).
 * At most one step for each event, so a fast spin does not jump; a small delta (trackpad pinch) steps only after
 * it has added up to `WHEEL_STEP`.
 */
export function wheelFontStep(acc: WheelAccumulator, deltaY: number, deltaMode: number, time: number): number {
  const d = wheelPixels(deltaY, deltaMode);
  if (d === 0) return 0;
  // the other direction or a long pause starts again
  if (time - acc.time > WHEEL_IDLE || Math.sign(d) !== Math.sign(acc.sum)) acc.sum = 0;
  acc.time = time;
  acc.sum += d;
  if (Math.abs(acc.sum) < WHEEL_STEP) return 0;
  const step = acc.sum < 0 ? 1 : -1;
  acc.sum = 0;
  return step;
}

/** The font size after `step` steps, kept inside the allowed range. */
export const clampFontSize = (size: number, step: number): number => Math.min(FONT_MAX, Math.max(FONT_MIN, size + step));

export interface WheelZoomHost {
  /** False: the extension does nothing (the setting is off, or this editor has its own fixed font size). */
  enabled: () => boolean;
  size: () => number;
  setSize: (size: number) => void;
}

/** Ctrl (Cmd on macOS) + mouse wheel changes the editor font size in 1 px steps. */
export function wheelZoomExtension(host: WheelZoomHost): Extension {
  const acc: WheelAccumulator = { sum: 0, time: 0 };
  return EditorView.domEventHandlers({
    wheel(e) {
      if (!(e.ctrlKey || e.metaKey) || !host.enabled()) return false;
      // always stop the page zoom of the webview, also at the end of the range
      e.preventDefault();
      const step = wheelFontStep(acc, e.deltaY, e.deltaMode, e.timeStamp);
      if (step === 0) return true;
      const size = host.size();
      const next = clampFontSize(size, step);
      if (next !== size) host.setSize(next);
      return true;
    },
  });
}
