// Browser mock of the MCP commands (docs/MCP.md): a server that can be switched on, two weeks of demo sessions (reads, a
// write, a denied call, an error) and, while it runs and somebody is subscribed, a new action about every 20 s.

import { effectivePerm, entryMatches } from "../features/mcp/model";
import type { DataSource, McpEvent, McpLogEntry, McpPerm, McpPolicy, McpPolicyInput, McpSession, McpStatus } from "./types";
import type { MockHandler } from "./tauri";

interface Deps {
  sources: () => DataSource[];
  load: <T>(key: string, fallback: T) => T;
  save: (key: string, value: unknown) => void;
}

interface Saved {
  enabled: boolean;
  port: number;
  token: string;
  policy: McpPolicyInput;
}

type Sink = { onmessage?: (e: McpEvent) => void };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ORDERS_PREVIEW = {
  columns: ["id", "customer_id", "status", "total"],
  rows: [
    ["10482", "311", "paid", "129.90"],
    ["10481", "87", "paid", "54.00"],
    ["10480", "311", "shipped", "310.25"],
    ["10479", "1204", "pending", "19.99"],
    ["10478", "56", "cancelled", "76.40"],
  ],
};

const rand = (n: number) => Math.floor(Math.random() * n);
const hex = (n: number) => Array.from({ length: n }, () => rand(16).toString(16)).join("");

export function mcpMockHandlers({ sources, load, save }: Deps): Record<string, MockHandler> {
  const saved = load<Saved>("mcp", { enabled: false, port: 7311, token: "", policy: { folderRules: {}, sourceRules: {}, groups: {} } });
  let startedAtMs: number | null = null;
  let error: string | null = null;
  let seq = 0;
  const subs = new Map<number, Sink>();
  let timer = 0;

  const persist = () => save("mcp", saved);
  const dsName = (id: string | null) => sources().find((s) => s.id === id)?.name ?? null;

  // ---- demo data, relative to now
  const log: McpLogEntry[] = [];
  const sessions: McpSession[] = [];

  const add = (s: McpSession, ago: number, tool: string, patch: Partial<McpLogEntry>): McpLogEntry => {
    const e: McpLogEntry = {
      id: `e${++seq}-${hex(4)}`,
      tsMs: Date.now() - ago,
      sessionId: s.id,
      clientName: s.clientName,
      kind: tool === "initialize" || tool === "end" ? "session" : "tool",
      tool,
      dataSourceId: null,
      dataSourceName: null,
      sql: null,
      args: null,
      status: "ok",
      error: null,
      elapsedMs: 4 + rand(40),
      rowCount: null,
      rowsAffected: null,
      truncated: false,
      preview: null,
      summary: "",
      ...patch,
    };
    if (e.dataSourceId && !e.dataSourceName) e.dataSourceName = dsName(e.dataSourceId);
    log.push(e);
    if (e.kind === "tool") {
      s.actionCount++;
      if (e.status !== "ok") s.errorCount++;
      if (e.tool === "execute_statement") s.writeCount++;
      if (e.dataSourceId && !s.dataSourceIds.includes(e.dataSourceId)) s.dataSourceIds.push(e.dataSourceId);
    }
    s.lastSeenMs = Math.max(s.lastSeenMs, e.tsMs);
    return e;
  };

  const newSession = (clientName: string, clientVersion: string | null, ago: number, active: boolean): McpSession => {
    const s: McpSession = { id: `s-${hex(8)}`, clientName, clientVersion, startedAtMs: Date.now() - ago, lastSeenMs: Date.now() - ago, active, actionCount: 0, errorCount: 0, writeCount: 0, dataSourceIds: [] };
    sessions.push(s);
    add(s, ago, "initialize", { summary: `${clientName}${clientVersion ? " " + clientVersion : ""} connected`, elapsedMs: 3 });
    return s;
  };

  function seed(): void {
    const ids = sources().map((s) => s.id);
    const a = ids[0] ?? "ds-shop";
    const b = ids[1] ?? a;
    const c = ids[2] ?? b;

    const s1 = newSession("claude-code", "2.1.1", 38 * MIN, true);
    add(s1, 37 * MIN, "list_data_sources", { summary: `Listed ${Math.max(1, Math.min(3, ids.length))} data sources`, rowCount: Math.max(1, Math.min(3, ids.length)) });
    add(s1, 36 * MIN, "list_schemas", { dataSourceId: a, summary: "Listed 3 schemas", rowCount: 3 });
    add(s1, 35 * MIN, "list_tables", { dataSourceId: a, args: { schema: "public" }, summary: "Listed 12 tables in public", rowCount: 12 });
    add(s1, 34 * MIN, "describe_table", { dataSourceId: a, args: { table: "orders", schema: "public" }, summary: "Described public.orders (9 columns)", rowCount: 9 });
    add(s1, 31 * MIN, "run_query", {
      dataSourceId: a,
      sql: "SELECT status, count(*) AS orders, sum(total) AS revenue\nFROM public.orders\nWHERE created_at >= now() - interval '7 days'\nGROUP BY status\nORDER BY orders DESC",
      summary: "Returned 4 rows from orders",
      rowCount: 4,
      elapsedMs: 42,
      preview: {
        columns: ["status", "orders", "revenue"],
        rows: [
          ["paid", "318", "28104.50"],
          ["shipped", "122", "11950.20"],
          ["pending", "47", "3980.00"],
          ["cancelled", "9", "612.30"],
        ],
      },
    });
    add(s1, 27 * MIN, "run_query", {
      dataSourceId: a,
      sql: "SELECT * FROM public.order_items WHERE order_id = 10480",
      status: "error",
      error: 'relation "public.order_items" does not exist (position 15)',
      summary: "Query failed",
      elapsedMs: 9,
    });
    add(s1, 24 * MIN, "run_query", {
      dataSourceId: a,
      sql: "SELECT id, customer_id, status, total\nFROM public.orders\nORDER BY id DESC\nLIMIT 200",
      summary: "Returned 200 rows from orders (cut at 20 in the log)",
      rowCount: 200,
      truncated: true,
      elapsedMs: 118,
      preview: ORDERS_PREVIEW,
    });
    add(s1, 19 * MIN, "run_query", {
      dataSourceId: c,
      sql: "SELECT * FROM billing.invoices WHERE paid = false",
      status: "denied",
      error: "No read access to this data source. Grant it in Prometeo DataGrip: MCP > Permissions.",
      summary: "Denied: no read permission",
      elapsedMs: 1,
    });
    add(s1, 12 * MIN, "execute_statement", {
      dataSourceId: a,
      sql: "UPDATE public.orders\nSET status = 'cancelled'\nWHERE status = 'pending'\n  AND created_at < now() - interval '30 days'",
      summary: "Updated 3 rows in orders",
      rowsAffected: 3,
      elapsedMs: 21,
    });
    add(s1, 11 * MIN + 30_000, "run_query", {
      dataSourceId: a,
      sql: "SELECT id, status FROM public.orders WHERE status = 'cancelled' ORDER BY id DESC LIMIT 5",
      summary: "Returned 5 rows from orders",
      rowCount: 5,
      elapsedMs: 11,
      preview: { columns: ["id", "status"], rows: [["10478", "cancelled"], ["10312", "cancelled"], ["10300", "cancelled"], ["10211", "cancelled"], ["10190", "cancelled"]] },
    });
    add(s1, 40_000, "run_query", {
      dataSourceId: b,
      sql: "SELECT count(*) AS customers FROM customers",
      summary: "Returned 1 row from customers",
      rowCount: 1,
      elapsedMs: 7,
      preview: { columns: ["customers"], rows: [["1473"]] },
    });

    const s2 = newSession("claude-code", "2.0.8", 26 * HOUR, false);
    add(s2, 26 * HOUR - 2 * MIN, "list_tables", { dataSourceId: a, summary: "Listed 12 tables in public", rowCount: 12 });
    add(s2, 26 * HOUR - 4 * MIN, "describe_table", { dataSourceId: a, args: { table: "customers" }, summary: "Described public.customers (7 columns)", rowCount: 7 });
    add(s2, 26 * HOUR - 6 * MIN, "run_query", {
      dataSourceId: a,
      sql: "SELECT c.name, count(o.id) AS orders\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nORDER BY orders DESC\nLIMIT 10",
      summary: "Returned 10 rows",
      rowCount: 10,
      elapsedMs: 64,
      preview: { columns: ["name", "orders"], rows: [["Ada Lovelace", "41"], ["Alan Turing", "37"], ["Grace Hopper", "29"]] },
    });
    add(s2, 26 * HOUR - 9 * MIN, "execute_statement", {
      dataSourceId: a,
      sql: "DELETE FROM public.sessions WHERE expires_at < now()",
      status: "denied",
      error: "No write access to this data source. Grant it in Prometeo DataGrip: MCP > Permissions.",
      summary: "Denied: no write permission",
      elapsedMs: 1,
    });
    add(s2, 26 * HOUR - 12 * MIN, "end", { summary: "Session ended" });

    const s3 = newSession("mcp-inspector", "0.16.2", 4 * DAY + 3 * HOUR, false);
    add(s3, 4 * DAY + 3 * HOUR - MIN, "list_data_sources", { summary: "Listed 1 data source", rowCount: 1 });
    add(s3, 4 * DAY + 3 * HOUR - 2 * MIN, "run_query", {
      dataSourceId: a,
      sql: "SELECT 1",
      summary: "Returned 1 row",
      rowCount: 1,
      elapsedMs: 2,
      preview: { columns: ["?column?"], rows: [["1"]] },
    });
    add(s3, 4 * DAY + 3 * HOUR - 3 * MIN, "end", { summary: "Session ended" });

    log.sort((x, y) => y.tsMs - x.tsMs);
    sessions.sort((x, y) => y.lastSeenMs - x.lastSeenMs);
  }
  seed();

  // ---- status / events
  const running = () => saved.enabled && error === null;
  const status = (): McpStatus => ({
    enabled: saved.enabled,
    running: running(),
    port: saved.port,
    endpoint: `http://127.0.0.1:${saved.port}/mcp`,
    token: saved.token,
    error,
    startedAtMs,
    activeSessions: running() ? sessions.filter((s) => s.active).length : 0,
    logRetentionDays: 30,
  });
  const emit = (e: McpEvent) => {
    for (const s of subs.values()) s.onmessage?.(e);
  };

  const live = () => {
    const s = sessions.find((x) => x.active);
    if (!running() || !s || !subs.size) return;
    const dsId = sources()[0]?.id ?? "ds-shop";
    const queries = [
      { sql: "SELECT count(*) FROM public.orders WHERE status = 'paid'", rows: 1, pv: { columns: ["count"], rows: [[String(300 + rand(40))]] } },
      { sql: "SELECT id, total FROM public.orders ORDER BY total DESC LIMIT 3", rows: 3, pv: { columns: ["id", "total"], rows: [["10211", "980.00"], ["10388", "845.10"], ["10102", "790.00"]] } },
    ];
    const q = queries[rand(queries.length)];
    const e = add(s, 0, "run_query", { dataSourceId: dsId, sql: q.sql, summary: `Returned ${q.rows} row${q.rows === 1 ? "" : "s"}`, rowCount: q.rows, preview: q.pv });
    log.sort((x, y) => y.tsMs - x.tsMs);
    emit({ type: "entry", entry: e });
    emit({ type: "status", status: status() });
  };
  const ensureTimer = () => {
    if (!timer) timer = window.setInterval(live, 20_000);
  };

  const policyOut = (): McpPolicy => ({
    ...saved.policy,
    effective: Object.fromEntries(sources().map((s) => [s.id, effectivePerm(s, saved.policy)])),
  });

  const h = (f: (a: Record<string, unknown>) => unknown): MockHandler => (args) => f(args ?? {});

  return {
    mcp_status: h(() => status()),
    mcp_configure: h((a) => {
      saved.enabled = !!a.enabled;
      saved.port = Number(a.port) || 7311;
      if (saved.enabled && !saved.token) saved.token = `pdg_${hex(40)}`;
      // the demo "port 8080 is in use" case, to see the error state
      error = saved.enabled && saved.port === 8080 ? "Port 8080 is in use" : null;
      startedAtMs = running() ? Date.now() : null;
      persist();
      emit({ type: "status", status: status() });
      return status();
    }),
    mcp_regenerate_token: h(() => {
      saved.token = `pdg_${hex(40)}`;
      persist();
      emit({ type: "status", status: status() });
      return status();
    }),
    mcp_get_policy: h(() => policyOut()),
    mcp_set_policy: h((a) => {
      const p = a.policy as McpPolicyInput;
      const clean = (r: Record<string, McpPerm>) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, { read: !!v.read, write: !!v.write }]));
      saved.policy = { folderRules: clean(p.folderRules), sourceRules: clean(p.sourceRules), groups: { ...(p.groups ?? {}) } };
      persist();
      return policyOut();
    }),
    mcp_sessions: h(() => structuredClone(sessions).sort((x, y) => y.lastSeenMs - x.lastSeenMs)),
    mcp_log: h((a) => {
      const q = (a.query ?? {}) as Parameters<typeof entryMatches>[0] & { limit?: number; beforeTsMs?: number };
      const limit = Math.min(1000, q.limit ?? 200);
      return structuredClone(
        log
          .filter((e) => entryMatches(q, e) && (q.beforeTsMs == null || e.tsMs < q.beforeTsMs))
          .sort((x, y) => y.tsMs - x.tsMs)
          .slice(0, limit),
      );
    }),
    mcp_clear_log: h(() => {
      log.length = 0;
      sessions.length = 0;
      emit({ type: "sessions" });
      return null;
    }),
    mcp_subscribe: h((a) => {
      const id = ++seq;
      subs.set(id, a.onEvent as Sink);
      ensureTimer();
      return id;
    }),
    mcp_unsubscribe: h((a) => {
      subs.delete(a.id as number);
      return null;
    }),
  };
}
