/** Status bar widget: the MCP server state and how many agents are connected. Only shown while the server is on. */
import { type JSX, Show } from "solid-js";
import { tip } from "../../components/ui";
import { isMcpView } from "../../state/view";
import { plural } from "./model";
import { activeSessionCount, status } from "./store";
import { toggleMcpView } from "./view";

export function McpStatusWidget(): JSX.Element {
  const on = () => status()?.enabled;
  const state = () => (status()?.running ? "running" : "error");
  const active = () => (status()?.running ? activeSessionCount() : 0);
  const title = () => {
    const s = status();
    if (!s) return "";
    if (!s.running) return `MCP server: ${s.error ?? "not running"}`;
    return `MCP server on ${s.endpoint}\n${active() ? plural(active(), "agent") + " connected" : "No agent connected"}`;
  };
  return (
    <Show when={on()}>
      <span
        class="dg-status-widget dg-clickable dg-status-mcp"
        classList={{ "dg-active": isMcpView() }}
        data-state={state()}
        role="button"
        tabindex={-1}
        {...tip(title())}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleMcpView}
      >
        <i class="dg-mcp-dot" />
        <span>MCP</span>
        <Show when={active() > 0}>
          <span class="dg-status-mcp-count">{active()}</span>
        </Show>
      </span>
    </Show>
  );
}
