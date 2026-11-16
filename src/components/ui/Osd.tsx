/**
 * On-screen display: a short message in the middle of the window ("UI scale 120%"). Mount <OsdHost/> once.
 *
 *   showOsd("UI scale 120%");
 */
import { type JSX, Show, createSignal } from "solid-js";

const [message, setMessage] = createSignal<string | null>(null);
let timer = 0;

/** Shows `text` for about a second, replacing the one on screen. */
export function showOsd(text: string): void {
  setMessage(text);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => setMessage(null), 1200);
}

export function OsdHost(): JSX.Element {
  return (
    <Show when={message()}>
      <div class="dg-osd" role="status" aria-live="polite">
        {message()}
      </div>
    </Show>
  );
}
