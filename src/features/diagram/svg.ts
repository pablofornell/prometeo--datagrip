/**
 * Pure SVG renderer for the database diagram. Produces a self-contained `<svg>` string (background, routed edges with
 * crow's-foot notation, and one box per table/view with a coloured header, key markers and column rows) from the
 * model + layout + a resolved colour palette, so the export string does not depend on the DOM or the theme at all.
 *
 * Interaction state (hover, selection, dimming, row highlights, edge labels, level of detail) is never baked into the
 * string: the elements carry data attributes and classes, and the embedded `<style>` reacts to class changes the view
 * makes on the live DOM, so highlighting a table does not re-render the diagram.
 */
import type { NodeKind } from "../../api/types";
import { LOOP_ROOM, reflowBoxes, type LayoutResult } from "./layout";
import { DGM, clip, footerText, hasToggle, moreText, rowChars, rowTop, toggleText, type ColumnsMode, type DiagramEdge, type DiagramModel, type DiagramNode } from "./model";
import { inkOn, mix } from "./palette";
import { placeLabels, routeEdges, rowsOf, type Pt, type Rect, type RoutedEdge } from "./route";
import type { ColorAssignment } from "./groups";

export interface DiagramPalette {
  background: string;
  nodeBg: string;
  nodeBorder: string;
  headerBg: string;
  headerFg: string;
  viewHeaderBg: string;
  viewFg: string;
  text: string;
  typeText: string;
  pk: string;
  fk: string;
  edge: string;
  edgeLabel: string;
  selection: string;
  rowLine: string;
  /** Concrete monospace stack (resolved from the theme): the export cannot resolve `var(...)`. */
  fontMono: string;
  /** Concrete UI stack for the table name and edge labels. */
  fontUi: string;
  /** The canvas is dark (shadows, dimming and tints differ). */
  isDark: boolean;
  /** 12 categorical colours: table headers and the foreign keys leaving them. */
  rainbow: string[];
  /** Candidate inks for text on a rainbow colour; the one with the better WCAG contrast is used. */
  inkLight: string;
  inkDark: string;
}

export interface DiagramRenderOptions {
  columns: ColumnsMode;
  showTypes: boolean;
  /** Highlighted node index, or null (the node and its direct neighbours stay lit, the rest is dimmed). */
  selected?: number | null;
  /** Who gets which rainbow colour; absent: every table is neutral. */
  colors?: ColorAssignment;
  /** Draw every foreign key name on its line (otherwise only a highlighted edge shows it). */
  edgeLabels?: boolean;
  /**
   * The SVG goes to a file (SVG / PNG export): no controls. The expand row of a cut table is a plain "+N more columns"
   * note, and the collapse row of an expanded table stays empty.
   */
  exporting?: boolean;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const num = (v: number): string => (Math.round(v * 100) / 100).toString();

/** The padded box of the whole diagram (the SVG's width / height / viewBox, and the box Fit zooms to). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Margin baked around the diagram in the exported SVG. */
export const DIAGRAM_PAD = 48;

const isView = (kind: NodeKind): boolean => kind === "view" || kind === "materializedView";

// ---------------------------------------------------------------- scene (rects + routes)

/** Everything geometric about one rendering: where the boxes are, where the edges run, and the padded bounds. */
export interface Scene {
  rects: Rect[];
  routes: RoutedEdge[];
  bounds: Bounds;
}

export function rectsOf(layout: LayoutResult, positions?: ReadonlyMap<string, { x: number; y: number }>): Rect[] {
  return layout.nodes.map((n) => {
    const p = positions?.get(n.key);
    return { x: p?.x ?? n.x, y: p?.y ?? n.y, w: n.width, h: n.height };
  });
}

/** Bounds of the boxes (plus the loop room of self-referencing ones) and of every route, padded by `DIAGRAM_PAD`. */
export function boundsOf(rects: readonly Rect[], routes?: readonly RoutedEdge[], loops?: ReadonlySet<number>): Bounds {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let first = true;
  const take = (x0: number, y0: number, x1: number, y1: number): void => {
    if (first) {
      minX = x0;
      minY = y0;
      maxX = x1;
      maxY = y1;
      first = false;
    } else {
      minX = Math.min(minX, x0);
      minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1);
      maxY = Math.max(maxY, y1);
    }
  };
  rects.forEach((r, i) => take(r.x, r.y, r.x + r.w + (loops?.has(i) ? LOOP_ROOM : 0), r.y + r.h));
  if (routes) for (const r of routes) if (r) for (const p of r.points) take(p.x, p.y, p.x, p.y);
  return { x: minX - DIAGRAM_PAD, y: minY - DIAGRAM_PAD, width: maxX - minX + DIAGRAM_PAD * 2, height: maxY - minY + DIAGRAM_PAD * 2 };
}

const loopSet = (model: DiagramModel): Set<number> => new Set(model.edges.filter((e) => e.self).map((e) => e.from));

/**
 * The boxes where `layout` (and the dragged `positions`) put them, with the sizes of `model`. When a table of the
 * layout was expanded or collapsed since, the boxes below it move to make room (`reflowBoxes`), so the diagram does
 * not jump to a new layout.
 */
export function buildScene(model: DiagramModel, layout: LayoutResult, positions?: ReadonlyMap<string, { x: number; y: number }>): Scene {
  const rects = reflowBoxes(rectsOf(layout, positions), model.nodes, (i) => positions?.has(model.nodes[i].key) ?? false);
  const routes = routeEdges(model, rects);
  placeLabels(model, routes, rects);
  return { rects, routes, bounds: boundsOf(rects, routes, loopSet(model)) };
}

/**
 * The padded box of the diagram: node bounds (and routes when given) plus `DIAGRAM_PAD` on all sides.
 * `renderDiagramSvg` emits exactly this as width / height / viewBox, and Fit zooms to it.
 */
export function diagramBounds(layout: LayoutResult, positions?: ReadonlyMap<string, { x: number; y: number }>, routes?: readonly RoutedEdge[]): Bounds {
  return boundsOf(rectsOf(layout, positions), routes);
}

// ---------------------------------------------------------------- colours

/** Header colour + ink of a node, from its colour group (neutral when it has none). */
export function nodeColors(node: DiagramNode, colors: ColorAssignment | undefined, p: DiagramPalette): { fill: string; ink: string; accent: string | null } {
  const g = colors && colors.groupOf[node.index] >= 0 ? colors.groups.find((x) => x.id === colors.groupOf[node.index]) : undefined;
  if (g) {
    const fill = p.rainbow[g.slot % p.rainbow.length];
    return { fill, ink: inkOn(fill, p.inkLight, p.inkDark), accent: fill };
  }
  const view = isView(node.kind);
  return { fill: view ? p.viewHeaderBg : p.headerBg, ink: view ? p.viewFg : p.headerFg, accent: null };
}

/** The line colour of an edge: the colour of the table it leaves. */
export function edgeColor(edge: DiagramEdge, model: DiagramModel, colors: ColorAssignment | undefined, p: DiagramPalette): string {
  return nodeColors(model.nodes[edge.from], colors, p).accent ?? p.edge;
}

// ---------------------------------------------------------------- nodes

/** A small table glyph for the header (self-contained, not the icon set). */
function glyph(kind: NodeKind, x: number, y: number, color: string): string {
  const view = isView(kind);
  const head = `<rect x="${num(x)}" y="${num(y + 1.5)}" width="11" height="8" rx="1.4" stroke="${color}" stroke-width="1.2" fill="none"/>`;
  const line = `<line x1="${num(x)}" y1="${num(y + 4.5)}" x2="${num(x + 11)}" y2="${num(y + 4.5)}" stroke="${color}" stroke-width="1.1"/>`;
  if (!view) return head + line;
  return head + `<line x1="${num(x + 1.5)}" y1="${num(y + 3.2)}" x2="${num(x + 9.5)}" y2="${num(y + 3.2)}" stroke="${color}" stroke-width="0.9"/>` + line;
}

/** A PK/FK key marker: a ring plus a shaft. */
function keyGlyph(cx: number, cy: number, color: string): string {
  return (
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="3" fill="none" stroke="${color}" stroke-width="1.3"/>` +
    `<path d="M${num(cx + 2.4)} ${num(cy + 2.4)} L${num(cx + 5.6)} ${num(cy + 5.6)}" stroke="${color}" stroke-width="1.3" fill="none"/>`
  );
}

/**
 * The last row of a box the row limit cut (or that is expanded): a chevron and "Show N more columns" ("Show fewer
 * columns"). `data-toggle` makes the view expand or collapse the table on a click; the hover tint is in the style.
 */
function toggleRow(node: DiagramNode, top: number, w: number, p: DiagramPalette): string {
  const cx = DGM.padX + 4;
  const cy = top + DGM.rowH / 2;
  // a chevron down (more rows below) or up (back to fewer)
  const d = node.expanded ? 1 : -1;
  const chevron = `M${num(cx - 3.5)} ${num(cy + d * 1.75)} L${num(cx)} ${num(cy - d * 1.75)} L${num(cx + 3.5)} ${num(cy + d * 1.75)}`;
  const label = toggleText(node.capped, node.expanded);
  return (
    `<g class="dg-toggle" data-toggle="${node.index}" role="button" aria-label="${esc(label)}">` +
    `<title>${node.expanded ? "Collapse the table to the first columns" : `Expand the table: ${node.columns.length} columns`}</title>` +
    `<rect class="dg-toggle-bg" x="1" y="${num(top)}" width="${num(w - 2)}" height="${DGM.rowH}" fill="${p.selection}" fill-opacity="0"/>` +
    `<path d="${chevron}" stroke="${p.selection}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `<text x="${num(DGM.padX + DGM.iconW)}" y="${num(cy + 4)}" font-family="${esc(p.fontUi)}" font-size="11" fill="${p.selection}">${esc(label)}</text>` +
    `</g>`
  );
}

function nodeSvg(node: DiagramNode, x: number, y: number, opts: DiagramRenderOptions, p: DiagramPalette, dimmed: boolean, selected: boolean, usedRows: ReadonlySet<number>): string {
  const w = node.width;
  const h = node.height;
  const view = isView(node.kind);
  const { fill, ink, accent } = nodeColors(node, opts.colors, p);
  const header = `M0 7 Q0 0 7 0 H${num(w - 7)} Q${num(w)} 0 ${num(w)} 7 V${DGM.headerH} H0 Z`;
  const chars = rowChars(w, node.rows, opts.showTypes);
  const hl = accent ?? p.selection;

  let rows = "";
  node.rows.forEach((c, j) => {
    const top = rowTop(j);
    const cy = top + DGM.rowH / 2;
    if (usedRows.has(j)) rows += `<rect class="dg-rowhl" data-row="${j}" x="1" y="${num(top)}" width="${num(w - 2)}" height="${DGM.rowH}" fill="${hl}" fill-opacity="${p.isDark ? 0.28 : 0.2}"/>`;
    if (c.isPk) rows += keyGlyph(DGM.padX + 4, cy, p.pk);
    else if (c.isFk) rows += keyGlyph(DGM.padX + 4, cy, p.fk);
    const shown = clip(c.name, chars.name);
    rows += `<text x="${num(DGM.padX + DGM.iconW)}" y="${num(cy + 4)}" font-family="${esc(p.fontMono)}" font-size="12"${c.isPk ? ' font-weight="600"' : ""} fill="${p.text}">${esc(shown)}${shown !== c.name ? `<title>${esc(c.name)}</title>` : ""}</text>`;
    if (opts.showTypes) {
      const t = clip(c.typeName, DGM.maxTypeChars);
      rows += `<text x="${num(w - DGM.padX)}" y="${num(cy + 4)}" text-anchor="end" font-family="${esc(p.fontMono)}" font-size="11.5" fill="${p.typeText}">${esc(t)}${t !== c.typeName ? `<title>${esc(c.typeName)}</title>` : ""}</text>`;
    }
    if (j < node.rows.length - 1 || node.hidden > 0 || (node.expanded && !opts.exporting)) rows += `<line x1="8" y1="${num(top + DGM.rowH)}" x2="${num(w - 8)}" y2="${num(top + DGM.rowH)}" stroke="${p.rowLine}" stroke-width="1"/>`;
  });
  if (node.hidden > 0 || node.expanded) {
    const top = rowTop(node.rows.length);
    const cy = top + DGM.rowH / 2;
    if (usedRows.has(node.rows.length)) rows += `<rect class="dg-rowhl" data-row="${node.rows.length}" x="1" y="${num(top)}" width="${num(w - 2)}" height="${DGM.rowH}" fill="${hl}" fill-opacity="${p.isDark ? 0.28 : 0.2}"/>`;
    if (hasToggle(node) && !opts.exporting) rows += toggleRow(node, top, w, p);
    else if (node.hidden > 0) {
      const note = node.capped > 0 ? moreText(node.capped) : footerText(node.hidden, node.rows.length);
      rows += `<text x="${num(DGM.padX + DGM.iconW)}" y="${num(cy + 4)}" font-family="${esc(p.fontUi)}" font-size="11" font-style="italic" fill="${p.typeText}">${esc(note)}</text>`;
    }
  }

  const schemaW = node.showSchema ? 14 + node.schema.length * 6.4 : 0;
  const nameChars = Math.max(4, Math.floor((w - DGM.padX * 2 - 18 - schemaW) / 7.6));
  const title = clip(node.name, nameChars);
  const name = `<text x="${num(DGM.padX + 18)}" y="${num(DGM.headerH / 2 + 4.5)}" font-family="${esc(p.fontUi)}" font-size="12.5" font-weight="600" fill="${ink}"${view ? ' font-style="italic"' : ""}>${esc(title)}</text>`;
  const schema = node.showSchema
    ? `<text x="${num(w - DGM.padX)}" y="${num(DGM.headerH / 2 + 4)}" text-anchor="end" font-family="${esc(p.fontUi)}" font-size="10.5" fill="${ink}" fill-opacity="0.72">${esc(clip(node.schema, 18))}</text>`
    : "";
  const cols = node.columns.length;
  const tip = `${node.showSchema ? node.schema + "." : ""}${node.name} (${view ? node.kind === "view" ? "view" : "materialized view" : "table"}, ${cols} column${cols === 1 ? "" : "s"})`;

  const cls = "dg-node" + (dimmed ? " dg-dim" : "") + (selected ? " dg-sel" : "");
  return (
    `<g class="${cls}" data-table-id="${node.index}" transform="translate(${num(x)} ${num(y)})">` +
    `<title>${esc(tip)}</title>` +
    `<rect x="1.5" y="2.5" width="${num(w)}" height="${num(h)}" rx="7" fill="#000" opacity="${p.isDark ? 0.3 : 0.1}"/>` +
    `<rect class="dg-card" x="0" y="0" width="${num(w)}" height="${num(h)}" rx="7" fill="${p.nodeBg}" stroke="${accent ? mix(accent, p.nodeBorder, 0.45) : p.nodeBorder}" stroke-width="1"${view ? ' stroke-dasharray="5 3"' : ""}/>` +
    `<path d="${header}" fill="${fill}"/>` +
    glyph(node.kind, DGM.padX, DGM.headerH / 2 - 5, ink) +
    name +
    schema +
    `<g class="dg-rows">${rows}</g>` +
    `</g>`
  );
}

// ---------------------------------------------------------------- edges

/** A polyline with rounded corners. */
export function roundedPath(points: readonly Pt[], radius = 8): string {
  if (points.length === 0) return "";
  let d = `M${num(points[0].x)} ${num(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const l1 = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const l2 = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: b.x - Math.sign(b.x - a.x) * r, y: b.y - Math.sign(b.y - a.y) * r };
    const p2 = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    d += ` L${num(p1.x)} ${num(p1.y)} Q${num(b.x)} ${num(b.y)} ${num(p2.x)} ${num(p2.y)}`;
  }
  const last = points[points.length - 1];
  return d + ` L${num(last.x)} ${num(last.y)}`;
}

/** Crow's foot (the "many" end) and a single bar (the "one" end), drawn on the box sides at the two ports. */
function markers(r: RoutedEdge): string {
  const f = r.from;
  const t = r.to;
  const df = f.side === "R" ? 1 : -1;
  const dt = t.side === "R" ? 1 : -1;
  const ax = f.x + df * 11;
  const foot = `M${num(ax)} ${num(f.y)} L${num(f.x)} ${num(f.y - 6)} M${num(ax)} ${num(f.y)} L${num(f.x)} ${num(f.y)} M${num(ax)} ${num(f.y)} L${num(f.x)} ${num(f.y + 6)}`;
  const bx = t.x + dt * 9;
  const bar = `M${num(bx)} ${num(t.y - 5)} L${num(bx)} ${num(t.y + 5)}`;
  return `${foot} ${bar}`;
}

/** The inside of an edge's `<g>` (also used to patch an edge while its table is dragged). */
export function edgeInner(edge: DiagramEdge, route: RoutedEdge, model: DiagramModel, color: string, p: DiagramPalette): string {
  const d = roundedPath(route.points);
  const from = model.nodes[edge.from];
  const to = model.nodes[edge.to];
  const tip = `${edge.label}: ${from.name}(${edge.columns.join(", ")}) → ${to.name}(${edge.refColumns.join(", ")})`;
  let label = "";
  if (route.label) {
    const l = route.label;
    label =
      `<g class="dg-elabel"><rect x="${num(l.x - l.w / 2)}" y="${num(l.y - l.h / 2)}" width="${num(l.w)}" height="${num(l.h)}" rx="4" fill="${p.background}" stroke="${color}" stroke-opacity="0.55"/>` +
      `<text x="${num(l.x)}" y="${num(l.y + 3.8)}" text-anchor="middle" font-family="${esc(p.fontUi)}" font-size="10.5" fill="${p.edgeLabel}">${esc(edge.label)}</text></g>`;
  }
  return (
    `<title>${esc(tip)}</title>` +
    `<path class="dg-hit" d="${d}"/>` +
    `<path class="dg-line" d="${d}" stroke="${color}" stroke-width="1.5" stroke-opacity="0.9" fill="none" stroke-linejoin="round"/>` +
    `<path class="dg-mark" d="${markers(route)}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" fill="none"/>` +
    label
  );
}

/** Row indices an edge lights up on each end (the columns of the foreign key, or its footer row). */
export function edgeRows(edge: DiagramEdge, model: DiagramModel): { from: number[]; to: number[] } {
  const f = model.nodes[edge.from];
  const t = model.nodes[edge.to];
  const rows = (n: DiagramNode, names: string[]): number[] => {
    const r = rowsOf(n, names);
    return r.length === 0 && n.hidden > 0 ? [n.rows.length] : r;
  };
  return { from: rows(f, edge.columns), to: rows(t, edge.refColumns) };
}

export function edgeAttrs(edge: DiagramEdge, model: DiagramModel, index: number): string {
  const r = edgeRows(edge, model);
  return `data-edge="${index}" data-from="${edge.from}" data-to="${edge.to}" data-rf="${r.from.join(",")}" data-rt="${r.to.join(",")}"`;
}

// ---------------------------------------------------------------- document

const styleSheet = (p: DiagramPalette): string =>
  `.dg-dim{opacity:.16}.dg-edge.dg-dim{opacity:.07}` +
  `.dg-rowhl{opacity:0}.dg-rowhl.dg-on{opacity:1}` +
  `.dg-elabel{display:none}.dg-labels .dg-elabel,.dg-edges-hl .dg-elabel{display:inline}` +
  `.dg-hit{stroke:transparent;stroke-width:12;fill:none;pointer-events:stroke}.dg-line,.dg-mark{pointer-events:none}` +
  `.dg-node{cursor:grab}.dg-toggle{cursor:pointer}.dg-toggle:hover .dg-toggle-bg{fill-opacity:${p.isDark ? 0.2 : 0.12}}.dg-node.dg-sel .dg-card{stroke:${p.selection};stroke-width:2}.dg-node.dg-hot .dg-card{stroke:${p.selection}}` +
  `.dg-edges-hl .dg-line,.dg-edges-hl .dg-mark{stroke-width:2.6;stroke-opacity:1}.dg-edges-hl .dg-hit{display:none}` +
  `.dg-far .dg-rows{display:none}`;

/** Gives a rendered diagram new bounds without rendering it again (a dropped table moved the edge of the diagram). */
export function applyBounds(svg: Element, bounds: Bounds): void {
  const W = num(bounds.width);
  const H = num(bounds.height);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `${num(bounds.x)} ${num(bounds.y)} ${W} ${H}`);
  const bg = svg.querySelector(":scope > rect");
  if (!bg) return;
  bg.setAttribute("x", num(bounds.x));
  bg.setAttribute("y", num(bounds.y));
  bg.setAttribute("width", W);
  bg.setAttribute("height", H);
}

export function renderDiagramSvg(
  model: DiagramModel,
  layout: LayoutResult,
  opts: DiagramRenderOptions,
  palette: DiagramPalette,
  positions?: ReadonlyMap<string, { x: number; y: number }>,
  scene?: Scene,
): string {
  const sc = scene ?? buildScene(model, layout, positions);
  const { rects, routes, bounds } = sc;

  // Spotlight: when a node is selected, tables with no direct edge to/from it are dimmed.
  const related = new Set<number>();
  const litEdges = new Set<number>();
  if (opts.selected != null) {
    related.add(opts.selected);
    model.edges.forEach((e, i) => {
      if (e.from === opts.selected || e.to === opts.selected) {
        related.add(e.from);
        related.add(e.to);
        litEdges.add(i);
      }
    });
  }

  // Rows that an edge attaches to get a highlight rect (lit on hover / selection).
  const used = model.nodes.map(() => new Set<number>());
  model.edges.forEach((e) => {
    const r = edgeRows(e, model);
    r.from.forEach((j) => used[e.from].add(j));
    r.to.forEach((j) => used[e.to].add(j));
  });

  const edges = model.edges
    .map((e, i) => {
      const r = routes[i];
      if (!r) return "";
      const dim = opts.selected != null && !litEdges.has(i);
      return `<g class="dg-edge${dim ? " dg-dim" : ""}" ${edgeAttrs(e, model, i)}>${edgeInner(e, r, model, edgeColor(e, model, opts.colors, palette), palette)}</g>`;
    })
    .join("");
  const nodes = model.nodes
    .map((nd) => {
      const r = rects[nd.index];
      const dimmed = opts.selected != null && !related.has(nd.index);
      return nodeSvg(nd, r.x, r.y, opts, palette, dimmed, opts.selected === nd.index, used[nd.index]);
    })
    .join("");

  const W = bounds.width;
  const H = bounds.height;
  const title = `Database diagram: ${model.nodes.length} table${model.nodes.length === 1 ? "" : "s"}, ${model.edges.length} relation${model.edges.length === 1 ? "" : "s"}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="dg-svg${opts.edgeLabels ? " dg-labels" : ""}" role="img" aria-label="${esc(title)}" width="${num(W)}" height="${num(H)}" viewBox="${num(bounds.x)} ${num(bounds.y)} ${num(W)} ${num(H)}">` +
    `<style>${styleSheet(palette)}</style>` +
    `<rect x="${num(bounds.x)}" y="${num(bounds.y)}" width="${num(W)}" height="${num(H)}" fill="${palette.background}"/>` +
    `<g class="dg-edges">${edges}</g>` +
    `<g class="dg-edges-hl"></g>` +
    `<g class="dg-nodes">${nodes}</g>` +
    `</svg>`
  );
}
