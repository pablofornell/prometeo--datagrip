// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { McpLogEntry, McpPolicyInput, McpSession } from "../../api/types";
import {
  AGENTS,
  type AgentId,
  type InstallScope,
  type PermSource,
  codexToml,
  installSnippet,
  isAgentId,
  scopeHint,
  tomlParts,
  claudeCommand,
  capEntries,
  claudeCommandParts,
  dayLabel,
  duration,
  effectivePerm,
  entryMatches,
  gapBetween,
  groupByDay,
  groupsOf,
  jsonParts,
  maskToken,
  mcpJson,
  mergeEffective,
  mergeNewest,
  mergeOlder,
  migrateFolderRules,
  originLabel,
  outcomeText,
  parsePort,
  permissionGroups,
  pruneFolderRules,
  rangeSince,
  reducesAccess,
  relativeTime,
  reuseSessions,
  sameGroups,
  samePolicy,
  sessionActive,
  setFolderRule,
  setSourceRule,
  startOfDay,
  summarizeSources,
  toggled,
  toolMeta,
} from "./model";

const src = (id: string, name = id, readOnly = false): PermSource => ({ id, name, readOnly });
const policy = (p: Partial<McpPolicyInput> = {}): McpPolicyInput => ({ folderRules: {}, sourceRules: {}, groups: {}, ...p });
const entry = (p: Partial<McpLogEntry> = {}): McpLogEntry => ({
  id: "e1",
  tsMs: 1000,
  sessionId: "s1",
  clientName: "claude-code",
  kind: "tool",
  tool: "run_query",
  dataSourceId: "a",
  dataSourceName: "shop",
  sql: "SELECT 1",
  args: null,
  status: "ok",
  error: null,
  elapsedMs: 5,
  rowCount: 1,
  rowsAffected: null,
  truncated: false,
  preview: null,
  summary: "Returned 1 row",
  ...p,
});

describe("install snippets", () => {
  it("builds the claude command with the endpoint and the token", () => {
    expect(claudeCommand("http://127.0.0.1:7311/mcp", "tok")).toBe(
      'claude mcp add --transport http datum http://127.0.0.1:7311/mcp --header "Authorization: Bearer tok"',
    );
  });

  it("colors the same text it copies", () => {
    expect(claudeCommandParts("http://x/mcp", "t").map((p) => p.text).join("")).toBe(claudeCommand("http://x/mcp", "t"));
  });

  it("builds the .mcp.json entry", () => {
    expect(JSON.parse(mcpJson("http://x/mcp", "t"))).toEqual({
      mcpServers: { "datum": { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer t" } } },
    });
  });

  it("splits a JSON text into keys, values and punctuation without losing a character", () => {
    const text = mcpJson("http://x/mcp", "t");
    const parts = jsonParts(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.cls === "key").map((p) => p.text)).toEqual(['"mcpServers"', '"datum"', '"type"', '"url"', '"headers"', '"Authorization"']);
    expect(parts.filter((p) => p.cls === "str").map((p) => p.text)).toEqual(['"http"', '"http://x/mcp"', '"Bearer t"']);
  });

  it("adds --scope user to the global claude command", () => {
    expect(claudeCommand("http://x/mcp", "tok", true)).toBe('claude mcp add --transport http --scope user datum http://x/mcp --header "Authorization: Bearer tok"');
  });

  it("splits the codex TOML into keys, values and punctuation without losing a character", () => {
    const text = codexToml("http://x/mcp", "t");
    expect(text).toBe('[mcp_servers.datum]\nurl = "http://x/mcp"\n\n[mcp_servers.datum.http_headers]\nAuthorization = "Bearer t"\n');
    const parts = tomlParts(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.cls === "key").map((p) => p.text)).toEqual(["[mcp_servers.datum]", "url", "[mcp_servers.datum.http_headers]", "Authorization"]);
    expect(parts.filter((p) => p.cls === "str").map((p) => p.text)).toEqual(['"http://x/mcp"', '"Bearer t"']);
  });

  it("knows its agents", () => {
    expect(AGENTS.map((a) => a.id)).toEqual(["claude", "codex", "gemini", "cursor", "copilot", "opencode"]);
    expect(isAgentId("cursor")).toBe(true);
    expect(isAgentId("vim")).toBe(false);
    expect(scopeHint("cursor", "global")).toContain("Cursor");
    expect(scopeHint("cursor", "project")).not.toBe(scopeHint("cursor", "global"));
  });

  const EP = "http://127.0.0.1:7311/mcp";
  const TOKEN = "pdg_0123456789abcdef";
  const expected: Record<AgentId, Record<InstallScope, string>> = {
    claude: {
      project: `claude mcp add --transport http datum ${EP} --header "Authorization: Bearer ${TOKEN}"`,
      global: `claude mcp add --transport http --scope user datum ${EP} --header "Authorization: Bearer ${TOKEN}"`,
    },
    gemini: {
      project: `gemini mcp add --transport http --header "Authorization: Bearer ${TOKEN}" datum ${EP}`,
      global: `gemini mcp add --transport http --scope user --header "Authorization: Bearer ${TOKEN}" datum ${EP}`,
    },
    opencode: {
      project: `opencode mcp add datum --url ${EP} --header "Authorization=Bearer ${TOKEN}"`,
      global: `opencode mcp add datum --global --url ${EP} --header "Authorization=Bearer ${TOKEN}"`,
    },
    codex: { project: codexToml(EP, TOKEN), global: codexToml(EP, TOKEN) },
    cursor: {
      project: JSON.stringify({ mcpServers: { datum: { url: EP, headers: { Authorization: `Bearer ${TOKEN}` } } } }, null, 2),
      global: JSON.stringify({ mcpServers: { datum: { url: EP, headers: { Authorization: `Bearer ${TOKEN}` } } } }, null, 2),
    },
    copilot: {
      project: JSON.stringify({ mcpServers: { datum: { type: "http", url: EP, headers: { Authorization: `Bearer ${TOKEN}` }, tools: ["*"] } } }),
      global: JSON.stringify({ mcpServers: { datum: { type: "http", url: EP, headers: { Authorization: `Bearer ${TOKEN}` }, tools: ["*"] } } }),
    },
  };
  const paths: Partial<Record<AgentId, Record<InstallScope, { posix: string; windows?: string }>>> = {
    codex: { project: { posix: ".codex/config.toml" }, global: { posix: "~/.codex/config.toml", windows: "%USERPROFILE%\\.codex\\config.toml" } },
    cursor: { project: { posix: ".cursor/mcp.json" }, global: { posix: "~/.cursor/mcp.json", windows: "%USERPROFILE%\\.cursor\\mcp.json" } },
    copilot: { project: { posix: ".mcp.json" }, global: { posix: "~/.copilot/mcp-config.json", windows: "%USERPROFILE%\\.copilot\\mcp-config.json" } },
  };
  const richText = (r: (string | { code: string })[]) => r.map((x) => (typeof x === "string" ? x : x.code)).join("");

  for (const { id } of AGENTS)
    for (const scope of ["project", "global"] as const)
      describe(`${id} / ${scope}`, () => {
        const real = installSnippet(id, scope, EP, TOKEN);
        const shown = installSnippet(id, scope, EP, maskToken(TOKEN));

        it("copies the expected text with the real token", () => {
          if (id === "copilot") {
            expect(JSON.parse(real.text)).toEqual(JSON.parse(expected[id][scope]));
            expect(real.text).toContain('"tools": ["*"]');
          }
          else expect(real.text).toBe(expected[id][scope]);
          expect(real.text).toContain(TOKEN);
          expect(real.text).toContain(EP);
        });

        it("shows the masked token and the same text otherwise", () => {
          const shownText = shown.parts.map((p) => p.text).join("");
          expect(shownText).toBe(shown.text);
          expect(shownText).not.toContain(TOKEN);
          expect(shownText).toContain(maskToken(TOKEN));
          expect(shownText).toBe(real.text.replace(TOKEN, maskToken(TOKEN)));
        });

        it("colors the same text it copies", () => {
          expect(real.parts.map((p) => p.text).join("")).toBe(real.text);
          expect(real.parts.some((p) => p.cls === "url" || p.cls === "str")).toBe(true);
        });

        it("is one line when it is a command, and a file with its path otherwise", () => {
          if (real.kind === "command") {
            expect(real.text).not.toContain("\n");
            expect(real.title).toBe("Run it in a terminal");
            expect(real.path).toBeUndefined();
          } else {
            expect(real.path).toEqual(paths[id]![scope]);
            expect(real.title).toContain(real.path!.posix);
            if (real.path!.windows) expect(richText(real.how)).toContain(real.path!.windows);
          }
        });

        it("says how to check it, and which scope it is", () => {
          expect(richText(real.how)).toMatch(/Check it|check the server/);
          expect(real.how).toEqual(shown.how);
        });
      });

  it("differs between the scopes for every agent", () => {
    for (const { id } of AGENTS) {
      const p = installSnippet(id, "project", EP, TOKEN);
      const g = installSnippet(id, "global", EP, TOKEN);
      expect(p.text !== g.text || p.path?.posix !== g.path?.posix).toBe(true);
    }
  });

  it("masks a token but keeps its ends", () => {
    expect(maskToken("pdg_0123456789abcdef")).toBe("pdg_••••••••cdef");
    expect(maskToken("short")).toBe("••••••••");
  });

  it("accepts only unprivileged ports", () => {
    expect(parsePort("7311")).toBe(7311);
    expect(parsePort(" 8080 ")).toBe(8080);
    expect(parsePort("80")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("73x1")).toBeNull();
    expect(parsePort("")).toBeNull();
  });
});

describe("effective permission", () => {
  const rw = { read: true, write: true };
  const ro = { read: true, write: false };

  it("a data source without a rule has no access", () => {
    expect(effectivePerm(src("a"), policy())).toEqual({ read: false, write: false, origin: "none", readOnlySource: false });
  });

  it("follows the rule of its folder", () => {
    const p = policy({ groups: { a: "prod" }, folderRules: { prod: ro } });
    expect(effectivePerm(src("a"), p)).toEqual({ read: true, write: false, origin: "folder", readOnlySource: false });
  });

  it("its own rule wins over the folder, also when it denies everything", () => {
    const p = policy({ groups: { a: "prod" }, folderRules: { prod: rw }, sourceRules: { a: { read: false, write: false } } });
    expect(effectivePerm(src("a"), p)).toMatchObject({ read: false, write: false, origin: "source" });
  });

  it("never gives write to a read-only data source", () => {
    const p = policy({ sourceRules: { a: rw } });
    expect(effectivePerm(src("a", "a", true), p)).toEqual({ read: true, write: false, origin: "source", readOnlySource: true });
  });

  it("ignores a group without a rule", () => {
    expect(effectivePerm(src("a"), policy({ groups: { a: "dev" }, folderRules: { prod: rw } })).origin).toBe("none");
  });
});

describe("editing the rules", () => {
  it("sets and removes the rule of a data source", () => {
    const p = setSourceRule(policy(), "a", { read: true, write: false });
    expect(p.sourceRules).toEqual({ a: { read: true, write: false } });
    expect(setSourceRule(p, "a", null).sourceRules).toEqual({});
  });

  it("keeps a data source rule that denies everything (it overrides the folder)", () => {
    expect(setSourceRule(policy(), "a", { read: false, write: false }).sourceRules).toEqual({ a: { read: false, write: false } });
  });

  it("drops a folder rule that grants nothing", () => {
    const p = setFolderRule(policy(), "prod", { read: true, write: false });
    expect(p.folderRules).toEqual({ prod: { read: true, write: false } });
    expect(setFolderRule(p, "prod", { read: false, write: false }).folderRules).toEqual({});
    expect(setFolderRule(p, "prod", null).folderRules).toEqual({});
  });

  it("does not change the policy it is given", () => {
    const p = policy();
    setSourceRule(p, "a", { read: true, write: true });
    expect(p.sourceRules).toEqual({});
  });

  it("flips one flag", () => {
    expect(toggled({ read: true, write: false }, "write")).toEqual({ read: true, write: true });
    expect(toggled({ read: true, write: true }, "read")).toEqual({ read: false, write: true });
  });
});

describe("folder rename and removal", () => {
  const rules = { prod: { read: true, write: false }, dev: { read: true, write: true } };

  it("moves the rule of a renamed folder", () => {
    expect(migrateFolderRules(rules, { type: "rename", from: "prod", to: "live" })).toEqual({ live: rules.prod, dev: rules.dev });
  });

  it("a case-only rename keeps the rule", () => {
    expect(migrateFolderRules(rules, { type: "rename", from: "prod", to: "PROD" })).toEqual({ PROD: rules.prod, dev: rules.dev });
    expect(migrateFolderRules(rules, { type: "rename", from: "prod", to: "prod" })).toEqual(rules);
  });

  it("drops the rule of a removed folder", () => {
    expect(migrateFolderRules(rules, { type: "remove", name: "prod" })).toEqual({ dev: rules.dev });
  });

  it("a stale rule under the new name does not carry over to the renamed folder", () => {
    const stale = { ...rules, live: { read: true, write: true } };
    expect(migrateFolderRules(stale, { type: "rename", from: "none", to: "live" })).toEqual(rules);
    expect(migrateFolderRules(stale, { type: "rename", from: "prod", to: "live" })).toEqual({ live: rules.prod, dev: rules.dev });
  });

  it("prunes the rules of folders that do not exist, keeping the object when nothing goes", () => {
    expect(pruneFolderRules(rules, ["dev"])).toEqual({ dev: rules.dev });
    expect(pruneFolderRules(rules, ["dev", "prod", "other"])).toBe(rules);
    expect(pruneFolderRules(rules, [])).toEqual({});
  });

  it("a folder without a rule changes nothing, and the input is not mutated", () => {
    expect(migrateFolderRules(rules, { type: "rename", from: "none", to: "x" })).toEqual(rules);
    expect(rules.prod).toEqual({ read: true, write: false });
    expect(Object.keys(rules)).toEqual(["prod", "dev"]);
  });
});

describe("groups pushed to the backend", () => {
  it("lists the data sources that sit in a folder", () => {
    const g: Record<string, string> = { a: "prod", c: "dev" };
    expect(groupsOf(["a", "b", "c"], (id) => g[id])).toEqual({ a: "prod", c: "dev" });
  });

  it("compares without looking at the order", () => {
    expect(sameGroups({ a: "x", b: "y" }, { b: "y", a: "x" })).toBe(true);
    expect(sameGroups({ a: "x" }, { a: "y" })).toBe(false);
    expect(sameGroups({ a: "x" }, { a: "x", b: "y" })).toBe(false);
  });
});

describe("permission matrix", () => {
  const sources = [src("c", "Zeta"), src("a", "alpha"), src("b", "Beta", true), src("d", "delta")];
  const p = policy({ groups: { a: "prod", b: "prod", c: "dev" }, folderRules: { prod: { read: true, write: true } }, sourceRules: { c: { read: true, write: false } } });

  it("groups by folder (also the empty ones) and puts the rest under no folder", () => {
    const g = permissionGroups(sources, ["dev", "empty", "prod"], p);
    expect(g.map((x) => [x.folder, x.rows.map((r) => r.src.id)])).toEqual([
      ["dev", ["c"]],
      ["empty", []],
      ["prod", ["a", "b"]],
      [null, ["d"]],
    ]);
    expect(g[2].rule).toEqual({ read: true, write: true });
    expect(g[2].total).toBe(2);
  });

  it("shows what each row inherits and where it comes from", () => {
    const rows = permissionGroups(sources, ["dev", "prod"], p).flatMap((g) => g.rows.map((r) => ({ ...r, folder: g.folder })));
    const by = (id: string) => rows.find((r) => r.src.id === id)!;
    expect(by("a").eff).toMatchObject({ read: true, write: true, origin: "folder" });
    expect(originLabel(by("a"), "prod")).toBe("from prod");
    expect(by("b").eff).toMatchObject({ read: true, write: false, origin: "folder", readOnlySource: true });
    expect(originLabel(by("b"), "prod")).toBe("read-only data source");
    expect(originLabel(by("c"), "dev")).toBe("own rule");
    expect(originLabel(by("d"), null)).toBe("no rule");
  });

  it("filters by the name of a data source or of a folder", () => {
    expect(permissionGroups(sources, ["dev", "prod"], p, "ALP").map((g) => [g.folder, g.rows.length])).toEqual([["prod", 1]]);
    expect(permissionGroups(sources, ["dev", "prod"], p, "dev").map((g) => [g.folder, g.rows.length])).toEqual([["dev", 1]]);
    expect(permissionGroups(sources, ["dev", "prod"], p, "nothing")).toEqual([]);
  });

  it("a rule on a folder that does not exist (any more) does not hide its data sources", () => {
    const g = permissionGroups([src("a")], [], policy({ groups: { a: "gone" } }));
    expect(g.map((x) => x.folder)).toEqual([null]);
  });

  it("counts what the agents can reach", () => {
    expect(summarizeSources(sources, p)).toEqual({ total: 4, none: 1, read: 2, write: 0, readwrite: 1, exposed: 3 });
  });
});

describe("tools and entries", () => {
  it("classifies the tools", () => {
    expect(toolMeta("run_query").kind).toBe("read");
    expect(toolMeta("execute_statement").kind).toBe("write");
    expect(toolMeta("list_data_sources").kind).toBe("meta");
    expect(toolMeta("initialize").kind).toBe("session");
    expect(toolMeta("something_new").label).toBe("something_new");
  });

  it("states the outcome in a few characters", () => {
    expect(outcomeText(entry({ rowCount: 12 }))).toBe("12 rows");
    expect(outcomeText(entry({ rowCount: 1 }))).toBe("1 row");
    expect(outcomeText(entry({ rowCount: 20, truncated: true }))).toBe("20+ rows");
    expect(outcomeText(entry({ rowCount: null, rowsAffected: 3 }))).toBe("3 rows affected");
    expect(outcomeText(entry({ rowCount: null, rowsAffected: 1 }))).toBe("1 row affected");
    expect(outcomeText(entry({ status: "error", rowCount: 5 }))).toBeNull();
    expect(outcomeText(entry({ rowCount: null }))).toBeNull();
  });
});

describe("log filters", () => {
  it("matches a live entry against the query of the list", () => {
    const e = entry({ tsMs: 5000 });
    expect(entryMatches({}, e)).toBe(true);
    expect(entryMatches({ sessionId: "s1" }, e)).toBe(true);
    expect(entryMatches({ sessionId: "s2" }, e)).toBe(false);
    expect(entryMatches({ dataSourceId: "b" }, e)).toBe(false);
    expect(entryMatches({ status: "error" }, e)).toBe(false);
    expect(entryMatches({ sinceMs: 6000 }, e)).toBe(false);
    expect(entryMatches({ untilMs: 4000 }, e)).toBe(false);
    expect(entryMatches({ text: "select" }, e)).toBe(true);
    expect(entryMatches({ text: " RETURNED " }, e)).toBe(true);
    // the backend searches SQL, summary, tool and error only
    expect(entryMatches({ text: "claude" }, e)).toBe(false);
    expect(entryMatches({ text: "shop" }, e)).toBe(false);
    expect(entryMatches({ text: "boom" }, entry({ error: "Boom!" }))).toBe(true);
    expect(entryMatches({ text: "run_query" }, e)).toBe(true);
    expect(entryMatches({ text: "drop table" }, e)).toBe(false);
  });

  it("merges new entries at the front and older pages at the end, without duplicates", () => {
    const a = entry({ id: "a", tsMs: 3 });
    const b = entry({ id: "b", tsMs: 2 });
    const c = entry({ id: "c", tsMs: 1 });
    const d = entry({ id: "d", tsMs: 4 });
    expect(mergeNewest([a, b], [d, a]).map((e) => e.id)).toEqual(["d", "a", "b"]);
    expect(mergeNewest([a], [a])).toEqual([a]);
    expect(mergeOlder([a, b], [b, c]).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("the quick ranges start at midnight, a week and thirty days back", () => {
    const now = new Date(2026, 10, 18, 15, 30).getTime();
    expect(rangeSince("today", now)).toBe(new Date(2026, 10, 18).getTime());
    expect(rangeSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(rangeSince("30d", now)).toBe(now - 30 * 86_400_000);
    expect(startOfDay(now)).toBe(new Date(2026, 10, 18).getTime());
  });
});

describe("days", () => {
  const now = new Date(2026, 10, 18, 15, 30).getTime();
  const at = (d: number, h = 12) => new Date(2026, 10, d, h).getTime();

  it("labels today, yesterday and older days", () => {
    expect(dayLabel(at(18, 9), now)).toBe("Today");
    expect(dayLabel(at(17, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(12), now)).toBe("Thu, Nov 12");
    expect(dayLabel(new Date(2025, 11, 30, 10).getTime(), now)).toBe("Tue, Dec 30, 2025");
  });

  it("groups entries newest first, one group per day", () => {
    const items = [at(18, 14), at(18, 9), at(17, 20), at(12, 8), at(12, 7)].map((tsMs) => ({ tsMs }));
    const g = groupByDay(items);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([
      ["2026-11-18", 2],
      ["2026-11-17", 1],
      ["2026-11-12", 2],
    ]);
    expect(g.map((x) => dayLabel(x.items[0].tsMs, now))).toEqual(["Today", "Yesterday", "Thu, Nov 12"]);
  });

  it("no entries, no groups", () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe("time text", () => {
  it("writes elapsed times", () => {
    expect(duration(0)).toBe("0 ms");
    expect(duration(42)).toBe("42 ms");
    expect(duration(1400)).toBe("1.4 s");
    expect(duration(12_000)).toBe("12 s");
    expect(duration(125_000)).toBe("2 min 5 s");
    expect(duration(120_000)).toBe("2 min");
    expect(duration(3_780_000)).toBe("1 h 3 min");
  });

  it("writes relative times", () => {
    const now = 10_000_000_000;
    expect(relativeTime(now - 3000, now)).toBe("just now");
    expect(relativeTime(now - 25_000, now)).toBe("25 s ago");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 d ago");
    expect(relativeTime(now + 5000, now)).toBe("just now");
  });

  it("marks a long pause between two actions", () => {
    expect(gapBetween(0, 4 * 60_000)).toBeNull();
    expect(gapBetween(0, 5 * 60_000)).toBe(300_000);
  });
});

describe("saved and unsaved rules", () => {
  const rw = { read: true, write: true };
  const base = policy({ groups: { a: "prod" }, folderRules: { prod: rw }, sourceRules: {} });

  it("compares rules and membership", () => {
    expect(samePolicy(base, structuredClone(base))).toBe(true);
    expect(samePolicy(base, { ...base, folderRules: { prod: { read: true, write: false } } })).toBe(false);
    expect(samePolicy(base, { ...base, groups: {} })).toBe(false);
    expect(samePolicy(base, { ...base, sourceRules: { a: rw } })).toBe(false);
  });

  it("an edit that takes access away is a revocation, one that adds is not", () => {
    const ids = ["a", "b"];
    expect(reducesAccess(base, policy({ groups: base.groups }), ids)).toBe(true); // folder rule gone
    expect(reducesAccess(base, { ...base, folderRules: { prod: { read: true, write: false } } }, ids)).toBe(true); // write off
    expect(reducesAccess(base, { ...base, groups: {} }, ids)).toBe(true); // moved out of the folder
    expect(reducesAccess(base, { ...base, sourceRules: { a: { read: false, write: false } } }, ids)).toBe(true); // own deny
    expect(reducesAccess(base, { ...base, sourceRules: { b: rw } }, ids)).toBe(false);
    expect(reducesAccess(policy(), base, ids)).toBe(false);
    expect(reducesAccess(base, { ...base, folderRules: { prod: rw } }, ids)).toBe(false);
  });

  it("a rename moves the rule with the members: not a revocation", () => {
    const next = { folderRules: { live: rw }, sourceRules: {}, groups: { a: "live" } };
    expect(reducesAccess(base, next, ["a"])).toBe(false);
  });

  it("the screen never shows less than the backend still allows", () => {
    const local = { read: false, write: false, origin: "none" as const, readOnlySource: false };
    const be = { read: true, write: false, origin: "folder" as const, readOnlySource: false };
    expect(mergeEffective(local, be)).toEqual({ ...local, read: true });
    expect(mergeEffective(local, undefined)).toBe(local);
    expect(mergeEffective({ ...be, write: true }, { ...be, read: false })).toMatchObject({ read: true, write: true });
  });
});

describe("sessions", () => {
  const sess = (p: Partial<McpSession> = {}): McpSession => ({
    id: "s1",
    clientName: "claude-code",
    clientVersion: "2.1",
    startedAtMs: 0,
    lastSeenMs: 1000,
    active: true,
    actionCount: 3,
    errorCount: 0,
    writeCount: 0,
    dataSourceIds: ["a"],
    ...p,
  });

  it("is active for ten minutes after it was last seen, and never again once the backend ended it", () => {
    expect(sessionActive(sess(), 1000 + 9 * 60_000)).toBe(true);
    expect(sessionActive(sess(), 1000 + 10 * 60_000)).toBe(false);
    expect(sessionActive(sess({ active: false }), 2000)).toBe(false);
  });

  it("keeps the object of a session that did not change", () => {
    const old = [sess(), sess({ id: "s2" })];
    const fresh = [sess({ actionCount: 4 }), sess({ id: "s2" }), sess({ id: "s3" })];
    const out = reuseSessions(old, fresh);
    expect(out[0]).toBe(fresh[0]);
    expect(out[1]).toBe(old[1]);
    expect(out[2]).toBe(fresh[2]);
  });
});

describe("memory cap", () => {
  it("keeps the newest entries", () => {
    const list = [3, 2, 1].map((t) => entry({ id: "e" + t, tsMs: t }));
    expect(capEntries(list, 2).map((e) => e.id)).toEqual(["e3", "e2"]);
    expect(capEntries(list, 5)).toBe(list);
  });
});
