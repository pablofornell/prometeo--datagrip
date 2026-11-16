import { describe, expect, it } from "vitest";
import { computeScene, type SceneRequest, type SceneResponse } from "./engine";
import { Cancelled, createSceneEngine, type WorkerLike } from "./engineClient";
import { layoutDiagram } from "./layout";
import { buildDiagram } from "./model";
import { randomSchema, shopSchema } from "./sample";

const request = (n: number, over: Partial<SceneRequest> = {}): SceneRequest => ({
  model: buildDiagram(randomSchema(21, n, { density: 1.3 }), { columns: "keys", showTypes: true }),
  direction: "LR",
  layout: null,
  positions: [],
  ...over,
});

/**
 * A stand-in for the bundled worker: the request crosses a structured clone both ways (as `postMessage` does) and is
 * answered by the very handler the real worker runs, after a macrotask. `terminate` drops what it was working on.
 */
function fakeWorkers(): { factory: () => WorkerLike; spawned: () => number; terminated: () => number; failOnStart: { value: boolean } } {
  let spawned = 0;
  let terminated = 0;
  const failOnStart = { value: false };
  const factory = (): WorkerLike => {
    spawned++;
    let dead = false;
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        const { id, req } = structuredClone(message) as { id: number; req: SceneRequest };
        setTimeout(() => {
          if (dead) return;
          if (failOnStart.value) return void w.onerror?.(new Error("blocked"));
          const res = structuredClone(computeScene(req));
          w.onmessage?.({ data: { id, res } });
        }, 0);
      },
      terminate() {
        dead = true;
        terminated++;
      },
    };
    return w;
  };
  return { factory, spawned: () => spawned, terminated: () => terminated, failOnStart };
}

describe("computeScene", () => {
  it("lays out and routes a model, reusing a given layout", () => {
    const req = request(40);
    const a = computeScene(req);
    expect(a.scene.rects).toHaveLength(req.model.nodes.length);
    expect(a.scene.routes).toHaveLength(req.model.edges.length);
    const again = computeScene({ ...req, layout: a.layout });
    expect(again).toEqual(a);
    expect(a.layout).toEqual(layoutDiagram(req.model, { direction: "LR" }));
  });

  it("applies the dragged positions", () => {
    const model = buildDiagram(shopSchema(), { columns: "all", showTypes: true });
    const key = model.nodes[0].key;
    const res = computeScene({ model, direction: "LR", layout: null, positions: [[key, { x: 1230, y: 450 }]] });
    expect(res.scene.rects[0]).toMatchObject({ x: 1230, y: 450 });
    expect(res.layout.nodes[0].x).not.toBe(1230);
  });
});

describe("the worker and the synchronous fallback give the same result", () => {
  it("through a structured clone of request and response (shop schema, both directions)", () => {
    for (const direction of ["LR", "TB"] as const) {
      const req: SceneRequest = { model: buildDiagram(shopSchema(), { columns: "all", showTypes: true }), direction, layout: null, positions: [] };
      const direct = computeScene(req);
      const viaWorker = structuredClone(computeScene(structuredClone(req)));
      expect(viaWorker).toEqual(direct);
      expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(direct));
    }
  });

  it("through the client with a worker, and with none, on a 150 table schema (and again: deterministic)", async () => {
    const req = request(150);
    const direct = computeScene(req);

    const workers = fakeWorkers();
    const withWorker = createSceneEngine(workers.factory);
    const a = await withWorker.run(req);
    const b = await withWorker.run(req);
    withWorker.dispose();
    expect(workers.spawned()).toBe(1); // an idle worker is reused

    const without = createSceneEngine(null);
    const c = await without.run(req);
    without.dispose();

    for (const got of [a, b, c]) {
      expect(got).toEqual(direct);
      expect(JSON.stringify(got)).toBe(JSON.stringify(direct));
    }
  });
});

describe("createSceneEngine", () => {
  it("cancels the job in flight when a newer one arrives, and only the newer one resolves", async () => {
    const workers = fakeWorkers();
    const engine = createSceneEngine(workers.factory);
    const first = engine.run(request(30));
    const second = engine.run(request(60));
    const firstResult = first.then(
      () => "resolved",
      (e: unknown) => (e instanceof Cancelled ? "cancelled" : "failed"),
    );
    const res: SceneResponse = await second;
    expect(await firstResult).toBe("cancelled");
    expect(res.scene.rects).toHaveLength(60);
    expect(workers.terminated()).toBe(1); // a worker cannot stop mid-layout: the busy one was dropped
    expect(workers.spawned()).toBe(2);
    engine.dispose();
  });

  it("cancel() rejects the job and a later run still works", async () => {
    const engine = createSceneEngine(fakeWorkers().factory);
    const job = engine.run(request(20));
    engine.cancel();
    await expect(job).rejects.toBeInstanceOf(Cancelled);
    expect((await engine.run(request(25))).scene.rects).toHaveLength(25);
    engine.dispose();
  });

  it("falls back to the main thread when the worker cannot run, without losing the request", async () => {
    const workers = fakeWorkers();
    workers.failOnStart.value = true;
    const engine = createSceneEngine(workers.factory);
    const req = request(30);
    expect(await engine.run(req)).toEqual(computeScene(req));
    expect(await engine.run(request(35))).toBeTruthy(); // and keeps working without spawning another worker
    expect(workers.spawned()).toBe(1);
    engine.dispose();
  });

  it("falls back when the worker cannot even be created", async () => {
    const engine = createSceneEngine(() => {
      throw new Error("no workers here");
    });
    const req = request(20);
    expect(await engine.run(req)).toEqual(computeScene(req));
    engine.dispose();
  });

  it("without a worker, a superseded request never computes", async () => {
    const engine = createSceneEngine(null);
    const first = engine.run(request(200));
    const second = engine.run(request(10));
    await expect(first).rejects.toBeInstanceOf(Cancelled);
    expect((await second).scene.rects).toHaveLength(10);
    engine.dispose();
  });

  it("reports an error from the worker", async () => {
    const bad = (): WorkerLike => {
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(m) {
          const { id } = m as { id: number };
          setTimeout(() => w.onmessage?.({ data: { id, error: "boom" } }), 0);
        },
        terminate() {},
      };
      return w;
    };
    const engine = createSceneEngine(bad);
    await expect(engine.run(request(10))).rejects.toThrow("boom");
    engine.dispose();
  });
});

describe("layout and routing cost (benchmark-style, generous bounds)", () => {
  it("a 300 table diagram is computed by one pure call, and a reused layout skips the layout", () => {
    const req = request(300);
    const t0 = performance.now();
    const full = computeScene(req);
    const fullMs = performance.now() - t0;
    const t1 = performance.now();
    computeScene({ ...req, layout: full.layout });
    const routeOnlyMs = performance.now() - t1;
    // no tight bound: this is the work the worker keeps off the main thread
    expect(fullMs, `full ${fullMs.toFixed(0)} ms, routing only ${routeOnlyMs.toFixed(0)} ms`).toBeLessThan(10_000);
    expect(routeOnlyMs).toBeLessThan(fullMs + 50);
  });
});
