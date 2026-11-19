/** Permissions tab: read and write per folder and per data source; a data source rule overrides its folder's. */
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { Button, Icon, TextField, tip } from "../../components/ui";
import { dsFolders } from "../../state/ds-folders";
import { dsIconUrl } from "../output/dsicon";
import { confirmDialog } from "./confirm";
import { type PermGroup, type PermRow, NO_PERM, READ_ONLY_NOTE, originLabel, permissionGroups, plural, summarize, toggled } from "./model";
import { configure, effectiveOf, livePolicy, loadPolicy, permSources, policyError, policyReady, revokeAll, setFolderPerm, setSourcePerm, status } from "./store";
import { type PermState, Chip, EmptyState, PermToggle } from "./widgets";

const READ_ONLY_TIP = "This data source is read-only in its settings: agents never get write access to it.";

function FolderRow(props: { g: PermGroup; collapsed: boolean; onToggle: () => void }): JSX.Element {
  const g = () => props.g;
  const name = () => g().folder!;
  const rule = () => g().rule ?? NO_PERM;
  const state = (k: "read" | "write"): PermState => (rule()[k] ? "on" : "off");
  return (
    <div class="dg-mcp-prow dg-mcp-prow-folder" role="row" data-write={rule().write ? "true" : undefined}>
      <div class="dg-mcp-pname" role="rowheader">
        <button type="button" class="dg-mcp-fold" aria-expanded={!props.collapsed} aria-label={(props.collapsed ? "Expand " : "Collapse ") + name()} onClick={props.onToggle}>
          <Icon name={props.collapsed ? "chevron-right" : "chevron-down"} />
        </button>
        <Icon name="folder" />
        <span class="dg-mcp-pname-text">{name()}</span>
        <span class="dg-mcp-count">{g().total}</span>
      </div>
      <div class="dg-mcp-pcell" role="cell">
        <PermToggle kind="read" state={state("read")} label={"for folder " + name()} title="Read: list schemas and tables, describe tables, run queries (read-only connection)" onToggle={() => setFolderPerm(name(), toggled(rule(), "read"))} />
        <PermToggle kind="write" state={state("write")} label={"for folder " + name()} title="Write: run one statement at a time, committed at once" onToggle={() => setFolderPerm(name(), toggled(rule(), "write"))} />
      </div>
      <div class="dg-mcp-pnote" role="cell">
        <Show when={g().rule} fallback={<span class="dg-mcp-muted">no rule</span>}>
          <span>folder rule</span>
          <button type="button" class="dg-mcp-iconbtn" aria-label={`Remove the rule of ${name()}`} {...tip("Remove the rule of this folder")} onClick={() => setFolderPerm(name(), null)}>
            <Icon name="revert" />
          </button>
        </Show>
      </div>
    </div>
  );
}

function SourceRow(props: { row: PermRow; folder: string | null; indented: boolean }): JSX.Element {
  const r = () => props.row;
  const src = () => r().src;
  const folderRule = () => (props.folder ? livePolicy().folderRules[props.folder] : undefined);

  const state = (k: "read" | "write"): PermState => {
    if (k === "write" && src().readOnly) return "locked";
    if (r().own) return r().own![k] ? "on" : "off";
    return r().eff.origin === "folder" && r().eff[k] ? "inherited" : "off";
  };
  const toggle = (k: "read" | "write") => {
    const base = r().own ?? folderRule() ?? NO_PERM;
    const next = toggled(base, k);
    setSourcePerm(src().id, { read: next.read, write: next.write && !src().readOnly });
  };
  const note = () => originLabel(r(), props.folder);
  const hasOwn = () => !!r().own;
  return (
    <div class="dg-mcp-prow" classList={{ "dg-indent": props.indented }} role="row" data-write={r().eff.write ? "true" : undefined} data-origin={r().eff.origin}>
      <div class="dg-mcp-pname" role="rowheader">
        <span class="dg-mcp-dsicon" classList={{ "dg-colored": !!src().color }} style={src().color ? { "--dg-mcp-ds-color": src().color! } : undefined}>
          <Icon src={src().driver ? dsIconUrl(src().driver as never) : undefined} name={src().driver ? undefined : "dg/dbms"} />
        </span>
        <span class="dg-mcp-pname-text">{src().name}</span>
        <Show when={src().readOnly}>
          <Chip tone="neutral" icon="dg/locked" title={READ_ONLY_TIP}>
            read-only
          </Chip>
        </Show>
      </div>
      <div class="dg-mcp-pcell" role="cell">
        <PermToggle kind="read" state={state("read")} label={"for " + src().name} onToggle={() => toggle("read")} title={state("read") === "inherited" ? `Read, from the folder ${props.folder}. Click to set a rule of its own.` : undefined} />
        <PermToggle
          kind="write"
          state={state("write")}
          label={"for " + src().name}
          onToggle={() => toggle("write")}
          title={src().readOnly ? READ_ONLY_TIP : state("write") === "inherited" ? `Write, from the folder ${props.folder}. Click to set a rule of its own.` : undefined}
        />
      </div>
      <div class="dg-mcp-pnote" role="cell" classList={{ "dg-inherited": r().eff.origin === "folder", "dg-own": hasOwn() }}>
        <span classList={{ "dg-mcp-muted": !hasOwn() }}>{note()}</span>
        <Show when={hasOwn()}>
          <button
            type="button"
            class="dg-mcp-iconbtn"
            aria-label={`Remove the rule of ${src().name}`}
            {...tip(props.folder ? `Remove this rule: follow the folder ${props.folder}` : "Remove this rule: no access")}
            onClick={() => setSourcePerm(src().id, null)}
          >
            <Icon name="revert" />
          </button>
        </Show>
      </div>
    </div>
  );
}

export function PermissionsTab(): JSX.Element {
  const [filter, setFilter] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const groups = createMemo(() => permissionGroups(permSources(), dsFolders(), livePolicy(), filter(), effectiveOf));
  const all = createMemo(() => summarize(permissionGroups(permSources(), dsFolders(), livePolicy(), "", effectiveOf).flatMap((g) => g.rows)));
  const hasFolders = () => dsFolders().length > 0;
  const ruleCount = () => {
    const p = livePolicy();
    return Object.keys(p.folderRules).length + Object.keys(p.sourceRules).length;
  };
  const q = () => filter().trim() !== "";
  const toggleFold = (f: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(f)) n.delete(f);
      else n.add(f);
      return n;
    });

  const revoke = async () => {
    const ok = await confirmDialog({
      title: "Revoke All Access",
      confirmLabel: "Revoke",
      message: <p>Every folder and data source rule is removed: agents will not see any data source until you grant access again.</p>,
    });
    if (ok) revokeAll();
  };

  return (
    <Show
      when={policyReady()}
      fallback={
        <EmptyState icon={policyError() ? "error" : "dg/gold-key"} title={policyError() ? "Cannot read the permissions" : "Loading the permissions…"} actions={<Show when={policyError()}><Button onClick={() => void loadPolicy()}>Retry</Button></Show>}>
          {policyError() ?? "Nothing can be changed before the current rules are known."}
        </EmptyState>
      }
    >
    <div class="dg-mcp-perms">
      <div class="dg-mcp-toolbar">
        <TextField
          frameClass="dg-mcp-search"
          placeholder="Filter data sources"
          aria-label="Filter data sources"
          value={filter()}
          onInput={setFilter}
          prefix={<Icon name="search" />}
          suffix={
            <Show when={filter()}>
              <button type="button" class="dg-mcp-iconbtn" aria-label="Clear the filter" onClick={() => setFilter("")}>
                <Icon name="close-small" />
              </button>
            </Show>
          }
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter()) {
              e.stopPropagation();
              setFilter("");
            }
          }}
        />
        <span class="dg-mcp-tb-spacer" />
        <span class="dg-mcp-legend">
          <Chip tone="info">{all().read + all().readwrite} read</Chip>
          <Chip tone="warning">{all().write + all().readwrite} write</Chip>
          <Chip tone="neutral">{all().none} no access</Chip>
        </span>
        <Button class="dg-mcp-danger" disabled={ruleCount() === 0} onClick={() => void revoke()}>
          Revoke all
        </Button>
      </div>
      <Show when={status() && !status()!.enabled}>
        <div class="dg-mcp-banner" data-tone="info">
          <Icon name="info" />
          <span>The MCP server is off. These rules apply as soon as you turn it on.</span>
          <Button class="dg-mcp-small" onClick={() => void configure(true, status()!.port)}>
            Enable
          </Button>
        </div>
      </Show>
      <div class="dg-mcp-ptable" role="table" aria-label="Permissions">
        <div class="dg-mcp-prow dg-mcp-phead" role="row">
          <div class="dg-mcp-pname" role="columnheader">
            Data source
          </div>
          <div class="dg-mcp-pcell" role="columnheader">
            Agents may
          </div>
          <div class="dg-mcp-pnote" role="columnheader">
            Rule
          </div>
        </div>
        <div class="dg-mcp-scroll dg-mcp-pbody" data-focus-target tabindex={-1}>
          <Show
            when={permSources().length}
            fallback={
              <EmptyState icon="dg/dbms" title="No data sources yet">
                Add a data source in the Database Explorer, then choose here what agents may do with it.
              </EmptyState>
            }
          >
            <Show
              when={groups().length}
              fallback={
                <EmptyState compact icon="search" title="No match">
                  No data source or folder matches “{filter().trim()}”.
                </EmptyState>
              }
            >
              <For each={groups()}>
                {(g) => (
                  <div role="rowgroup" class="dg-mcp-pgroup">
                    <Show
                      when={g.folder !== null}
                      fallback={
                        <Show when={hasFolders()}>
                          <div class="dg-mcp-pgroup-title">No folder</div>
                        </Show>
                      }
                    >
                      <FolderRow g={g} collapsed={!q() && collapsed().has(g.folder!)} onToggle={() => toggleFold(g.folder!)} />
                    </Show>
                    <Show when={q() || g.folder === null || !collapsed().has(g.folder)}>
                      <For each={g.rows}>{(row) => <SourceRow row={row} folder={g.folder} indented={g.folder !== null} />}</For>
                      <Show when={g.folder !== null && g.rows.length === 0}>
                        <div class="dg-mcp-prow-empty">{g.total === 0 ? "Empty folder. Move data sources into it from the Database Explorer." : "No data source matches."}</div>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
      <footer class="dg-mcp-pfoot">
        <Icon name="info-outline" />
        <span>
          Agents get <b>no access</b> unless a rule grants it. A data source rule overrides its folder rule; write is never granted to a read-only data source.
          {" "}
          {plural(ruleCount(), "rule")} set.
        </span>
      </footer>
      <footer class="dg-mcp-pfoot dg-mcp-pfoot-tip">
        <Icon name="intention-bulb" />
        <span>{READ_ONLY_NOTE}</span>
      </footer>
    </div>
    </Show>
  );
}
