/**
 * Runs `computeScene` off the main thread. One request is in flight at a time and a newer request cancels the older
 * one: a worker cannot be interrupted in the middle of a layout, so a busy worker is terminated and a fresh one takes
 * the new request (the old result would be thrown away anyway). When there is no worker (tests, a webview that
 * refuses one, a worker that fails) the same computation runs on the main thread in a timer callback, so callers see
 * one behaviour: a promise that resolves with the response, or rejects with `Cancelled` when it was superseded.
 */
import { computeScene, type SceneRequest, type SceneResponse } from "./engine";

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** The part of `Worker` the client uses (a test double can implement it). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: { id: number; res?: SceneResponse; error?: string } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface SceneEngine {
  run(req: SceneRequest): Promise<SceneResponse>;
  /** Cancels the job in flight, if any. */
  cancel(): void;
  dispose(): void;
}

/** The bundled worker; null where there are none (Node, old webviews). Vite bundles the `new Worker(new URL(...))` form. */
export const defaultWorkerFactory: WorkerFactory | null =
  typeof Worker === "undefined" ? null : () => new Worker(new URL("./diagram.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;

interface Job {
  id: number;
  req: SceneRequest;
  resolve: (r: SceneResponse) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createSceneEngine(factory: WorkerFactory | null = defaultWorkerFactory): SceneEngine {
  let worker: WorkerLike | null = null;
  let broken = factory === null;
  let seq = 0;
  let job: Job | null = null;
  let disposed = false;

  const stopWorker = (): void => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
  };

  const finish = (j: Job, fn: () => void): void => {
    if (job === j) job = null;
    fn();
  };

  /** The same computation on the main thread, after a tick so a busy indicator can paint first. */
  const runHere = (j: Job): void => {
    j.timer = setTimeout(() => {
      try {
        const res = computeScene(j.req);
        finish(j, () => j.resolve(res));
      } catch (err) {
        finish(j, () => j.reject(err));
      }
    }, 0);
  };

  const spawn = (): WorkerLike | null => {
    if (broken || !factory) return null;
    try {
      const w = factory();
      w.onmessage = (e) => {
        const cur = job;
        if (!cur || e.data.id !== cur.id) return; // an answer to a cancelled job
        if (e.data.res) finish(cur, () => cur.resolve(e.data.res!));
        else finish(cur, () => cur.reject(new Error(e.data.error ?? "diagram worker failed")));
      };
      w.onerror = () => {
        // no worker after all (blocked by the page policy, failed to load): compute on the main thread from now on
        broken = true;
        stopWorker();
        const cur = job;
        if (cur) runHere(cur);
      };
      return w;
    } catch {
      broken = true;
      return null;
    }
  };

  const cancel = (): void => {
    const cur = job;
    if (!cur) return;
    job = null;
    if (cur.timer !== undefined) clearTimeout(cur.timer);
    else stopWorker(); // busy in the middle of a layout: the only way to stop it is to start over
    cur.reject(new Cancelled());
  };

  return {
    run(req) {
      cancel();
      if (disposed) return Promise.reject(new Cancelled()); // a late request must not bring a worker back to life
      return new Promise<SceneResponse>((resolve, reject) => {
        const j: Job = { id: ++seq, req, resolve, reject };
        job = j;
        worker ??= spawn();
        if (!worker) return runHere(j);
        worker.postMessage({ id: j.id, req });
      });
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      stopWorker();
    },
  };
}
