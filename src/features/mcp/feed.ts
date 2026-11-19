/**
 * A live list of log entries for one query: loads the newest page, pages older ones, and puts the entries that arrive
 * while it is open at the front when they match the query. Entries are kept newest first.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { mcpLog } from "../../api/db";
import type { McpLogEntry, McpLogQuery } from "../../api/types";
import { capEntries, entryMatches, mergeNewest, mergeOlder } from "./model";
import { onMcpEntry, onMcpLogReset } from "./store";

export const PAGE_SIZE = 200;
/** Newest entries kept in memory while the user has not paged back (a view left open for days must not grow without end). */
export const MAX_LIVE_ENTRIES = 2000;

export interface LogFeed {
  entries: Accessor<McpLogEntry[]>;
  loading: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  /** An older page may exist. */
  hasMore: Accessor<boolean>;
  error: Accessor<string | null>;
  loadMore: () => void;
  reload: () => void;
}

export interface LogFeedOptions {
  /** Called right before / after a live entry is added, so the list can keep its scroll position. */
  onLive?: (phase: "before" | "after", entry: McpLogEntry) => void;
}

export function createLogFeed(query: Accessor<McpLogQuery>, opts: LogFeedOptions = {}): LogFeed {
  const [entries, setEntries] = createSignal<McpLogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let gen = 0;
  /** Entries that arrived while the first page was loading: the page was read before them, they are merged into it. */
  let buffer: McpLogEntry[] = [];
  let paged = false;

  const key = createMemo(() => JSON.stringify(query()));

  async function load(): Promise<void> {
    const g = ++gen;
    buffer = [];
    paged = false;
    setLoading(true);
    setError(null);
    try {
      const page = await mcpLog({ ...untrack(query), limit: PAGE_SIZE, beforeTsMs: undefined });
      if (g !== gen) return;
      setEntries(mergeNewest(page, buffer));
      setHasMore(page.length >= PAGE_SIZE);
    } catch (e) {
      if (g !== gen) return;
      setEntries([]);
      setHasMore(false);
      setError(String((e as Error)?.message ?? e));
    } finally {
      if (g === gen) {
        buffer = [];
        setLoading(false);
      }
    }
  }

  async function more(): Promise<void> {
    const last = untrack(entries).at(-1);
    if (!last || untrack(loadingMore) || !untrack(hasMore)) return;
    const g = gen;
    setLoadingMore(true);
    try {
      // the backend returns entries strictly older than `beforeTsMs`: +1 keeps the ones that share the last timestamp (merge drops the ones already shown)
      const page = await mcpLog({ ...untrack(query), limit: PAGE_SIZE, beforeTsMs: last.tsMs + 1 });
      if (g !== gen) return;
      paged = true;
      setEntries((l) => mergeOlder(l, page));
      setHasMore(page.length >= PAGE_SIZE);
    } catch (e) {
      if (g === gen) setError(String((e as Error)?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  createEffect(on(key, () => void load()));

  const offEntry = onMcpEntry((e) => {
    if (!entryMatches(untrack(query), e)) return;
    if (untrack(loading)) {
      buffer.push(e);
      return;
    }
    opts.onLive?.("before", e);
    setEntries((l) => (paged ? mergeNewest(l, [e]) : capEntries(mergeNewest(l, [e]), MAX_LIVE_ENTRIES)));
    opts.onLive?.("after", e);
  });
  const offReset = onMcpLogReset(() => void load());
  onCleanup(() => {
    gen++;
    offEntry();
    offReset();
  });

  return { entries, loading, loadingMore, hasMore, error, loadMore: () => void more(), reload: () => void load() };
}

/** Ids of the entries that just arrived (their row flashes once); each one is forgotten after the animation. */
export function createFresh(ms = 2600): { has: (id: string) => boolean; add: (id: string) => void } {
  const [ids, setIds] = createSignal<ReadonlySet<string>>(new Set());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => timers.forEach(clearTimeout));
  return {
    has: (id) => ids().has(id),
    add: (id) => {
      setIds((s) => new Set(s).add(id));
      const t = setTimeout(() => {
        timers.delete(t);
        setIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }, ms);
      timers.add(t);
    },
  };
}
