// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/db", () => ({ getUiState: async () => undefined, setUiState: async () => undefined }));

import { type DsFolderChange, addDsFolder, dsFolders, dsGroupOf, forgetDsGroup, moveToDsFolder, onDsFolderChange, removeDsFolder, renameDsFolder, resetDsFolders } from "./ds-folders";

beforeEach(() => resetDsFolders());

describe("data source folders", () => {
  it("creates folders alphabetically and refuses empty or duplicate names", () => {
    expect(addDsFolder("prod")).toBe("prod");
    expect(addDsFolder(" Dev ")).toBe("Dev");
    expect(addDsFolder("PROD")).toBeNull();
    expect(addDsFolder("  ")).toBeNull();
    expect(dsFolders()).toEqual(["Dev", "prod"]);
  });

  it("moves a data source in and out of a folder", () => {
    addDsFolder("prod");
    moveToDsFolder("a", "prod");
    expect(dsGroupOf("a")).toBe("prod");
    moveToDsFolder("a", null);
    expect(dsGroupOf("a")).toBeUndefined();
    moveToDsFolder("a", "nope");
    expect(dsGroupOf("a")).toBeUndefined();
  });

  it("renaming keeps the members, removing frees them", () => {
    addDsFolder("prod");
    addDsFolder("dev");
    moveToDsFolder("a", "prod");
    expect(renameDsFolder("prod", "live")).toBe(true);
    expect(dsGroupOf("a")).toBe("live");
    expect(renameDsFolder("live", "dev")).toBe(false);
    removeDsFolder("live");
    expect(dsGroupOf("a")).toBeUndefined();
    expect(dsFolders()).toEqual(["dev"]);
  });

  it("forgets a removed data source", () => {
    addDsFolder("prod");
    moveToDsFolder("a", "prod");
    forgetDsGroup("a");
    expect(dsGroupOf("a")).toBeUndefined();
  });

  it("announces renamed and removed folders", () => {
    const seen: DsFolderChange[] = [];
    const off = onDsFolderChange((c) => seen.push(c));
    addDsFolder("prod");
    renameDsFolder("prod", "live");
    renameDsFolder("live", "LIVE"); // a case change is a rename too
    renameDsFolder("LIVE", "LIVE"); // same name: nothing changed
    renameDsFolder("nope", "x"); // unknown folder: refused, nothing announced
    removeDsFolder("LIVE");
    off();
    removeDsFolder("again");
    expect(seen).toEqual([
      { type: "rename", from: "prod", to: "live" },
      { type: "rename", from: "live", to: "LIVE" },
      { type: "remove", name: "LIVE" },
    ]);
  });
});
