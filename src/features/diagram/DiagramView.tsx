/**
 * Diagram view (`editor.view.diagram`): a 34px toolbar over a pannable / zoomable SVG of the database diagram, with a
 * legend, a minimap and keyboard navigation. The SVG is generated as a single string by `renderDiagramSvg` and
 * injected via `innerHTML`; everything interactive after that (hover / selection spotlight, row highlights, level of
 * detail, live edge re-routing while a box is dragged and when it is dropped) only toggles classes and patches the
 * edges of the moved table, so it never re-renders the whole diagram. Node positions moved by the user live in a
 * per-tab map keyed by `schema.name` (stale keys are pruned on reload) and are dropped on re-layout or when the
 * options that change box sizes change. Fit zooms to the same padded box the SVG emits as its viewBox. A table that does
 * not show all its columns (the column mode or the row limit leaves some out) can be expanded to show every column
 * (its last row, its context menu, the E key, Expand All) and collapsed again, in every column mode; the set of
 * expanded tables is per tab, and expanding keeps the layout: only the boxes below the table (and after it, when it
 * grows wider) move.
 *
 * Layout and routing are the expensive part (hundreds of milliseconds for hundreds of tables), so they never run in a
 * reactive update on the main thread: `engineClient` runs them in a web worker (and cancels a stale job when the
 * options change again). What is on screen is `base`, the last finished job (model, layout, routed scene); until the
 * next one lands the old diagram stays put, with a subtle progress bar. A drag builds the obstacle lattice once and
 * routes only the dragged table's edges each frame; the drop keeps those routes and every other one as they are.
 * `scheduler` decides when jobs run: no table can be picked up while a job is pending (the cursor says so), and a job
 * waits for a drag in progress instead of swapping the diagram under the pointer.
 */
import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import type { ObjectRef } from "../../api/types";
import { ActionButton, Loading, ToolbarSeparator, type MenuItem, notify, openMenu } from "../../components/ui";
import { startTask } from "../../state/status";
import { theme } from "../../state/theme";
import type { EditorTab } from "../../state/tabs";
import { connectedDataSourceIds, explorerDataSources, loadSchemaSnapshot, schemaSnapshotErrorFor, schemaSnapshotFor } from "../explorer";
import { openDdlTab, openTableTab } from "../table/commands";
import { describeFocus, focusSets, neighbourInDirection, sameFocus, type Focus } from "./focus";
import { COLOR_MODES, assignColors, type ColorMode } from "./groups";
import { DRAG_START, DragSession, clickToggles, type TogglePress } from "./drag";
import { createSceneEngine } from "./engineClient";
import { layoutPhase, loadPhase } from "./phases";
import { diagramFontCss, embedFonts, exportFile, renderPng, svgFileText } from "./export";
import { layoutDiagram, resolveDrop, type Direction, type LayoutResult } from "./layout";
import { DGM, buildDiagram, hasToggle, prunePositions, subsetOf, toggleKey, type ColumnsMode, type DiagramModel, type DiagramOptions } from "./model";
import { resolvePalette } from "./palette";
import type { RoutedEdge } from "./route";
import { createScheduler } from "./scheduler";
import { applyBounds, buildScene, edgeColor, edgeInner, renderDiagramSvg, type Scene } from "./svg";
import { centerOn, fitView, minimapFrame, revealRect, visibleRect, zoomAt, type View } from "./view";
import "./diagram.css";

interface DiagramTabData {
  dsId?: string;
  schema?: string | null;
  /** Diagram of these tables (and their direct FK neighbours) instead of the whole schema. */
  tables?: string[];
}

const COLUMN_LABEL: Record<ColumnsMode, string> = { all: "All Columns", keys: "Keys Only", none: "Compact" };
const COLOR_LABEL: Record<ColorMode, string> = { cluster: "Cluster", schema: "Schema", prefix: "Name Prefix", none: "None" };
const COLOR_TITLE: Record<ColorMode, string> = { cluster: "Clusters of related tables", schema: "Schemas", prefix: "Name prefixes", none: "" };
const DIRECTION_LABEL: Record<Direction, string> = { LR: "Left to Right", TB: "Top to Bottom" };

/** From this many tables on, the columns start out as keys only (a full box per table is unreadable at that size). */
const KEYS_ONLY_FROM = 60;
const MINIMAP_MAX = { width: 200, height: 140 };
const PREFS_KEY = "prometeo.diagram.prefs";

interface Prefs {
  direction: Direction;
  colorMode: ColorMode;
  showTypes: boolean;
  edgeLabels: boolean;
  legend: boolean;
  minimap: boolean;
}
const DEFAULT_PREFS: Prefs = { direction: "LR", colorMode: "cluster", showTypes: true, edgeLabels: false, legend: true, minimap: true };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      direction: raw.direction === "TB" ? "TB" : "LR",
      colorMode: COLOR_MODES.includes(raw.colorMode as ColorMode) ? (raw.colorMode as ColorMode) : DEFAULT_PREFS.colorMode,
      showTypes: raw.showTypes ?? DEFAULT_PREFS.showTypes,
      edgeLabels: raw.edgeLabels ?? DEFAULT_PREFS.edgeLabels,
      legend: raw.legend ?? DEFAULT_PREFS.legend,
      minimap: raw.minimap ?? DEFAULT_PREFS.minimap,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const snap = (v: number): number => Math.round(v / DGM.grid) * DGM.grid;

export function DiagramView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as DiagramTabData | undefined;
  const dsId = data?.dsId;
  if (!dsId) return <div class="dgd-view"><div class="dgd-overlay">This diagram has no data source.</div></div>;
  return <Diagram tab={props.tab} active={props.active} dsId={dsId} schema={data?.schema ?? null} tables={data?.tables} />;
}

type Drag =
  | { mode: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { mode: "node"; index: number; key: string; ox: number; oy: number; sx: number; sy: number; x: number; y: number; moved: boolean; session: DragSession | null };

/** What the last finished layout + routing job produced, with the inputs it was made from. */
interface Base {
  model: DiagramModel;
  options: DiagramOptions;
  direction: Direction;
  layout: LayoutResult;
  scene: Scene;
}

const EMPTY_OPTIONS: DiagramOptions = { columns: "all", showTypes: true };
const EMPTY_MODEL = buildDiagram([], EMPTY_OPTIONS);
const EMPTY_LAYOUT = layoutDiagram(EMPTY_MODEL);
const EMPTY_SCENE = buildScene(EMPTY_MODEL, EMPTY_LAYOUT);

function Diagram(props: { tab: EditorTab; active: boolean; dsId: string; schema: string | null; tables?: string[] }): JSX.Element {
  const prefs = loadPrefs();
  const [columnsMode, setColumnsMode] = createSignal<ColumnsMode>("all");
  const [showTypes, setShowTypes] = createSignal(prefs.showTypes);
  const [direction, setDirection] = createSignal<Direction>(prefs.direction);
  const [colorMode, setColorMode] = createSignal<ColorMode>(prefs.colorMode);
  const [edgeLabels, setEdgeLabels] = createSignal(prefs.edgeLabels);
  const [showLegend, setShowLegend] = createSignal(prefs.legend);
  const [showMinimap, setShowMinimap] = createSignal(prefs.minimap);
  const [selection, setSelection] = createSignal<Focus | null>(null);
  const [hover, setHover] = createSignal<Focus | null>(null);
  const [positions, setPositions] = createSignal<Map<string, { x: number; y: number }>>(new Map());
  // Tables (by `nodeKey`) that show every column, and a counter that Re-layout bumps. A new column mode keeps the set:
  // the tables the user opened stay open in the new mode (a key has no effect where the table hides no column, and
  // takes effect again in a mode that hides some). Collapse All clears it.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [layoutGen, setLayoutGen] = createSignal(0);
  const [view, setView] = createSignal<View>({ zoom: 1, tx: 24, ty: 24 });
  const [stageSize, setStageSize] = createSignal({ width: 0, height: 0 });
  const [loading, setLoading] = createSignal(true);
  // The diagram on screen: the last finished job, the scene a drop made of it (no new job for a drop), and whether a
  // newer job is running.
  const [base, setBase] = createSignal<Base | null>(null);
  const [dropped, setDropped] = createSignal<Scene | null>(null);
  const [computing, setComputing] = createSignal(false);
  // Bumped when `<html data-theme>` actually changes: the theme memo fires before `apply()` sets the attribute, so
  // reading the CSS variables in that same tick would keep the previous theme's colours.
  const [themeEpoch, setThemeEpoch] = createSignal(0);

  let stage!: HTMLDivElement;
  let didFit = false;
  let userPickedColumns = false;
  let autoDefaults = false;
  let drag: Drag | null = null;
  let pending: { x: number; y: number } | null = null;
  let frame = 0;
  let nodeEls: Element[] = [];
  let edgeEls: Element[] = [];
  let fitFrame = 0;
  /** Where the button went down on an expand / collapse row (a click there that did not move toggles the table). */
  let pressedToggle: TogglePress | null = null;

  const objects = () => subsetOf(schemaSnapshotFor(props.dsId, props.schema), props.tables);
  const loadError = () => schemaSnapshotErrorFor(props.dsId, props.schema);
  /** The model the options ask for; what is drawn (`model`) catches up when the job for it has finished. */
  const wanted = createMemo(() => {
    const o: DiagramOptions = { columns: columnsMode(), showTypes: showTypes(), expanded: expanded() };
    return { model: buildDiagram(objects(), o), options: o };
  });
  /** A new object when the tables, the options that set box widths, or Re-layout ask for a new layout (not on expand). */
  const layoutKey = createMemo(() => {
    objects();
    columnsMode();
    showTypes();
    layoutGen();
    return {};
  });
  const model = createMemo(() => base()?.model ?? EMPTY_MODEL);
  const layout = createMemo(() => base()?.layout ?? EMPTY_LAYOUT);
  const scene = createMemo(() => dropped() ?? base()?.scene ?? EMPTY_SCENE);
  const drawnOptions = (): DiagramOptions => base()?.options ?? EMPTY_OPTIONS;
  const colors = createMemo(() => assignColors(model(), colorMode()));
  const palette = createMemo(() => {
    theme();
    themeEpoch();
    return resolvePalette();
  });
  const focus = createMemo<Focus | null>(() => hover() ?? selection(), null, { equals: sameFocus });

  /** The SVG of what is on screen (the scene is read untracked by the render effect: a drop patches the DOM instead). */
  const svgString = (exporting = false): string =>
    renderDiagramSvg(model(), layout(), { columns: drawnOptions().columns, showTypes: drawnOptions().showTypes, colors: colors(), edgeLabels: edgeLabels(), exporting }, palette(), undefined, untrack(scene));

  const reload = (): void => {
    setLoading(true);
    void loadSchemaSnapshot(props.dsId, props.schema).finally(() => setLoading(false));
  };

  onMount(() => {
    reload();
    const observer = new MutationObserver(() => setThemeEpoch((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const r = stage.getBoundingClientRect();
            setStageSize({ width: r.width, height: r.height });
            if (!didFit && props.active && fit()) didFit = true;
          });
    ro?.observe(stage);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    onCleanup(() => {
      scheduler.dispose();
      observer.disconnect();
      ro?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(fitFrame);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    });
  });

  // Remember the view options across diagrams.
  createEffect(() => {
    const p: Prefs = { direction: direction(), colorMode: colorMode(), showTypes: showTypes(), edgeLabels: edgeLabels(), legend: showLegend(), minimap: showMinimap() };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* private mode / no storage: the options just do not persist */
    }
  });

  // Big schemas start with keys only, several schemas start coloured by schema (until the user chooses).
  createEffect(() => {
    const m = wanted().model;
    const n = m.nodes.length;
    if (n === 0 || autoDefaults) return;
    autoDefaults = true;
    untrack(() => {
      if (!userPickedColumns && n >= KEYS_ONLY_FROM) setColumnsMode("keys");
      if (new Set(m.nodes.map((x) => x.schema)).size > 1 && prefs.colorMode === "cluster") setColorMode("schema");
    });
  });

  // New column / type / direction options change node sizes and ranks: stale dragged positions are meaningless.
  const resetting = (fn: () => void): void =>
    batch(() => {
      fn();
      setPositions(new Map());
    });
  const chooseColumns = (m: ColumnsMode): void =>
    resetting(() => {
      userPickedColumns = true;
      setColumnsMode(m);
    });

  // A reloaded snapshot may drop tables: their dragged positions go with them (positions are keyed by schema.name).
  createEffect(() => setPositions((prev) => prunePositions(prev, wanted().model.nodes)));

  // Layout and routing run in the worker, one job at a time (a newer one cancels the older). The diagram on screen
  // stays as it is until the job lands; then it is swapped in one go.
  const scheduler = createScheduler<DiagramOptions>(createSceneEngine(), {
    busy: setComputing,
    landed: ({ inputs, meta, res, fit: fitNow }) => {
      batch(() => {
        setDropped(null);
        setBase({ model: inputs.model, options: meta, direction: inputs.direction, layout: res.layout, scene: res.scene });
        setComputing(false);
      });
      if (fitNow) fitFrame = requestAnimationFrame(fit);
    },
    failed: (err) => notify({ kind: "error", title: "Diagram", body: err instanceof Error ? err.message : String(err) }),
  });
  createEffect(() => {
    const w = wanted();
    const dir = direction();
    const pos = positions();
    const key = layoutKey();
    untrack(() => scheduler.request({ model: w.model, direction: dir, positions: pos, layoutKey: key }, w.options));
  });

  // A selection that no longer exists (the snapshot reloaded smaller) is dropped.
  createEffect(() => {
    const s = untrack(selection);
    if (s && s.kind === "node" && s.index >= model().nodes.length) setSelection(null);
  });

  // Coming back to the tab retries a snapshot that failed while it was hidden.
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active && loadError() !== undefined) reload();
      },
      { defer: true },
    ),
  );

  // ---------------------------------------------------------------- rendering

  const applyTransform = (v: View): void => {
    const svg = stage.querySelector("svg");
    if (!svg) return;
    svg.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:translate(${v.tx}px,${v.ty}px) scale(${v.zoom});`;
    // Zoomed far out the column rows are unreadable anyway: skip drawing them (much cheaper to pan and zoom).
    svg.classList.toggle("dg-far", v.zoom < (model().nodes.length > 60 ? 0.5 : 0.28));
  };

  const indexElements = (): void => {
    nodeEls = [];
    edgeEls = [];
    stage.querySelectorAll("[data-table-id]").forEach((el) => (nodeEls[Number(el.getAttribute("data-table-id"))] = el));
    stage.querySelectorAll(".dg-edges > [data-edge]").forEach((el) => (edgeEls[Number(el.getAttribute("data-edge"))] = el));
  };

  /** Spotlights the focus: dims what is unrelated, draws its edges on top and lights the foreign key rows. */
  const applyFocus = (): void => {
    const svg = stage.querySelector("svg");
    if (!svg) return;
    const hl = svg.querySelector(".dg-edges-hl");
    hl?.replaceChildren();
    for (const el of nodeEls) el?.classList.remove("dg-dim", "dg-sel", "dg-hot");
    for (const el of edgeEls) el?.classList.remove("dg-dim");
    svg.querySelectorAll(".dg-rowhl.dg-on").forEach((el) => el.classList.remove("dg-on"));
    const f = focus();
    const sel = selection();
    if (sel?.kind === "node") nodeEls[sel.index]?.classList.add("dg-sel");
    if (!f) return;
    const sets = focusSets(model(), colors(), f);
    nodeEls.forEach((el, i) => {
      if (!sets.nodes.has(i)) el.classList.add("dg-dim");
    });
    if (f.kind === "node" && !(sel && sel.kind === "node" && sel.index === f.index)) nodeEls[f.index]?.classList.add("dg-hot");
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
    const s = svgString();
    stage.innerHTML = s;
    indexElements();
    untrack(() => {
      applyTransform(view());
      applyFocus();
    });
  });
  createEffect(() => applyTransform(view()));
  createEffect(() => {
    focus();
    selection();
    colors();
    untrack(applyFocus);
  });

  // ---------------------------------------------------------------- view

  /** Fits the padded diagram box (the same box the SVG emits) into the stage; false when the stage is still empty. */
  const fit = (): boolean => {
    if (model().nodes.length === 0) return false;
    const r = stage.getBoundingClientRect();
    const v = fitView(scene().bounds, { width: r.width, height: r.height });
    if (!v) return false;
    setView(v);
    return true;
  };
  const actualSize = (): void => {
    const r = stage.getBoundingClientRect();
    const b = scene().bounds;
    setView(centerOn({ zoom: 1, tx: 0, ty: 0 }, { width: r.width, height: r.height }, b.x + Math.min(b.width, r.width) / 2, b.y + Math.min(b.height, r.height) / 2));
  };
  const relayout = (): void => {
    resetting(() => setLayoutGen((g) => g + 1));
    scheduler.fitWhenLanded();
  };

  // ---------------------------------------------------------------- expanding tables that leave out columns

  /**
   * Expands a table that leaves out columns (in any column mode), or collapses an expanded one. The layout stays: the
   * boxes below (and after it) make room. The set decides, not the model on screen: that can be a job behind when the
   * key is pressed again quickly.
   */
  const toggleColumns = (index: number): void => {
    const node = model().nodes[index];
    if (!node) return;
    setExpanded((prev) => toggleKey(prev, node.key, hasToggle(node)));
  };
  const canExpandAll = createMemo(() => model().nodes.some((n) => n.hidden > 0));
  const canCollapseAll = createMemo(() => model().nodes.some((n) => n.expanded));
  const expandAll = (): void => {
    setExpanded((prev) => new Set([...prev, ...model().nodes.filter((n) => n.hidden > 0).map((n) => n.key)]));
  };
  const collapseAll = (): void => {
    setExpanded(new Set<string>());
  };
  const expandItems = (): MenuItem[] => [
    { label: "Expand All Tables", enabled: canExpandAll(), run: expandAll },
    { label: "Collapse All Tables", enabled: canCollapseAll(), run: collapseAll },
  ];
  const zoomBy = (factor: number): void => {
    const r = stage.getBoundingClientRect();
    setView((v) => zoomAt(v, factor, r.width / 2, r.height / 2));
  };
  const chooseDirection = (d: Direction): void => {
    if (d === direction()) return;
    resetting(() => setDirection(d));
    scheduler.fitWhenLanded(); // the new layout is fitted when it lands
  };

  // Fit once, when the tab is first shown with data. A 0x0 stage (a restored tab at startup) fails the fit; the
  // ResizeObserver above retries it, and `didFit` only latches after a fit actually happened.
  createEffect(() => {
    if (didFit || !props.active || layout().nodes.length === 0) return;
    requestAnimationFrame(() => {
      if (!didFit && props.active && fit()) didFit = true;
    });
  });

  // ---------------------------------------------------------------- interactions

  const nodeAt = (e: Event): number | null => {
    const el = (e.target as Element | null)?.closest?.("[data-table-id]");
    return el ? Number(el.getAttribute("data-table-id")) : null;
  };
  const edgeAt = (e: Event): number | null => {
    const el = (e.target as Element | null)?.closest?.("[data-edge]");
    return el ? Number(el.getAttribute("data-edge")) : null;
  };
  /** The table whose expand / collapse row is under the pointer. */
  const toggleAt = (e: Event): number | null => {
    const el = (e.target as Element | null)?.closest?.("[data-toggle]");
    return el ? Number(el.getAttribute("data-toggle")) : null;
  };

  function onMouseDown(e: MouseEvent): void {
    pressedToggle = null;
    if (e.button !== 0) return;
    stage.focus({ preventScroll: true });
    // The expand / collapse row is also a handle: the table is picked up as from any other row, and the click toggles
    // it only when the pointer did not move (`clickToggles`).
    const toggle = toggleAt(e);
    if (toggle !== null) pressedToggle = { index: toggle, x: e.clientX, y: e.clientY };
    const index = nodeAt(e);
    if (index === null) {
      const edge = edgeAt(e);
      if (edge !== null) {
        setSelection({ kind: "edge", index: edge });
        return;
      }
      setSelection(null);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: view().tx, ty: view().ty };
      stage.classList.add("panning");
      return;
    }
    setSelection({ kind: "node", index });
    setHover(null);
    // A newer layout is being computed: these boxes are about to move, so they cannot be picked up (the cursor says so).
    if (!scheduler.beginDrag()) return;
    const node = layout().nodes[index];
    const r = scene().rects[index];
    drag = { mode: "node", index, key: node.key, ox: r.x, oy: r.y, sx: e.clientX, sy: e.clientY, x: r.x, y: r.y, moved: false, session: null };
  }

  function onMouseMove(e: MouseEvent): void {
    if (!drag) return;
    if (e.buttons === 0) return onMouseUp(); // the button was released outside the window: the drag is over
    if (drag.mode === "pan") {
      const d = drag;
      setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.sx), ty: d.ty + (e.clientY - d.sy) }));
      return;
    }
    // Moves are applied once per frame: re-routing the table's edges is the expensive part.
    pending = { x: e.clientX, y: e.clientY };
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) moveNode(pending.x, pending.y);
        pending = null;
      });
  }

  /** Draws a route (and its label) in the edge's element and in its spotlight copy, if it has one. */
  const patchEdge = (i: number, route: RoutedEdge): void => {
    const m = model();
    const edge = m.edges[i];
    const html = edgeInner(edge, route, m, edgeColor(edge, m, colors(), palette()), palette());
    const el = edgeEls[i];
    if (el) el.innerHTML = html;
    const copy = stage.querySelector(`.dg-edges-hl > [data-edge="${i}"]`);
    if (copy) copy.innerHTML = html;
  };

  /** Live drag: the box follows the pointer on the lattice and its edges are routed again around the other boxes. */
  function moveNode(clientX: number, clientY: number): void {
    const d = drag;
    if (!d || d.mode !== "node") return;
    const z = view().zoom;
    const dx = clientX - d.sx;
    const dy = clientY - d.sy;
    if (!d.moved && Math.abs(dx) < DRAG_START && Math.abs(dy) < DRAG_START) return;
    const x = snap(d.ox + dx / z);
    const y = snap(d.oy + dy / z);
    if (d.moved && x === d.x && y === d.y) return;
    d.moved = true;
    d.x = x;
    d.y = y;
    nodeEls[d.index]?.setAttribute("transform", `translate(${x} ${y})`);
    // The obstacle lattice is built once (on the first move) and then only updated around the box, and only the
    // edges of this table are routed: a frame costs a few searches.
    const sc = scene();
    d.session ??= new DragSession(model(), sc, d.index);
    const r = sc.rects[d.index];
    const routes = d.session.move({ x, y, w: r.w, h: r.h });
    for (const i of d.session.edges) if (routes[i]) patchEdge(i, routes[i]);
  }

  function onMouseUp(): void {
    if (!drag) return;
    const d = drag;
    drag = null;
    stage.classList.remove("panning");
    // a table that was dragged from its toggle row (and maybe back to where it was) is not toggled by the click
    if (d.mode === "node" && d.moved) pressedToggle = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
    }
    if (d.mode !== "node") return;
    if (!(d.moved && d.session)) return scheduler.endDrag();
    if (!scheduler.canDrop()) {
      // The options changed, or Re-layout was pressed, while the box was in the pointer: that diagram is about to be
      // replaced, so the move is not kept (it would pin one box of the new layout). The box goes back until it lands.
      const sc = scene();
      const r = sc.rects[d.index];
      nodeEls[d.index]?.setAttribute("transform", `translate(${r.x} ${r.y})`);
      for (const i of d.session.edges) if (sc.routes[i]) patchEdge(i, sc.routes[i]);
      return scheduler.endDrag();
    }
    const sc = scene();
    const others = sc.rects.filter((_, i) => i !== d.index).map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }));
    // the size on screen: an expanded or collapsed table is not the size it was laid out with
    const r = sc.rects[d.index];
    const spot = resolveDrop({ x: d.x, y: d.y }, { width: r.w, height: r.h }, others);
    // The drop keeps the routes of the drag (re-routed once more only when the spot differs) and every other route
    // as it is; the DOM already shows them, so it is patched, not rendered again.
    const done = d.session.finish({ x: spot.x, y: spot.y, w: r.w, h: r.h });
    const next = new Map(positions()).set(d.key, spot);
    nodeEls[d.index]?.setAttribute("transform", `translate(${spot.x} ${spot.y})`);
    for (const i of done.changed) if (done.scene.routes[i]) patchEdge(i, done.scene.routes[i]);
    const svg = stage.querySelector("svg");
    if (svg) applyBounds(svg, done.scene.bounds);
    scheduler.endDrag(next); // first: the diagram on screen now stands for `next`, so the positions below start no job
    batch(() => {
      setDropped(done.scene);
      setPositions(next);
    });
  }

  function onMouseOver(e: MouseEvent): void {
    if (drag) return;
    const n = nodeAt(e);
    const next: Focus | null = n !== null ? { kind: "node", index: n } : edgeAt(e) !== null ? { kind: "edge", index: edgeAt(e)! } : null;
    setHover(next);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    // trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel sends big steps
    const k = e.ctrlKey ? 0.012 : Math.abs(e.deltaY) >= 50 ? 0.0016 : 0.004;
    const factor = Math.exp(-e.deltaY * k);
    setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
  }

  function onClick(e: MouseEvent): void {
    const toggle = clickToggles(pressedToggle, { index: toggleAt(e), x: e.clientX, y: e.clientY, detail: e.detail });
    pressedToggle = null;
    if (toggle !== null) toggleColumns(toggle);
  }

  /** Opens the table, also from its expand / collapse row (whose first click already toggled it, see `clickToggles`). */
  function onDblClick(e: MouseEvent): void {
    const index = nodeAt(e);
    if (index === null) return;
    openNode(index);
  }

  const refOf = (index: number): ObjectRef => {
    const node = model().nodes[index];
    return { schema: node.schema, name: node.name, kind: node.kind } as ObjectRef;
  };
  const openNode = (index: number): void => void openTableTab(props.dsId, refOf(index));

  function onContextMenu(e: MouseEvent): void {
    const index = nodeAt(e);
    e.preventDefault();
    if (index === null) {
      openMenu(
        [
          { label: "Fit Diagram", run: () => void fit() },
          { label: "Re-layout", run: relayout },
          { type: "separator" },
          ...expandItems(),
        ],
        { x: e.clientX, y: e.clientY },
      );
      return;
    }
    setSelection({ kind: "node", index });
    const node = model().nodes[index];
    const ref = refOf(index);
    const moved = positions().has(node.key);
    openMenu(
      [
        { label: "Open Data", icon: "dg/edit-data", run: () => openNode(index) },
        { label: "Go to DDL", icon: "dg/table", run: () => void openDdlTab(props.dsId, ref) },
        { type: "separator" } as MenuItem,
        ...(node.hidden > 0 ? [{ label: "Show All Columns", shortcut: "E", run: () => toggleColumns(index) } as MenuItem] : []),
        ...(node.expanded ? [{ label: "Show Fewer Columns", shortcut: "E", run: () => toggleColumns(index) } as MenuItem] : []),
        ...(moved ? [{ label: "Reset Position", run: () => setPositions((p) => { const m = new Map(p); m.delete(node.key); return m; }) } as MenuItem] : []),
        { label: "Copy Name", run: () => void navigator.clipboard?.writeText(node.name).catch(() => {}) },
      ],
      { x: e.clientX, y: e.clientY },
    );
  }

  // ---------------------------------------------------------------- keyboard

  const status = createMemo(() => describeFocus(model(), selection()));

  const revealNode = (index: number): void => {
    const r = scene().rects[index];
    if (r) setView((v) => revealRect(v, stageSize(), { x: r.x, y: r.y, width: r.w, height: r.h }));
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = selection();
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = dirs[e.key];
    if (dir) {
      e.preventDefault();
      if (sel?.kind === "node" && !e.shiftKey) {
        const next = neighbourInDirection(scene().rects, sel.index, dir);
        if (next !== null) {
          setSelection({ kind: "node", index: next });
          revealNode(next);
        }
      } else {
        const step = 80;
        setView((v) => ({ ...v, tx: v.tx + (dir === "left" ? step : dir === "right" ? -step : 0), ty: v.ty + (dir === "up" ? step : dir === "down" ? -step : 0) }));
      }
      return;
    }
    switch (e.key) {
      case "+":
      case "=":
        zoomBy(1.2);
        break;
      case "-":
      case "_":
        zoomBy(1 / 1.2);
        break;
      case "0":
        fit();
        break;
      case "1":
        actualSize();
        break;
      case "l":
      case "L":
        relayout();
        break;
      case "Tab": {
        // Tab walks the tables in layout order; leaving at either end hands focus back to the page.
        const n = model().nodes.length;
        if (n === 0) return;
        const cur = sel?.kind === "node" ? sel.index : -1;
        const next = cur + (e.shiftKey ? -1 : 1);
        if (next < 0 || next >= n) return;
        e.preventDefault();
        setSelection({ kind: "node", index: next });
        revealNode(next);
        break;
      }
      case "Enter":
        if (sel?.kind === "node") openNode(sel.index);
        break;
      case "e":
      case "E":
        if (sel?.kind === "node") toggleColumns(sel.index);
        break;
      case "Escape":
        setSelection(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------- export

  const fileBase = (): string => (props.schema || "diagram").replace(/[^A-Za-z0-9_-]+/g, "_") || "diagram";

  const exportFailed = (e: unknown): void => {
    notify({ kind: "error", title: "Export failed", body: e instanceof Error ? e.message : String(e) });
  };
  const exported = (path: string | null): void => {
    if (path) notify({ kind: "success", title: "Diagram exported", body: path, timeout: 6000 });
  };
  /** A PNG export is running (a status bar task and a busy cursor; a second one does not start). */
  const [exporting, setExporting] = createSignal(false);

  /** The diagram as it is on screen (current theme, options and table positions), without hover, selection or controls. */
  const exportSvg = (): void => {
    const bytes = new TextEncoder().encode(svgFileText(svgString(true)));
    exportFile(fileBase(), "svg", "image/svg+xml", async () => bytes).then(exported, exportFailed);
  };

  /** The Save dialog first; then the PNG is drawn (with the bundled fonts) and written, with the busy state on. */
  const exportPng = (): void => {
    if (exporting()) return;
    const svg = svgString(true);
    const b = scene().bounds;
    const background = palette().background;
    const busy = (): (() => void) => {
      setExporting(true);
      const task = startTask("Exporting the diagram as PNG…");
      return () => {
        task.done();
        setExporting(false);
      };
    };
    exportFile(fileBase(), "png", "image/png", async () => renderPng(embedFonts(svg, await diagramFontCss()), b.width, b.height, background), busy).then(exported, exportFailed);
  };

  const openExportMenu = (anchor: HTMLElement): void =>
    openMenu(
      [
        { label: "Export as SVG", run: exportSvg },
        { label: "Export as PNG", run: exportPng },
      ],
      { anchor },
    );

  const openColumnsMenu = (anchor: HTMLElement): void =>
    openMenu(
      [
        ...(Object.keys(COLUMN_LABEL) as ColumnsMode[]).map<MenuItem>((m) => ({ label: COLUMN_LABEL[m], checked: columnsMode() === m, run: () => chooseColumns(m) })),
        { type: "separator" },
        ...expandItems(),
      ],
      { anchor },
    );
  const openColorMenu = (anchor: HTMLElement): void =>
    openMenu(
      COLOR_MODES.map<MenuItem>((m) => ({ label: COLOR_LABEL[m], checked: colorMode() === m, run: () => setColorMode(m) })),
      { anchor },
    );
  const openDirectionMenu = (anchor: HTMLElement): void =>
    openMenu(
      (Object.keys(DIRECTION_LABEL) as Direction[]).map<MenuItem>((d) => ({ label: DIRECTION_LABEL[d], checked: direction() === d, run: () => chooseDirection(d) })),
      { anchor },
    );

  // ---------------------------------------------------------------- minimap

  const mapFrame = createMemo(() => minimapFrame(scene().bounds, MINIMAP_MAX));
  const mapSvg = createMemo(() => {
    const b = scene().bounds;
    const f = mapFrame();
    const p = palette();
    const c = colors();
    const rects = scene().rects
      .map((r, i) => {
        const g = c.groupOf[i] >= 0 ? c.groups.find((x) => x.id === c.groupOf[i]) : undefined;
        return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="${g ? p.rainbow[g.slot] : p.typeText}" opacity="${g ? 0.95 : 0.55}"/>`;
      })
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" preserveAspectRatio="none">${rects}</svg>`;
  });
  const viewport = createMemo(() => {
    const b = scene().bounds;
    const f = mapFrame();
    const v = visibleRect(view(), stageSize());
    const x0 = Math.max(0, (v.x - b.x) * f.scale);
    const y0 = Math.max(0, (v.y - b.y) * f.scale);
    const x1 = Math.min(f.width, (v.x + v.width - b.x) * f.scale);
    const y1 = Math.min(f.height, (v.y + v.height - b.y) * f.scale);
    return { left: x0, top: y0, width: Math.max(4, x1 - x0), height: Math.max(4, y1 - y0) };
  });
  const everythingVisible = createMemo(() => {
    const v = visibleRect(view(), stageSize());
    const b = scene().bounds;
    return v.x <= b.x && v.y <= b.y && v.x + v.width >= b.x + b.width && v.y + v.height >= b.y + b.height;
  });

  function navigateMinimap(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const b = scene().bounds;
    const wx = b.x + ((e.clientX - r.left) / r.width) * b.width;
    const wy = b.y + ((e.clientY - r.top) / r.height) * b.height;
    setView((v) => centerOn(v, stageSize(), wx, wy));
  }
  function onMapDown(e: PointerEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    navigateMinimap(e);
  }
  function onMapMove(e: PointerEvent): void {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) navigateMinimap(e);
  }

  // ---------------------------------------------------------------- legend

  const groupFocused = (id: number): boolean => {
    const s = selection();
    return s?.kind === "group" && s.id === id;
  };
  const toggleGroup = (id: number): void => {
    setSelection(groupFocused(id) ? null : { kind: "group", id });
  };

  const isLoading = () => loading() && objects().length === 0;
  const hasData = () => model().nodes.length > 0;

  return (
    <div class="dgd-view" classList={{ exporting: exporting() }}>
      <div class="dgd-toolbar" role="toolbar" aria-label="Diagram options">
        <button class="dgd-tbtn text" tabindex={-1} title="Which columns each table shows" onClick={(e) => openColumnsMenu(e.currentTarget)}>
          {COLUMN_LABEL[columnsMode()]}
          <i class="dgg-i i-chevron" />
        </button>
        <button class="dgd-tbtn text" classList={{ selected: showTypes() }} tabindex={-1} title="Show column types" onClick={() => resetting(() => setShowTypes(!showTypes()))}>
          Types
        </button>
        <button class="dgd-tbtn text" tabindex={-1} title="Direction of the layout" onClick={(e) => openDirectionMenu(e.currentTarget)}>
          {DIRECTION_LABEL[direction()]}
          <i class="dgg-i i-chevron" />
        </button>
        <button class="dgd-tbtn text" tabindex={-1} title="What the table colours mean" onClick={(e) => openColorMenu(e.currentTarget)}>
          <span class="dgd-rainbow" aria-hidden="true" />
          Color: {COLOR_LABEL[colorMode()]}
          <i class="dgg-i i-chevron" />
        </button>
        <button class="dgd-tbtn text" classList={{ selected: edgeLabels() }} tabindex={-1} title="Show the foreign key names on the lines" onClick={() => setEdgeLabels(!edgeLabels())}>
          Labels
        </button>
        <ToolbarSeparator />
        <ActionButton icon="layout" title="Re-layout (L)" onClick={relayout} />
        <ActionButton icon="locate" title="Fit Diagram (0)" onClick={() => void fit()} />
        <ActionButton icon="window-restore" title="Actual Size (1)" onClick={actualSize} />
        <ToolbarSeparator />
        <button class="dgd-tbtn text" classList={{ selected: showLegend() }} tabindex={-1} title="Show the legend" onClick={() => setShowLegend(!showLegend())}>
          Legend
        </button>
        <button class="dgd-tbtn text" classList={{ selected: showMinimap() }} tabindex={-1} title="Show the minimap" onClick={() => setShowMinimap(!showMinimap())}>
          Map
        </button>
        <ToolbarSeparator />
        <button class="dgd-tbtn text" tabindex={-1} title="Export the diagram as an image" onClick={(e) => openExportMenu(e.currentTarget)}>
          Export
          <i class="dgg-i i-chevron" />
        </button>
      </div>
      <Show when={hasData() && showLegend()}>
        <div class="dgd-legend" role="group" aria-label="Legend">
          <Show when={colors().groups.length > 0}>
            <div class="dgd-legend-title">{COLOR_TITLE[colorMode()]}</div>
            <div class="dgd-legend-groups">
              <For each={colors().groups}>
                {(g) => (
                  <button class="dgd-legend-item" classList={{ active: groupFocused(g.id) }} tabindex={-1} aria-pressed={groupFocused(g.id)} title={`Highlight ${g.label}`} onClick={() => toggleGroup(g.id)}>
                    <span class="dgd-swatch" style={{ background: palette().rainbow[g.slot % palette().rainbow.length] }} />
                    <span class="dgd-legend-label">{g.label}</span>
                    <span class="dgd-legend-count">{g.count}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="dgd-legend-notation">
            <span title="Primary key">
              <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
                <circle cx="4" cy="6" r="3" fill="none" stroke={palette().pk} stroke-width="1.3" />
                <path d="M6.4 8.4 L9.6 11.6" stroke={palette().pk} stroke-width="1.3" />
              </svg>
              PK
            </span>
            <span title="Foreign key">
              <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
                <circle cx="4" cy="6" r="3" fill="none" stroke={palette().fk} stroke-width="1.3" />
                <path d="M6.4 8.4 L9.6 11.6" stroke={palette().fk} stroke-width="1.3" />
              </svg>
              FK
            </span>
            <span title="The referencing side of a foreign key: many rows">
              <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
                <path d="M1 6 H21 M11 6 L21 1 M11 6 L21 11" stroke={palette().edge} stroke-width="1.4" fill="none" stroke-linecap="round" />
              </svg>
              many
            </span>
            <span title="The referenced side of a foreign key: one row">
              <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
                <path d="M1 6 H21 M14 1 V11" stroke={palette().edge} stroke-width="1.4" fill="none" stroke-linecap="round" />
              </svg>
              one
            </span>
          </div>
        </div>
      </Show>
      <div class="dgd-body">
        <div
          class="dgd-stage"
          classList={{ computing: computing() }}
          ref={stage}
          tabindex={0}
          role="application"
          aria-label={`Database diagram, ${model().nodes.length} tables. Arrow keys move between tables, Enter opens one, E expands or collapses its columns, plus and minus zoom, 0 fits.`}
          onMouseDown={onMouseDown}
          onMouseOver={onMouseOver}
          onMouseLeave={() => setHover(null)}
          onWheel={onWheel}
          onClick={onClick}
          onDblClick={onDblClick}
          onContextMenu={onContextMenu}
          onKeyDown={onKeyDown}
        />
        <div class="dgd-sr" aria-live="polite">
          {status()}
        </div>
        <Show when={hasData() && showMinimap() && !everythingVisible()}>
          <div
            class="dgd-minimap"
            style={{ width: `${mapFrame().width}px`, height: `${mapFrame().height}px` }}
            title="Drag to move around"
            aria-hidden="true"
            onPointerDown={onMapDown}
            onPointerMove={onMapMove}
          >
            <div class="dgd-minimap-map" innerHTML={mapSvg()} />
            <div class="dgd-minimap-view" style={{ left: `${viewport().left}px`, top: `${viewport().top}px`, width: `${viewport().width}px`, height: `${viewport().height}px` }} />
          </div>
        </Show>
        <Show when={isLoading()}>
          <Loading phase={loadPhase(connectedDataSourceIds().has(props.dsId), explorerDataSources().find((d) => d.id === props.dsId)?.name ?? props.dsId)} />
        </Show>
        <Show when={computing() && !hasData() && objects().length > 0}>
          <Loading phase={layoutPhase(wanted().model.nodes.length)} />
        </Show>
        <Show when={computing() && hasData()}>
          <Loading compact class="dgd-busy" phase={layoutPhase(wanted().model.nodes.length)} />
        </Show>
        <Show when={!loading() && loadError() !== undefined && objects().length === 0}>
          <div class="dgd-overlay error">
            <div class="dgd-error-text">{loadError()}</div>
            <a class="dgd-retry" onClick={reload}>
              Retry
            </a>
          </div>
        </Show>
        <Show when={!loading() && loadError() === undefined && objects().length === 0}>
          <div class="dgd-overlay">
            <div class="dgd-empty">
              <svg width="56" height="44" viewBox="0 0 56 44" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="3" />
                <path d="M2 9 H22" />
                <rect x="34" y="27" width="20" height="14" rx="3" />
                <path d="M34 33 H54" />
                <path d="M22 10 H28 V34 H34" stroke-linejoin="round" />
              </svg>
              <div class="dgd-empty-title">No tables to show</div>
              <div class="dgd-empty-hint">Select a schema or tables with the Explorer and open the diagram again.</div>
            </div>
          </div>
        </Show>
        <Show when={hasData() && model().edges.length === 0}>
          <div class="dgd-note">No foreign keys between these tables: they are packed side by side.</div>
        </Show>
      </div>
    </div>
  );
}
