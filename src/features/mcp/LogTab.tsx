/** Log tab: everything agents did in the last 30 days, grouped by day, with filters and paging. */
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { McpLogQuery, McpLogStatus } from "../../api/types";
import { Button, ComboBox, Icon, Loading, TextField } from "../../components/ui";
import { loadLocal, saveUiState } from "../../state/persist";
import { explorerDataSources } from "../explorer";
import { confirmDialog } from "./confirm";
import { EntryRow } from "./EntryRow";
import { createFresh, createLogFeed } from "./feed";
import { type LogRange, RANGES, RETENTION_DAYS, dayKey, dayLabel, groupByDay, plural, rangeSince, startOfDay } from "./model";
import { clearExplorerFilter, explorerFilter, openSession } from "./nav";
import { clearLog, now, status } from "./store";
import { EmptyState, FilterChip, Segmented } from "./widgets";

const RANGE_KEY = "mcp.logRange";
/** The log opens on today: what an agent did a moment ago is what the user comes to check. */
const DEFAULT_RANGE: LogRange = "today";
const storedRange = loadLocal<unknown>(RANGE_KEY, DEFAULT_RANGE);
const isRange = (r: unknown): r is LogRange => RANGES.some((x) => x.id === r);

export function LogTab(): JSX.Element {
  const [range, setRangeSignal] = createSignal<LogRange>(isRange(storedRange) ? storedRange : DEFAULT_RANGE);
  const [statusF, setStatusF] = createSignal<McpLogStatus | "all">("all");
  const [dsF, setDsF] = createSignal("all");
  const [text, setText] = createSignal("");
  const [textQ, setTextQ] = createSignal("");
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const fresh = createFresh();
  let scroller!: HTMLDivElement;

  // "30 days" and "7 days" are counted from the moment they are chosen (a moving bound would reload the list every few seconds);
  // "Today" starts at the midnight of the clock, so it rolls over by itself
  const [chosenAt, setChosenAt] = createSignal(Date.now());
  const setRange = (r: LogRange) => {
    setChosenAt(Date.now());
    setRangeSignal(r);
    saveUiState(RANGE_KEY, r);
  };

  let timer = 0;
  createEffect(
    on(text, (t) => {
      clearTimeout(timer);
      timer = setTimeout(() => setTextQ(t), 250);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const since = createMemo(() => (range() === "today" ? startOfDay(now()) : rangeSince(range(), chosenAt())));
  const dsId = () => explorerFilter() ?? (dsF() === "all" ? undefined : dsF());
  const query = createMemo<McpLogQuery>(() => {
    const st = statusF();
    return {
    dataSourceId: dsId(),
    status: st === "all" ? undefined : st,
    text: textQ().trim() || undefined,
    sinceMs: since(),
    };
  });
  const filtered = () => !!(dsId() || statusF() !== "all" || textQ().trim());

  let before: { h: number; top: number } | null = null;
  const feed = createLogFeed(query, {
    // an entry that arrives above what is on screen must not push it down: keep the same rows under the pointer
    onLive: (phase, e) => {
      if (phase === "before") before = { h: scroller.scrollHeight, top: scroller.scrollTop };
      else if (before) {
        if (before.top > 0) scroller.scrollTop = before.top + (scroller.scrollHeight - before.h);
        before = null;
        fresh.add(e.id);
      }
    },
  });

  // sections are keyed by day and rows by entry: the clock ticking or an entry arriving keeps every row (focus, expanded state)
  const dayKeys = createMemo(() => groupByDay(feed.entries()).map((g) => g.key));
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const dsOptions = createMemo(() => [{ value: "all", label: "All data sources" }, ...explorerDataSources().map((d) => ({ value: d.id, label: d.name }))]);
  const reset = () => {
    setStatusF("all");
    setDsF("all");
    setText("");
    setTextQ("");
    clearExplorerFilter();
  };

  const clear = async () => {
    const ok = await confirmDialog({
      title: "Clear MCP Log",
      confirmLabel: "Clear Log",
      message: <p>All recorded sessions and actions are deleted. The permissions stay as they are.</p>,
    });
    if (ok) void clearLog();
  };

  return (
    <div class="dg-mcp-logtab">
      <div class="dg-mcp-toolbar">
        <Show
          when={explorerFilter()}
          fallback={<ComboBox class="dg-mcp-combo" width={190} options={dsOptions()} value={dsF()} onChange={setDsF} />}
        >
          <FilterChip icon="filter" title="Filtered by the data source selected in the Database Explorer" onRemove={clearExplorerFilter}>
            {explorerDataSources().find((d) => d.id === explorerFilter())?.name ?? "Data source"}
          </FilterChip>
        </Show>
        <ComboBox<McpLogStatus | "all">
          class="dg-mcp-combo"
          width={120}
          value={statusF()}
          onChange={setStatusF}
          options={[
            { value: "all", label: "Any status" },
            { value: "ok", label: "OK" },
            { value: "error", label: "Error" },
            { value: "denied", label: "Denied" },
          ]}
        />
        <Segmented label="Period" value={range()} options={RANGES} onChange={setRange} />
        <TextField
          frameClass="dg-mcp-search dg-grow"
          placeholder="Search SQL, tools, errors"
          aria-label="Search the log"
          value={text()}
          onInput={setText}
          prefix={<Icon name="search" />}
          suffix={
            <Show when={text()}>
              <button type="button" class="dg-mcp-iconbtn" aria-label="Clear the search" onClick={() => setText("")}>
                <Icon name="close-small" />
              </button>
            </Show>
          }
          onKeyDown={(e) => {
            if (e.key === "Escape" && text()) {
              e.stopPropagation();
              setText("");
            }
          }}
        />
        <Button class="dg-mcp-danger" disabled={!feed.entries().length && !filtered()} onClick={() => void clear()}>
          Clear log
        </Button>
      </div>
      <div class="dg-mcp-scroll dg-mcp-log-scroll" ref={scroller} data-focus-target tabindex={-1}>
        <Show when={!feed.loading()} fallback={<Loading />}>
          <Show when={!feed.error()} fallback={<EmptyState icon="error" title="Cannot read the log">{feed.error()}</EmptyState>}>
            <Show
              when={feed.entries().length}
              fallback={
                <Show
                  when={filtered()}
                  fallback={
                    <EmptyState icon="history" title="Nothing logged yet">
                      Every tool call of an agent is recorded here: the SQL it ran, the rows it got back, what it changed and what was refused.
                    </EmptyState>
                  }
                >
                  <EmptyState icon="filter" title="No entries match the filters" actions={<Button onClick={reset}>Reset filters</Button>}>
                    Try another period or search text.
                  </EmptyState>
                </Show>
              }
            >
              <For each={dayKeys()}>
                {(k) => {
                  const items = createMemo(() => feed.entries().filter((e) => dayKey(e.tsMs) === k));
                  return (
                    <section class="dg-mcp-daygroup">
                      <h4 class="dg-mcp-day dg-sticky">
                        <span>{dayLabel(items()[0]?.tsMs ?? 0, now())}</span>
                        <span class="dg-mcp-count">{items().length}</span>
                      </h4>
                      <For each={items()}>{(e) => <EntryRow entry={e} open={open().has(e.id)} onToggle={() => toggle(e.id)} onOpenSession={openSession} fresh={fresh.has(e.id)} />}</For>
                    </section>
                  );
                }}
              </For>
              <div class="dg-mcp-more-row">
                <Show
                  when={feed.hasMore()}
                  fallback={<span class="dg-mcp-muted">That is everything in this period.</span>}
                >
                  <Button class="dg-mcp-small" disabled={feed.loadingMore()} onClick={feed.loadMore}>
                    {feed.loadingMore() ? "Loading…" : "Load older"}
                  </Button>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      <footer class="dg-mcp-logfoot">
        <Icon name="history" />
        <span>
          {plural(feed.entries().length, "entry", "entries")}
          {feed.hasMore() ? "+" : ""} shown. Entries are kept for {status()?.logRetentionDays ?? RETENTION_DAYS} days, then removed.
        </span>
      </footer>
    </div>
  );
}
