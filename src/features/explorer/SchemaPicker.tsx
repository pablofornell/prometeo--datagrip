/**
 * User/Schema selector: the popup of the console toolbar's schema button and of the explorer toolbar's. A searchable
 * list of every user (Oracle: ALL_USERS, with whether they own objects) / schema (PostgreSQL) / database (MySQL) the
 * account can reach, the current one first. Enter switches the session to the row (the backend quotes the identifier),
 * the eye of a row (or Ctrl+Enter) shows / hides it in the explorer, which is the schema filter of the data source:
 * the same UI-state store as Data Sources > Schemas, so neither reconnects. The logic is `schemaChoices.ts`.
 *
 * Not the badge popup of the explorer tree (`SchemaSelector.tsx`): that one edits the whole filter as a checkbox tree.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { type DataSource, type SchemaChoice, listSchemas } from "../../api/db";
import { ActionButton, Checkbox, Highlighted, Icon, TextField, notify } from "../../components/ui";
import { storeCurrentSchema, storedCurrentSchema } from "../../state/schema-filter";
import { activeSession, allSessions } from "../console/registry";
import { defaultSchemaName, visibleSchemasRaw } from "../datasource/schemas";
import { dsOf, ensureConnected, showSystemObjects } from "./core";
import { save } from "./schemaFilter";
import { type PickerRow, buildSections, canSwitchSchema, filterShowing, flatRows, hasNothingToShow, isChoiceVisible, schemaNouns, stepIndex, toggledFilter } from "./schemaChoices";

export interface SchemaPickerOptions {
  ds: DataSource;
  anchor: HTMLElement | { left: number; bottom: number };
  /** The schema the session is in (reactive); null when it is not known yet. */
  current: () => string | null;
  /** Switches to the schema; resolves to whether that worked (a failure is told to the user by the caller). */
  onPick?: (name: string) => Promise<boolean>;
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

function Picker(props: { opts: SchemaPickerOptions; rect: { left: number; bottom: number }; close: () => void }) {
  const ds = props.opts.ds;
  const nouns = schemaNouns(ds.driver);
  const switching = !!props.opts.onPick && canSwitchSchema(ds);
  const [choices, setChoices] = createSignal<SchemaChoice[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [showSystem, setShowSystem] = createSignal(showSystemObjects());
  const [active, setActive] = createSignal(0);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [raw, setRaw] = createSignal<string | undefined>(visibleSchemasRaw(ds) || undefined);
  let root!: HTMLDivElement;
  let input: HTMLInputElement | undefined;
  let alive = true;

  async function load() {
    setError(null);
    setChoices(null);
    try {
      await ensureConnected(ds.id);
      const list = await listSchemas(ds.id);
      if (alive) setChoices(list);
    } catch (e) {
      if (alive) setError(errText(e));
    }
  }

  const sections = createMemo(() => {
    const list = choices();
    if (!list) return [];
    return buildSections({
      choices: list,
      driver: ds.driver,
      // not known yet (no session opened): the server says where a new session starts
      current: props.opts.current() ?? list.find((c) => c.default)?.name ?? null,
      query: query(),
      showSystem: showSystem(),
      isVisible: (c) => isChoiceVisible(raw(), list, c),
    });
  });
  const rows = createMemo(() => flatRows(sections()));
  /** Index of the first row of each section, for the ids the list scrolls to. */
  const starts = createMemo(() => {
    let n = 0;
    return sections().map((s) => {
      const at = n;
      n += s.rows.length;
      return at;
    });
  });
  // a new search or list starts at the top
  createEffect(on([query, choices, showSystem], () => setActive(0)));
  createEffect(() => {
    const i = active();
    if (rows().length) root.querySelector(`[data-row="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  async function applyFilter(value: string | undefined): Promise<boolean> {
    const before = raw();
    setRaw(value);
    try {
      await save(ds, value);
      return true;
    } catch (e) {
      setRaw(before);
      notify({ kind: "error", title: `Cannot save the ${nouns.many} to show`, body: errText(e) });
      return false;
    }
  }

  async function toggle(r: PickerRow) {
    const list = choices();
    if (!list || hasNothingToShow(r.choice)) return;
    await applyFilter(toggledFilter(raw(), list, r.choice, !r.visible));
  }

  async function pick(r: PickerRow) {
    if (busy()) return;
    if (!switching) {
      await toggle(r);
      return;
    }
    if (r.current) {
      props.close();
      return;
    }
    setBusy(r.choice.name);
    const ok = await props.opts.onPick!(r.choice.name);
    setBusy(null);
    if (!ok || !alive) return;
    // the explorer must not hide the schema the console works in now
    const list = choices();
    const show = list ? filterShowing(raw(), list, r.choice.name) : null;
    if (show && (await applyFilter(show.value))) notify({ kind: "info", title: `${r.choice.name} is shown in the Database Explorer`, body: `It was hidden by the schema filter of ${ds.name}.` });
    props.close();
  }

  const onDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) props.close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const n = rows().length;
    const eat = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case "Escape":
        eat();
        props.close();
        break;
      case "ArrowDown":
        eat();
        setActive((i) => Math.max(0, stepIndex(i, 1, n)));
        break;
      case "ArrowUp":
        eat();
        setActive((i) => Math.max(0, stepIndex(i, -1, n)));
        break;
      case "PageDown":
        eat();
        setActive((i) => Math.min(n - 1, i + 8));
        break;
      case "PageUp":
        eat();
        setActive((i) => Math.max(0, i - 8));
        break;
      case "Home":
      case "End":
        // inside the search field they move its caret; with Ctrl they walk the list
        if (!e.ctrlKey && !e.metaKey) return;
        eat();
        setActive(e.key === "Home" ? 0 : Math.max(0, n - 1));
        break;
      case "Enter": {
        if ((e.target as HTMLElement | null)?.closest("button, [role=checkbox]")) return;
        eat();
        const r = rows()[active()];
        if (!r) return;
        if (e.ctrlKey || e.metaKey) void toggle(r);
        else void pick(r);
        break;
      }
    }
  };
  onMount(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    input?.focus();
    void load();
  });
  onCleanup(() => {
    alive = false;
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  });

  const width = 360;
  const left = Math.max(4, Math.min(props.rect.left, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(props.rect.bottom + 4, window.innerHeight - 420));
  const rowTitle = (c: SchemaChoice) =>
    c.hasObjects === null
      ? c.name
      : c.hasObjects
        ? `${c.name}: owns objects visible to your account`
        : `${c.name}: owns no objects visible to your account, so there is nothing to show in the explorer`;

  return (
    <div ref={root} class="dg-schemapick" style={{ left: left + "px", top: top + "px", width: width + "px" }} role="dialog" aria-label={nouns.title}>
      <div class="dg-schemapick-head">
        <span class="dg-schemapick-title">{nouns.title}</span>
        <ActionButton icon="refresh" title="Reload the list" onClick={() => void load()} />
      </div>
      <div class="dg-schemapick-search">
        <TextField
          ref={(el) => (input = el)}
          value={query()}
          onInput={setQuery}
          prefix={<Icon name="search" />}
          placeholder={`Search ${nouns.many}`}
          role="combobox"
          aria-expanded="true"
          aria-controls="dg-schemapick-list"
          aria-activedescendant={rows().length ? `dg-schemapick-row-${active()}` : undefined}
          aria-label={`Search ${nouns.many}`}
        />
      </div>
      <div class="dg-schemapick-list" id="dg-schemapick-list" role="listbox" aria-label={nouns.many}>
        <Show when={!error()} fallback={<ErrorState what={nouns.many} text={error()!} onRetry={() => void load()} />}>
          <Show when={choices()} fallback={<div class="dg-schemapick-state"><span class="dg-spinner" /> Loading {nouns.many}…</div>}>
            <Show
              when={rows().length}
              fallback={
                <div class="dg-schemapick-state">
                  {query().trim() ? `No ${nouns.many} match '${query().trim()}'.` : `No ${nouns.many} to show.`}
                  <Show when={!showSystem() && !query().trim()}> System {nouns.many} are hidden.</Show>
                </div>
              }
            >
              <For each={sections()}>
                {(section, si) => (
                  <>
                    <div class="dg-schemapick-section" role="presentation">
                      {section.label}
                    </div>
                    <For each={section.rows}>
                      {(r, ri) => {
                        const idx = () => starts()[si()] + ri();
                        const nothing = hasNothingToShow(r.choice);
                        return (
                          <div
                            id={`dg-schemapick-row-${idx()}`}
                            data-row={idx()}
                            class="dg-schemapick-row"
                            classList={{ "dg-active": active() === idx(), "dg-current": r.current, "dg-dim": nothing || !r.visible }}
                            role="option"
                            aria-selected={active() === idx()}
                            title={rowTitle(r.choice)}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseMove={() => active() !== idx() && setActive(idx())}
                            onClick={() => void pick(r)}
                          >
                            <Icon name={ds.driver === "oracle" ? "dg/user" : "dg/schema"} />
                            <span class="dg-schemapick-name">
                              <Highlighted text={r.choice.name} query={query().trim()} />
                            </span>
                            <Show when={r.current}>
                              <Icon name="checkmark" class="dg-schemapick-check" />
                            </Show>
                            <Show when={busy() === r.choice.name}>
                              <span class="dg-spinner" />
                            </Show>
                            <Show when={nothing}>
                              <span class="dg-schemapick-tag">no objects</span>
                            </Show>
                            <Show when={r.choice.default && !r.current}>
                              <span class="dg-schemapick-tag">default</span>
                            </Show>
                            <button
                              type="button"
                              class="dg-schemapick-eye"
                              disabled={nothing}
                              tabindex={-1}
                              aria-label={r.visible ? `Hide ${r.choice.name} in the Database Explorer` : `Show ${r.choice.name} in the Database Explorer`}
                              title={nothing ? "Owns no objects: nothing to show in the explorer" : r.visible ? "Shown in the Database Explorer. Click to hide (Ctrl+Enter)" : "Hidden in the Database Explorer. Click to show (Ctrl+Enter)"}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                void toggle(r);
                              }}
                            >
                              <Icon name={r.visible ? "show" : "hide"} />
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="dg-schemapick-foot">
        <Checkbox checked={showSystem()} onChange={setShowSystem} label={`Show system ${nouns.many}`} />
        <span class="dg-schemapick-hint">
          {switching ? "Enter: switch · Ctrl+Enter: show / hide" : "Enter: show / hide"}
        </span>
      </div>
    </div>
  );
}

/** The message stays plain selectable text: select it to copy it. */
function ErrorState(props: { what: string; text: string; onRetry: () => void }) {
  return (
    <div class="dg-schemapick-state dg-schemapick-error" role="alert">
      <div class="dg-schemapick-errhead">
        <Icon name="error" />
        <span>Cannot list the {props.what}</span>
      </div>
      <div class="dg-schemapick-errtext">{props.text}</div>
      <button type="button" class="dg-schemapick-retry" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}

let openPop: (() => void) | undefined;

/** Opens the selector under `opts.anchor`; one at a time. Focus goes back to where it was when it closes. */
export function openSchemaPicker(opts: SchemaPickerOptions): void {
  openPop?.();
  const rect = opts.anchor instanceof HTMLElement ? opts.anchor.getBoundingClientRect() : opts.anchor;
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  let dispose: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (openPop === close) openPop = undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
      if (before?.isConnected) before.focus();
    });
  };
  openPop = close;
  dispose = render(() => <Picker opts={opts} rect={{ left: rect.left, bottom: rect.bottom }} close={close} />, host);
}

// ---------------------------------------------------------------- the explorer's selector

const [pickTick, setPickTick] = createSignal(0);

/**
 * The schema the data source is in as far as the explorer knows: its active console's, else any console's, else the one
 * chosen for it in this selector, else the one a new session starts in as far as the data source tells (Oracle: the
 * login user, MySQL: the database; PostgreSQL's depends on the server's search_path: unknown, the selector asks).
 * Reactive.
 */
export function currentSchemaOfDs(ds: DataSource): string | null {
  pickTick();
  const a = activeSession();
  const s = a && a.dsId === ds.id ? a : allSessions().find((x) => x.dsId === ds.id);
  return s?.schema() ?? storedCurrentSchema(ds.id) ?? (ds.driver === "postgres" ? null : defaultSchemaName(ds) || null);
}

/**
 * Switches every open console of the data source to `name`, and makes it the schema the consoles opened later start
 * in. Resolves to whether it took effect (at least one console switched, or none is open).
 */
export async function switchDataSourceSchema(ds: DataSource, name: string): Promise<boolean> {
  const open = allSessions().filter((s) => s.dsId === ds.id);
  const results = await Promise.all(open.map((s) => s.switchSchema(name)));
  if (open.length && !results.some(Boolean)) return false;
  storeCurrentSchema(ds.id, name);
  setPickTick((t) => t + 1);
  if (!open.length) notify({ kind: "info", title: `${schemaNouns(ds.driver).title}: ${name}`, body: `No console of ${ds.name} is open. The consoles you open start in ${name}.` });
  return true;
}

/** The selector of the explorer toolbar for data source `dsId`. */
export function openExplorerSchemaPicker(dsId: string, anchor: HTMLElement): void {
  const ds = dsOf(dsId);
  if (!ds) return;
  openSchemaPicker({ ds, anchor, current: () => currentSchemaOfDs(ds), onPick: (name) => switchDataSourceSchema(ds, name) });
}
