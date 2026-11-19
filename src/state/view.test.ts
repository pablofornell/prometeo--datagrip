// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let view: typeof import("./view");
let layout: typeof import("./layout");

beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  (globalThis as Record<string, unknown>).document = { activeElement: null, querySelector: () => null };
  view = await import("./view");
  layout = await import("./layout");
});

beforeEach(() => view.leaveAppView());

describe("workspace view", () => {
  it("starts in the editor", () => {
    expect(view.appView()).toBe("editor");
    expect(view.isMcpView()).toBe(false);
  });

  it("switches to the MCP view and back", () => {
    view.setAppView("mcp");
    expect(view.isMcpView()).toBe(true);
    view.leaveAppView();
    expect(view.appView()).toBe("editor");
  });

  it("Restore Default Layout leaves the MCP view", () => {
    view.setAppView("mcp");
    layout.resetLayout();
    expect(view.appView()).toBe("editor");
  });
});

describe("tool windows behind the MCP view", () => {
  beforeEach(() => {
    for (const t of layout.TOOL_WINDOWS) layout.hideToolWindow(t.id);
    layout.setBodyBox(1600, 900);
  });

  it("showing, focusing or toggling a window at the right or bottom brings the editor back", () => {
    layout.showToolWindow("files", false);
    for (const act of [() => layout.showToolWindow("files", false), () => layout.focusToolWindow("files"), () => layout.toggleToolWindow("files")]) {
      view.setAppView("mcp");
      act();
      expect(view.appView()).toBe("editor");
      expect(layout.layout.visible.files).toBe(true); // brought up, not hidden
    }
  });

  it("a left window keeps the MCP view", () => {
    view.setAppView("mcp");
    layout.showToolWindow("explorer", false);
    layout.focusToolWindow("explorer");
    expect(view.appView()).toBe("mcp");
  });
});

describe("left column in the MCP view", () => {
  it("keeps a wide explorer and narrows it on a small window", () => {
    expect(view.mcpLeftWidth(490, 1600, 160)).toBe(490);
    expect(view.mcpLeftWidth(490, 900, 160)).toBe(340);
    expect(view.mcpLeftWidth(490, 600, 160)).toBe(160);
  });

  it("no left window, no column", () => {
    expect(view.mcpLeftWidth(0, 900, 160)).toBe(0);
  });
});
