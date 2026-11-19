/**
 * The model behind `<Loading>`: the phases of a long piece of work (a mini log), their elapsed time, and the delay
 * before the indicator shows at all. Nothing here draws anything; the views feed it the real boundaries of their work.
 */
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

/** Work faster than this never shows an indicator (a flash of spinner is worse than none). */
export const LOADING_DELAY_MS = 150;

export type PhaseStatus = "running" | "done" | "failed";

export interface LoadingPhase {
  id: number;
  /** The line as the user reads it while it runs ("Connecting to prod…"). */
  text: string;
  status: PhaseStatus;
  startedAt: number;
  /** Elapsed time, known once the phase ended. */
  ms?: number;
}

/** Durations as `850 ms`, `1.3 s`, `12 s`, `2 min 05 s`. */
export function formatElapsed(ms: number): string {
  const r = Math.max(0, Math.round(ms));
  if (r < 1000) return `${r} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** How a phase reads once it ended: the trailing ellipsis of "Connecting…" is dropped. */
export const endedText = (text: string): string => text.replace(/\s*(…|\.\.\.)$/, "");

/** The line a phase shows: running ones keep their text, ended ones lose the ellipsis. */
export const phaseText = (p: Pick<LoadingPhase, "text" | "status">): string => (p.status === "running" ? p.text : endedText(p.text));

/** `list` with the running phase `id` ended (`done` / `failed`) at `now`. Unknown or ended ids change nothing. */
export function endPhase(list: readonly LoadingPhase[], id: number, status: "done" | "failed", now: number): LoadingPhase[] {
  return list.map((p) => (p.id === id && p.status === "running" ? { ...p, status, ms: Math.max(0, now - p.startedAt) } : p));
}

/** `list` with every running phase ended at `now`. */
export function endAll(list: readonly LoadingPhase[], status: "done" | "failed", now: number): LoadingPhase[] {
  return list.map((p) => (p.status === "running" ? { ...p, status, ms: Math.max(0, now - p.startedAt) } : p));
}

/** The last `max` phases (the log is a few lines, not a history). */
export const lastPhases = (list: readonly LoadingPhase[], max: number): readonly LoadingPhase[] => (list.length > max ? list.slice(list.length - max) : list);

/**
 * Resolves after the browser had the chance to paint (a frame, then a tick). Await it between a phase line and a
 * long synchronous computation so the line is on screen before the main thread is busy. Falls back to a timer where
 * there are no frames (tests) or they are paused (hidden window).
 */
export function nextPaint(fallbackMs = 100): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, fallbackMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(done, 0));
  });
}

export interface PhaseLog {
  phases: Accessor<readonly LoadingPhase[]>;
  /** Text of the phase running now (the newest one when several run in parallel), if any. */
  current: Accessor<string | undefined>;
  /** Starts a phase next to the running ones (parallel work) and returns what ends it. */
  start(text: string): (status?: "done" | "failed") => void;
  /** Ends the running phases as done and starts the next one: sequential work. */
  step(text: string): void;
  /** Ends every running phase as done. */
  finish(): void;
  /** Ends every running phase as failed. */
  fail(): void;
  /** Forgets everything (a new run starts). */
  clear(): void;
}

/** A reactive phase list; `now` is the clock (milliseconds), replaceable in tests. */
export function createPhaseLog(now: () => number = () => performance.now()): PhaseLog {
  const [phases, setPhases] = createSignal<readonly LoadingPhase[]>([]);
  let seq = 0;
  const start = (text: string): ((status?: "done" | "failed") => void) => {
    const id = ++seq;
    setPhases((l) => [...l, { id, text, status: "running", startedAt: now() }]);
    return (status = "done") => setPhases((l) => endPhase(l, id, status, now()));
  };
  return {
    phases,
    current: () => [...phases()].reverse().find((p) => p.status === "running")?.text,
    start,
    step(text) {
      setPhases((l) => endAll(l, "done", now()));
      start(text);
    },
    finish: () => setPhases((l) => endAll(l, "done", now())),
    fail: () => setPhases((l) => endAll(l, "failed", now())),
    clear: () => setPhases([]),
  };
}

/**
 * True once `active` has been true for `delayMs` without a break; false at once when it ends. The delay is what keeps
 * quick work from flashing an indicator. A `delayMs` of 0 follows `active` directly.
 */
export function createDelayedFlag(active: Accessor<boolean>, delayMs: Accessor<number> = () => LOADING_DELAY_MS): Accessor<boolean> {
  const [on, setOn] = createSignal(false);
  createEffect(() => {
    if (!active()) {
      setOn(false);
      return;
    }
    const d = delayMs();
    if (d <= 0) {
      setOn(true);
      return;
    }
    const t = setTimeout(() => setOn(true), d);
    onCleanup(() => clearTimeout(t));
  });
  return on;
}
