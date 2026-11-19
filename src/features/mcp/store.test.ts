// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpPolicy, McpPolicyInput } from "../../api/types";

const api = vi.hoisted(() => ({
  mcpStatus: vi.fn(),
  mcpGetPolicy: vi.fn(),
  mcpSetPolicy: vi.fn(),
  mcpSessions: vi.fn(),
  mcpSubscribe: vi.fn(),
  mcpConfigure: vi.fn(),
  mcpRegenerateToken: vi.fn(),
  mcpClearLog: vi.fn(),
  mcpLog: vi.fn(),
  getUiState: async () => undefined,
  setUiState: async () => undefined,
}));
vi.mock("../../api/db", () => api);
vi.mock("../../components/ui", () => ({ notify: vi.fn() }));
vi.mock("../explorer", async () => {
  const { createSignal } = await import("solid-js");
  const [sources, setSources] = createSignal<{ id: string; name: string; driver: string; color: null; readOnly: boolean }[]>([]);
  return { explorerDataSources: sources, __setSources: setSources };
});

const rw = { read: true, write: true };
const ro = { read: true, write: false };
const ds = (id: string, readOnly = false) => ({ id, name: id, driver: "postgres", color: null, readOnly });
const withEffective = (p: McpPolicyInput, effective: McpPolicy["effective"] = {}): McpPolicy => ({ ...p, effective });

type Store = typeof import("./store");
type Folders = typeof import("../../state/ds-folders");
let store: Store;
let folders: Folders;
let setSources: (l: ReturnType<typeof ds>[]) => void;

/** Lets the promises of the mocked backend settle (the timers are fake). */
const settle = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};

async function boot(policy: McpPolicyInput, opts: { effective?: McpPolicy["effective"]; folders?: { folders: string[]; group: Record<string, string> } } = {}) {
  const sources = [ds("a"), ds("b")];
  vi.resetModules();
  store = await import("./store");
  folders = await import("../../state/ds-folders");
  folders.resetDsFolders(opts.folders ?? { folders: Object.keys(policy.folderRules), group: policy.groups });
  ({ __setSources: setSources } = (await import("../explorer")) as unknown as { __setSources: typeof setSources });
  setSources(sources);
  api.mcpStatus.mockResolvedValue({ enabled: true, running: true, port: 7311, endpoint: "", token: "t", error: null, startedAtMs: 0, activeSessions: 0, logRetentionDays: 30 });
  api.mcpGetPolicy.mockResolvedValue(withEffective(policy, opts.effective));
  api.mcpSetPolicy.mockImplementation(async (p: McpPolicyInput) => withEffective(p));
  await store.startMcp();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(api).forEach((f) => typeof f === "function" && "mockReset" in f && (f as ReturnType<typeof vi.fn>).mockReset());
  api.mcpSessions.mockResolvedValue([]);
  api.mcpSubscribe.mockResolvedValue(() => {});
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {} };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("editing before the rules are known", () => {
  it("does nothing: an empty policy never overwrites the real one", async () => {
    vi.resetModules();
    store = await import("./store");
    store.setSourcePerm("a", rw);
    store.revokeAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.mcpSetPolicy).not.toHaveBeenCalled();
    expect(store.policy().sourceRules).toEqual({});
  });

  it("a backend that cannot give the rules keeps the view read-only and is asked again, with a growing pause", async () => {
    vi.resetModules();
    store = await import("./store");
    api.mcpGetPolicy.mockRejectedValue("down");
    await store.loadPolicy();
    expect(store.policyReady()).toBe(false);
    expect(store.policyError()).toBe("down");
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.mcpGetPolicy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); // the pause grew: no third call yet
    expect(api.mcpGetPolicy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.mcpGetPolicy).toHaveBeenCalledTimes(3);
    api.mcpGetPolicy.mockResolvedValue(withEffective({ folderRules: {}, sourceRules: { a: ro }, groups: {} }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.policyReady()).toBe(true);
    expect(store.policy().sourceRules).toEqual({ a: ro });
  });
});

describe("saving", () => {
  it("sends the loaded rules together with the edit, after the debounce", async () => {
    await boot({ folderRules: {}, sourceRules: { b: ro }, groups: {} });
    store.setSourcePerm("a", ro);
    store.setSourcePerm("a", rw); // a burst is one request
    expect(api.mcpSetPolicy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(store.PUSH_DEBOUNCE_MS);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    expect(api.mcpSetPolicy.mock.calls[0][0]).toEqual({ folderRules: {}, sourceRules: { a: rw, b: ro }, groups: {} });
  });

  it("sends a revocation at once, also Revoke all", async () => {
    await boot({ folderRules: { prod: rw }, sourceRules: { a: ro }, groups: {} });
    store.revokeAll();
    await settle();
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    expect(api.mcpSetPolicy.mock.calls[0][0]).toEqual({ folderRules: {}, sourceRules: {}, groups: {} });
  });

  it("a revocation takes the edits that were waiting for the debounce with it", async () => {
    await boot({ folderRules: {}, sourceRules: { a: rw }, groups: {} });
    store.setSourcePerm("b", ro); // waits
    store.setSourcePerm("a", ro); // write off: goes now
    await settle();
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    expect(api.mcpSetPolicy.mock.calls[0][0].sourceRules).toEqual({ a: ro, b: ro });
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
  });

  it("a failed save is retried after 5 s and then with longer pauses, and clears when it works", async () => {
    await boot({ folderRules: {}, sourceRules: {}, groups: {} });
    api.mcpSetPolicy.mockRejectedValue("offline");
    store.setSourcePerm("a", ro);
    await vi.advanceTimersByTimeAsync(store.PUSH_DEBOUNCE_MS);
    expect(store.saveError()).toBe("offline");
    expect(store.unsaved()).toBe(true);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4900);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_000); // next pause is 15 s
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(2);
    api.mcpSetPolicy.mockImplementation(async (p: McpPolicyInput) => withEffective(p));
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(3);
    expect(store.saveError()).toBeNull();
    expect(store.unsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(3);
  });

  it("flushes what is waiting when the window closes", async () => {
    await boot({ folderRules: {}, sourceRules: {}, groups: {} });
    store.setSourcePerm("a", ro);
    expect(api.mcpSetPolicy).not.toHaveBeenCalled();
    store.flushPendingPolicy();
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.mcpSetPolicy).toHaveBeenCalledTimes(1);
  });
});

describe("what the screen says agents can do", () => {
  it("is the backend's answer once saved, and never less than it while a change is not saved", async () => {
    await boot({ folderRules: {}, sourceRules: { a: rw }, groups: {} }, { effective: { a: { ...rw, origin: "source", readOnlySource: false } } });
    api.mcpSetPolicy.mockRejectedValue("offline");
    store.setSourcePerm("a", null); // revoke: the save fails
    await settle();
    const src = store.permSources().find((s) => s.id === "a")!;
    expect(store.unsaved()).toBe(true);
    expect(store.effectiveOf(src)).toMatchObject({ read: true, write: true }); // agents still have it
    api.mcpSetPolicy.mockImplementation(async (p: McpPolicyInput) => withEffective(p, { a: { read: false, write: false, origin: "none", readOnlySource: false } }));
    await vi.advanceTimersByTimeAsync(5100);
    expect(store.unsaved()).toBe(false);
    expect(store.effectiveOf(src)).toMatchObject({ read: false, write: false });
  });
});

describe("folders", () => {
  it("a renamed folder keeps its rule and the new membership is pushed", async () => {
    await boot({ folderRules: { prod: ro }, sourceRules: {}, groups: { a: "prod" } });
    expect(folders.renameDsFolder("prod", "live")).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    const last = api.mcpSetPolicy.mock.calls.at(-1)![0];
    expect(last.folderRules).toEqual({ live: ro });
    expect(last.groups).toEqual({ a: "live" });
  });

  it("renaming a folder without a rule onto a name that has a stale rule does not hand the rule over", async () => {
    await boot({ folderRules: { live: rw, prod: ro }, sourceRules: {}, groups: {} }, { folders: { folders: ["dev", "prod", "live"], group: {} } });
    folders.removeDsFolder("live"); // the rule goes with it
    await vi.advanceTimersByTimeAsync(500);
    expect(store.policy().folderRules).toEqual({ prod: ro });
    folders.renameDsFolder("dev", "live"); // a new folder named like the old one starts without access
    await vi.advanceTimersByTimeAsync(500);
    expect(store.policy().folderRules).toEqual({ prod: ro });
  });

  it("drops the rules of folders that no longer exist once everything is loaded, and saves that", async () => {
    await boot({ folderRules: { gone: rw, kept: ro }, sourceRules: {}, groups: {} }, { folders: { folders: ["kept"], group: {} } });
    await vi.advanceTimersByTimeAsync(500);
    expect(store.policy().folderRules).toEqual({ kept: ro });
    expect(api.mcpSetPolicy.mock.calls.at(-1)![0].folderRules).toEqual({ kept: ro });
  });
});

describe("sessions", () => {
  it("reads them again every minute while the server is on", async () => {
    await boot({ folderRules: {}, sourceRules: {}, groups: {} });
    const n = api.mcpSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(store.SESSIONS_REFRESH_MS * 2 + 10);
    expect(api.mcpSessions.mock.calls.length).toBe(n + 2);
  });
});
