import { type Component, For, Show } from "solid-js";
import { type LoadingPhase, LOADING_DELAY_MS, createDelayedFlag, formatElapsed, lastPhases, phaseText } from "./loading";

export interface LoadingProps {
  /** Work in progress. Nothing shows until it has lasted `delay` ms; false removes the indicator. Default true. */
  active?: boolean;
  /** The current phase, for work with a single line ("Comparing schemas…"). Ignored when `log` is given. */
  phase?: string;
  /** The mini log: a line per phase, a spinner on the running ones, a check and the elapsed time on the ended ones. */
  log?: readonly LoadingPhase[];
  /** Lines of the log kept (the newest) and reserved, so the block never changes height as phases come. Default 4. */
  maxLines?: number;
  /** Milliseconds of work before the indicator shows. Default 150. */
  delay?: number;
  /** One line, no centring: for a corner of a view. Default: centred block filling its (positioned) parent. */
  compact?: boolean;
  class?: string;
}

const LINE_HEIGHT = 20;

/**
 * Spinner + phase lines, the one "this is working" indicator of the app. It takes the room it will need from the start
 * (hidden until the delay passed), so showing it moves nothing. The spinner follows prefers-reduced-motion (slower).
 */
export const Loading: Component<LoadingProps> = (props) => {
  const shown = createDelayedFlag(
    () => props.active ?? true,
    () => props.delay ?? LOADING_DELAY_MS,
  );
  const max = () => (props.compact ? 1 : (props.maxLines ?? 4));
  const rows = (): readonly LoadingPhase[] => {
    if (props.log) return lastPhases(props.log, max());
    return props.phase ? [{ id: 0, text: props.phase, status: "running", startedAt: 0 }] : [];
  };
  return (
    <Show when={props.active ?? true}>
      <div class={"dg-loading" + (props.compact ? " dg-loading-compact" : "") + (props.class ? " " + props.class : "")} classList={{ "dg-loading-on": shown() }} role="status" aria-live="polite">
        <ul class="dg-loading-lines" style={{ "min-height": props.compact ? undefined : `${(props.log ? max() : 1) * LINE_HEIGHT}px` }}>
          <For each={rows()}>
            {(p) => (
              <li class={"dg-loading-line dg-loading-" + p.status}>
                <span class="dg-loading-mark" aria-hidden="true">
                  {p.status === "running" ? <span class="dg-spinner" /> : p.status === "done" ? "✓" : "✗"}
                </span>
                <span class="dg-loading-text">{phaseText(p)}</span>
                <Show when={p.ms !== undefined}>
                  <span class="dg-loading-ms">{formatElapsed(p.ms!)}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
};
