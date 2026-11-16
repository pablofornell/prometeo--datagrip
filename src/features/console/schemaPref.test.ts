// @vitest-environment node
import { describe, expect, it } from "vitest";
import { forgetVisibleSchemas, resetVisibleSchemasCache, storeCurrentSchema, storedCurrentSchema } from "../../state/schema-filter";
import { savedSchema, saveSchema, saveSearchPath, savedSearchPath } from "./schemaPref";

describe("console schema preference", () => {
  it("is kept per data source and console, and can be forgotten", () => {
    expect(savedSchema("pg", "console")).toBeNull();
    saveSchema("pg", "console", "sales");
    saveSchema("pg", "console_1", "inventory");
    saveSchema("my", "console", "demo");
    expect(savedSchema("pg", "console")).toBe("sales");
    expect(savedSchema("pg", "console_1")).toBe("inventory");
    expect(savedSchema("my", "console")).toBe("demo");
    saveSchema("pg", "console", null);
    expect(savedSchema("pg", "console")).toBeNull();
    expect(savedSchema("pg", "console_1")).toBe("inventory");
  });
  it("a console without a choice of its own starts in the schema chosen for the data source in the explorer", () => {
    resetVisibleSchemasCache();
    expect(savedSchema("ora", "console")).toBeNull();
    storeCurrentSchema("ora", "HR");
    expect(savedSchema("ora", "console")).toBe("HR");
    expect(savedSchema("ora", "console_1")).toBe("HR");
    // the console's own choice wins, and forgetting it falls back to the data source's
    saveSchema("ora", "console", "SCOTT");
    expect(savedSchema("ora", "console")).toBe("SCOTT");
    saveSchema("ora", "console", null);
    expect(savedSchema("ora", "console")).toBe("HR");
    // another data source is unaffected; removing the data source forgets the choice
    expect(savedSchema("pg", "console_9")).toBeNull();
    forgetVisibleSchemas("ora");
    expect(storedCurrentSchema("ora")).toBeNull();
    expect(savedSchema("ora", "console")).toBeNull();
  });
  it("keeps the search_path text verbatim, per console", () => {
    saveSearchPath("pg", "console", '"$user", public');
    expect(savedSearchPath("pg", "console")).toBe('"$user", public');
    expect(savedSearchPath("pg", "console_1")).toBeNull();
    saveSearchPath("pg", "console", null);
    expect(savedSearchPath("pg", "console")).toBeNull();
  });
});
