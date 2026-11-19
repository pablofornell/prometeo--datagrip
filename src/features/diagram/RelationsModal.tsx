/**
 * The relations focus of the diagram: a large dialog over the (blurred, dimmed) diagram with one table in the middle and
 * the tables related to it on rings around it, as many levels out as the depth says (level 1: the tables it references
 * and the tables that reference it, level 2: the same for those, and so on). It does not draw anything of its own: the
 * neighbourhood (`relations.ts`) becomes a model with `buildDiagram`, `radialLayout` places it, and the same engine
 * (edge routing, in the web worker) and the same SVG renderer, palette and colours as the main diagram draw it.
 * Clicking another table re-centres on it (Back returns), a click that is a drag is a pan, the wheel zooms.
 *
 * Opened by `DiagramView` for the table that was clicked; the depth is the dialog's own state (default 1, `+` / `-`).
 */
import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js";
import type { ObjectRef } from "../../api/types";
import { ActionButton, ToolbarSeparator, notify } from "../../components/ui";
import { Dialog } from "../../components/ui/Dialog";
import { theme } from "../../state/theme";
import { schemaSnapshotFor } from "../explorer";
import { openTableTab } from "../table/commands";
import { focusSets } from "./focus";
import { assignColors, type ColorMode } from "./groups";
import { Cancelled, createSceneEngine } from "./engineClient";
import type { LayoutResult } from "./layout";
import { buildDiagram, nodeKey, type ColumnsMode, type DiagramModel } from "./model";
import { resolvePalette } from "./palette";
import { RELATION_MAX_DEPTH, bfsLevels, buildAdjacency, clickOpensRelations, radialLayout, type NodePress } from "./relations";
import { renderDiagramSvg, type Scene } from "./svg";
import { fitView, zoomAt, type View } from "./view";
import "./relations.css";

export interface RelationsModalProps {
  dsId: string;
  schema: string | null;
  /** `nodeKey` of the table in the middle. */
  table: string;
  colorMode: ColorMode;
  showTypes: boolean;
  edgeLabels: boolean;
  onClose: () => void;
}

/** Up to this many tables every column is drawn; past it only the keys (the boxes of a big neighbourhood would not fit). */
const ALL_COLUMNS_UP_TO = 12;
/** A click on the backdrop right after the dialog opened is the second click of a double-click on the table: ignored. */
const BACKDROP_GRACE_MS = 400;

/** What the last finished job produced. */
interface Shown {
  model: DiagramModel;
  layout: LayoutResult;
  scene: Scene;
  columns: ColumnsMode;
  showTypes: boolean;
  /** Index of the table in the middle. */
  center: number;
}

const nameOf = (key: string): string => key.split("\u0000")[1] ?? key;

export function RelationsModal(props: RelationsModalProps): JSX.Element {
  const [center, setCenter] = createSignal(props.table);
  const [history, setHistory] = createSignal<string[]>([]);
  const [wantedDepth, setWantedDepth] = createSignal(1);
  const [shown, setShown] = createSignal<Shown | null>(null);
  const [computing, setComputing] = createSignal(0); // tables being laid out, 0 when idle
  const [hover, setHover] = createSignal<number | null>(null);
  const [view, setView] = createSignal<View>({ zoom: 1, tx: 0, ty: 0 });
  const [win, setWin] = createSignal({ width: window.innerWidth, height: window.innerHeight });
  // see DiagramView: the theme memo fires before `<html data-theme>` changes, so the palette waits for the attribute
  const [themeEpoch, setThemeEpoch] = createSignal(0);

  let root!: HTMLDivElement;
  let stage!: HTMLDivElement;
  let nodeEls: Element[] = [];
  let edgeEls: Element[] = [];
  let press: NodePress | null = null;
  let pan: { sx: number; sy: number; tx: number; ty: number } | null = null;
  let seq = 0;
  const openedAt = Date.now();
  const engine = createSceneEngine();

  const objects = () => schemaSnapshotFor(props.dsId, props.schema);
  const adjacency = createMemo(() => buildAdjacency(objects()));
  /** Every level reachable from the centre, down to the depth limit. */
  const levels = createMemo(() => bfsLevels(adjacency(), center(), RELATION_MAX_DEPTH));
  const maxDepth = () => Math.max(1, levels().length - 1);
  const depth = () => Math.min(wantedDepth(), maxDepth());
  const counts = createMemo(() => levels().slice(1, depth() + 1).map((l) => l.length));
  const total = () => 1 + counts().reduce((a, b) => a + b, 0);
  const centerName = () => nameOf(center());

  const colors = createMemo(() => {
    const s = shown();
    return s ? assignColors(s.model, props.colorMode) : undefined;
  });
  const palette = createMemo(() => {
    theme();
    themeEpoch();
    return resolvePalette();
  });

  // ---------------------------------------------------------------- layout job

  /** Builds the model of the neighbourhood and its radial layout, and has the engine route it (off the main thread). */
  const start = (objs: ReturnType<typeof objects>, lv: string[][], key: string, showTypes: boolean): void => {
    if (objs.length === 0) return; // the snapshot is still loading
    const level = new Map<string, number>();
    lv.forEach((keys, d) => keys.forEach((k) => level.set(k, d)));
    const columns: ColumnsMode = level.size <= ALL_COLUMNS_UP_TO ? "all" : "keys";
    const model = buildDiagram(objs.filter((o) => level.has(nodeKey(o.schema, o.name))), { columns, showTypes });
    const centerIdx = model.nodes.findIndex((n) => n.key === key);
    if (centerIdx < 0) return props.onClose(); // the table is gone (the snapshot reloaded without it)
    const layout = radialLayout(model, centerIdx, model.nodes.map((n) => level.get(n.key) ?? 0));
    const job = ++seq;
    setComputing(model.nodes.length);
    engine.run({ model, direction: "LR", layout, positions: [] }).then(
      (res) => {
        if (job !== seq) return;
        batch(() => {
          setShown({ model, layout: res.layout, scene: res.scene, columns, showTypes, center: centerIdx });
          setComputing(0);
        });
        requestAnimationFrame(fit);
      },
      (err) => {
        if (err instanceof Cancelled || job !== seq) return;
        setComputing(0);
        notify({ kind: "error", title: "Diagram", body: err instanceof Error ? err.message : String(err) });
      },
    );
  };
  createEffect(() => {
    const objs = objects();
    const lv = levels().slice(0, depth() + 1);
    const key = center();
    const types = props.showTypes;
    untrack(() => start(objs, lv, key, types));
  });

  // ---------------------------------------------------------------- rendering (the main diagram's renderer)

  const applyTransform = (v: View): void => {
    const svg = stage.querySelector("svg");
    if (!svg) return;
    svg.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:translate(${v.tx}px,${v.ty}px) scale(${v.zoom});`;
    // zoomed far out the column rows are unreadable anyway: skip drawing them (as in the main diagram)
    svg.classList.toggle("dg-far", v.zoom < ((shown()?.model.nodes.length ?? 0) > 60 ? 0.5 : 0.28));
  };

  /** The centre is the selected table; the one under the pointer lights up with its edges, the rest dims. */
  const applyFocus = (): void => {
    const svg = stage.querySelector("svg");
    const s = shown();
    if (!svg || !s) return;
    svg.querySelector(".dg-edges-hl")?.replaceChildren();
    for (const el of nodeEls) el?.classList.remove("dg-dim", "dg-sel", "dg-hot");
    for (const el of edgeEls) el?.classList.remove("dg-dim");
    svg.querySelectorAll(".dg-rowhl.dg-on").forEach((el) => el.classList.remove("dg-on"));
    nodeEls[s.center]?.classList.add("dg-sel");
    const h = hover();
    if (h === null) return;
    const sets = focusSets(s.model, colors(), { kind: "node", index: h });
    nodeEls.forEach((el, i) => {
      if (!sets.nodes.has(i)) el.classList.add("dg-dim");
    });
    if (h !== s.center) nodeEls[h]?.classList.add("dg-hot");
    const hl = svg.querySelector(".dg-edges-hl");
    edgeEls.forEach((el, i) => {
      if (!sets.edges.has(i)) {
        el.classList.add("dg-dim");
        return;
      }
      const clone = el.cloneNode(true) as Element;
      clone.classList.add("dg-on");
      hl?.appendChild(clone);
      const rows = (name: string): number[] => (el.getAttribute(name) ?? "").split(",").filter(Boolean).map(Number);
      const from = Number(el.getAttribute("data-from"));
      const to = Number(el.getAttribute("data-to"));
      for (const j of rows("data-rf")) nodeEls[from]?.querySelector(`[data-row="${j}"]`)?.classList.add("dg-on");
      for (const j of rows("data-rt")) nodeEls[to]?.querySelector(`[data-row="${j}"]`)?.classList.add("dg-on");
    });
  };

  createEffect(() => {
    const s = shown();
    if (!s) {
      stage.replaceChildren();
      return;
    }
    stage.innerHTML = renderDiagramSvg(
      s.model,
      s.layout,
      { columns: s.columns, showTypes: s.showTypes, colors: colors(), edgeLabels: props.edgeLabels, exporting: true },
      palette(),
      undefined,
      s.scene,
    );
    nodeEls = [];
    edgeEls = [];
    stage.querySelectorAll("[data-table-id]").forEach((el) => (nodeEls[Number(el.getAttribute("data-table-id"))] = el));
    stage.querySelectorAll(".dg-edges > [data-edge]").forEach((el) => (edgeEls[Number(el.getAttribute("data-edge"))] = el));
    untrack(() => {
      applyTransform(view());
      applyFocus();
    });
  });
  createEffect(() => applyTransform(view()));
  createEffect(() => {
    hover();
    untrack(applyFocus);
  });

  // ---------------------------------------------------------------- view

  const fit = (): void => {
    const s = shown();
    if (!s) return;
    const r = stage.getBoundingClientRect();
    const v = fitView(s.scene.bounds, { width: r.width, height: r.height });
    if (v) setView(v);
  };

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const k = e.ctrlKey ? 0.012 : Math.abs(e.deltaY) >= 50 ? 0.0016 : 0.004;
    setView((v) => zoomAt(v, Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top));
  }

  const nodeAt = (e: Event): number | null => {
    const el = (e.target as Element | null)?.closest?.("[data-table-id]");
    return el ? Number(el.getAttribute("data-table-id")) : null;
  };

  function onMouseDown(e: MouseEvent): void {
    press = null;
    if (e.button !== 0) return;
    stage.focus({ preventScroll: true });
    const index = nodeAt(e);
    if (index !== null) press = { index, x: e.clientX, y: e.clientY };
    // a press on a table pans too: only a click that did not move re-centres (`clickOpensRelations`)
    pan = { sx: e.clientX, sy: e.clientY, tx: view().tx, ty: view().ty };
    stage.classList.add("panning");
    setHover(null);
  }
  function onMouseMove(e: MouseEvent): void {
    if (!pan) return;
    if (e.buttons === 0) return onMouseUp();
    const p = pan;
    setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.sx), ty: p.ty + (e.clientY - p.sy) }));
  }
  function onMouseUp(): void {
    pan = null;
    stage.classList.remove("panning");
  }
  function onMouseOver(e: MouseEvent): void {
    if (pan) return;
    setHover(nodeAt(e));
  }

  // ---------------------------------------------------------------- navigation

  const recenter = (key: string): void => {
    if (key === center()) return;
    batch(() => {
      setHistory((h) => [...h, center()]);
      setCenter(key);
      setHover(null);
    });
  };
  const back = (): void => {
    const h = history();
    if (h.length === 0) return;
    batch(() => {
      setHistory(h.slice(0, -1));
      setCenter(h[h.length - 1]);
      setHover(null);
    });
  };

  function onClick(e: MouseEvent): void {
    const p = press;
    press = null;
    const index = clickOpensRelations(p, { index: nodeAt(e), x: e.clientX, y: e.clientY, detail: e.detail });
    const s = shown();
    if (index === null || !s) return;
    const node = s.model.nodes[index];
    if (node) recenter(node.key);
  }

  const openCenter = (): void => {
    const s = shown();
    const node = s?.model.nodes[s.center];
    if (!node) return;
    props.onClose();
    void openTableTab(props.dsId, { schema: node.schema, name: node.name, kind: node.kind } as ObjectRef);
  };
  /** Double-click on the table in the middle opens it (any other table has just been re-centred by the first click). */
  function onDblClick(e: MouseEvent): void {
    const s = shown();
    if (s && nodeAt(e) === s.center) openCenter();
  }

  const setDepth = (d: number): void => {
    const next = Math.max(1, Math.min(maxDepth(), d));
    if (next !== depth()) setWantedDepth(next);
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "+":
      case "=":
        setDepth(depth() + 1);
        break;
      case "-":
      case "_":
        setDepth(depth() - 1);
        break;
      case "0":
        fit();
        break;
      case "Backspace":
        back();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- lifecycle

  onMount(() => {
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const onResize = (): void => {
      setWin({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    // The dialog frame is the generic `Dialog`: its overlay gets the blur and closes on a click of the backdrop.
    let overlay: Element | null = null;
    const onBackdrop = (e: Event): void => {
      if (e.target === overlay && Date.now() - openedAt > BACKDROP_GRACE_MS) props.onClose();
    };
    const attach = (): void => {
      overlay = root.closest(".dg-dialog-overlay");
      overlay?.classList.add("dgd-rel-overlay");
      overlay?.addEventListener("mousedown", onBackdrop);
    };
    attach();
    const retry = overlay ? 0 : requestAnimationFrame(attach);

    onCleanup(() => {
      seq++;
      engine.dispose();
      observer.disconnect();
      cancelAnimationFrame(retry);
      overlay?.removeEventListener("mousedown", onBackdrop);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  });

  const status = () => `Relations of ${centerName()}: depth ${depth()}, ${total()} tables`;

  return (
    <Dialog
      title={`Relations of ${centerName()}`}
      onClose={props.onClose}
      flush
      width={Math.round(win().width * 0.85)}
      height={Math.round(win().height * 0.85)}
      footerLeft={<span class="dgd-rel-hint">Click a table to centre on it. + / - change the depth, 0 fits, Backspace goes back.</span>}
      buttons={[
        { label: "Open Table", primary: true, run: openCenter },
        { label: "Close", run: props.onClose },
      ]}
    >
      <div class="dgd-rel" ref={root} onKeyDown={onKeyDown}>
        <div class="dgd-rel-bar" role="toolbar" aria-label="Relations options">
          <ActionButton icon="chevron-left" title="Back to the previous table" shortcut="Backspace" disabled={history().length === 0} onClick={back} />
          <span class="dgd-rel-name" title={centerName()}>
            {centerName()}
          </span>
          <ToolbarSeparator />
          <span class="dgd-rel-label">Depth</span>
          <div class="dgd-rel-stepper" role="group" aria-label="Depth">
            <ActionButton icon="remove" title="Less depth" shortcut="-" disabled={depth() <= 1} onClick={() => setDepth(depth() - 1)} />
            <span class="dgd-rel-depth" aria-live="polite">
              {depth()}
            </span>
            <ActionButton icon="add" title="More depth" shortcut="+" disabled={depth() >= maxDepth()} onClick={() => setDepth(depth() + 1)} />
          </div>
          <span class="dgd-rel-of" title="How many levels of related tables there are">
            of {maxDepth()}
          </span>
          <ToolbarSeparator />
          <div class="dgd-rel-counts" aria-label="Tables per level">
            <For each={counts()}>
              {(c, i) => (
                <span class="dgd-rel-chip" title={`Level ${i() + 1}: ${c} table${c === 1 ? "" : "s"} ${i() === 0 ? "directly related" : `${i() + 1} relations away`}`}>
                  L{i() + 1}
                  <b>{c}</b>
                </span>
              )}
            </For>
            <span class="dgd-rel-total">
              {total()} table{total() === 1 ? "" : "s"}
            </span>
          </div>
          <ActionButton icon="locate" title="Fit" shortcut="0" onClick={fit} />
        </div>
        <div class="dgd-rel-body">
          <div
            class="dgd-stage dgd-rel-stage"
            classList={{ computing: computing() > 0 }}
            ref={stage}
            tabindex={0}
            data-autofocus
            role="application"
            aria-label={`Relations diagram of ${centerName()}. Click a table to centre on it, plus and minus change the depth, 0 fits.`}
            onMouseDown={onMouseDown}
            onMouseOver={onMouseOver}
            onMouseLeave={() => setHover(null)}
            onWheel={onWheel}
            onClick={onClick}
            onDblClick={onDblClick}
          />
          <div class="dgd-sr" aria-live="polite">
            {status()}
          </div>
          <Show when={!shown()}>
            <div class="dgd-overlay">{computing() > 0 ? `Laying out ${computing()} tables…` : "Loading…"}</div>
          </Show>
          <Show when={shown() && computing() > 0}>
            <div class="dgd-busy" role="progressbar" aria-label="Updating the diagram" />
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
