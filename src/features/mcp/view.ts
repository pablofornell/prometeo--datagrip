/** Entering and leaving the MCP view (the state itself is `state/view.ts`). */
import { anchorOf, clearMaximizedToolWindow, showToolWindow, visibleAt } from "../../state/layout";
import { isMcpView, leaveAppView, setAppView } from "../../state/view";
import { startMcp } from "./store";

/** Opens the MCP view. The left column stays: the Database Explorer comes back when nothing sits there. */
export function enterMcpView(): void {
  clearMaximizedToolWindow(); // a maximized window would cover the view
  if (anchorOf("explorer") === "left" && !visibleAt("left")) showToolWindow("explorer", false);
  setAppView("mcp");
  void startMcp();
  // Esc and the keyboard shortcuts of the view work from the moment it opens
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-mcp]")?.focus({ preventScroll: true }));
}

export function toggleMcpView(): void {
  if (isMcpView()) leaveAppView();
  else enterMcpView();
}

