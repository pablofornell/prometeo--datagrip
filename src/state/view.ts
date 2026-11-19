/**
 * The workspace view of the window. The editor (editor tabs + the right / bottom tool windows) is the default one; the
 * MCP view takes the whole area to the right of the left data-sources column. Switching only changes what the shell
 * shows: the editor stays mounted (its console views own the DB sessions), it is hidden with CSS.
 */
import { createSignal } from "solid-js";
import { loadLocal, saveUiState } from "./persist";

export type AppView = "editor" | "mcp";

const KEY = "view";
const isView = (v: unknown): v is AppView => v === "editor" || v === "mcp";

const [view, setViewSignal] = createSignal<AppView>(((v) => (isView(v) ? v : "editor"))(loadLocal<unknown>(KEY, "editor")));

/** The view that is shown now. */
export const appView = view;
export const isMcpView = (): boolean => view() === "mcp";

export function setAppView(v: AppView): void {
  if (view() === v) return;
  setViewSignal(v);
  saveUiState(KEY, v);
}

/** Puts the keyboard focus back into the active editor (falls back to the editor island itself). */
export function focusEditorArea(): void {
  const area = document.querySelector<HTMLElement>("[data-editor-area]");
  const view = ".dg-editor-view:not(.dg-hidden) .cm-content, .dg-editor-view:not(.dg-hidden) .dgg";
  const target =
    area?.querySelector<HTMLElement>(".dg-pane-focused " + view.replace(", ", ", .dg-pane-focused ")) ??
    area?.querySelector<HTMLElement>(view) ??
    area;
  target?.focus({ preventScroll: true });
}

/**
 * Back to the editor (Esc, the toggle again, a new editor tab, a window at the right or bottom, Restore Default Layout).
 * The view that was focused is gone: the focus goes to the editor, as Esc in a tool window does.
 */
export function leaveAppView(): void {
  if (view() === "editor") return;
  setAppView("editor");
  queueMicrotask(focusEditorArea);
}

/**
 * Width of the left column in the MCP view: the explorer keeps its size on a wide window, on a narrow one it gives the
 * view at least `minView` px (the column never goes below `minLeft`). Not persisted: the stored size is untouched.
 */
export function mcpLeftWidth(stored: number, bodyW: number, minLeft: number, minView = 560): number {
  if (stored <= 0) return 0;
  return Math.max(minLeft, Math.min(stored, bodyW - minView));
}
