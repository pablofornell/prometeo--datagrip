/** Pure logic of the MCP view: install snippets, permission rules and their display, day grouping, log filters, formatting. */
import type { McpEffectivePerm, McpLogEntry, McpLogQuery, McpLogStatus, McpPerm, McpPolicyInput, McpSession } from "../../api/types";

export const SERVER_NAME = "prometeo-datagrip";
export const DEFAULT_PORT = 7311;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const RETENTION_DAYS = 30;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- install snippets

export const MASK = "••••••••";

/** `abcd••••••••wxyz`: enough to recognise a token, not enough to use it. */
export const maskToken = (token: string): string => (token.length > 12 ? token.slice(0, 4) + MASK + token.slice(-4) : MASK);

/** A piece of a code sample with its role, for the colors of the code block. */
export interface CodePart {
  text: string;
  cls?: "cmd" | "flag" | "str" | "url" | "key" | "punct";
}

/** The one-line `claude mcp add` command (a single line runs the same in bash, PowerShell and cmd), in colored pieces. */
export const claudeCommandParts = (endpoint: string, token: string): CodePart[] => [
  { text: "claude mcp add", cls: "cmd" },
  { text: " " },
  { text: "--transport", cls: "flag" },
  { text: ` http ${SERVER_NAME} ` },
  { text: endpoint, cls: "url" },
  { text: " " },
  { text: "--header", cls: "flag" },
  { text: " " },
  { text: `"Authorization: Bearer ${token}"`, cls: "str" },
];

/** Read-only is a read-only connection where the database has one; the hard guarantee is the database user. */
export const READ_ONLY_NOTE =
  "Read-only is enforced by a read-only connection on PostgreSQL, MySQL and SQLite, but on Oracle it is a check made by the app, and a function with side effects can still write: for a hard guarantee, connect with a database user that only has SELECT rights.";

export const claudeCommand = (endpoint: string, token: string): string => claudeCommandParts(endpoint, token).map((p) => p.text).join("");

/** The project `.mcp.json` entry. */
export const mcpJson = (endpoint: string, token: string): string =>
  JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

/** Pieces of a JSON text: keys, string values and punctuation (numbers and literals stay plain). */
export function jsonParts(text: string): CodePart[] {
  const out: CodePart[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\],:]/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    if (m[1]) {
      out.push({ text: m[1], cls: m[2] ? "key" : "str" });
      if (m[2]) out.push({ text: m[2], cls: "punct" });
    } else out.push({ text: m[0], cls: "punct" });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Valid listener port typed by the user (the backend runs unprivileged: no ports below 1024). */
export const parsePort = (text: string): number | null => {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_PORT && n <= MAX_PORT ? n : null;
};

// ---------------------------------------------------------------- permissions

export const NO_PERM: McpPerm = { read: false, write: false };
export const emptyPolicy = (): McpPolicyInput => ({ folderRules: {}, sourceRules: {}, groups: {} });

/** What the policy needs to know about a data source. */
export interface PermSource {
  id: string;
  name: string;
  driver?: string;
  color?: string | null;
  readOnly: boolean;
}

/**
 * The permission a data source ends up with (docs/MCP.md): its own rule wins over the one of its folder, no rule is no access,
 * and a read-only data source never gets write.
 */
export function effectivePerm(src: Pick<PermSource, "id" | "readOnly">, p: McpPolicyInput): McpEffectivePerm {
  const own = p.sourceRules[src.id];
  const folder = p.groups[src.id];
  const inherited = folder !== undefined ? p.folderRules[folder] : undefined;
  const rule = own ?? inherited;
  const origin = own ? "source" : inherited ? "folder" : "none";
  const wanted = !!rule?.write;
  return { read: !!rule?.read, write: wanted && !src.readOnly, origin, readOnlySource: wanted && src.readOnly };
}

export type Exposure = "none" | "read" | "write" | "readwrite";
export const exposureOf = (e: McpPerm): Exposure => (e.read && e.write ? "readwrite" : e.read ? "read" : e.write ? "write" : "none");

/** `true` when both flags are off: the rule is the same as none, but as a data source rule it still overrides the folder. */
export const isDenyAll = (p: McpPerm): boolean => !p.read && !p.write;

export function setSourceRule(p: McpPolicyInput, id: string, rule: McpPerm | null): McpPolicyInput {
  const sourceRules = { ...p.sourceRules };
  if (rule) sourceRules[id] = { read: rule.read, write: rule.write };
  else delete sourceRules[id];
  return { ...p, sourceRules };
}

/** A folder rule with both flags off is the same as no rule (a folder has nothing to override), so it is dropped. */
export function setFolderRule(p: McpPolicyInput, folder: string, rule: McpPerm | null): McpPolicyInput {
  const folderRules = { ...p.folderRules };
  if (rule && !isDenyAll(rule)) folderRules[folder] = { read: rule.read, write: rule.write };
  else delete folderRules[folder];
  return { ...p, folderRules };
}

/** Flips one flag of a permission. */
export const toggled = (perm: McpPerm, flag: "read" | "write"): McpPerm => ({ ...perm, [flag]: !perm[flag] });

export type FolderChange = { type: "rename"; from: string; to: string } | { type: "remove"; name: string };

/**
 * A renamed folder keeps its rule under the new name, a removed one loses it. A rule that already sits under the target name
 * of a rename belongs to an older folder of that name: it never carries over to the folder that now has the name.
 */
export function migrateFolderRules(rules: Record<string, McpPerm>, change: FolderChange): Record<string, McpPerm> {
  const out = { ...rules };
  if (change.type === "remove") {
    delete out[change.name];
  } else if (change.to !== change.from) {
    if (change.from in out) out[change.to] = out[change.from];
    else delete out[change.to];
    delete out[change.from];
  }
  return out;
}

/** Drops the rules of folders that do not exist (any more): a new folder with that name must not inherit them. */
export function pruneFolderRules(rules: Record<string, McpPerm>, folders: string[]): Record<string, McpPerm> {
  const known = new Set(folders);
  const keep = Object.entries(rules).filter(([f]) => known.has(f));
  return keep.length === Object.keys(rules).length ? rules : Object.fromEntries(keep);
}

const samePerm = (a: McpPerm | undefined, b: McpPerm | undefined): boolean => !!a === !!b && (!a || (a.read === b!.read && a.write === b!.write));
const sameRules = (a: Record<string, McpPerm>, b: Record<string, McpPerm>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => samePerm(a[k], b[k]));
};

/** Same rules and same folder membership. */
export const samePolicy = (a: McpPolicyInput, b: McpPolicyInput): boolean =>
  sameRules(a.folderRules, b.folderRules) && sameRules(a.sourceRules, b.sourceRules) && sameGroups(a.groups, b.groups);

/** Does the change take access away from any data source (`ids`)? Those changes are pushed at once, not after the debounce. */
export function reducesAccess(prev: McpPolicyInput, next: McpPolicyInput, ids: string[]): boolean {
  const all = new Set([...ids, ...Object.keys(prev.sourceRules), ...Object.keys(next.sourceRules), ...Object.keys(prev.groups), ...Object.keys(next.groups)]);
  for (const id of all) {
    const a = effectivePerm({ id, readOnly: false }, prev);
    const b = effectivePerm({ id, readOnly: false }, next);
    if ((a.read && !b.read) || (a.write && !b.write)) return true;
  }
  return false;
}

/**
 * What the screen says agents can do while the rules are not (yet) saved: never less than the backend still allows. Once saved
 * both are the same.
 */
export function mergeEffective(local: McpEffectivePerm, backend: McpEffectivePerm | undefined): McpEffectivePerm {
  if (!backend) return local;
  return { ...local, read: local.read || backend.read, write: local.write || backend.write };
}

/** Data source id -> folder, for the data sources that sit in one (what the backend needs to apply the folder rules). */
export function groupsOf(ids: string[], groupOf: (id: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const g = groupOf(id);
    if (g !== undefined) out[id] = g;
  }
  return out;
}

/** Same keys with the same values, whatever their order. */
export function sameGroups(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export interface PermRow {
  src: PermSource;
  eff: McpEffectivePerm;
  /** The data source has a rule of its own (an override of its folder's). */
  own: McpPerm | undefined;
}

export interface PermGroup {
  /** `null`: the data sources outside every folder. */
  folder: string | null;
  rule: McpPerm | undefined;
  rows: PermRow[];
  /** Number of data sources of the folder before the filter. */
  total: number;
}

const has = (text: string, q: string): boolean => text.toLowerCase().includes(q);

/**
 * The rows of the permission matrix: one group per folder (also the empty ones, they can carry a rule) and one for the data
 * sources outside every folder. The filter keeps the data sources whose name matches (all of a folder whose name matches).
 * `eff` says what each data source can do (default: derived from the rules).
 */
export function permissionGroups(sources: PermSource[], folders: string[], p: McpPolicyInput, filter = "", eff: (src: PermSource) => McpEffectivePerm = (src) => effectivePerm(src, p)): PermGroup[] {
  const q = filter.trim().toLowerCase();
  const rowOf = (src: PermSource): PermRow => ({ src, eff: eff(src), own: p.sourceRules[src.id] });
  const byName = (a: PermSource, b: PermSource) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const inFolder = (f: string) => sources.filter((s) => p.groups[s.id] === f);
  const groups: PermGroup[] = [];
  for (const f of folders) {
    const all = inFolder(f).sort(byName);
    const rows = (!q || has(f, q) ? all : all.filter((s) => has(s.name, q))).map(rowOf);
    if (q && !rows.length && !has(f, q)) continue;
    groups.push({ folder: f, rule: p.folderRules[f], rows, total: all.length });
  }
  const known = new Set(folders);
  const loose = sources.filter((s) => !known.has(p.groups[s.id] ?? "")).sort(byName);
  const rows = (q ? loose.filter((s) => has(s.name, q)) : loose).map(rowOf);
  if (rows.length) groups.push({ folder: null, rule: undefined, rows, total: loose.length });
  return groups;
}

export interface ExposureSummary {
  total: number;
  none: number;
  read: number;
  write: number;
  readwrite: number;
  /** Data sources an agent can see at all. */
  exposed: number;
}

export function summarize(rows: Pick<PermRow, "eff">[]): ExposureSummary {
  const s: ExposureSummary = { total: rows.length, none: 0, read: 0, write: 0, readwrite: 0, exposed: 0 };
  for (const r of rows) s[exposureOf(r.eff)]++;
  s.exposed = s.total - s.none;
  return s;
}

export function summarizeSources(sources: PermSource[], p: McpPolicyInput): ExposureSummary {
  return summarize(sources.map((src) => ({ eff: effectivePerm(src, p) })));
}

/** Where the permission of a data source comes from, as the matrix says it. */
export function originLabel(row: PermRow, folder: string | null): string {
  if (row.src.readOnly && row.eff.readOnlySource) return "read-only data source";
  if (row.eff.origin === "source") return isDenyAll(row.own ?? NO_PERM) ? "blocked here" : "own rule";
  if (row.eff.origin === "folder") return `from ${folder ?? "folder"}`;
  return "no rule";
}

// ---------------------------------------------------------------- tools

export type ToolKind = "read" | "write" | "meta" | "session";
export interface ToolMeta {
  label: string;
  icon: string;
  kind: ToolKind;
}

const TOOLS: Record<string, ToolMeta> = {
  list_data_sources: { label: "List data sources", icon: "dg/dbms", kind: "meta" },
  list_schemas: { label: "List schemas", icon: "dg/schema", kind: "read" },
  list_tables: { label: "List tables", icon: "dg/table", kind: "read" },
  describe_table: { label: "Describe table", icon: "dg/column", kind: "read" },
  run_query: { label: "Run query", icon: "dg/sql", kind: "read" },
  execute_statement: { label: "Execute statement", icon: "dg/submit", kind: "write" },
  initialize: { label: "Session started", icon: "dg/console-run", kind: "session" },
  end: { label: "Session ended", icon: "stop", kind: "session" },
};

export function toolMeta(tool: string): ToolMeta {
  return TOOLS[tool] ?? { label: tool, icon: "dg/routine", kind: "read" };
}

/** The kind that styles an entry: what the call was, not how it ended. */
export const entryKind = (e: Pick<McpLogEntry, "kind" | "tool">): ToolKind => (e.kind === "session" ? "session" : toolMeta(e.tool).kind);

export const STATUS_LABEL: Record<McpLogStatus, string> = { ok: "OK", error: "Error", denied: "Denied" };

/** `12 rows`, `3 rows affected`, `20+ rows` (cut): the outcome of a call in a few characters; null when there is nothing to say. */
export function outcomeText(e: Pick<McpLogEntry, "status" | "rowCount" | "rowsAffected" | "truncated">): string | null {
  if (e.status !== "ok") return null;
  const n = (v: number, what: string) => `${v.toLocaleString("en-US")}${e.truncated ? "+" : ""} ${what}${v === 1 && !e.truncated ? "" : "s"}`;
  if (e.rowsAffected != null) return `${e.rowsAffected.toLocaleString("en-US")} row${e.rowsAffected === 1 ? "" : "s"} affected`;
  if (e.rowCount != null) return n(e.rowCount, "row");
  return null;
}

/** Does the entry have anything to show when it is opened? */
export const hasDetail = (e: McpLogEntry): boolean => !!(e.sql || e.error || e.preview || (e.args != null && JSON.stringify(e.args) !== "{}"));

// ---------------------------------------------------------------- the log

export type LogRange = "today" | "7d" | "30d";
export const RANGES: { id: LogRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

export const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Lower bound of the quick range. */
export function rangeSince(range: LogRange, now: number): number {
  return range === "today" ? startOfDay(now) : now - (range === "7d" ? 7 : RETENTION_DAYS) * DAY;
}

/** Does a live entry belong to the list the query describes? (the query minus its paging) */
export function entryMatches(q: McpLogQuery, e: McpLogEntry): boolean {
  if (q.sessionId && e.sessionId !== q.sessionId) return false;
  if (q.dataSourceId && e.dataSourceId !== q.dataSourceId) return false;
  if (q.status && e.status !== q.status) return false;
  if (q.sinceMs != null && e.tsMs < q.sinceMs) return false;
  if (q.untilMs != null && e.tsMs > q.untilMs) return false;
  const t = q.text?.trim().toLowerCase();
  if (t) {
    // the same fields the backend searches (log.rs): SQL, summary, tool and error
    const hay = [e.sql, e.summary, e.tool, e.error].filter(Boolean).join("\n").toLowerCase();
    if (!hay.includes(t)) return false;
  }
  return true;
}

/** Adds `fresh` (newest first) to the front of the list, without the entries it already holds. */
export function mergeNewest(list: McpLogEntry[], fresh: McpLogEntry[]): McpLogEntry[] {
  const seen = new Set(list.map((e) => e.id));
  const add = fresh.filter((e) => !seen.has(e.id));
  return add.length ? [...add, ...list].sort((a, b) => b.tsMs - a.tsMs) : list;
}

/** Keeps the newest `max` entries (the list is newest first). */
export const capEntries = (list: McpLogEntry[], max: number): McpLogEntry[] => (list.length > max ? list.slice(0, max) : list);

/** Adds an older page to the end of the list, without the entries it already holds. */
export function mergeOlder(list: McpLogEntry[], page: McpLogEntry[]): McpLogEntry[] {
  const seen = new Set(list.map((e) => e.id));
  return [...list, ...page.filter((e) => !seen.has(e.id))];
}

export interface DayGroup<T> {
  /** Local `YYYY-MM-DD`. */
  key: string;
  items: T[];
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(ms: number, now: number): string {
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return "Today";
  if (day === startOfDay(today - 12 * HOUR)) return "Yesterday";
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * Groups entries by local day, keeping their order (one group per run of the same day). The label of a day depends on the
 * clock (`dayLabel`), so it is not part of the group: the views key their sections by `key` and keep their rows when the
 * clock ticks or an entry arrives.
 */
export function groupByDay<T extends { tsMs: number }>(items: T[]): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const it of items) {
    const key = dayKey(it.tsMs);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, items: [it] });
  }
  return out;
}

// ---------------------------------------------------------------- sessions

export const sessionTitle = (s: Pick<McpSession, "clientName" | "clientVersion">): string => (s.clientVersion ? `${s.clientName} ${s.clientVersion}` : s.clientName);

/** A session counts as active for 10 minutes after it was last seen (the backend's `active` also knows about ended sessions). */
export const ACTIVE_MS = 10 * MIN;
export const sessionActive = (s: Pick<McpSession, "active" | "lastSeenMs">, now: number): boolean => s.active && now - s.lastSeenMs < ACTIVE_MS;

/** The fresh list, with the object of every session that did not change (so the views keep their rows). */
export function reuseSessions(old: McpSession[], fresh: McpSession[]): McpSession[] {
  const byId = new Map(old.map((s) => [s.id, s]));
  const same = (a: McpSession, b: McpSession) =>
    a.clientName === b.clientName &&
    a.clientVersion === b.clientVersion &&
    a.startedAtMs === b.startedAtMs &&
    a.lastSeenMs === b.lastSeenMs &&
    a.active === b.active &&
    a.actionCount === b.actionCount &&
    a.errorCount === b.errorCount &&
    a.writeCount === b.writeCount &&
    a.dataSourceIds.length === b.dataSourceIds.length &&
    a.dataSourceIds.every((x, i) => x === b.dataSourceIds[i]);
  return fresh.map((s) => {
    const o = byId.get(s.id);
    return o && same(o, s) ? o : s;
  });
}

/** The sessions that touched the data source (all of them without a filter). */
export const sessionsOfDataSource = (list: McpSession[], dsId: string | undefined): McpSession[] => (dsId ? list.filter((s) => s.dataSourceIds.includes(dsId)) : list);

/** Gap between two actions that is worth a mark in the timeline (the agent went away and came back). */
export const GAP_MS = 5 * MIN;
export const gapBetween = (earlier: number, later: number): number | null => (later - earlier >= GAP_MS ? later - earlier : null);

// ---------------------------------------------------------------- formatting

const pad = (n: number) => String(n).padStart(2, "0");

/** `14:32:07` in local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `12 ms`, `1.4 s`, `2 min 5 s`, `1 h 3 min`. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toString()} s`;
  if (ms < MIN) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min${Math.round((ms % MIN) / 1000) ? ` ${Math.round((ms % MIN) / 1000)} s` : ""}`;
  return `${Math.floor(ms / HOUR)} h${Math.round((ms % HOUR) / MIN) ? ` ${Math.round((ms % HOUR) / MIN)} min` : ""}`;
}

/** `just now`, `5 min ago`, `3 h ago`, `yesterday`, `4 d ago`. */
export function relativeTime(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 10_000) return "just now";
  if (d < MIN) return `${Math.floor(d / 1000)} s ago`;
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "yesterday" : `${days} d ago`;
}

export const plural = (n: number, one: string, many = one + "s"): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
