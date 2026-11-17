/**
 * When a layout + routing job runs, and what a drag may do while one is pending. The view reads three things from the
 * UI (the wanted model, the direction and the dragged positions) and the scheduler decides, one request at a time:
 *
 *  - what is on screen (`shown`: the inputs of the last landed job, plus its layout so a positions-only change can
 *    reuse it) already is what is wanted: nothing runs, and whatever was in flight is cancelled;
 *  - otherwise a job runs (cancelling the older one), reusing the layout when only the positions changed, or when
 *    the model changed but keeps its layout key (a table was expanded or collapsed: the boxes make room, they do
 *    not move to a new layout);
 *  - while a table is being dragged nothing is started: the diagram under the pointer must not be swapped out from
 *    under it, so the request waits and is settled when the drag ends.
 *
 * A table can only be picked up when the diagram on screen is the wanted one (no job pending): a drop made while a
 * newer layout is computing would be applied to boxes that are about to move, and would either pin one box of a fresh
 * layout or cancel the job. A drag that became stale in the meantime (the options changed, Re-layout was pressed) is
 * dropped by the caller without pinning anything (`canDrop`).
 *
 * No DOM and no Solid in here: the view plugs a few callbacks in, and the tests drive it with a stand-in engine.
 */
import type { SceneResponse } from "./engine";
import { Cancelled, type SceneEngine } from "./engineClient";
import type { Direction, LayoutResult } from "./layout";
import type { DiagramModel } from "./model";

export type Positions = Map<string, { x: number; y: number }>;

/** What a scene is made from. Compared by identity: every change of an input makes a new object. */
export interface Inputs {
  model: DiagramModel;
  direction: Direction;
  positions: Positions;
  /**
   * Two models with the same key (and direction) share a layout: they have the same tables, edges and box widths,
   * only box heights differ. Absent: the model itself is the key.
   */
  layoutKey?: object;
}

export type Plan = { action: "idle" } | { action: "run"; reuseLayout: boolean };

const sameInputs = (a: Inputs, b: Inputs): boolean => a.model === b.model && a.direction === b.direction && a.positions === b.positions;

const layoutKeyOf = (i: Inputs): object => i.layoutKey ?? i.model;

/** What to do for `want` when `shown` is on screen (null: nothing has landed yet). Pure. */
export function planJob(shown: Inputs | null, want: Inputs): Plan {
  if (!shown) return want.model.nodes.length === 0 ? { action: "idle" } : { action: "run", reuseLayout: false };
  if (sameInputs(shown, want)) return { action: "idle" };
  return { action: "run", reuseLayout: layoutKeyOf(shown) === layoutKeyOf(want) && shown.direction === want.direction };
}

export interface Landed<Meta> {
  inputs: Inputs;
  meta: Meta;
  res: SceneResponse;
  /** `fitWhenLanded` was asked for and this is the job it waited for. */
  fit: boolean;
}

export interface SchedulerHooks<Meta> {
  /** A job started (true) or nothing is pending any more (false). `landed` and `failed` imply not busy. */
  busy(on: boolean): void;
  landed(l: Landed<Meta>): void;
  failed(err: unknown): void;
}

export interface Scheduler<Meta> {
  /** The inputs the UI wants on screen now; `meta` rides along to `landed` (the options the model was built with). */
  request(want: Inputs, meta: Meta): void;
  /** Ask `landed` to say `fit` for the job that is pending (or is held back by a drag); no pending work: no effect. */
  fitWhenLanded(): void;
  /** True when a table may be picked up: the diagram on screen is the wanted one, so no job is pending. */
  beginDrag(): boolean;
  /** False when the inputs moved on since the drag began: its drop must be discarded, not pinned. */
  canDrop(): boolean;
  /** Ends the drag and settles what was held back. With `pin` (the positions after a valid drop) there is nothing to compute. */
  endDrag(pin?: Positions): void;
  dispose(): void;
}

export function createScheduler<Meta>(engine: SceneEngine, hooks: SchedulerHooks<Meta>): Scheduler<Meta> {
  let shown: { inputs: Inputs; layout: LayoutResult } | null = null;
  let latest: { want: Inputs; meta: Meta } | null = null;
  let inFlight = false;
  let dragging = false;
  let fitWanted = false;
  let disposed = false;
  // Identifies the job whose answer may still be used: anything older (or after dispose) is ignored even if it resolves.
  let token = 0;

  /** Nothing to wait for: cancels the job in flight, forgets a fit that no longer has a layout to wait for. */
  const stop = (): void => {
    token++;
    inFlight = false;
    fitWanted = false;
    engine.cancel();
    hooks.busy(false);
  };

  const settle = (): void => {
    if (!latest || disposed) return;
    const { want, meta } = latest;
    const plan = planJob(shown?.inputs ?? null, want);
    if (plan.action === "idle") return stop();
    const mine = ++token;
    inFlight = true;
    hooks.busy(true);
    engine
      .run({ model: want.model, direction: want.direction, layout: plan.reuseLayout ? shown!.layout : null, positions: [...want.positions] })
      .then((res) => {
        if (mine !== token) return;
        inFlight = false;
        const fit = fitWanted;
        fitWanted = false;
        shown = { inputs: want, layout: res.layout };
        hooks.landed({ inputs: want, meta, res, fit });
      })
      .catch((err: unknown) => {
        if (mine !== token || err instanceof Cancelled) return;
        inFlight = false;
        fitWanted = false;
        hooks.busy(false);
        hooks.failed(err);
      });
  };

  const onScreen = (): boolean => !!shown && !!latest && sameInputs(shown.inputs, latest.want);

  return {
    request(want, meta) {
      if (disposed) return;
      latest = { want, meta };
      if (!dragging) settle();
    },
    fitWhenLanded() {
      if (inFlight || dragging) fitWanted = true;
    },
    beginDrag() {
      if (disposed || dragging || inFlight || !onScreen()) return false;
      dragging = true;
      return true;
    },
    canDrop() {
      return dragging && onScreen();
    },
    endDrag(pin) {
      if (!dragging) return;
      if (pin && onScreen()) {
        shown = { ...shown!, inputs: { ...shown!.inputs, positions: pin } };
        latest = { ...latest!, want: { ...latest!.want, positions: pin } };
      }
      dragging = false;
      settle();
    },
    dispose() {
      disposed = true;
      token++;
      inFlight = false;
      engine.dispose();
    },
  };
}
