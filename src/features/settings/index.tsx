/**
 * Settings dialog (operative pages: Database > Query Execution / Data Editor and Viewer, Appearance, Keymap, Editor >
 * General > Appearance / Font / Color Scheme > SQL / Code Style > SQL). The values live in `src/state/settings.ts` (+ the
 * theme in `state/theme.ts`); the keymap edits go to the action registry, the color scheme to `state/colorScheme.ts`.
 *
 *   openSettings(pageId?)   open the dialog (or jump to a page of the open one). Page ids: see ./model.ts
 *                           (`appearance`, `keymap`, `editor.font`, `editor.general.appearance`, `editor.color-scheme.sql`,
 *                           `editor.code-style.sql`, `database.query-execution`, `database.data-editor`).
 *
 * Action: `app.settings` (Ctrl+Alt+S).
 * UI scale actions: `view.zoomIn` (Ctrl+= / Ctrl++), `view.zoomOut` (Ctrl+-), `view.zoomReset` (Ctrl+0). The global keymap
 * dispatches them inside text fields and with a dialog open too; each shows the new scale on screen.
 */
import { render } from "solid-js/web";
import { showOsd } from "../../components/ui";
import { registerAction } from "../../state/actions";
import { UI_SCALE_DEFAULT, stepUiScale, zoomMessage } from "../../state/appearance";
import { loadLocal, saveUiState } from "../../state/persist";
import { settings, updateSettings } from "../../state/settings";
import { SettingsDialog } from "./SettingsDialog";
import { exportSettings, importSettings } from "./transfer";
import "./settings.css";

const LAST_PAGE_KEY = "settings.page";

let jump: ((id: string) => void) | null = null;
let isOpen = false;

export function openSettings(pageId?: string): void {
  if (isOpen) {
    if (pageId) jump?.(pageId);
    return;
  }
  isOpen = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <SettingsDialog
        initialPage={pageId ?? loadLocal<string>(LAST_PAGE_KEY, "appearance")}
        onPage={(id) => saveUiState(LAST_PAGE_KEY, id)}
        register={(f) => (jump = f)}
        onClose={() => {
          isOpen = false;
          jump = null;
          // let Solid finish the current event before the tree is torn down
          queueMicrotask(() => {
            dispose();
            host.remove();
          });
        }}
      />
    ),
    host,
  );
}

registerAction({
  id: "app.settings",
  title: "Settings…",
  shortcut: "Ctrl+Alt+S",
  icon: "settings",
  run: (ctx) => openSettings(typeof ctx === "string" ? ctx : undefined),
});

registerAction({
  id: "app.exportSettings",
  title: "Export Settings…",
  run: () => void exportSettings(),
});

registerAction({
  id: "app.importSettings",
  title: "Import Settings…",
  run: () => void importSettings(),
});

/** Sets the UI scale (percent) and tells the user. */
function setUiScale(percent: number): void {
  updateSettings({ uiScale: percent });
  showOsd(zoomMessage(percent));
}

registerAction({
  id: "view.zoomIn",
  title: "Zoom In (UI Scale)",
  shortcut: ["Ctrl+=", "Ctrl+Plus", "Ctrl+Shift+Plus"],
  run: () => setUiScale(stepUiScale(settings.uiScale, 1)),
});

registerAction({
  id: "view.zoomOut",
  title: "Zoom Out (UI Scale)",
  shortcut: "Ctrl+-",
  run: () => setUiScale(stepUiScale(settings.uiScale, -1)),
});

registerAction({
  id: "view.zoomReset",
  title: "Reset Zoom (UI Scale 100%)",
  shortcut: "Ctrl+0",
  run: () => setUiScale(UI_SCALE_DEFAULT),
});
