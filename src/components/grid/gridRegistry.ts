/**
 * The mounted data grids, so a global keymap action (`table.findColumn`) can reach the grid that has the focus.
 * A grid registers its root element and API once mounted.
 */
import type { DataGridApi } from "./types";

const grids = new Map<HTMLElement, DataGridApi>();

/** Registers a mounted grid; returns the function that removes it. */
export function registerGrid(root: HTMLElement, api: DataGridApi): () => void {
  grids.set(root, api);
  return () => {
    if (grids.get(root) === api) grids.delete(root);
  };
}

/** The API of the grid that contains the focused element (the one a keyboard shortcut is meant for), if any. */
export function focusedGridApi(): DataGridApi | undefined {
  const el = document.activeElement;
  if (!el) return undefined;
  for (const [root, api] of grids) if (root.contains(el)) return api;
  return undefined;
}
