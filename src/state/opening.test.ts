// @vitest-environment node
import { describe, expect, it } from "vitest";
import { beginOpening, isOpening } from "./opening";

describe("tabs that are opening", () => {
  it("is on between begin and end, and ending twice changes nothing", () => {
    expect(isOpening("t1")).toBe(false);
    const end = beginOpening("t1");
    expect(isOpening("t1")).toBe(true);
    expect(isOpening("t2")).toBe(false);
    end();
    expect(isOpening("t1")).toBe(false);
    end();
    expect(isOpening("t1")).toBe(false);
  });
  it("overlapping marks of one tab nest: it stays on until the last one ends", () => {
    const a = beginOpening("t1");
    const b = beginOpening("t1");
    a();
    expect(isOpening("t1")).toBe(true);
    a(); // the same mark again must not eat the other one
    expect(isOpening("t1")).toBe(true);
    b();
    expect(isOpening("t1")).toBe(false);
  });
});
