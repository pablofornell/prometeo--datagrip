/** Sessions tab: the agent sessions on the left, the timeline of what the selected one did on the right. */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { McpLogEntry, McpSession } from "../../api/types";
import { Button, CopyButton, Icon, Loading } from "../../components/ui";
import { Splitter } from "../../components/ui/Splitter";
import { EntryRow } from "./EntryRow";
import { createFresh, createLogFeed } from "./feed";
import { clearExplorerFilter, explorerFilter, selectedSession, setSelectedSession, type McpTab } from "./nav";
import { clock, dayKey, dayLabel, duration, entryKind, gapBetween, groupByDay, plural, relativeTime, sessionActive, sessionTitle, sessionsOfDataSource } from "./model";
import { explorerDataSources } from "../explorer";
import { now, sessions } from "./store";
import { Chip, DsChip, EmptyState, FilterChip, Segmented } from "./widgets";

function SessionCard(props: { s: McpSession; selected: boolean; onSelect: () => void }): JSX.Element {
  const s = () => props.s;
  const problems = () => s().errorCount;
  const shown = () => s().dataSourceIds.slice(0, 2);
  return (
    <button type="button" role="option" aria-selected={props.selected} class="dg-mcp-session" classList={{ "dg-selected": props.selected }} onClick={props.onSelect}>
      <span class="dg-mcp-session-top">
        <i class="dg-mcp-dot" classList={{ "dg-live": sessionActive(s(), now()) }} {...{ "data-tip": sessionActive(s(), now()) ? "Active: seen in the last 10 minutes" : "Ended or idle" }} />
        <span class="dg-mcp-session-name">{s().clientName}</span>
        <Show when={s().clientVersion}>
          <span class="dg-mcp-session-ver">{s().clientVersion}</span>
        </Show>
        <span class="dg-mcp-session-ago">{relativeTime(s().lastSeenMs, now())}</span>
      </span>
      <span class="dg-mcp-session-stats">
        <span>{plural(s().actionCount, "action")}</span>
        <Show when={s().writeCount}>
          <Chip tone="warning" icon="edit">
            {plural(s().writeCount, "write")}
          </Chip>
        </Show>
        <Show when={problems()}>
          <Chip tone="danger" icon="warning">
            {plural(problems(), "problem")}
          </Chip>
        </Show>
      </span>
      <Show when={s().dataSourceIds.length}>
        <span class="dg-mcp-session-ds">
          <For each={shown()}>{(id) => <DsChip id={id} name={explorerDataSources().find((d) => d.id === id)?.name ?? id} />}</For>
          <Show when={s().dataSourceIds.length > shown().length}>
            <span class="dg-mcp-more-inline">+{s().dataSourceIds.length - shown().length}</span>
          </Show>
        </span>
      </Show>
    </button>
  );
}

type TlFilter = "all" | "writes" | "problems";

/**
 * The activity strip: one tick per action, colored by what it was; a click brings the action into view. It is a time axis
 * (oldest on the left, newest on the right) whatever the order of the list below it: that is how a strip of ticks reads.
 */
function Strip(props: { entries: McpLogEntry[]; onPick: (e: McpLogEntry) => void }): JSX.Element {
  return (
    <div class="dg-mcp-strip" role="list" aria-label="Actions of the session, oldest to newest">
      <For each={props.entries}>
        {(e) => (
          <button
            type="button"
            role="listitem"
            class="dg-mcp-tick"
            data-kind={entryKind(e)}
            data-status={e.status}
            tabindex={-1}
            data-tip={`${clock(e.tsMs)}  ${e.summary || e.tool}`}
            aria-label={e.summary || e.tool}
            onClick={() => props.onPick(e)}
          />
        )}
      </For>
    </div>
  );
}

function Timeline(props: { id: string }): JSX.Element {
  const session = () => sessions().find((s) => s.id === props.id);
  const query = createMemo(() => ({ sessionId: props.id, dataSourceId: explorerFilter() }));
  let scroller!: HTMLDivElement;
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const fresh = createFresh();
  const [unseen, setUnseen] = createSignal(0);
  const [mode, setMode] = createSignal<TlFilter>("all");

  // newest first: the latest action is at the top, where the list starts, and older ones are paged in at the bottom
  const nearTop = () => !scroller || scroller.scrollTop < 48;
  const toTop = (smooth: boolean) => requestAnimationFrame(() => scroller?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" }));
  const matches = (e: McpLogEntry) => {
    const m = mode();
    return m === "all" ? true : m === "writes" ? entryKind(e) === "write" : e.status !== "ok";
  };

  let before: { h: number; top: number; follow: boolean } | null = null;
  const feed = createLogFeed(query, {
    onLive: (phase, e) => {
      if (phase === "before") {
        before = { h: scroller.scrollHeight, top: scroller.scrollTop, follow: nearTop() };
        return;
      }
      const b = before;
      before = null;
      fresh.add(e.id);
      if (!b || b.follow) {
        // reading the top: the new action appears there
        if (b && b.top > 0) toTop(true);
        return;
      }
      // scrolled down: the entry arrives above what is on screen, keep the same rows under the pointer and say so
      scroller.scrollTop = b.top + (scroller.scrollHeight - b.h);
      if (matches(e)) setUnseen((n) => n + 1);
    },
  });

  createEffect(on(() => props.id, () => setUnseen(0)));

  const visible = createMemo(() => feed.entries().filter(matches));
  /** The strip is a time axis: oldest on the left. */
  const chronological = createMemo(() => [...feed.entries()].reverse());
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pick = (e: McpLogEntry) => {
    setOpen((o) => new Set(o).add(e.id));
    requestAnimationFrame(() => scroller.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(e.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  return (
    <div class="dg-mcp-timeline">
      <Show when={session()}>
        {(s) => (
          <header class="dg-mcp-tl-head">
            <div class="dg-mcp-tl-title">
              <i class="dg-mcp-dot" classList={{ "dg-live": sessionActive(s(), now()) }} />
              <h3>{sessionTitle(s())}</h3>
              <Show when={sessionActive(s(), now())}>
                <Chip tone="success">Active</Chip>
              </Show>
              <span class="dg-mcp-tl-spacer" />
              <span class="dg-mcp-mono dg-mcp-tl-id">{s().id.slice(0, 12)}</span>
              <CopyButton text={() => s().id} tooltip="Copy the session id" />
            </div>
            <div class="dg-mcp-tl-sub">
              Started {new Date(s().startedAtMs).toLocaleString()}
              <span class="dg-mcp-sep">·</span>
              {duration(s().lastSeenMs - s().startedAtMs)} of activity
              <span class="dg-mcp-sep">·</span>
              {plural(s().actionCount, "action")}
              <Show when={s().writeCount}>
                <span class="dg-mcp-sep">·</span>
                <span class="dg-mcp-warn-text">{plural(s().writeCount, "write")}</span>
              </Show>
              <Show when={s().errorCount}>
                <span class="dg-mcp-sep">·</span>
                <span class="dg-mcp-danger-text">{plural(s().errorCount, "problem")}</span>
              </Show>
            </div>
          </header>
        )}
      </Show>
      <div class="dg-mcp-tl-bar">
        <Segmented
          label="Show"
          value={mode()}
          onChange={setMode}
          options={[
            { id: "all", label: "All" },
            { id: "writes", label: "Writes" },
            { id: "problems", label: "Problems" },
          ]}
        />
        <Strip entries={chronological()} onPick={pick} />
        <Button class="dg-mcp-small" disabled={open().size === 0} onClick={() => setOpen(new Set())}>
          Collapse all
        </Button>
      </div>
      <div class="dg-mcp-scroll dg-mcp-tl-scroll" ref={scroller} data-focus-target tabindex={-1}>
        <Show when={unseen() > 0}>
          <div class="dg-mcp-newpill-anchor">
            <button
              type="button"
              class="dg-mcp-newpill"
              onClick={() => {
                setUnseen(0);
                toTop(true);
              }}
            >
              <Icon name="chevron-up" />
              {plural(unseen(), "new action")}
            </button>
          </div>
        </Show>
        <Show when={!feed.loading()} fallback={<Loading />}>
          <Show when={!feed.error()} fallback={<EmptyState compact icon="error" title="Cannot read the log">{feed.error()}</EmptyState>}>
            <Show
              when={visible().length}
              fallback={
                <EmptyState compact icon="history" title={mode() === "all" ? "No actions recorded" : "Nothing to show"}>
                  {mode() === "all" ? (explorerFilter() ? "This session did not touch the selected data source." : "The agent has not called any tool yet.") : "No action of this session matches the filter."}
                </EmptyState>
              }
            >
              <div class="dg-mcp-tl-list">
                <For each={visible()}>
                  {(e, i) => {
                    // the list runs from the newest to the oldest: the row above is the later one
                    const gap = () => (i() > 0 ? gapBetween(e.tsMs, visible()[i() - 1].tsMs) : null);
                    return (
                      <>
                        <Show when={gap()}>{(g) => <div class="dg-mcp-gap">{duration(g())} earlier</div>}</Show>
                        <div data-entry-id={e.id}>
                          <EntryRow rail entry={e} open={open().has(e.id)} onToggle={() => toggle(e.id)} first={i() === 0} last={i() === visible().length - 1} fresh={fresh.has(e.id)} />
                        </div>
                      </>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
        <Show when={!feed.loading() && !feed.error() && feed.hasMore()}>
          <div class="dg-mcp-more-row">
            <Button class="dg-mcp-small" disabled={feed.loadingMore()} onClick={feed.loadMore}>
              {feed.loadingMore() ? "Loading…" : "Load older actions"}
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function SessionsTab(props: { goto: (t: McpTab) => void }): JSX.Element {
  const [width, setWidth] = createSignal(300);
  const list = createMemo(() => sessionsOfDataSource(sessions(), explorerFilter()));
  const selected = createMemo(() => list().find((s) => s.id === selectedSession())?.id ?? list()[0]?.id);
  // sections keyed by day, cards by session object (kept by `reuseSessions` while a session does not change)
  const dayKeys = createMemo(() => groupByDay(list().map((s) => ({ tsMs: s.lastSeenMs }))).map((g) => g.key));
  const filterName = () => explorerDataSources().find((d) => d.id === explorerFilter())?.name;

  return (
    <div class="dg-mcp-split">
      <aside class="dg-mcp-master" style={{ width: width() + "px" }}>
        <header class="dg-mcp-pane-head">
          <span class="dg-mcp-pane-title">Sessions</span>
          <span class="dg-mcp-count">{list().length}</span>
          <Show when={explorerFilter()}>
            <FilterChip icon="filter" title="Filtered by the data source selected in the Database Explorer" onRemove={clearExplorerFilter}>
              {filterName() ?? "Data source"}
            </FilterChip>
          </Show>
        </header>
        <div class="dg-mcp-scroll dg-mcp-sessions" role="listbox" aria-label="Sessions" data-focus-target tabindex={-1}>
          <Show
            when={list().length}
            fallback={
              <EmptyState compact icon="services" title={explorerFilter() ? "No session used this data source" : "No agent has connected yet"}>
                {explorerFilter() ? (
                  <Button class="dg-mcp-small" onClick={clearExplorerFilter}>
                    Show all sessions
                  </Button>
                ) : (
                  <>
                    Sessions appear here as soon as an agent connects.
                    <br />
                    <button type="button" class="dg-mcp-textlink" onClick={() => props.goto("connect")}>
                      How to connect
                    </button>
                  </>
                )}
              </EmptyState>
            }
          >
            <For each={dayKeys()}>
              {(k) => {
                const items = createMemo(() => list().filter((s) => dayKey(s.lastSeenMs) === k));
                return (
                  <section>
                    <h4 class="dg-mcp-day">{dayLabel(items()[0]?.lastSeenMs ?? 0, now())}</h4>
                    <For each={items()}>{(s) => <SessionCard s={s} selected={selected() === s.id} onSelect={() => void setSelectedSession(s.id)} />}</For>
                  </section>
                );
              }}
            </For>
          </Show>
        </div>
      </aside>
      <Splitter class="dg-mcp-split-bar" orientation="vertical" size={width()} min={230} max={460} onResize={setWidth} />
      <section class="dg-mcp-detail-pane" aria-label="Session timeline">
        <Show
          when={selected()}
          keyed
          fallback={
            <EmptyState icon="history" title={list().length ? "Select a session" : "Nothing to follow yet"}>
              Its actions, newest first, appear here: the queries it ran, what they returned and what it changed.
            </EmptyState>
          }
        >
          {(id) => <Timeline id={id} />}
        </Show>
      </section>
    </div>
  );
}
