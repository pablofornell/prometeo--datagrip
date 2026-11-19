/**
 * Speed search helpers shared by trees and lists: matching (substring, then word-start initials),
 * the orange match highlight, the key handling and the search field.
 */
import { For, type JSX, Show, createSignal } from "solid-js";
import { Icon } from "./Icon";
import { type Range, matchRanges } from "./speedMatch";

export { matchRanges, type Range };

/** Text with the speed-search matches highlighted. */
export function Highlighted(props: { text: string; query?: string }): JSX.Element {
  const parts = () => {
    const r = props.query ? matchRanges(props.text, props.query) : null;
    if (!r) return null;
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

export interface SpeedSearch {
  query: () => string;
  active: () => boolean;
  setQuery: (q: string) => void;
  clear: () => void;
  /** Feed a keydown; returns true if it was consumed (typing, Backspace, Escape while active). */
  handleKey: (e: KeyboardEvent) => boolean;
}

export function createSpeedSearch(onChange?: (q: string) => void): SpeedSearch {
  const [query, setQ] = createSignal("");
  const set = (q: string) => {
    setQ(q);
    onChange?.(q);
  };
  return {
    query,
    active: () => query().length > 0,
    setQuery: set,
    clear: () => set(""),
    handleKey(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === "Escape" && query()) {
        set("");
        return true;
      }
      if (e.key === "Backspace" && query()) {
        set(query().slice(0, -1));
        return true;
      }
      if (e.key.length === 1 && (e.key !== " " || query())) {
        set(query() + e.key);
        return true;
      }
      return false;
    },
  };
}

/** The search field DataGrip shows over a tree/list while typing (🔍 text, funnel filter toggle). */
export function SpeedSearchField(props: {
  query: string;
  /** No match: text turns red. */
  noMatch?: boolean;
  filterMode?: boolean;
  onToggleFilter?: () => void;
  class?: string;
}): JSX.Element {
  return (
    <div class={"dg-speedsearch" + (props.class ? " " + props.class : "")} classList={{ "dg-nomatch": props.noMatch }}>
      <Icon name="search" />
      <span class="dg-speedsearch-text">{props.query}</span>
      <Show when={props.onToggleFilter}>
        <span
          class="dg-speedsearch-filter"
          classList={{ "dg-on": props.filterMode }}
          data-tip="Show Only Matching Elements"
          onMouseDown={(e) => e.preventDefault() /* keep the focus in the list */}
          onClick={props.onToggleFilter}
        >
          <Icon name="filter" />
        </span>
      </Show>
    </div>
  );
}
