// @vitest-environment node
import { describe, expect, it } from "vitest";
import { columnSearchHint, matchColumnName, matchColumns, stepColumnPos } from "./columnSearch";

const cols = ["id", "user_id", "user_name", "Created_At", "orderItems", "email"].map((name) => ({ name }));
const all = cols.map((_, i) => i);

describe("matchColumnName", () => {
  it("is a case-insensitive substring match with the matched range", () => {
    expect(matchColumnName("Created_At", "created")).toEqual([[0, 7]]);
    expect(matchColumnName("user_name", "NAME")).toEqual([[5, 9]]);
    expect(matchColumnName("email", "zz")).toBeNull();
  });
  it("falls back to word initials", () => {
    expect(matchColumnName("order_items", "oi")).toEqual([[0, 1], [6, 7]]);
    expect(matchColumnName("orderItems", "oi")).toEqual([[0, 1], [5, 6]]);
  });
  it("needs every word of the query and ignores their order", () => {
    expect(matchColumnName("user_id", "user id")).toEqual([[0, 4], [5, 7]]);
    expect(matchColumnName("user_id", "id user")).toEqual([[0, 4], [5, 7]]);
    expect(matchColumnName("user_name", "user id")).toBeNull();
  });
  it("merges overlapping and touching ranges", () => {
    expect(matchColumnName("user_name", "user us")).toEqual([[0, 4]]);
    expect(matchColumnName("username", "user name")).toEqual([[0, 8]]);
  });
  it("matches everything, with no range, for a blank query", () => {
    expect(matchColumnName("id", "")).toEqual([]);
    expect(matchColumnName("id", "   ")).toEqual([]);
  });
});

describe("matchColumns", () => {
  it("keeps the order of the candidates", () => {
    expect(matchColumns(cols, all, "id").map((m) => m.ci)).toEqual([0, 1]);
    expect(matchColumns(cols, [5, 2, 1], "user").map((m) => m.ci)).toEqual([2, 1]);
  });
  it("only looks at the candidates: columns hidden by Manage Columns stay hidden", () => {
    expect(matchColumns(cols, [0, 2, 3], "user").map((m) => m.ci)).toEqual([2]);
    expect(matchColumns(cols, [], "user")).toEqual([]);
  });
  it("returns every candidate for a blank query and nothing when no name matches", () => {
    expect(matchColumns(cols, all, " ").map((m) => m.ci)).toEqual(all);
    expect(matchColumns(cols, all, "nope")).toEqual([]);
  });
  it("skips candidates that are not columns", () => {
    expect(matchColumns(cols, [0, 99], "id").map((m) => m.ci)).toEqual([0]);
  });
  it("reports the ranges to highlight", () => {
    expect(matchColumns(cols, all, "name")).toEqual([{ ci: 2, ranges: [[5, 9]] }]);
  });
});

describe("columnSearchHint", () => {
  it("reads n of m while searching and m otherwise", () => {
    expect(columnSearchHint(3, 30, true)).toBe("3 of 30 columns");
    expect(columnSearchHint(0, 30, true)).toBe("0 of 30 columns");
    expect(columnSearchHint(30, 30, false)).toBe("30 columns");
    expect(columnSearchHint(1, 1, false)).toBe("1 column");
  });
});

describe("stepColumnPos", () => {
  it("starts at the first / last column when none is current", () => {
    expect(stepColumnPos(4, null, 1)).toBe(0);
    expect(stepColumnPos(4, null, -1)).toBe(3);
    expect(stepColumnPos(4, 9, 1)).toBe(0);
  });
  it("wraps around", () => {
    expect(stepColumnPos(4, 3, 1)).toBe(0);
    expect(stepColumnPos(4, 0, -1)).toBe(3);
    expect(stepColumnPos(4, 1, 1)).toBe(2);
  });
  it("is -1 with nothing shown", () => {
    expect(stepColumnPos(0, null, 1)).toBe(-1);
  });
});
