import { describe, expect, it } from "vitest";
import { computeScene, type SceneRequest, type SceneResponse } from "./engine";
import { Cancelled, type SceneEngine } from "./engineClient";
import { buildDiagram } from "./model";
import { shopSchema } from "./sample";
import { createScheduler, planJob, type Inputs, type Landed, type Positions } from "./scheduler";

const model = () => buildDiagram(shopSchema(), { columns: "all", showTypes: true });
const empty = () => buildDiagram([], { columns: "all", showTypes: true });
const inputs = (over: Partial<Inputs> = {}): Inputs => ({ model: model(), direction: "LR", positions: new Map(), ...over });
const moved = (key: string): Positions => new Map([[key, { x: 400, y: 300 }]]);

const answer = computeScene({ model: model(), direction: "LR", layout: null, positions: [] });

interface Run {
  req: SceneRequest;
  resolve: (r: SceneResponse) => void;
  reject: (e: unknown) => void;
}

/** An engine whose jobs finish when the test says so; like the real one, a newer job (or `cancel`) rejects the older. */
function manualEngine(): { engine: SceneEngine; runs: Run[]; cancels: () => number; disposed: () => boolean; leaky: { value: boolean } } {
  const runs: Run[] = [];
  let live: Run | null = null;
  let cancels = 0;
  let disposed = false;
  const leaky = { value: false }; // a cancelled job still resolves (an engine that lets a stale answer through)
  const cancel = (): void => {
    cancels++;
    if (live && !leaky.value) live.reject(new Cancelled());
    live = null;
  };
  const engine: SceneEngine = {
    run(req) {
      cancel();
      return new Promise<SceneResponse>((resolve, reject) => {
        const r: Run = { req, resolve, reject };
        runs.push(r);
        live = r;
      });
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
  return { engine, runs, cancels: () => cancels, disposed: () => disposed, leaky };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup() {
  const m = manualEngine();
  const log = { busy: [] as boolean[], landed: [] as Landed<string>[], failed: [] as unknown[] };
  const scheduler = createScheduler<string>(m.engine, {
    busy: (on) => log.busy.push(on),
    landed: (l) => log.landed.push(l),
    failed: (e) => log.failed.push(e),
  });
  /** Lets the newest job finish and the scheduler see it. */
  const land = async (): Promise<void> => {
    m.runs[m.runs.length - 1].resolve(answer);
    await tick();
  };
  /** The first diagram on screen: one job landed for `first`. */
  const showFirst = async (first = inputs()): Promise<Inputs> => {
    scheduler.request(first, "meta");
    await land();
    return first;
  };
  return { ...m, log, scheduler, land, showFirst };
}

describe("planJob", () => {
  it("does nothing for an empty model with nothing on screen, and for what is already on screen", () => {
    expect(planJob(null, inputs({ model: empty() }))).toEqual({ action: "idle" });
    const shown = inputs();
    expect(planJob(shown, { ...shown })).toEqual({ action: "idle" });
  });

  it("runs the first job, with no layout to reuse", () => {
    expect(planJob(null, inputs())).toEqual({ action: "run", reuseLayout: false });
  });

  it("reuses the layout only when just the positions changed", () => {
    const shown = inputs();
    expect(planJob(shown, { ...shown, positions: new Map() })).toEqual({ action: "run", reuseLayout: true });
    expect(planJob(shown, { ...shown, direction: "TB" })).toEqual({ action: "run", reuseLayout: false });
    expect(planJob(shown, { ...shown, model: model() })).toEqual({ action: "run", reuseLayout: false });
  });

  it("an emptied model still replaces a diagram that is on screen", () => {
    expect(planJob(inputs(), inputs({ model: empty() }))).toEqual({ action: "run", reuseLayout: false });
  });
});

describe("scheduler: the basics", () => {
  it("runs a job, lands it with its meta, and shows no work afterwards", async () => {
    const t = setup();
    const want = inputs();
    t.scheduler.request(want, "m1");
    expect(t.log.busy).toEqual([true]);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0].req).toMatchObject({ direction: "LR", layout: null, positions: [] });
    await t.land();
    expect(t.log.landed).toHaveLength(1);
    expect(t.log.landed[0]).toMatchObject({ inputs: want, meta: "m1", fit: false });
    t.scheduler.request(want, "m1"); // the same again: nothing to do
    expect(t.runs).toHaveLength(1);
  });

  it("a newer request supersedes the job in flight, and only the newer one lands", async () => {
    const t = setup();
    t.scheduler.request(inputs(), "a");
    t.scheduler.request(inputs({ direction: "TB" }), "b");
    expect(t.runs).toHaveLength(2);
    await t.land();
    expect(t.log.landed.map((l) => l.meta)).toEqual(["b"]);
    expect(t.log.failed).toEqual([]); // the cancelled job is not an error
  });

  it("reuses the layout of what is on screen when only the positions change", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.request({ ...shown, positions: moved("public.orders") }, "meta");
    expect(t.runs[1].req.layout).toBe(answer.layout);
    expect(t.runs[1].req.positions).toEqual([["public.orders", { x: 400, y: 300 }]]);
  });

  it("a failed job is reported once, is not busy any more, and does not keep a fit waiting", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    t.scheduler.fitWhenLanded();
    t.runs[1].reject(new Error("boom"));
    await tick();
    expect(t.log.failed).toHaveLength(1);
    expect(t.log.busy.at(-1)).toBe(false);
    t.scheduler.request({ ...shown, positions: moved("public.orders") }, "meta");
    await t.land();
    expect(t.log.landed.at(-1)!.fit).toBe(false);
  });
});

describe("race: a drop while a Re-layout job is pending (reviewer finding 1)", () => {
  it("does not let a box be picked up until the diagram on screen is the wanted one", async () => {
    const t = setup();
    const shown = await t.showFirst({ ...inputs(), positions: moved("public.orders") });
    t.scheduler.request({ ...shown, positions: new Map() }, "meta"); // Re-layout: positions cleared, job started
    t.scheduler.fitWhenLanded();
    expect(t.scheduler.beginDrag()).toBe(false);
    // nothing the pointer does can touch the job: it is still the one in flight, and it lands with its fit
    expect(t.runs).toHaveLength(2);
    await t.land();
    expect(t.log.landed.at(-1)).toMatchObject({ fit: true });
    expect(t.log.landed.at(-1)!.inputs.positions.size).toBe(0); // no stray pinned box in the new layout
    expect(t.scheduler.beginDrag()).toBe(true); // and now the new boxes can be dragged
  });

  it("a valid drop starts no job, keeps the layout on screen, and the next change reuses that layout", async () => {
    const t = setup();
    const shown = await t.showFirst();
    expect(t.scheduler.beginDrag()).toBe(true);
    expect(t.scheduler.canDrop()).toBe(true);
    const next = moved("public.orders");
    t.scheduler.endDrag(next);
    t.scheduler.request({ ...shown, positions: next }, "meta"); // what the positions effect then asks for
    expect(t.runs).toHaveLength(1);
    expect(t.log.busy.at(-1)).toBe(false);
    t.scheduler.request({ ...shown, positions: new Map() }, "meta"); // Reset Position
    expect(t.runs[1].req.layout).toBe(answer.layout);
  });
});

describe("race: nothing to lay out (reviewer finding 2)", () => {
  it("an emptied model cancels the job in flight before anything landed, so a stale diagram cannot appear", async () => {
    const t = setup();
    t.scheduler.request(inputs(), "full");
    t.scheduler.fitWhenLanded();
    const cancelsBefore = t.cancels();
    t.scheduler.request(inputs({ model: empty() }), "empty");
    expect(t.cancels()).toBeGreaterThan(cancelsBefore);
    expect(t.log.busy.at(-1)).toBe(false);
    t.runs[0].resolve(answer); // even if the answer was already on its way
    await tick();
    expect(t.log.landed).toEqual([]);
  });

  it("the stale answer is ignored even by an engine that lets cancelled jobs resolve", async () => {
    const t = setup();
    t.leaky.value = true;
    t.scheduler.request(inputs(), "full");
    t.scheduler.request(inputs({ model: empty() }), "empty");
    t.runs[0].resolve(answer);
    await tick();
    expect(t.log.landed).toEqual([]);
  });

  it("the fit that was waiting does not fire on a later, unrelated job", async () => {
    const t = setup();
    t.scheduler.request(inputs(), "full");
    t.scheduler.fitWhenLanded();
    t.scheduler.request(inputs({ model: empty() }), "empty");
    t.scheduler.request(inputs(), "full again");
    await t.land();
    expect(t.log.landed).toHaveLength(1);
    expect(t.log.landed[0].fit).toBe(false);
  });

  it("with no pending work a fit request has nothing to wait for", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.fitWhenLanded();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    await t.land();
    expect(t.log.landed.at(-1)!.fit).toBe(false);
  });

  it("returning to exactly what is on screen cancels the job and the fit that waited for it", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    t.scheduler.fitWhenLanded();
    t.scheduler.request(shown, "meta");
    expect(t.log.busy.at(-1)).toBe(false);
    t.scheduler.request({ ...shown, positions: moved("public.orders") }, "meta");
    await t.land();
    expect(t.log.landed.at(-1)!.fit).toBe(false);
  });
});

describe("race: the inputs change while a box is in the pointer", () => {
  it("a job asked for during the drag waits for the drop, then runs for the latest inputs", async () => {
    const t = setup();
    const shown = await t.showFirst();
    expect(t.scheduler.beginDrag()).toBe(true);
    t.scheduler.request({ ...shown, model: model() }, "new model"); // e.g. the snapshot reloaded
    t.scheduler.request({ ...shown, model: model(), direction: "TB" }, "newest");
    expect(t.runs).toHaveLength(1); // the diagram under the pointer is not swapped out
    expect(t.scheduler.canDrop()).toBe(false);
    t.scheduler.endDrag(); // the stale drop is discarded: no pin
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1].req.direction).toBe("TB");
    await t.land();
    expect(t.log.landed.map((l) => l.meta)).toEqual(["meta", "newest"]);
  });

  it("a direction change during the drag is not lost, and its drop does not pin a box", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.beginDrag();
    t.scheduler.request({ ...shown, direction: "TB", positions: new Map() }, "meta"); // chooseDirection
    t.scheduler.fitWhenLanded();
    expect(t.scheduler.canDrop()).toBe(false);
    t.scheduler.endDrag(moved("public.orders")); // even if the caller passes a pin, it is ignored
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1].req).toMatchObject({ direction: "TB", positions: [] });
    await t.land();
    expect(t.log.landed.at(-1)).toMatchObject({ fit: true });
    expect(t.log.landed.at(-1)!.inputs.positions.size).toBe(0);
  });

  it("Re-layout pressed during the drag clears the positions of the new layout, and keeps its fit", async () => {
    const t = setup();
    const shown = await t.showFirst({ ...inputs(), positions: moved("public.customers") });
    t.scheduler.beginDrag();
    t.scheduler.request({ ...shown, positions: new Map() }, "meta");
    t.scheduler.fitWhenLanded();
    t.scheduler.endDrag();
    await t.land();
    expect(t.log.landed.at(-1)!.inputs.positions.size).toBe(0);
    expect(t.log.landed.at(-1)!.fit).toBe(true);
  });

  it("changes during the drag that end up back at what is on screen start nothing", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.beginDrag();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    t.scheduler.request(shown, "meta");
    expect(t.scheduler.canDrop()).toBe(true);
    t.scheduler.endDrag(moved("public.orders"));
    expect(t.runs).toHaveLength(1);
  });

  it("a click without a move ends the drag and settles what was held back", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.beginDrag();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    t.scheduler.endDrag();
    expect(t.runs).toHaveLength(2);
  });
});

describe("race: a job and a drag meeting", () => {
  it("a job in flight refuses a drag, so one cannot land in the middle of a drag", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    expect(t.scheduler.beginDrag()).toBe(false);
    await t.land();
    expect(t.scheduler.beginDrag()).toBe(true);
    expect(t.scheduler.beginDrag()).toBe(false); // one drag at a time
  });

  it("nothing can be dragged before the first diagram lands", () => {
    const t = setup();
    t.scheduler.request(inputs(), "meta");
    expect(t.scheduler.beginDrag()).toBe(false);
  });

  it("canDrop is false outside a drag", async () => {
    const t = setup();
    await t.showFirst();
    expect(t.scheduler.canDrop()).toBe(false);
    t.scheduler.endDrag(); // harmless without a drag
    expect(t.runs).toHaveLength(1);
  });
});

describe("race: the view goes away", () => {
  it("disposing during a job cancels it, and an answer that still arrives lands nowhere", async () => {
    const t = setup();
    t.leaky.value = true;
    t.scheduler.request(inputs(), "meta");
    t.scheduler.dispose();
    expect(t.disposed()).toBe(true);
    t.runs[0].resolve(answer);
    await tick();
    expect(t.log.landed).toEqual([]);
    expect(t.log.failed).toEqual([]);
  });

  it("disposing during a drag, and requests after dispose, start nothing", async () => {
    const t = setup();
    const shown = await t.showFirst();
    t.scheduler.beginDrag();
    t.scheduler.dispose();
    t.scheduler.request({ ...shown, direction: "TB" }, "meta");
    t.scheduler.endDrag(moved("public.orders"));
    expect(t.runs).toHaveLength(1);
    expect(t.scheduler.beginDrag()).toBe(false);
  });
});
