/**
 * Tabs that are still opening (connecting, reading the first rows): the table editor marks its tab while it works, and
 * the explorer shows a spinner on the node of the object until the first rows arrive (or the open failed).
 */
import { createSignal } from "solid-js";

const [counts, setCounts] = createSignal<ReadonlyMap<string, number>>(new Map());

/** Whether the tab `tabId` is opening. Reactive. */
export const isOpening = (tabId: string): boolean => counts().has(tabId);

/** Marks `tabId` as opening; the returned function ends it (calling it again does nothing). Overlapping marks nest. */
export function beginOpening(tabId: string): () => void {
  setCounts((m) => new Map(m).set(tabId, (m.get(tabId) ?? 0) + 1));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    setCounts((m) => {
      const next = new Map(m);
      const n = (next.get(tabId) ?? 1) - 1;
      if (n > 0) next.set(tabId, n);
      else next.delete(tabId);
      return next;
    });
  };
}
