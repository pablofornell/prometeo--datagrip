// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  LOADING_DELAY_MS,
  createDelayedFlag,
  createPhaseLog,
  endAll,
  endPhase,
  endedText,
  formatElapsed,
  lastPhases,
  phaseText,
  type LoadingPhase,
} from "./phaseLog";
import css from "../../styles/ui.css?raw";

const phase = (id: number, over: Partial<LoadingPhase> = {}): LoadingPhase => ({ id, text: `p${id}…`, status: "running", startedAt: 0, ...over });

describe("formatElapsed", () => {
  it("reads like a stopwatch", () => {
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(42.4)).toBe("42 ms");
    expect(formatElapsed(999)).toBe("999 ms");
    expect(formatElapsed(1250)).toBe("1.3 s");
    expect(formatElapsed(9949)).toBe("9.9 s");
    expect(formatElapsed(12_400)).toBe("12 s");
    expect(formatElapsed(65_000)).toBe("1 min 05 s");
    expect(formatElapsed(-5)).toBe("0 ms");
  });
});

describe("phase text", () => {
  it("drops the ellipsis once the phase ended", () => {
    expect(endedText("Connecting to prod…")).toBe("Connecting to prod");
    expect(endedText("Connecting to prod...")).toBe("Connecting to prod");
    expect(phaseText({ text: "Connecting…", status: "running" })).toBe("Connecting…");
    expect(phaseText({ text: "Connecting…", status: "done" })).toBe("Connecting");
    expect(phaseText({ text: "Connecting…", status: "failed" })).toBe("Connecting");
  });
});

describe("phase list helpers", () => {
  it("endPhase ends only the running phase with that id and records the elapsed time", () => {
    const l = [phase(1, { startedAt: 10 }), phase(2, { startedAt: 20 })];
    const out = endPhase(l, 1, "done", 110);
    expect(out[0]).toMatchObject({ status: "done", ms: 100 });
    expect(out[1].status).toBe("running");
    // already ended / unknown: unchanged
    expect(endPhase(out, 1, "failed", 500)[0]).toMatchObject({ status: "done", ms: 100 });
    expect(endPhase(out, 9, "done", 500)).toEqual(out);
  });
  it("endAll ends every running phase and keeps the ended ones", () => {
    const l = [phase(1, { status: "done", ms: 5 }), phase(2, { startedAt: 30 }), phase(3, { startedAt: 40 })];
    const out = endAll(l, "failed", 100);
    expect(out.map((p) => p.status)).toEqual(["done", "failed", "failed"]);
    expect(out.map((p) => p.ms)).toEqual([5, 70, 60]);
  });
  it("lastPhases keeps the newest lines", () => {
    const l = [phase(1), phase(2), phase(3)];
    expect(lastPhases(l, 2).map((p) => p.id)).toEqual([2, 3]);
    expect(lastPhases(l, 5)).toBe(l);
  });
});

describe("createPhaseLog", () => {
  it("steps through sequential phases, timing each from the clock", () => {
    let t = 1000;
    createRoot((dispose) => {
      const log = createPhaseLog(() => t);
      log.step("Connecting to prod…");
      expect(log.current()).toBe("Connecting to prod…");
      t = 1300;
      log.step("Reading columns…");
      t = 1450;
      log.finish();
      expect(log.phases().map((p) => [p.text, p.status, p.ms])).toEqual([
        ["Connecting to prod…", "done", 300],
        ["Reading columns…", "done", 150],
      ]);
      expect(log.current()).toBeUndefined();
      dispose();
    });
  });
  it("runs phases in parallel and ends them one by one; the newest running one is current", () => {
    let t = 0;
    createRoot((dispose) => {
      const log = createPhaseLog(() => t);
      const endA = log.start("Reading A…");
      const endB = log.start("Reading B…");
      expect(log.current()).toBe("Reading B…");
      t = 80;
      endB();
      expect(log.current()).toBe("Reading A…");
      t = 120;
      endA("failed");
      expect(log.phases().map((p) => [p.status, p.ms])).toEqual([
        ["failed", 120],
        ["done", 80],
      ]);
      endA(); // ending twice changes nothing
      expect(log.phases()[0].status).toBe("failed");
      dispose();
    });
  });
  it("fail marks what was running as failed, clear forgets everything", () => {
    createRoot((dispose) => {
      const log = createPhaseLog(() => 0);
      log.step("a…");
      log.step("b…");
      log.fail();
      expect(log.phases().map((p) => p.status)).toEqual(["done", "failed"]);
      log.clear();
      expect(log.phases()).toEqual([]);
      dispose();
    });
  });
});

describe("createDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Effects of a root run when its body returns, so the flag is created inside and driven from outside. */
  const make = (initial: boolean, delay?: () => number) =>
    createRoot((dispose) => {
      const [active, setActive] = createSignal(initial);
      const on = createDelayedFlag(active, delay);
      return { on, setActive, dispose };
    });

  it("work shorter than the delay never shows", () => {
    const h = make(false);
    h.setActive(true);
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    expect(h.on()).toBe(false);
    h.setActive(false);
    vi.advanceTimersByTime(1000);
    expect(h.on()).toBe(false);
    h.dispose();
  });
  it("shows after the delay and hides at once when the work ends", () => {
    const h = make(true);
    expect(h.on()).toBe(false);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    expect(h.on()).toBe(true);
    h.setActive(false);
    expect(h.on()).toBe(false);
    h.dispose();
  });
  it("a second run starts its own delay", () => {
    const h = make(true);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    h.setActive(false);
    h.setActive(true);
    expect(h.on()).toBe(false);
    vi.advanceTimersByTime(LOADING_DELAY_MS);
    expect(h.on()).toBe(true);
    h.dispose();
  });
  it("a delay of 0 follows the work directly, and a custom delay is honoured", () => {
    const now = make(true, () => 0);
    expect(now.on()).toBe(true);
    const slow = make(true, () => 500);
    vi.advanceTimersByTime(499);
    expect(slow.on()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(slow.on()).toBe(true);
    now.dispose();
    slow.dispose();
  });
  it("disposing the owner cancels the pending timer", () => {
    const h = make(true);
    h.dispose();
    vi.advanceTimersByTime(1000);
    expect(h.on()).toBe(false);
  });
});

describe("the Loading styles", () => {
  it("use theme tokens only (no hex colours) and respect prefers-reduced-motion", () => {
    const block = css.slice(css.indexOf("/* <Loading>"), css.indexOf("/* main menu bar dropdowns"));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // the fade only runs when the user did not ask for less motion; the spinner is slowed down by the shared rule
    expect(block).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*transition: opacity/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.dg-spinner[^@]*animation-duration/);
  });
});
