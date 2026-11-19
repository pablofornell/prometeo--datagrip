/**
 * The MCP view: a workspace of its own (state/view.ts) with four tabs. The shell gives it the whole area to the right of the
 * left column; its header has the same 41 px strip as the editor tabs.
 */
import { type JSX, Match, Show, Switch as SolidSwitch, createSignal, createEffect } from "solid-js";
import { ActionButton, Button, Icon, Tabs } from "../../components/ui";
import { leaveAppView } from "../../state/view";
import { ConnectTab, EnableHero } from "./ConnectTab";
import { LogTab } from "./LogTab";
import { PermissionsTab } from "./PermissionsTab";
import { SessionsTab } from "./SessionsTab";
import { type McpTab, mcpTab, setMcpTab } from "./nav";
import { activeSessionCount, busy, configure, saveError, savePolicyNow, status, unavailable } from "./store";
import { EmptyState, Toggle } from "./widgets";
import { plural } from "./model";

const TAB_ITEMS = [
  { id: "connect", title: "Connect", icon: "dg/dbms", closeable: false },
  { id: "sessions", title: "Sessions", icon: "services", closeable: false },
  { id: "permissions", title: "Permissions", icon: "dg/gold-key", closeable: false },
  { id: "log", title: "Log", icon: "history", closeable: false },
];

type ServerState = "running" | "error" | "stopped";
const serverState = (): ServerState => {
  const s = status();
  return !s || !s.enabled ? "stopped" : s.running ? "running" : "error";
};

/** Server state at a glance: a dot (pulsing while it runs), where it listens, and how many agents are connected. */
function ServerBadge(): JSX.Element {
  const s = () => status()!;
  const active = activeSessionCount;
  return (
    <span class="dg-mcp-server" data-state={serverState()} role="status">
      <i class="dg-mcp-dot" />
      <span class="dg-mcp-server-text">
        <Show when={serverState() === "running"} fallback={serverState() === "error" ? (s().error ?? "Not running") : "Server off"}>
          127.0.0.1:{s().port}
        </Show>
      </span>
      <Show when={serverState() === "running" && active() > 0}>
        <span class="dg-mcp-server-agents">{plural(active(), "agent")}</span>
      </Show>
    </span>
  );
}

export function McpView(): JSX.Element {
  // a tab body is mounted the first time it is shown, then kept (its filters and scroll stay)
  const [visited, setVisited] = createSignal<ReadonlySet<McpTab>>(new Set([mcpTab()]));
  createEffect(() => setVisited((v) => (v.has(mcpTab()) ? v : new Set(v).add(mcpTab()))));
  const pane = (id: McpTab, body: () => JSX.Element) => (
    <Show when={visited().has(id)}>
      <div class="dg-mcp-pane" hidden={mcpTab() !== id}>
        {body()}
      </div>
    </Show>
  );

  return (
    <section class="dg-island dg-mcp-host dg-mcp" data-mcp tabindex={-1} aria-label="MCP">
      <header class="dg-mcp-top">
        <div class="dg-mcp-brand">
          <Icon name="mcp" />
          <span class="dg-mcp-brand-text">MCP</span>
        </div>
        <Tabs variant="editor" class="dg-mcp-tabs" items={TAB_ITEMS} active={mcpTab()} onSelect={(id) => setMcpTab(id as McpTab)} />
        <div class="dg-mcp-top-right">
          <Show when={status()}>
            <ServerBadge />
            <Toggle
              checked={!!status()?.enabled}
              busy={busy()}
              disabled={busy()}
              label={status()?.enabled ? "Disable the MCP server" : "Enable the MCP server"}
              onChange={(on) => void configure(on, status()!.port)}
            />
          </Show>
          <ActionButton icon="hide" title="Back to the editor" shortcut="Esc" onClick={leaveAppView} />
        </div>
      </header>
      <Show when={saveError()}>
        <div class="dg-mcp-banner dg-mcp-banner-top" data-tone="danger" role="alert">
          <Icon name="warning" />
          <span>
            Permissions not saved: agents still have the access they had before. It is retried automatically.
            <span class="dg-mcp-banner-detail"> {saveError()}</span>
          </span>
          <Button class="dg-mcp-small" onClick={() => void savePolicyNow()}>
            Retry
          </Button>
        </div>
      </Show>
      <div class="dg-mcp-body">
        <SolidSwitch>
          <Match when={unavailable()}>
            <EmptyState icon="error" title="The MCP server is not available">
              This build of Prometeo has no MCP support.
            </EmptyState>
          </Match>
          <Match when={!status()}>
            <div class="dg-mcp-loading">Loading…</div>
          </Match>
          <Match when={true}>
            {pane("connect", () => (
              <Show when={status()?.enabled} fallback={<div class="dg-mcp-page dg-mcp-scroll" data-focus-target tabindex={-1}><EnableHero /></div>}>
                <ConnectTab goto={setMcpTab} />
              </Show>
            ))}
            {pane("sessions", () => (
              <SessionsTab goto={setMcpTab} />
            ))}
            {pane("permissions", () => (
              <PermissionsTab />
            ))}
            {pane("log", () => (
              <LogTab />
            ))}
          </Match>
        </SolidSwitch>
      </div>
    </section>
  );
}

