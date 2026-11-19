/**
 * MCP: the built-in Model Context Protocol server (docs/MCP.md) and its workspace view. Importing this module registers the
 * `mcp.view` slot (the view the shell shows in place of the editor, state/view.ts), the `statusbar.mcp` widget and the actions
 *
 *   mcp.toggleView  (Ctrl+Shift+M)  View > MCP: open the view / back to the editor
 *   mcp.openView                    open the view (Settings > Tools > MCP Server uses it)
 *   mcp.exitView    (Escape)        back to the editor, while the focus is in the view and no text field or popup uses the key
 *
 * The server status, the permission rules and the live events are read from the backend at start (`store.ts`).
 */
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import { isMcpView, leaveAppView } from "../../state/view";
import { McpStatusWidget } from "./StatusWidget";
import { McpView } from "./McpView";
import { startMcp } from "./store";
import { enterMcpView, toggleMcpView } from "./view";
import "./mcp.css";

/** Esc closes the view when the focus is inside it and nothing else (a text field, a menu, a dialog) is using the key. */
const escapeLeaves = (): boolean => {
  if (!isMcpView()) return false;
  const a = document.activeElement as HTMLElement | null;
  if (!a?.closest("[data-mcp]")) return false;
  if (a.matches("input, textarea, select, [contenteditable=true]")) return false;
  return !document.querySelector(".dg-menu-backdrop, .dg-dialog-overlay");
};

const disposers = [
  registerSlot("mcp.view", McpView),
  registerSlot("statusbar.mcp", McpStatusWidget),
  registerActions([
    { id: "mcp.toggleView", title: "MCP", shortcut: "Ctrl+Shift+M", icon: "mcp", checked: isMcpView, run: toggleMcpView },
    { id: "mcp.openView", title: "Open MCP View", run: enterMcpView },
    { id: "mcp.exitView", title: "Back to the Editor", shortcut: "Escape", when: escapeLeaves, enabled: isMcpView, run: leaveAppView },
  ]),
];

// the status bar widget and the explorer filter need the status as soon as the app is up
setTimeout(() => void startMcp(), 0);

if (import.meta.hot) import.meta.hot.dispose(() => disposers.forEach((d) => d()));
