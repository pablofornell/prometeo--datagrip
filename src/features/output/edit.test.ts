// @vitest-environment node
import { describe, expect, it } from "vitest";
import { logSubmitted, oneLine } from "./edit";

describe("oneLine", () => {
  it("joins the lines of a statement with one space", () => {
    expect(oneLine("UPDATE shop.t\nSET a = 1,\n    b = 2\nWHERE id = 3;")).toBe("UPDATE shop.t SET a = 1, b = 2 WHERE id = 3;");
    expect(oneLine("DELETE\r\nFROM t\r\nWHERE a = 1;")).toBe("DELETE FROM t WHERE a = 1;");
  });

  it("keeps a line break that is part of a value", () => {
    expect(oneLine("INSERT INTO t (a)\nVALUES ('line1\n  line2');")).toBe("INSERT INTO t (a) VALUES ('line1\n  line2');");
    expect(oneLine('SELECT "a\nb"\nFROM t')).toBe('SELECT "a\nb" FROM t');
    // a doubled quote does not end the literal
    expect(oneLine("INSERT INTO t (a)\nVALUES ('it''s\nhere');")).toBe("INSERT INTO t (a) VALUES ('it''s\nhere');");
  });
});

describe("logSubmitted", () => {
  it("logs each statement on one line, then the outcome", () => {
    const lines: [string, string][] = [];
    logSubmitted((k, t) => lines.push([k, t]), "p", ["DELETE\nFROM t\nWHERE a = 'x\ny';"], { rowsAffected: 1, ms: 5 });
    expect(lines[0]).toEqual(["sql", "DELETE FROM t WHERE a = 'x\ny';"]);
    expect(lines[1][0]).toBe("text");
    const failed: [string, string][] = [];
    logSubmitted((k, t) => failed.push([k, t]), "p", [], { error: "boom" });
    expect(failed).toEqual([["error", "boom"]]);
  });
});
