/**
 * Quick column search bar ("Find Column", above the grid): a field that narrows the grid to the columns whose name
 * matches, with the `n of m columns` hint and previous / next / close. Presentational; the grid owns state and matching
 * (`columnSearch.ts`). Also `MatchedText`, the column name with the matched characters highlighted.
 */
import { For, Show, onMount, type JSX } from "solid-js";
import type { Range } from "../ui/speedMatch";
import { columnSearchHint } from "./columnSearch";
import "./grid.css";

export interface ColumnSearchBarProps {
  query: string;
  /** Columns the search leaves in the grid / columns Manage Columns leaves visible. */
  shown: number;
  total: number;
  /** Called after mount with a focus function (re-focus on a repeated shortcut). */
  focusRef?: (focus: () => void) => void;
  onQuery: (q: string) => void;
  /** Enter / Down = 1, Shift+Enter / Up = -1: select the next / previous shown column. */
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}

export function ColumnSearchBar(props: ColumnSearchBarProps): JSX.Element {
  let input!: HTMLInputElement;
  const searching = () => props.query.trim().length > 0;
  const noMatch = () => searching() && props.shown === 0;
  onMount(() => {
    const focus = () => {
      input.focus();
      input.select();
    };
    props.focusRef?.(focus);
    focus();
  });
  return (
    <div
      class="dgg-cs"
      role="search"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <i class="dgg-i i-colFilter dgg-cs-ico" />
      <div class="dgg-cs-field">
        <input
          ref={input}
          class="dgg-cs-input"
          classList={{ err: noMatch() }}
          value={props.query}
          placeholder="Find column"
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => props.onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            // the shortcut that opens the bar (modified keys) goes on to the global keymap; typing stays in the field
            if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopPropagation();
            if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              props.onStep(e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onClose();
            }
          }}
        />
        <Show when={props.query}>
          <button class="dgg-cs-clear" title="Clear" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => (props.onQuery(""), input.focus())} />
        </Show>
      </div>
      <span class="dgg-cs-hint" classList={{ err: noMatch() }} role="status">
        {noMatch() ? "No columns match" : columnSearchHint(props.shown, props.total, searching())}
      </span>
      <button class="dgg-fbtn arr up" title="Previous Column  Shift+Enter" tabIndex={-1} disabled={props.shown === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStep(-1)} />
      <button class="dgg-fbtn arr down" title="Next Column  Enter" tabIndex={-1} disabled={props.shown === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onStep(1)} />
      <span class="dgg-find-spacer" />
      <button class="dgg-find-close" title="Close  Escape" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onClose()} />
    </div>
  );
}

/** A column name with the matched ranges highlighted (plain text without ranges). */
export function MatchedText(props: { text: string; ranges?: Range[] }): JSX.Element {
  const parts = () => {
    const r = props.ranges;
    if (!r || !r.length) return null;
    const out: { t: string; m: boolean }[] = [];
    let p = 0;
    for (const [a, b] of r) {
      if (a > p) out.push({ t: props.text.slice(p, a), m: false });
      out.push({ t: props.text.slice(a, b), m: true });
      p = b;
    }
    if (p < props.text.length) out.push({ t: props.text.slice(p), m: false });
    return out;
  };
  return (
    <Show when={parts()} fallback={<>{props.text}</>}>
      {(ps) => <For each={ps()}>{(s) => (s.m ? <mark class="dg-search-match">{s.t}</mark> : <>{s.t}</>)}</For>}
    </Show>
  );
}
