import { describe, expect, it } from "vitest";
import { layoutPhase, loadPhase } from "./phases";

describe("diagram phase lines", () => {
  it("names the connection first, then the metadata read", () => {
    expect(loadPhase(false, "prod")).toBe("Connecting to prod…");
    expect(loadPhase(true, "prod")).toBe("Reading schema metadata…");
  });
  it("counts the tables being laid out", () => {
    expect(layoutPhase(120)).toBe("Laying out 120 tables…");
    expect(layoutPhase(1)).toBe("Laying out 1 table…");
  });
});
