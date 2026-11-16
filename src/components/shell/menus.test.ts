// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../ui/Menu";

// the menu structure is pure data: keep the explorer / import feature modules (and their DOM needs) out of it
vi.mock("../../features/explorer/core", () => ({ selectedNode: () => undefined }));
vi.mock("../../features/import/target", () => ({ importTargetOf: () => null }));
// `../ui` is a barrel of every widget (dialogs, grid, editor ...): importing it is what made the first import slow.
// menus.ts only needs `notify` from it.
vi.mock("../ui", () => ({ notify: () => {} }));
vi.mock("../../api/tauri", () => ({ openLogFolder: async () => {} }));
vi.mock("../../api/db", () => ({ getUiState: async () => null, setUiState: async () => {} })); // the layout's persistence

let MAIN_MENU: typeof import("./menus").MAIN_MENU;
let GEAR_MENU: typeof import("./menus").GEAR_MENU;

beforeAll(async () => {
  const doc = { activeElement: null, querySelector: () => null, addEventListener: () => {} };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined, document: doc };
  ({ MAIN_MENU, GEAR_MENU } = await import("./menus"));
  // the module graph is kept small by the mocks above (it used to pull the whole UI); the larger limit is only a margin
  // for a loaded CI machine: a real failure of the import still rejects the hook at once
}, 30_000);

/** Letters (lower-cased) that share a mnemonic among the items of one menu level. */
function clashes(items: MenuItem[], where: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const it of items) {
    if (it.type) continue;
    const label = it.label ?? it.action ?? "?";
    const m = it.mnemonic?.toLowerCase();
    if (m) {
      const prev = seen.get(m);
      if (prev) out.push(`${where}: "${m}" used by ${prev} and ${label}`);
      else seen.set(m, label);
    }
    if (it.children) out.push(...clashes(it.children, `${where} > ${label}`));
  }
  return out;
}

describe("main menu mnemonics", () => {
  it("are unique among the bar entries", () => {
    const letters = MAIN_MENU.map((m) => m.mnemonic.toLowerCase());
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("are unique inside every menu and submenu", () => {
    const all = MAIN_MENU.flatMap((m) => clashes(m.items, m.label));
    expect(all).toEqual([]);
  });
});

describe("gear menu", () => {
  it("offers About after the layout reset", () => {
    const actions = GEAR_MENU.map((it) => ("action" in it ? it.action : undefined)).filter(Boolean);
    expect(actions).toEqual(["app.settings", "app.themePopup", "app.keymapPopup", "window.resetLayout", "help.about"]);
  });
});

describe("View menu", () => {
  it("has the UI scale entries", () => {
    const view = MAIN_MENU.find((m) => m.label === "View")!;
    const actions = view.items.map((it) => ("action" in it ? it.action : undefined));
    expect(actions).toEqual(expect.arrayContaining(["view.zoomIn", "view.zoomOut", "view.zoomReset"]));
  });
});
