import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { EDITOR_FONT_MAX, EDITOR_FONT_MIN } from "../../state/settings";

/** Wheel distance (px) that small, continuous deltas (trackpad, pinch) must add up to for one step. */
export const WHEEL_STEP = 50;
/** A pause longer than this (ms) drops the distance that was added up and did not make a step. */
const WHEEL_IDLE = 250;
/** One wheel notch in `wheelDeltaY` units (the legacy WebKit and Blink property: 120 for each notch of a mouse wheel). */
const NOTCH = 120;

export interface WheelAccumulator {
  sum: number;
  time: number;
}

/** The part of a `WheelEvent` that decides the step. `wheelDeltaY` is missing in some engines. */
export interface WheelInput {
  deltaY: number;
  deltaMode: number;
  wheelDeltaY?: number;
}

/**
 * True when the event is one notch of a mouse wheel and not a part of a smooth scroll. The size of `deltaY` does not tell
 * it: a notch is 100 px in Chromium, about 40 px in WebKitGTK, about 33 px in WebView2 with 1 line for each notch, and
 * Chromium divides it by the page zoom. So: line and page units are notches; else `wheelDeltaY` is a multiple of 120;
 * without `wheelDeltaY`, a whole `deltaY` of 16 px or more (the deltas of a trackpad are small or fractional).
 */
export function isWheelNotch(e: WheelInput): boolean {
  if (e.deltaY === 0) return false;
  if (e.deltaMode !== 0) return true;
  const w = e.wheelDeltaY;
  if (typeof w === "number" && w !== 0) return w % NOTCH === 0;
  return Math.abs(e.deltaY) >= 16 && Number.isInteger(e.deltaY);
}

/**
 * Font size step that one wheel event causes: -1, 0 or +1 (wheel up = +1).
 * Each notch of a mouse wheel is exactly one step, on every platform; the accumulator is not used for it.
 * A smooth delta (trackpad pinch) steps only after the deltas added up to `WHEEL_STEP`, then the sum starts again.
 */
export function wheelFontStep(acc: WheelAccumulator, e: WheelInput, time: number): number {
  if (e.deltaY === 0) return 0;
  if (isWheelNotch(e)) return e.deltaY < 0 ? 1 : -1;
  // the other direction or a long pause starts again
  if (time - acc.time > WHEEL_IDLE || Math.sign(e.deltaY) !== Math.sign(acc.sum)) acc.sum = 0;
  acc.time = time;
  acc.sum += e.deltaY;
  if (Math.abs(acc.sum) < WHEEL_STEP) return 0;
  const step = acc.sum < 0 ? 1 : -1;
  acc.sum = 0;
  return step;
}

/**
 * The font size after `step` steps, kept inside the allowed range. A size that is already outside the range
 * (a stored value) is never moved against the step: wheel up does not shrink, wheel down does not grow.
 */
export const clampFontSize = (size: number, step: number): number =>
  step > 0 ? Math.max(size, Math.min(EDITOR_FONT_MAX, size + step)) : Math.min(size, Math.max(EDITOR_FONT_MIN, size + step));

export interface WheelZoomHost {
  /** False: the extension does nothing (the setting is off, or this editor does not zoom). */
  enabled: () => boolean;
  size: () => number;
  setSize: (size: number) => void;
}

/** The part of a `WheelEvent` the handler uses. */
export type WheelLike = WheelInput & { ctrlKey: boolean; metaKey: boolean; timeStamp: number; preventDefault: () => void };

/** Handles one wheel event; true when the event is for the zoom (the page zoom of the webview is stopped). */
export function handleWheel(e: WheelLike, host: WheelZoomHost, acc: WheelAccumulator): boolean {
  if (!(e.ctrlKey || e.metaKey) || !host.enabled()) return false;
  // always stop the page zoom of the webview, also at the end of the range
  e.preventDefault();
  const step = wheelFontStep(acc, e, e.timeStamp);
  if (step === 0) return true;
  const size = host.size();
  const next = clampFontSize(size, step);
  if (next !== size) host.setSize(next);
  return true;
}

/**
 * Ctrl (Cmd on macOS) + mouse wheel changes the editor font size in 1 px steps. The listener is on the editor root and
 * not on the content (CodeMirror `domEventHandlers`), so the gutter with the line numbers zooms too; it is not passive,
 * or `preventDefault` would not stop the page zoom.
 */
export function wheelZoomExtension(host: WheelZoomHost): Extension {
  return ViewPlugin.define((view) => {
    const acc: WheelAccumulator = { sum: 0, time: 0 };
    const onWheel = (e: WheelEvent): void => {
      handleWheel(e, host, acc);
    };
    view.dom.addEventListener("wheel", onWheel, { passive: false });
    return { destroy: () => view.dom.removeEventListener("wheel", onWheel) };
  });
}
