// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SchemaChoice } from "../../api/db";
import { buildSections, canSwitchSchema, filterShowing, flatRows, hasNothingToShow, isChoiceVisible, matchRank, schemaNouns, stepIndex, toggledFilter } from "./schemaChoices";

const c = (name: string, o: Partial<SchemaChoice> = {}): SchemaChoice => ({ name, path: [name], system: false, default: false, hasObjects: null, ...o });
const ORACLE: SchemaChoice[] = [
  c("DEMO", { default: true, hasObjects: true }),
  c("HR", { hasObjects: true }),
  c("APP_RO", { hasObjects: false }),
  c("scott", { hasObjects: false }),
  c("SYS", { system: true, hasObjects: true }),
  c("SYSTEM", { system: true, hasObjects: false }),
];
const args = (o: Partial<Parameters<typeof buildSections>[0]> = {}) => ({ choices: ORACLE, driver: "oracle" as const, current: "DEMO", query: "", showSystem: false, isVisible: () => true, ...o });
const names = (s: ReturnType<typeof buildSections>) => s.map((x) => [x.id, x.rows.map((r) => r.choice.name)]);

describe("labels adapt to the DBMS", () => {
  it("User/Schema for Oracle, Schema for PostgreSQL and SQLite, Database for MySQL", () => {
    expect(schemaNouns("oracle").title).toBe("User/Schema");
    expect(schemaNouns("postgres").title).toBe("Schema");
    expect(schemaNouns("sqlite").title).toBe("Schema");
    expect(schemaNouns("mysql").title).toBe("Database");
    expect(schemaNouns("oracle")).toMatchObject({ one: "user", many: "users", currentSection: "Current user", systemSection: "System users" });
    expect(schemaNouns("mysql")).toMatchObject({ many: "databases", currentSection: "Current database" });
  });
  it("only SQLite (one schema per file) and a data source with switching turned off cannot switch", () => {
    expect(canSwitchSchema({ driver: "oracle", options: {} })).toBe(true);
    expect(canSwitchSchema({ driver: "sqlite", options: {} })).toBe(false);
    expect(canSwitchSchema({ driver: "postgres", options: { switchSchema: "disabled" } })).toBe(false);
  });
});

describe("type-ahead match", () => {
  it("ranks same name, prefix, word start, inside a word, initials; no match is null", () => {
    expect(matchRank("HR", "hr")).toBe(0);
    expect(matchRank("HR_APP", "hr")).toBe(1);
    expect(matchRank("MY_APP", "app")).toBe(2);
    expect(matchRank("SCOTT", "ott")).toBe(3);
    expect(matchRank("order_items", "oi")).toBe(4);
    expect(matchRank("HR", "zz")).toBeNull();
    expect(matchRank("HR", "  ")).toBe(0);
  });
  it("is case-insensitive and trims the query", () => {
    expect(matchRank("Scott", " SCO ")).toBe(1);
  });
});

describe("sections of the list", () => {
  it("the current user first, the others by name, system users only when asked for", () => {
    expect(names(buildSections(args()))).toEqual([
      ["current", ["DEMO"]],
      ["others", ["APP_RO", "HR", "scott"]],
    ]);
    expect(names(buildSections(args({ showSystem: true })))).toEqual([
      ["current", ["DEMO"]],
      ["others", ["APP_RO", "HR", "scott"]],
      ["system", ["SYS", "SYSTEM"]],
    ]);
  });
  it("a system schema that is the current one shows even with system hidden, in the current section", () => {
    expect(names(buildSections(args({ current: "SYS" })))).toEqual([
      ["current", ["SYS"]],
      ["others", ["APP_RO", "DEMO", "HR", "scott"]],
    ]);
  });
  it("without a known current schema there is no current section", () => {
    expect(buildSections(args({ current: null })).map((s) => s.id)).toEqual(["others"]);
  });
  it("typing filters across sections and sorts by match quality, then name", () => {
    const s = buildSections(args({ query: "s", showSystem: true }));
    expect(names(s)).toEqual([
      ["others", ["scott"]],
      ["system", ["SYS", "SYSTEM"]],
    ]);
    // 'hr' is nobody's prefix but HR's: the section of the others holds only it
    expect(names(buildSections(args({ query: "hr" })))).toEqual([["others", ["HR"]]]);
    expect(buildSections(args({ query: "zzz" }))).toEqual([]);
  });
  it("labels the sections per DBMS and flags the rows", () => {
    const pg = buildSections({ choices: [c("public", { default: true }), c("shop")], driver: "postgres", current: "shop", query: "", showSystem: false, isVisible: (x) => x.name !== "public" });
    expect(pg.map((s) => s.label)).toEqual(["Current schema", "Schemas"]);
    expect(pg[0].rows[0]).toMatchObject({ current: true, visible: true });
    expect(pg[1].rows[0]).toMatchObject({ current: false, visible: false });
  });
  it("the arrow keys walk the flat list and wrap around", () => {
    const rows = flatRows(buildSections(args()));
    expect(rows.map((r) => r.choice.name)).toEqual(["DEMO", "APP_RO", "HR", "scott"]);
    expect(stepIndex(0, 1, 4)).toBe(1);
    expect(stepIndex(3, 1, 4)).toBe(0);
    expect(stepIndex(0, -1, 4)).toBe(3);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe("show / hide in the explorer (the schema filter)", () => {
  it("the default view shows every non-system user; hiding one stores the rest explicitly", () => {
    expect(isChoiceVisible(undefined, ORACLE, ORACLE[1])).toBe(true);
    expect(isChoiceVisible(undefined, ORACLE, ORACLE[4])).toBe(false);
    const hidden = toggledFilter(undefined, ORACLE, ORACLE[1], false)!;
    expect(JSON.parse(hidden)).toEqual([["DEMO"], ["APP_RO"], ["scott"]]);
    expect(isChoiceVisible(hidden, ORACLE, ORACLE[1])).toBe(false);
    expect(isChoiceVisible(hidden, ORACLE, ORACLE[0])).toBe(true);
  });
  it("showing it again is the default view again (nothing stored)", () => {
    const hidden = toggledFilter(undefined, ORACLE, ORACLE[1], false);
    expect(toggledFilter(hidden, ORACLE, ORACLE[1], true)).toBeUndefined();
  });
  it("showing a system user adds it to the explicit list", () => {
    const shown = toggledFilter(undefined, ORACLE, ORACLE[4], true)!;
    expect(JSON.parse(shown)).toContainEqual(["SYS"]);
    expect(isChoiceVisible(shown, ORACLE, ORACLE[4])).toBe(true);
  });
  it("PostgreSQL schemas keep their [database, schema] path", () => {
    const pg = [c("public", { path: ["db", "public"], default: true }), c("shop", { path: ["db", "shop"] })];
    expect(JSON.parse(toggledFilter(undefined, pg, pg[1], false)!)).toEqual([["db", "public"]]);
  });
  it("a user without objects has nothing to show: the toggle does not apply and switching to it changes no filter", () => {
    expect(hasNothingToShow(ORACLE[2])).toBe(true);
    expect(hasNothingToShow(ORACLE[1])).toBe(false);
    expect(hasNothingToShow(c("public"))).toBe(false);
    expect(filterShowing(JSON.stringify([["DEMO"]]), ORACLE, "APP_RO")).toBeNull();
  });
  it("switching to a hidden schema returns the filter that shows it; to a visible or unknown one, null", () => {
    const only = JSON.stringify([["DEMO"]]);
    const next = filterShowing(only, ORACLE, "HR")!;
    expect(JSON.parse(next.value!)).toEqual([["DEMO"], ["HR"]]);
    expect(filterShowing(only, ORACLE, "DEMO")).toBeNull();
    expect(filterShowing(only, ORACLE, "NOBODY")).toBeNull();
    // a system user is hidden in the default view
    expect(filterShowing(undefined, ORACLE, "SYS")).not.toBeNull();
    // the name patterns of the filter count: `!HR` hides it, showing it drops the pattern
    const byPattern = JSON.stringify({ paths: [["DEMO"]], patterns: ["!HR"] });
    expect(JSON.parse(filterShowing(byPattern, ORACLE, "HR")!.value!)).toEqual([["DEMO"], ["HR"]]);
  });
});
