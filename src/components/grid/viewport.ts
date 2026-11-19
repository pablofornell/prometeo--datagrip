/**
 * Viewport measurement of the grid scroller. Pure functions, no DOM.
 *
 * The visible window (rows and columns that get cells) is derived from the viewport size. A pane that is not displayed
 * (inactive editor tab, collapsed tool window, `display: none`) measures 0 x 0; windowing on that draws only the first
 * columns (id + email in the table editor, nothing from the third column on) and the first rows, and any row built in
 * that state stays like that until the next measurement. A hidden pane therefore keeps the last real size.
 */
export interface ViewSize {
  w: number;
  h: number;
}

/** Size to window on: the new measurement, or `prev` when the scroller is not displayed (a zero side). */
export function measuredViewport(w: number, h: number, prev: ViewSize): ViewSize {
  return w > 0 && h > 0 ? { w, h } : prev;
}

/** Fewest rows kept built above and below the visible ones. */
export const MIN_OVERSCAN_ROWS = 15;

/**
 * Rows built beyond each edge of the viewport: one screen, at least `MIN_OVERSCAN_ROWS`. The browser scrolls the
 * pixels it already has before the scroll event reaches the page, so the rows must already stand where a wheel notch or a
 * flick lands; with a few rows (4 = 108px) every wheel step outran them and showed blank space until the next frame.
 */
export function overscanRows(dataH: number, rowH: number): number {
  return Math.max(MIN_OVERSCAN_ROWS, Math.ceil(Math.max(0, dataH) / rowH));
}

/**
 * Inclusive range of the rows to build for `top` (logical px of the first visible row edge), a data area `dataH` px tall and
 * `total` rows of `rowH` px, `overscan` more at each end. `[0, -1]` when there are no rows.
 */
export function rowWindow(top: number, dataH: number, total: number, rowH: number, overscan: number): [number, number] {
  const r0 = Math.max(0, Math.floor(top / rowH) - overscan);
  const r1 = Math.min(total - 1, Math.ceil((top + dataH) / rowH) + overscan);
  return [r0, r1];
}
