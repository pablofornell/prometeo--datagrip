/**
 * Small icon button that copies a text (an error message, version info...) and says "Copied" for a moment.
 *
 *   <CopyButton text={() => message()} tooltip="Copy error" />
 *
 * `text` is read on click, so it can build the text from the DOM or from state at that moment.
 */
import { type JSX, Show, createSignal, onCleanup } from "solid-js";
import { copyText } from "./clipboard";
import { Icon } from "./Icon";

export const COPIED_FEEDBACK_MS = 1500;

export interface CopyButtonProps {
  text: () => string;
  /** Tooltip (default "Copy"). */
  tooltip?: string;
  class?: string;
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const [state, setState] = createSignal<"idle" | "done" | "failed">("idle");
  let timer = 0;
  onCleanup(() => window.clearTimeout(timer));
  const click = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(props.text());
    setState(ok ? "done" : "failed");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
  };
  const label = () => (state() === "done" ? "Copied" : state() === "failed" ? "Copy failed" : (props.tooltip ?? "Copy"));
  return (
    <button
      type="button"
      class={"dg-copy-btn" + (props.class ? " " + props.class : "")}
      classList={{ "dg-copy-done": state() === "done", "dg-copy-failed": state() === "failed" }}
      data-tip={label()}
      aria-label={label()}
      tabindex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => void click(e)}
    >
      <Icon name={state() === "done" ? "checkmark" : "copy"} />
      <Show when={state() !== "idle"}>
        <span class="dg-copy-label" role="status">
          {label()}
        </span>
      </Show>
    </button>
  );
}
