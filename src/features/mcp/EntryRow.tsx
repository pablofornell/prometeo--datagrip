/**
 * One log entry: a header line (what the agent called, on which data source, how it ended) that opens to the SQL, the
 * error, the arguments and the result preview. Used by the session timeline (with its rail) and by the log list.
 */
import { For, type JSX, Show, createMemo } from "solid-js";
import { createConsole, writeConsole } from "../../api/db";
import type { McpLogEntry } from "../../api/types";
import { Icon, CopyButton, notify } from "../../components/ui";
import { highlightSql } from "../../components/editor";
import type { Dialect } from "../../components/editor";
import { settings } from "../../state/settings";
import { leaveAppView } from "../../state/view";
import { ensureConnected, explorerDataSources, openConsoleTab } from "../explorer";
import { clock, duration, entryKind, hasDetail, outcomeText, toolMeta } from "./model";
import { DsChip, StatusPill } from "./widgets";

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

/** Opens a new console on the data source with the SQL in it, and leaves the MCP view so it can be seen. */
export async function openInConsole(dsId: string, sql: string): Promise<void> {
  try {
    await ensureConnected(dsId);
    const name = await createConsole(dsId);
    await writeConsole(dsId, name, sql.endsWith("\n") ? sql : sql + "\n");
    openConsoleTab(dsId, name);
    leaveAppView();
  } catch (e) {
    notify({ kind: "error", title: "Cannot open a console", body: errText(e) });
  }
}

/** SQL with the editor's keyword / string / number colors. */
export function SqlBlock(props: { sql: string; dialect: Dialect }): JSX.Element {
  const parts = createMemo<JSX.Element[]>(() => {
    const text = props.sql;
    const out: JSX.Element[] = [];
    let at = 0;
    for (const m of [...highlightSql(text, props.dialect)].sort((a, b) => a.from - b.from)) {
      if (m.from < at || m.to <= m.from) continue;
      if (m.from > at) out.push(text.slice(at, m.from));
      out.push(<span class={`cm-sql-${m.cls}`}>{text.slice(m.from, m.to)}</span>);
      at = m.to;
    }
    out.push(text.slice(at));
    return out;
  });
  return <pre class="dg-mcp-sql dg-sql-hl">{parts()}</pre>;
}

/** The result preview as a small read-only grid. */
export function PreviewGrid(props: { preview: NonNullable<McpLogEntry["preview"]>; rowCount: number | null; truncated: boolean }): JSX.Element {
  const shown = () => props.preview.rows.length;
  const total = () => props.rowCount ?? shown();
  return (
    <div class="dg-mcp-result">
      <div class="dg-mcp-grid-scroll">
        <table class="dg-mcp-grid">
          <thead>
            <tr>
              <th class="dg-mcp-grid-n">#</th>
              <For each={props.preview.columns}>{(c) => <th>{c}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={props.preview.rows}>
              {(r, i) => (
                <tr>
                  <td class="dg-mcp-grid-n">{i() + 1}</td>
                  <For each={r}>{(v) => <td classList={{ "dg-null": v === null }}>{v === null ? settings.gridNullText : v}</td>}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="dg-mcp-result-note">
        {shown() < total() || props.truncated
          ? `Preview of the first ${shown()} of ${total().toLocaleString("en-US")}${props.truncated ? "+" : ""} rows${props.truncated ? " (the row limit of the call was reached)" : ""}`
          : `${shown()} row${shown() === 1 ? "" : "s"}`}
      </div>
    </div>
  );
}

function Args(props: { args: unknown }): JSX.Element {
  const pairs = (): [string, string][] | null => {
    const a = props.args;
    if (!a || typeof a !== "object" || Array.isArray(a)) return null;
    return Object.entries(a as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  };
  return (
    <Show when={pairs()} fallback={<pre class="dg-mcp-sql">{JSON.stringify(props.args, null, 2)}</pre>}>
      {(p) => (
        <dl class="dg-mcp-args">
          <For each={p()}>
            {([k, v]) => (
              <>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </>
            )}
          </For>
        </dl>
      )}
    </Show>
  );
}

function Detail(props: { e: McpLogEntry }): JSX.Element {
  const e = () => props.e;
  const ds = () => explorerDataSources().find((d) => d.id === e().dataSourceId);
  const hasArgs = () => e().args != null && JSON.stringify(e().args) !== "{}";
  return (
    <div class="dg-mcp-detail">
      <Show when={e().error}>
        <div class="dg-mcp-alert" data-status={e().status}>
          <Icon name={e().status === "denied" ? "dg/locked" : "error"} />
          <span>{e().error}</span>
        </div>
      </Show>
      <Show when={e().sql}>
        <section class="dg-mcp-block">
          <header class="dg-mcp-block-head">
            <span class="dg-mcp-block-title">{entryKind(e()) === "write" ? "Statement" : "SQL"}</span>
            <span class="dg-mcp-block-actions">
              <Show when={ds() && e().sql}>
                <button type="button" class="dg-mcp-link" onClick={() => void openInConsole(ds()!.id, e().sql!)}>
                  <Icon name="dg/console" />
                  Open in console
                </button>
              </Show>
              <CopyButton text={() => e().sql ?? ""} tooltip="Copy SQL" />
            </span>
          </header>
          <SqlBlock sql={e().sql!} dialect={((ds()?.driver as Dialect | undefined) ?? "postgres") as Dialect} />
        </section>
      </Show>
      <Show when={hasArgs()}>
        <section class="dg-mcp-block">
          <header class="dg-mcp-block-head">
            <span class="dg-mcp-block-title">Arguments</span>
          </header>
          <Args args={e().args} />
        </section>
      </Show>
      <Show when={e().preview}>
        {(p) => (
          <section class="dg-mcp-block">
            <header class="dg-mcp-block-head">
              <span class="dg-mcp-block-title">Result</span>
            </header>
            <PreviewGrid preview={p()} rowCount={e().rowCount} truncated={e().truncated} />
          </section>
        )}
      </Show>
      <div class="dg-mcp-detail-foot">
        <span>{new Date(e().tsMs).toLocaleString()}</span>
        <span>{duration(e().elapsedMs)}</span>
        <Show when={outcomeText(e())}>{(t) => <span>{t()}</span>}</Show>
        <span class="dg-mcp-mono">session {e().sessionId.slice(0, 10)}</span>
      </div>
    </div>
  );
}

export interface EntryRowProps {
  entry: McpLogEntry;
  open: boolean;
  onToggle: () => void;
  /** The timeline look: a rail with a node on the left. */
  rail?: boolean;
  /** Log list: show who called and let a click jump to the session. */
  onOpenSession?: (sessionId: string) => void;
  /** First / last entry of the timeline (the rail starts / ends there). */
  first?: boolean;
  last?: boolean;
  /** Played once: the entry arrived while the view was open. */
  fresh?: boolean;
}

export function EntryRow(props: EntryRowProps): JSX.Element {
  const e = () => props.entry;
  const meta = () => toolMeta(e().tool);
  const kind = () => entryKind(e());
  const expandable = () => e().kind === "tool" && hasDetail(e());
  const oneLine = () => (e().sql ? e().sql!.replace(/\s+/g, " ").trim() : null);

  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      if (expandable()) props.onToggle();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const heads = [...(ev.currentTarget as HTMLElement).closest(".dg-mcp-scroll")?.querySelectorAll<HTMLElement>(".dg-mcp-entry-head") ?? []];
      const next = heads[heads.indexOf(ev.currentTarget as HTMLElement) + (ev.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        ev.preventDefault();
        next.focus();
      }
    } else if (ev.key === "ArrowRight" && expandable() && !props.open) {
      ev.preventDefault();
      props.onToggle();
    } else if (ev.key === "ArrowLeft" && props.open) {
      ev.preventDefault();
      props.onToggle();
    }
  };

  return (
    <article
      class="dg-mcp-entry"
      classList={{
        "dg-open": props.open,
        "dg-rail": props.rail,
        "dg-first": props.first,
        "dg-last": props.last,
        "dg-fresh": props.fresh,
        "dg-session": e().kind !== "tool",
        "dg-withclient": !!props.onOpenSession,
      }}
      data-kind={kind()}
      data-status={e().status}
      data-entry-id={e().id}
    >
      <Show when={props.rail}>
        <div class="dg-mcp-rail">
          <span class="dg-mcp-node">
            <Icon name={meta().icon} />
          </span>
        </div>
      </Show>
      <div class="dg-mcp-entry-main">
        {/* One grid (mcp.css): a column for each of time, tool, data source, summary, client, status, duration and twisty.
            A column that has nothing to show stays empty instead of closing up, so the rows line up. */}
        <div
          class="dg-mcp-entry-head"
          role={expandable() ? "button" : undefined}
          tabindex={0}
          aria-expanded={expandable() ? props.open : undefined}
          onClick={() => expandable() && props.onToggle()}
          onKeyDown={key}
        >
          <Show when={!props.rail}>
            <span class="dg-mcp-node dg-inline">
              <Icon name={meta().icon} />
            </span>
          </Show>
          <time class="dg-mcp-time" datetime={new Date(e().tsMs).toISOString()} title={new Date(e().tsMs).toLocaleString()}>
            {clock(e().tsMs)}
          </time>
          <Show when={e().kind === "tool"} fallback={<span class="dg-mcp-entry-session">{e().summary || meta().label}</span>}>
            <span class="dg-mcp-cell-tool">
              <span class="dg-mcp-tool" data-kind={kind()}>
                {meta().label}
              </span>
            </span>
            <span class="dg-mcp-cell-ds">
              <DsChip id={e().dataSourceId} name={e().dataSourceName} />
            </span>
            <span class="dg-mcp-entry-summary" title={e().summary || undefined}>
              {e().summary}
            </span>
          </Show>
          <Show when={props.onOpenSession}>
            <button
              type="button"
              class="dg-mcp-client"
              title="Show the session"
              onClick={(ev) => {
                ev.stopPropagation();
                props.onOpenSession!(e().sessionId);
              }}
              onKeyDown={(ev) => ev.stopPropagation()}
            >
              {e().clientName}
            </button>
          </Show>
          <Show when={e().kind === "tool"}>
            <span class="dg-mcp-cell-status">
              <StatusPill status={e().status} />
            </span>
            <span class="dg-mcp-elapsed">{duration(e().elapsedMs)}</span>
          </Show>
          <span class="dg-mcp-twisty" classList={{ "dg-hidden-twisty": !expandable() }}>
            <Icon name={props.open ? "chevron-down" : "chevron-right"} />
          </span>
          <Show when={oneLine() && !props.open}>
            {/* a preview for the eye: out of the accessible name of the button (the full SQL is in the opened body) */}
            <div class="dg-mcp-entry-sql" aria-hidden="true">
              {oneLine()}
            </div>
          </Show>
        </div>
        <Show when={props.open && expandable()}>
          <Detail e={e()} />
        </Show>
      </div>
    </article>
  );
}
