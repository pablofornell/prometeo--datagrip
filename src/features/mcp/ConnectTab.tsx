/** Connect tab: how to install Datum in an agent (per project or global), the endpoint and token, and what the agents can reach. */
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { Button, ComboBox, CopyButton, Icon, TextField, tip } from "../../components/ui";
import { loadLocal, saveUiState } from "../../state/persist";
import { confirmDialog } from "./confirm";
import {
  AGENTS,
  type AgentId,
  type CodePart,
  DEFAULT_AGENT,
  DEFAULT_PORT,
  type InstallScope,
  type RichText,
  installSnippet,
  isAgentId,
  maskToken,
  parsePort,
  plural,
  READ_ONLY_NOTE,
  scopeHint,
  summarize,
} from "./model";
import { type McpTab } from "./nav";
import { busy, configure, effectiveOf, permSources, regenerateToken, status } from "./store";
import { Chip, DsChip, EmptyState, Toggle } from "./widgets";

function Code(props: { parts: CodePart[]; label: string; kind: "command" | "file" }): JSX.Element {
  return (
    <pre class="dg-mcp-code-text" data-kind={props.kind} aria-label={props.label}>
      <For each={props.parts}>{(p) => (p.cls ? <span class={"dg-mcp-c-" + p.cls}>{p.text}</span> : p.text)}</For>
    </pre>
  );
}

function Rich(props: { text: RichText }): JSX.Element {
  return <For each={props.text}>{(x) => (typeof x === "string" ? x : <code>{x.code}</code>)}</For>;
}

const AGENT_KEY = "mcp.connect.agent";
const GLOBAL_KEY = "mcp.connect.global";

/** The server is off: say what it is and how it stays safe, and offer to start it. */
export function EnableHero(): JSX.Element {
  const [port, setPort] = createSignal(String(status()?.port ?? DEFAULT_PORT));
  const valid = () => parsePort(port()) !== null;
  const enable = () => {
    const p = parsePort(port());
    if (p !== null) void configure(true, p);
  };
  return (
    <div class="dg-mcp-hero">
      <div class="dg-mcp-hero-art" aria-hidden="true">
        <span class="dg-mcp-hero-ring" />
        <span class="dg-mcp-hero-core">
          <Icon name="mcp@20x20" size={28} />
        </span>
      </div>
      <h2 class="dg-mcp-hero-title">Let AI agents work with your databases</h2>
      <p class="dg-mcp-hero-text">
        Datum runs a local MCP server. Agents such as Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot or OpenCode connect to it to read schemas, run queries and, only where you allow it, change data. Every
        action is recorded in this view for {status()?.logRetentionDays ?? 30} days.
      </p>
      <ul class="dg-mcp-safety">
        <li>
          <Icon name="dg/locked" />
          <span>
            <b>Local only.</b> It listens on 127.0.0.1; web pages cannot reach it.
          </span>
        </li>
        <li>
          <Icon name="dg/gold-key" />
          <span>
            <b>Token protected.</b> Every request needs the secret token of this app.
          </span>
        </li>
        <li>
          <Icon name="dg/funnel" />
          <span>
            <b>Nothing is visible by default.</b> You grant read or write per data source or folder.
          </span>
        </li>
      </ul>
      <div class="dg-mcp-hero-actions">
        <Button primary disabled={!valid() || busy()} onClick={enable}>
          {busy() ? "Starting…" : "Enable MCP server"}
        </Button>
        <label class="dg-mcp-port">
          <span>Port</span>
          <TextField value={port()} onInput={setPort} error={!valid()} inputmode="numeric" maxlength={5} aria-label="Port" onKeyDown={(e) => e.key === "Enter" && enable()} />
        </label>
      </div>
      <Show when={status()?.error}>
        <div class="dg-mcp-alert" data-status="error">
          <Icon name="error" />
          <span>{status()!.error}</span>
        </div>
      </Show>
    </div>
  );
}

export function ConnectTab(props: { goto: (t: McpTab) => void }): JSX.Element {
  const st = () => status()!;
  const storedAgent = loadLocal<unknown>(AGENT_KEY, DEFAULT_AGENT);
  const [agent, setAgentSignal] = createSignal<AgentId>(isAgentId(storedAgent) ? storedAgent : DEFAULT_AGENT);
  // installing for every project is a choice the user makes on purpose: off unless they switched it on before
  const [global, setGlobalSignal] = createSignal(loadLocal<unknown>(GLOBAL_KEY, false) === true);
  const setAgent = (a: AgentId) => {
    setAgentSignal(a);
    saveUiState(AGENT_KEY, a);
  };
  const setGlobal = (on: boolean) => {
    setGlobalSignal(on);
    saveUiState(GLOBAL_KEY, on);
  };
  const scope = (): InstallScope => (global() ? "global" : "project");
  const [reveal, setReveal] = createSignal(false);
  const [portText, setPortText] = createSignal<string | null>(null);

  const shownToken = () => (reveal() ? st().token : maskToken(st().token));
  // the screen shows the masked token (unless revealed); the copy always has the real one
  const shown = createMemo(() => installSnippet(agent(), scope(), st().endpoint, shownToken()));
  const parts = (): CodePart[] => shown().parts;
  const text = () => installSnippet(agent(), scope(), st().endpoint, st().token).text;
  const isCommand = () => shown().kind === "command";
  const codeLabel = () => (isCommand() ? "Install command" : `${shown().path!.posix} entry`);

  const summary = () => summarize(permSources().map((s) => ({ eff: effectiveOf(s) })));
  const exposed = createMemo(() =>
    permSources()
      .map((s) => ({ s, eff: effectiveOf(s) }))
      .filter((x) => x.eff.read || x.eff.write),
  );

  const portShown = () => portText() ?? String(st().port);
  const portDirty = () => portText() !== null && parsePort(portText()!) !== null && parsePort(portText()!) !== st().port;
  const applyPort = async () => {
    const p = parsePort(portText() ?? "");
    if (p !== null && (await configure(true, p))) setPortText(null);
  };

  const regenerate = async () => {
    const ok = await confirmDialog({
      title: "Regenerate Token",
      confirmLabel: "Regenerate",
      message: (
        <>
          <p>Agents that use the current token are refused from now on, until you give them the new install command.</p>
        </>
      ),
    });
    if (ok) void regenerateToken();
  };

  return (
    <div class="dg-mcp-page dg-mcp-scroll" data-focus-target tabindex={-1}>
      <div class="dg-mcp-connect">
        <section class="dg-mcp-card dg-mcp-card-main">
          <header class="dg-mcp-card-head">
            <h3 class="dg-mcp-card-title">Connect an agent</h3>
            <label class="dg-mcp-agent">
              <span>Agent</span>
              <ComboBox<AgentId> class="dg-mcp-combo" width={170} value={agent()} onChange={setAgent} options={AGENTS.map((a) => ({ value: a.id, label: a.label }))} />
            </label>
          </header>
          <div class="dg-mcp-scope">
            <Toggle checked={global()} onChange={setGlobal} label="Global, for all projects" />
            <div class="dg-mcp-scope-text">
              <button type="button" class="dg-mcp-scope-label" onClick={() => setGlobal(!global())}>
                Global — for all projects
              </button>
              <span class="dg-mcp-scope-hint">{scopeHint(agent(), scope())}</span>
            </div>
          </div>
          <ol class="dg-mcp-steps">
            <li>
              <span class="dg-mcp-step">1</span>
              <div>
                <div class="dg-mcp-step-title">{isCommand() ? "Copy the command" : "Copy the entry"}</div>
                <div class="dg-mcp-code">
                  <Code parts={parts()} label={codeLabel()} kind={shown().kind} />
                  <div class="dg-mcp-code-actions">
                    <button
                      type="button"
                      class="dg-mcp-iconbtn"
                      aria-pressed={reveal()}
                      aria-label={reveal() ? "Hide the token" : "Show the token"}
                      {...tip(reveal() ? "Hide the token" : "Show the token")}
                      onClick={() => setReveal(!reveal())}
                    >
                      <Icon name={reveal() ? "hide" : "show"} />
                    </button>
                    <CopyButton text={text} tooltip={isCommand() ? "Copy the command" : shown().lang === "toml" ? "Copy the TOML" : "Copy the JSON"} />
                  </div>
                </div>
                <div class="dg-mcp-step-text">The copy has the real token; keep it private like a password.</div>
              </div>
            </li>
            <li>
              <span class="dg-mcp-step">2</span>
              <div>
                <div class="dg-mcp-step-title">{shown().title}</div>
                <div class="dg-mcp-step-text">
                  <Rich text={shown().how} />
                </div>
              </div>
            </li>
            <li>
              <span class="dg-mcp-step">3</span>
              <div>
                <div class="dg-mcp-step-title">Choose what it can reach</div>
                <div class="dg-mcp-step-text">
                  The agent sees no data source until you grant it one.{" "}
                  <button type="button" class="dg-mcp-textlink" onClick={() => props.goto("permissions")}>
                    Open Permissions
                  </button>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <div class="dg-mcp-side">
          <section class="dg-mcp-card">
            <header class="dg-mcp-card-head">
              <h3 class="dg-mcp-card-title">Server</h3>
            </header>
            <dl class="dg-mcp-props">
              <dt>Status</dt>
              <dd>
                <span class="dg-mcp-state" data-state={st().running ? "running" : st().error ? "error" : "stopped"}>
                  <i class="dg-mcp-dot" />
                  {st().running ? "Listening on 127.0.0.1" : st().error ? "Not running" : "Stopped"}
                </span>
                <Show when={st().error}>
                  <div class="dg-mcp-prop-error">{st().error}</div>
                </Show>
              </dd>
              <dt>Endpoint</dt>
              <dd class="dg-mcp-with-actions">
                <code class="dg-mcp-mono dg-mcp-ellipsis">{st().endpoint}</code>
                <CopyButton text={() => st().endpoint} tooltip="Copy the endpoint" />
              </dd>
              <dt>Port</dt>
              <dd class="dg-mcp-with-actions">
                <TextField
                  frameClass="dg-mcp-port-field"
                  value={portShown()}
                  inputmode="numeric"
                  maxlength={5}
                  aria-label="Port"
                  error={portText() !== null && parsePort(portText()!) === null}
                  onInput={(v) => setPortText(v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && portDirty()) void applyPort();
                    if (e.key === "Escape" && portText() !== null) {
                      e.stopPropagation();
                      setPortText(null);
                    }
                  }}
                />
                <Show when={portDirty()}>
                  <Button disabled={busy()} onClick={() => void applyPort()}>
                    Restart
                  </Button>
                </Show>
              </dd>
              <dt>Token</dt>
              <dd class="dg-mcp-with-actions">
                <code class="dg-mcp-mono dg-mcp-ellipsis">{shownToken()}</code>
                <CopyButton text={() => st().token} tooltip="Copy the token" />
                <button type="button" class="dg-mcp-iconbtn" aria-label="Regenerate the token" {...tip("Regenerate the token")} onClick={() => void regenerate()}>
                  <Icon name="refresh" />
                </button>
              </dd>
            </dl>
          </section>

          <section class="dg-mcp-card">
            <header class="dg-mcp-card-head">
              <h3 class="dg-mcp-card-title">What agents can reach</h3>
              <button type="button" class="dg-mcp-textlink" onClick={() => props.goto("permissions")}>
                Manage
              </button>
            </header>
            <div class="dg-mcp-stats">
              <div class="dg-mcp-stat" data-tone="info">
                <b>{summary().read}</b>
                <span>Read only</span>
              </div>
              <div class="dg-mcp-stat" data-tone="warning">
                <b>{summary().readwrite + summary().write}</b>
                <span>Can write</span>
              </div>
              <div class="dg-mcp-stat" data-tone="neutral">
                <b>{summary().none}</b>
                <span>No access</span>
              </div>
            </div>
            <Show
              when={exposed().length}
              fallback={
                <EmptyState compact icon="dg/locked" title="No data source is exposed">
                  Agents can connect but see nothing yet.
                </EmptyState>
              }
            >
              <ul class="dg-mcp-exposed">
                <For each={exposed().slice(0, 6)}>
                  {(x) => (
                    <li>
                      <DsChip id={x.s.id} name={x.s.name} />
                      <span class="dg-mcp-exposed-perms">
                        <Show when={x.eff.read}>
                          <Chip tone="info">Read</Chip>
                        </Show>
                        <Show when={x.eff.write}>
                          <Chip tone="warning">Write</Chip>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={exposed().length > 6}>
                <div class="dg-mcp-more">+ {plural(exposed().length - 6, "more data source")}</div>
              </Show>
            </Show>
            <div class="dg-mcp-tip">
              <Icon name="intention-bulb" />
              <span>{READ_ONLY_NOTE}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
