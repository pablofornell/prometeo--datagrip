// @vitest-environment node
/**
 * The data source folder nodes of the tree. The shared Tree draws `item.icon` from the shared icon kit; the explorer-local
 * folder icon (`x:` key) is not in that kit, so a top-level `icon` made an `<img>` without `src` (a broken-image box that
 * shows at some UI scales). The explorer draws node icons from `data.icon` in the label, so the item must have no `icon`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../state/ds-folders", () => ({ dsFolders: () => ["Work"], dsGroupOf: () => undefined }));
vi.mock("../../components/ui", () => ({ notify: () => {} }));

const { treeRoots } = await import("./core");
const { hasIcon } = await import("../../components/ui/icons");

describe("data source folder node", () => {
  const folder = treeRoots().find((n) => n.id === "dsfolder:Work")!;

  it("is in the tree roots", () => {
    expect(folder).toBeDefined();
  });

  it("leaves the Tree-level icon empty, or names an icon of the shared kit", () => {
    expect(folder.icon === undefined || hasIcon(folder.icon)).toBe(true);
  });

  it("keeps the folder icon in the node data for the label", () => {
    expect(folder.data.icon).toBeTruthy();
  });
});
