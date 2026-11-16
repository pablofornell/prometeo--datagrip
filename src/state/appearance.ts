/**
 * UI scale maths: limits, validation, stepping and the zoom factor the window gets. Pure (no DOM, no store), so it can be
 * tested under node. `settings.ts` applies the result; `index.html` repeats the same few lines before first paint
 * (`prepaint.test.ts` keeps both in sync).
 */

/** UI scale is stored in percent. */
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 200;
export const UI_SCALE_STEP = 10;
export const UI_SCALE_DEFAULT = 100;

/** Every value the scale can take, in order (the choices of the Settings dialog). */
export const UI_SCALE_VALUES: number[] = Array.from({ length: (UI_SCALE_MAX - UI_SCALE_MIN) / UI_SCALE_STEP + 1 }, (_, i) => UI_SCALE_MIN + i * UI_SCALE_STEP);

/** Percent rounded to the step and kept inside the limits; anything that is not a finite number becomes the default. */
export function sanitizeUiScale(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return UI_SCALE_DEFAULT;
  const stepped = Math.round(v / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
}

/** Next UI scale one step up or down, kept inside the limits. */
export const stepUiScale = (current: number, dir: 1 | -1): number => sanitizeUiScale(sanitizeUiScale(current) + dir * UI_SCALE_STEP);

/**
 * Zoom factor of the window: the UI scale times the zoom of the custom UI font size (13 px = 1), rounded to 4 decimals.
 * `index.html` computes the same before first paint.
 */
export function effectiveZoom(uiScale: number, customFontSize?: number): number {
  const font = customFontSize === undefined ? 1 : Math.round((customFontSize / 13) * 100) / 100;
  return Math.round((sanitizeUiScale(uiScale) / 100) * font * 10000) / 10000;
}

/** Text of the message after a scale change ("UI scale 120%", with "(maximum)" / "(minimum)" at the end of the range). */
export function zoomMessage(percent: number): string {
  const edge = percent >= UI_SCALE_MAX ? " (maximum)" : percent <= UI_SCALE_MIN ? " (minimum)" : "";
  return `UI scale ${percent}%${edge}`;
}
