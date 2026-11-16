import { Show, createMemo, type JSX } from "solid-js";
import { ActionButton, Icon, type MenuItem, SpeedSearchField, ToolbarSeparator, matchRanges, openMenu } from "../../components/ui";
import { newMenuItems } from "./actions";
import { dataSourceDialogAvailable, dataSourceProperties } from "./commands";
import { controller, dsOf, searchQuery, selectedNode, setShowSystemObjects, setSortAlphabetically, showSystemObjects, sortAlphabetically } from "./core";
import { currentSchemaOfDs, openExplorerSchemaPicker } from "./SchemaPicker";
import { schemaNouns } from "./schemaChoices";

const sep: MenuItem = { type: "separator" };

/** The 34px toolbar under the header: New, Data Source Properties | Refresh, Deactivate | Console, Edit Data, DDL | View Options. */
export function ExplorerToolbar(): JSX.Element {
  let newBtn!: HTMLButtonElement;
  let viewBtn!: HTMLButtonElement;
  let schemaBtn!: HTMLButtonElement;
  const schemaDs = createMemo(() => {
    const id = selectedNode()?.data.dsId;
    return id ? dsOf(id) : undefined;
  });
  const noMatch = () => !matchRanges(selectedNode()?.label ?? "", searchQuery());
  return (
    <div class="dg-toolbar dg-tw-toolbar dg-explorer-toolbar">
      <ActionButton
        icon="add"
        title="New"
        dropdown
        ref={(el) => (newBtn = el)}
        onClick={() => openMenu(newMenuItems(), { anchor: newBtn, title: "New", compact: true, minWidth: 290 })}
      />
      <ActionButton
        icon="dg/manage-data-sources"
        title="Data Sources…"
        shortcut="Ctrl+Alt+Shift+S"
        disabled={!dataSourceDialogAvailable()}
        onClick={() => dataSourceProperties(selectedNode()?.data.dsId)}
      />
      <ToolbarSeparator />
      <ActionButton icon="refresh" action="db.refresh" />
      <ActionButton icon="dg/kill-process" action="db.disconnect" />
      <ToolbarSeparator />
      <ActionButton icon="dg/console" action="db.jumpToConsole" />
      <ActionButton icon="dg/edit-data" action="db.editData" />
      <ActionButton class="dg-explorer-ddl" action="db.gotoDdl" title="Go to DDL">
        DDL
      </ActionButton>
      <ToolbarSeparator />
      <ActionButton
        icon="show"
        title="View Options"
        dropdown
        ref={(el) => (viewBtn = el)}
        onClick={() =>
          openMenu(
            [
              { label: "Show System Schemas", checked: () => showSystemObjects(), run: () => setShowSystemObjects(!showSystemObjects()) },
              sep,
              { label: "Sort Alphabetically", checked: () => sortAlphabetically(), run: () => setSortAlphabetically(!sortAlphabetically()) },
            ],
            { anchor: viewBtn },
          )
        }
      />
      {/* the User/Schema selector of the selected data source (same popup as the console's) */}
      <Show when={schemaDs()}>
        {(ds) => (
          <button
            ref={schemaBtn}
            type="button"
            class="dg-schemabtn"
            title={`${schemaNouns(ds().driver).title}: ${currentSchemaOfDs(ds()) ?? "not known yet"}. Switch the current ${schemaNouns(ds().driver).one} of ${ds().name}, show or hide it in the explorer`}
            aria-haspopup="listbox"
            onClick={() => openExplorerSchemaPicker(ds().id, schemaBtn)}
          >
            <Icon name="dg/schema" size={16} />
            <span>{currentSchemaOfDs(ds()) ?? `<${schemaNouns(ds().driver).one}>`}</span>
            <Icon name="chevron-down" size={16} />
          </button>
        )}
      </Show>
      <Show when={searchQuery()}>
        <div class="dg-explorer-search">
          <SpeedSearchField
            query={searchQuery()}
            noMatch={noMatch()}
            filterMode={controller()?.filterMode()}
            onToggleFilter={() => controller()?.setFilterMode(!controller()!.filterMode())}
          />
        </div>
      </Show>
    </div>
  );
}

/** Header buttons (visible on hover): select opened object, expand all, collapse all. */
export function ExplorerHeaderActions(): JSX.Element {
  return (
    <>
      <ActionButton icon="locate" action="explorer.locate" />
      <ActionButton icon="expand-all" action="explorer.expandAll" />
      <ActionButton icon="collapse-all" action="explorer.collapseAll" />
    </>
  );
}
