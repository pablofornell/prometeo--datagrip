// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { McpLogEntry } from "../../api/types";

const api = vi.hoisted(() => ({ mcpLog: vi.fn() }));
vi.mock("../../api/db", () => api);
const bus = vi.hoisted(() => ({ entry: new Set<(e: unknown) => void>(), reset: new Set<() => void>() }));
vi.mock("./store", () => ({
  onMcpEntry: (cb: (e: never) => void) => {
    bus.entry.add(cb as (e: unknown) => void);
    return () => bus.entry.delete(cb as (e: unknown) => void);
  },
  onMcpLogReset: (cb: () => void) => {
    bus.reset.add(cb);
    return () => bus.reset.delete(cb);
  },
}));

import { MAX_LIVE_ENTRIES, PAGE_SIZE, createLogFeed } from "./feed";

const entry = (id: string, tsMs: number, p: Partial<McpLogEntry> = {}): McpLogEntry => ({
  id,
  tsMs,
  sessionId: "s",
  clientName: "c",
  kind: "tool",
  tool: "run_query",
  dataSourceId: "a",
  dataSourceName: null,
  sql: null,
  args: null,
  status: "ok",
  error: null,
  elapsedMs: 1,
  rowCount: null,
  rowsAffected: null,
  truncated: false,
  preview: null,
  summary: "",
  ...p,
});
const emit = (e: McpLogEntry) => bus.entry.forEach((cb) => cb(e));
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.mcpLog.mockReset();
  bus.entry.clear();
  bus.reset.clear();
});

describe("log feed", () => {
  it("keeps an entry that arrives while the first page is loading", async () => {
    let resolve!: (l: McpLogEntry[]) => void;
    api.mcpLog.mockReturnValueOnce(new Promise<McpLogEntry[]>((r) => (resolve = r)));
    await createRoot(async (dispose) => {
      const feed = createLogFeed(() => ({}));
      await tick();
      expect(feed.loading()).toBe(true);
      emit(entry("live", 500));
      resolve([entry("old2", 200), entry("old1", 100)]);
      await tick();
      expect(feed.loading()).toBe(false);
      expect(feed.entries().map((e) => e.id)).toEqual(["live", "old2", "old1"]);
      dispose();
    });
  });

  it("does not keep an entry that arrived for a load that was replaced by another query", async () => {
    api.mcpLog.mockResolvedValue([]);
    await createRoot(async (dispose) => {
      const feed = createLogFeed(() => ({}));
      await tick();
      emit(entry("x", 1));
      await tick();
      feed.reload();
      await tick();
      expect(feed.entries().map((e) => e.id)).toEqual([]);
      dispose();
    });
  });

  it("pages with beforeTsMs + 1 so entries that share the last timestamp are not lost", async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) => entry("n" + i, 1000 - Math.floor(i / 2))); // pairs of equal timestamps
    const lastTs = first.at(-1)!.tsMs;
    // the entry that sat beyond the page limit at the same timestamp, then older ones
    const second = [first.at(-1)!, entry("shared", lastTs), entry("older", lastTs - 5)];
    api.mcpLog.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await createRoot(async (dispose) => {
      const feed = createLogFeed(() => ({}));
      await tick();
      expect(feed.hasMore()).toBe(true);
      feed.loadMore();
      await tick();
      expect(api.mcpLog.mock.calls[1][0].beforeTsMs).toBe(lastTs + 1);
      const ids = feed.entries().map((e) => e.id);
      expect(ids).toContain("shared");
      expect(ids).toContain("older");
      expect(new Set(ids).size).toBe(ids.length); // no duplicate of the entry that came twice
      expect(ids.length).toBe(PAGE_SIZE + 2);
      dispose();
    });
  });

  it("applies live entries that match the query, newest first, and ignores the others", async () => {
    api.mcpLog.mockResolvedValue([entry("old", 100)]);
    await createRoot(async (dispose) => {
      const feed = createLogFeed(() => ({ status: "error" }));
      await tick();
      emit(entry("fine", 200)); // status ok: not part of this list
      emit(entry("bad", 300, { status: "error" }));
      expect(feed.entries().map((e) => e.id)).toEqual(["bad", "old"]);
      dispose();
    });
  });

  it("keeps the newest 2000 entries unless the user paged back", async () => {
    api.mcpLog.mockResolvedValue([]);
    await createRoot(async (dispose) => {
      const feed = createLogFeed(() => ({}));
      await tick();
      for (let i = 0; i < MAX_LIVE_ENTRIES + 50; i++) emit(entry("e" + i, 1000 + i));
      expect(feed.entries().length).toBe(MAX_LIVE_ENTRIES);
      expect(feed.entries()[0].id).toBe("e" + (MAX_LIVE_ENTRIES + 49));
      dispose();
    });
  });

  it("stops listening when its owner is disposed", async () => {
    api.mcpLog.mockResolvedValue([]);
    await createRoot(async (dispose) => {
      createLogFeed(() => ({}));
      await tick();
      expect(bus.entry.size).toBe(1);
      dispose();
    });
    expect(bus.entry.size).toBe(0);
  });
});
