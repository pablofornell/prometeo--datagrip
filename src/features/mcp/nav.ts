/** Navigation state of the MCP view: the open tab, the selected session, and the data source filter taken from the explorer. */
import { createEffect, createRoot, createSignal } from "solid-js";
import { loadLocal, saveUiState } from "../../state/persist";
import { isMcpView } from "../../state/view";
import { getSelectedNode } from "../explorer";

export type McpTab = "connect" | "sessions" | "permissions" | "log";
const TABS: McpTab[] = ["connect", "sessions", "permissions", "log"];
const KEY = "mcp.tab";

const stored = loadLocal<unknown>(KEY, "connect");
const [tab, setTabSignal] = createSignal<McpTab>(TABS.includes(stored as McpTab) ? (stored as McpTab) : "connect");

/** The tab that is open (remembered between runs). */
export const mcpTab = tab;
export function setMcpTab(t: McpTab): void {
  if (tab() === t) return;
  setTabSignal(t);
  saveUiState(KEY, t);
}

export const [selectedSession, setSelectedSession] = createSignal<string | null>(null);

/** Shows a session in the Sessions tab (a click on the client of a log entry). */
export function openSession(id: string): void {
  setSelectedSession(id);
  setMcpTab("sessions");
}

// ---- the data source selected in the Database Explorer filters the Sessions and Log tabs

const [dismissed, setDismissed] = createSignal<string | undefined>();
const [selectedDs, setSelectedDs] = createSignal<string | undefined>();

createRoot(() => {
  createEffect(() => setSelectedDs(getSelectedNode()?.dsId));
  // a different data source selected brings the filter back after it was removed
  createEffect(() => {
    if (selectedDs() !== dismissed()) setDismissed(undefined);
  });
});

/** Id of the data source the explorer has selected, while the MCP view is open and the user did not remove the chip. */
export const explorerFilter = (): string | undefined => {
  const id = selectedDs();
  return isMcpView() && id && id !== dismissed() ? id : undefined;
};
export const clearExplorerFilter = (): void => void setDismissed(selectedDs());
