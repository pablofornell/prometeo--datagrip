/**
 * State of the MCP view: the server status, the permission rules, the sessions, and the live events. The backend is the
 * source of truth; the rules are edited optimistically and pushed (debounced, one request at a time, a failure retried with a
 * growing pause) with the folder membership of the data sources, which only the frontend knows (`state/ds-folders.ts`).
 */
import { createEffect, createRoot, createSignal, untrack } from "solid-js";
import { mcpConfigure, mcpClearLog, mcpGetPolicy, mcpRegenerateToken, mcpSessions, mcpSetPolicy, mcpStatus, mcpSubscribe } from "../../api/db";
import type { McpEffectivePerm, McpLogEntry, McpPerm, McpPolicy, McpPolicyInput, McpSession, McpStatus } from "../../api/types";
import { notify } from "../../components/ui";
import { dsFolders, dsGroupOf, onDsFolderChange } from "../../state/ds-folders";
import { explorerDataSources } from "../explorer";
import {
  type PermSource,
  effectivePerm,
  emptyPolicy,
  groupsOf,
  mergeEffective,
  migrateFolderRules,
  pruneFolderRules,
  reducesAccess,
  reuseSessions,
  sameGroups,
  samePolicy,
  sessionActive,
  setFolderRule,
  setSourceRule,
} from "./model";

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");
const fail = (title: string, e: unknown): void => void notify({ kind: "error", title, body: errText(e) });

export const [status, setStatus] = createSignal<McpStatus | null>(null);
/** The backend has no MCP server (an older build): the view says so instead of showing empty lists. */
export const [unavailable, setUnavailable] = createSignal(false);
/** The rules as the screen has them (edited at once, saved in the background). Not usable before `policyReady()`. */
export const [policy, setPolicyValue] = createSignal<McpPolicyInput>(emptyPolicy());
/** What the backend last confirmed (its rules and the effective permissions it applies). */
const [confirmed, setConfirmed] = createSignal<McpPolicy | null>(null);
/** The rules were read from the backend. Until then nothing is edited or pushed: an empty policy would overwrite the real one. */
export const [policyReady, setPolicyReady] = createSignal(false);
export const [policyError, setPolicyError] = createSignal<string | null>(null);
/** The last save failed (the text says why): the rules on screen are not what the agents are held to. */
export const [saveError, setSaveError] = createSignal<string | null>(null);
export const [sessions, setSessions] = createSignal<McpSession[]>([]);
/** Wall clock, refreshed every few seconds: relative times and "active" follow it. */
export const [now, setNow] = createSignal(Date.now());
export const [busy, setBusy] = createSignal(false);

export const isRunning = (): boolean => !!status()?.running;

/** Agents seen in the last 10 minutes (the status counts them too, but only on its own events). */
export const activeSessionCount = (): number => sessions().filter((s) => sessionActive(s, now())).length;

/** The data sources as the permission rules see them. */
export const permSources = (): PermSource[] =>
  explorerDataSources().map((d) => ({ id: d.id, name: d.name, driver: d.driver, color: d.color, readOnly: d.readOnly }));

/** The rules with the folder membership as the explorer has it now (the pushed copy may be a moment behind). */
export const livePolicy = (): McpPolicyInput => ({
  ...policy(),
  groups: groupsOf(
    explorerDataSources().map((d) => d.id),
    dsGroupOf,
  ),
});

/** The rules on screen differ from what the backend has confirmed (a save is on its way, or failed). */
export const unsaved = (): boolean => {
  const c = confirmed();
  return policyReady() && !!c && !samePolicy(policy(), c);
};

/**
 * What a data source may do, for display. Once saved it is what the backend applies; while a change is not saved it is never
 * less than the backend still allows, so the screen cannot understate the access agents really have.
 */
export function effectiveOf(src: PermSource): McpEffectivePerm {
  const local = effectivePerm(src, livePolicy());
  const be = confirmed()?.effective[src.id];
  if (!be) return local;
  return unsaved() ? mergeEffective(local, be) : be;
}

// ---------------------------------------------------------------- live events

const entryListeners = new Set<(e: McpLogEntry) => void>();
const resetListeners = new Set<() => void>();

/** `cb` gets every new log entry of the server. Returns the unsubscribe function. */
export function onMcpEntry(cb: (e: McpLogEntry) => void): () => void {
  entryListeners.add(cb);
  return () => entryListeners.delete(cb);
}
/** `cb` runs when the log was cleared (the lists load again). */
export function onMcpLogReset(cb: () => void): () => void {
  resetListeners.add(cb);
  return () => resetListeners.delete(cb);
}

let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
const refreshSessionsSoon = (): void => {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(() => void refreshSessions(), 250);
};

export async function refreshSessions(): Promise<void> {
  try {
    const fresh = await mcpSessions();
    setSessions((old) => reuseSessions(old, fresh));
  } catch {
    /* the list stays as it was */
  }
}

// ---------------------------------------------------------------- server

/** Enables / disables the server and sets its port. */
export async function configure(enabled: boolean, port: number): Promise<boolean> {
  setBusy(true);
  try {
    setStatus(await mcpConfigure(enabled, port));
    return true;
  } catch (e) {
    fail(enabled ? "Cannot start the MCP server" : "Cannot stop the MCP server", e);
    return false;
  } finally {
    setBusy(false);
  }
}

export async function regenerateToken(): Promise<void> {
  try {
    setStatus(await mcpRegenerateToken());
    notify({ kind: "info", title: "New MCP token", body: "Agents that used the old token are refused. Copy the new install command." });
  } catch (e) {
    fail("Cannot regenerate the token", e);
  }
}

export async function clearLog(): Promise<void> {
  try {
    await mcpClearLog();
    for (const l of [...resetListeners]) l();
    void refreshSessions();
  } catch (e) {
    fail("Cannot clear the MCP log", e);
  }
}

// ---------------------------------------------------------------- permissions (edited at once, saved in order)

/** Pause after the last edit before it is sent (a burst of clicks is one request); access is never held back, see `editPolicy`. */
export const PUSH_DEBOUNCE_MS = 150;
/** First retry after a failed save; it grows to `RETRY_MAX_MS` so a backend that is down is not hammered. */
export const RETRY_MIN_MS = 5000;
export const RETRY_MAX_MS = 60_000;

let pushTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = RETRY_MIN_MS;
let pushPending = false;
let chain: Promise<unknown> = Promise.resolve();

/** Sends the rules now (after the saves that are already on their way); a failure is retried with a growing pause. */
export function savePolicyNow(): Promise<void> {
  clearTimeout(pushTimer);
  clearTimeout(retryTimer);
  pushPending = false;
  const run = chain.then(async () => {
    if (!untrack(policyReady)) return;
    try {
      setConfirmed(await mcpSetPolicy(untrack(policy)));
      setSaveError(null);
      retryDelay = RETRY_MIN_MS;
    } catch (e) {
      const first = untrack(saveError) === null;
      setSaveError(errText(e));
      if (first) fail("Cannot save the MCP permissions", e);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void savePolicyNow(), retryDelay);
      retryDelay = Math.min(retryDelay * 3, RETRY_MAX_MS);
    }
  });
  chain = run;
  return run;
}

const schedulePush = (now: boolean): void => {
  if (now) {
    void savePolicyNow();
    return;
  }
  clearTimeout(pushTimer);
  pushPending = true;
  pushTimer = setTimeout(() => void savePolicyNow(), PUSH_DEBOUNCE_MS);
};

/** Window closing: what is waiting for its debounce goes out now (best effort, nobody can wait for the answer). */
export function flushPendingPolicy(): void {
  if (!pushPending || !untrack(policyReady)) return;
  clearTimeout(pushTimer);
  pushPending = false;
  void mcpSetPolicy(untrack(policy)).catch(() => {});
}

/**
 * Changes the rules on screen and saves them. A change that takes access away is sent at once (an agent must not keep access
 * for a debounce); the others wait for the burst of clicks to end. Does nothing before the rules were read from the backend.
 */
function editPolicy(f: (p: McpPolicyInput) => McpPolicyInput): boolean {
  if (!untrack(policyReady)) return false;
  const prev = untrack(policy);
  const next = f(prev);
  if (samePolicy(prev, next)) return true;
  setPolicyValue(next);
  schedulePush(
    reducesAccess(
      prev,
      next,
      untrack(explorerDataSources).map((d) => d.id),
    ),
  );
  return true;
}

/** A rule for a data source (`null`: no rule of its own, it follows its folder). */
export const setSourcePerm = (id: string, rule: McpPerm | null): void => void editPolicy((p) => setSourceRule(p, id, rule));
/** A rule for a folder (`null` or both flags off: no rule). */
export const setFolderPerm = (folder: string, rule: McpPerm | null): void => void editPolicy((p) => setFolderRule(p, folder, rule));
/** No access for anyone: every rule is dropped. */
export const revokeAll = (): void => void editPolicy((p) => ({ ...p, folderRules: {}, sourceRules: {} }));

let loadTimer: ReturnType<typeof setTimeout> | undefined;
let loadDelay = RETRY_MIN_MS;

/** Reads the rules from the backend (retried with a growing pause until it works). */
export async function loadPolicy(): Promise<void> {
  clearTimeout(loadTimer);
  try {
    const p = await mcpGetPolicy();
    setConfirmed(p);
    setPolicyValue({ folderRules: p.folderRules, sourceRules: p.sourceRules, groups: p.groups });
    setPolicyError(null);
    setPolicyReady(true);
    loadDelay = RETRY_MIN_MS;
  } catch (e) {
    if (untrack(policyError) === null) fail("Cannot read the MCP permissions", e);
    setPolicyError(errText(e));
    loadTimer = setTimeout(() => void loadPolicy(), loadDelay);
    loadDelay = Math.min(loadDelay * 3, RETRY_MAX_MS);
  }
}

// ---------------------------------------------------------------- start

let started = false;
/** Sessions are read again this often while the server is on (the "active" state ends by itself, without an event). */
export const SESSIONS_REFRESH_MS = 60_000;

/** Reads the status, the rules and the sessions and follows the live events. Safe to call twice. */
export async function startMcp(): Promise<void> {
  if (started) return;
  started = true;
  try {
    setStatus(await mcpStatus());
  } catch {
    setUnavailable(true);
    return;
  }
  void loadPolicy();
  void refreshSessions();
  setInterval(() => setNow(Date.now()), 5000);
  setInterval(() => {
    if (status()?.enabled) void refreshSessions();
  }, SESSIONS_REFRESH_MS);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPendingPolicy);
    window.addEventListener("beforeunload", flushPendingPolicy);
  }
  try {
    await mcpSubscribe((ev) => {
      if (ev.type === "status") setStatus(ev.status);
      else if (ev.type === "sessions") refreshSessionsSoon();
      else {
        for (const l of [...entryListeners]) l(ev.entry);
        refreshSessionsSoon();
      }
    });
  } catch (e) {
    fail("Cannot follow the MCP server", e);
  }

  createRoot(() => {
    // The backend applies a folder rule through the membership it was given: keep it in step with the explorer's folders.
    // Not before the rules were read (they would be overwritten) nor before the data sources are known.
    createEffect(() => {
      if (!policyReady()) return;
      const list = explorerDataSources();
      void dsFolders(); // a folder added, renamed or removed runs this again
      if (!list.length) return;
      const groups = groupsOf(
        list.map((d) => d.id),
        dsGroupOf,
      );
      if (!sameGroups(groups, policy().groups)) {
        editPolicy((p) => ({ ...p, groups }));
        return;
      }
      // The rule of a folder that is gone must not wait for a new folder of that name. Deferred: a rename announces itself right
      // after the folders changed, and moves the rule to the new name first.
      queueMicrotask(() => {
        const cur = untrack(policy);
        const kept = pruneFolderRules(cur.folderRules, untrack(dsFolders));
        if (kept !== cur.folderRules) editPolicy((p) => ({ ...p, folderRules: kept }));
      });
    });
  });
  // a renamed folder keeps its rule, a removed one loses it
  onDsFolderChange((c) => void editPolicy((p) => ({ ...p, folderRules: migrateFolderRules(p.folderRules, c) })));
}
