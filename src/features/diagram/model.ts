/**
 * Database diagram model: turns the flat schema snapshot (`schemaSnapshot`) into nodes (tables/views with
 * measured sizes) and edges (foreign keys), the pure data the layout and SVG renderer consume.
 *
 * The foreign-key contract is `SnapshotObject.foreignKeys?: SnapshotForeignKey[]` (see crates/dbcore/src/model.rs);
 * the frontend types (`api/types.ts`) may not expose it yet, so we define the shape here and treat a missing
 * field as `[]`. An FK whose target is not part of the selection still marks its columns as keys, but draws no edge.
 */
import type { NodeKind } from "../../api/types";

export interface DiagramForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

/** The shape of a snapshot object the diagram needs (structurally what `SnapshotObject` is or will be). */
export interface DiagramInputObject {
  schema: string;
  name: string;
  kind: NodeKind;
  columns: { name: string; typeName: string; isPk: boolean }[];
  foreignKeys?: DiagramForeignKey[];
}

export interface DiagramColumn {
  name: string;
  typeName: string;
  isPk: boolean;
  /** The column is part of a foreign key (drawn with the blue key marker even when the edge is not). */
  isFk: boolean;
  /** Another table's foreign key points at this column (it is an edge port, so keys-only mode keeps it). */
  isRef?: boolean;
}

export interface DiagramNode {
  /** Stable index into the model's node array (also the DOM `data-table-id`). */
  index: number;
  /** `schema.name`: the stable identity dragged positions are keyed by. */
  key: string;
  schema: string;
  name: string;
  kind: NodeKind;
  columns: DiagramColumn[];
  /** The rows drawn in the box for the current column mode (a subset of `columns`, in their original order). */
  rows: DiagramColumn[];
  /** Columns not drawn: a footer row ("+N more") stands in for them, and is where their edge ports attach. */
  hidden: number;
  /** The schema is shown next to the name (the diagram spans several schemas). */
  showSchema: boolean;
  width: number;
  height: number;
}

export interface DiagramEdge {
  id: string;
  /** Referencing table (the FK owner, the "many" side). */
  from: number;
  /** Referenced table (the "one" side). */
  to: number;
  label: string;
  columns: string[];
  refColumns: string[];
  self: boolean;
}

export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type ColumnsMode = "all" | "keys" | "none";

export interface DiagramOptions {
  columns: ColumnsMode;
  showTypes: boolean;
}

// ---------------------------------------------------------------- geometry metrics (shared with layout.ts / route.ts / svg.ts)

export const DGM = {
  /** Approximate width of one character of the column/table name (12px monospace). */
  charW: 7.2,
  /** Every box edge and row centre sits on this lattice, which is the grid the edge router runs on. */
  grid: 10,
  rowH: 20,
  headerH: 30,
  padX: 12,
  padBottom: 10,
  /** Gap between the name column and the type column. */
  colGap: 16,
  /** Reserved width of the key-icon column (PK/FK marker). */
  iconW: 14,
  minW: 140,
  /** A box never grows wider than this: longer names / types are truncated with an ellipsis. */
  maxW: 380,
  /** A type longer than this many characters is truncated. */
  maxTypeChars: 22,
  /** More rows than this and the box shows the keys plus the first columns, then a "+N more" footer. */
  maxRows: 28,
} as const;

/** Rounds up to the routing lattice. */
const up = (v: number): number => Math.ceil(v / DGM.grid) * DGM.grid;

/** The columns a node shows for the current mode. */
export function visibleColumns(columns: readonly DiagramColumn[], mode: ColumnsMode): DiagramColumn[] {
  if (mode === "all") return [...columns];
  if (mode === "none") return [];
  return columns.filter((c) => c.isPk || c.isFk || c.isRef);
}

/**
 * The rows a box draws, and how many columns it leaves out. Past `DGM.maxRows` the keys always stay (edge ports
 * attach to them) and the first other columns fill the remaining rows, in their original order.
 */
export function displayRows<T extends DiagramColumn>(columns: readonly T[], mode: ColumnsMode): { rows: T[]; hidden: number } {
  const vis = visibleColumns(columns, mode) as T[];
  let rows = vis;
  if (vis.length > DGM.maxRows) {
    const keys = vis.filter((c) => c.isPk || c.isFk || c.isRef);
    let room = Math.max(0, DGM.maxRows - keys.length);
    const keep = new Set<T>(keys);
    for (const c of vis) {
      if (room === 0) break;
      if (!keep.has(c)) {
        keep.add(c);
        room--;
      }
    }
    rows = vis.filter((c) => keep.has(c));
  }
  return { rows, hidden: columns.length - rows.length };
}

/** Text of the footer row that stands in for the columns the box does not draw. */
export const footerText = (hidden: number, shown: number): string => (shown === 0 ? `${hidden} column${hidden === 1 ? "" : "s"}` : `+${hidden} more`);

/** Top of row `j` (0-based, the footer row is `rows.length`) relative to the box. */
export const rowTop = (j: number): number => DGM.headerH + j * DGM.rowH;

/**
 * Characters of the name and type columns that fit in a box of `width`: the renderer truncates to these, and
 * `measureTable` uses the same split, so what is measured is what is drawn.
 */
export function rowChars(width: number, rows: readonly { name: string; typeName: string }[], showTypes: boolean): { name: number; type: number } {
  let typeChars = 0;
  if (showTypes) for (const r of rows) typeChars = Math.max(typeChars, Math.min(r.typeName.length, DGM.maxTypeChars));
  const typeW = showTypes && typeChars ? DGM.colGap + typeChars * DGM.charW : 0;
  const name = Math.max(4, Math.floor((width - DGM.padX * 2 - DGM.iconW - typeW) / DGM.charW));
  return { name, type: typeChars };
}

/** `text` cut to `max` characters with a trailing ellipsis. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : max <= 1 ? "…" : text.slice(0, max - 1) + "…");

/** Width / height of a table box for the given columns and options (the layout uses these, so they must be deterministic). */
export function measureTable(
  name: string,
  columns: readonly { name: string; typeName: string; isPk: boolean; isFk: boolean; isRef?: boolean }[],
  opts: DiagramOptions,
  schema?: string,
): { width: number; height: number } {
  const { rows, hidden } = displayRows(columns, opts.columns);
  let nameW = 0;
  let typeW = 0;
  for (const c of rows) nameW = Math.max(nameW, c.name.length);
  if (hidden > 0) nameW = Math.max(nameW, footerText(hidden, rows.length).length);
  if (opts.showTypes) for (const c of rows) typeW = Math.max(typeW, Math.min(c.typeName.length, DGM.maxTypeChars));
  const rowsW = DGM.padX * 2 + DGM.iconW + nameW * DGM.charW + (opts.showTypes && typeW ? DGM.colGap + typeW * DGM.charW : 0);
  // The header holds the glyph, the (semi-bold) name and, across schemas, the schema in a smaller muted face.
  const headW = DGM.padX * 2 + 18 + name.length * 7.6 + (schema ? 14 + schema.length * 6.4 : 0);
  const width = Math.min(DGM.maxW, Math.max(DGM.minW, up(Math.max(rowsW, headW))));
  const nrows = rows.length + (hidden > 0 ? 1 : 0);
  const height = DGM.headerH + nrows * DGM.rowH + DGM.padBottom;
  return { width, height: up(height) };
}

const keyOf = (schema: string, name: string): string => `${schema}\u0000${name}`;

/**
 * The identity a dragged node position is stored under; stable across snapshot reloads and reorders.
 * NUL cannot occur in a schema or table name, so `a.b` + `c` and `a` + `b.c` stay distinct.
 */
export const nodeKey = (schema: string, name: string): string => `${schema}\u0000${name}`;

/**
 * Keeps only the dragged positions whose table still exists (keyed by `nodeKey`), so a reload does not move a
 * position onto a different table. Returns the same map when nothing was dropped.
 */
export function prunePositions(
  positions: Map<string, { x: number; y: number }>,
  nodes: readonly { key: string }[],
): Map<string, { x: number; y: number }> {
  const keys = new Set(nodes.map((n) => n.key));
  let changed = false;
  const out = new Map<string, { x: number; y: number }>();
  for (const [key, pos] of positions) {
    if (keys.has(key)) out.set(key, pos);
    else changed = true;
  }
  return changed ? out : positions;
}

/**
 * The objects of a diagram of some tables: those tables plus their direct FK neighbours (tables they reference and
 * tables that reference them), so each selected table shows its relations. `tables` undefined: every object.
 * Names match exactly: the explorer passes the names as the database has them.
 */
export function subsetOf<T extends DiagramInputObject>(objects: readonly T[], tables: readonly string[] | undefined): T[] {
  if (!tables) return [...objects];
  const picked = new Set(tables);
  const keep = new Set(picked);
  for (const o of objects) {
    for (const fk of o.foreignKeys ?? []) {
      if (picked.has(o.name)) keep.add(fk.refTable);
      if (picked.has(fk.refTable)) keep.add(o.name);
    }
  }
  return objects.filter((o) => keep.has(o.name));
}

/**
 * Builds the diagram model. Nodes are sorted by (schema, name) and edges by (from, to, label), so the result is
 * deterministic for a given snapshot regardless of its input order. Missing / duplicate objects are handled safely.
 */
export function buildDiagram(objects: readonly DiagramInputObject[], opts: DiagramOptions): DiagramModel {
  const sorted = [...objects].sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  const showSchema = new Set(sorted.map((o) => o.schema)).size > 1;

  // Columns another table's foreign key points at: they are edge ports, so keys-only mode keeps them.
  const known = new Set(sorted.map((o) => keyOf(o.schema, o.name)));
  const referenced = new Map<string, Set<string>>();
  for (const o of sorted)
    for (const fk of o.foreignKeys ?? []) {
      const k = keyOf(fk.refSchema, fk.refTable);
      if (!known.has(k)) continue;
      let set = referenced.get(k);
      if (!set) referenced.set(k, (set = new Set()));
      for (const c of fk.refColumns) set.add(c);
    }

  const byKey = new Map<string, number>();
  const nodes: DiagramNode[] = [];
  for (const o of sorted) {
    const key = keyOf(o.schema, o.name);
    if (byKey.has(key)) continue;
    const index = nodes.length;
    byKey.set(key, index);
    const fkCols = new Set<string>();
    for (const fk of o.foreignKeys ?? []) for (const c of fk.columns) fkCols.add(c);
    const refCols = referenced.get(key);
    const columns: DiagramColumn[] = o.columns.map((c) => ({ name: c.name, typeName: c.typeName, isPk: c.isPk, isFk: fkCols.has(c.name), isRef: refCols?.has(c.name) ?? false }));
    const { rows, hidden } = displayRows(columns, opts.columns);
    const { width, height } = measureTable(o.name, columns, opts, showSchema ? o.schema : undefined);
    nodes.push({ index, key: nodeKey(o.schema, o.name), schema: o.schema, name: o.name, kind: o.kind, columns, rows, hidden, showSchema, width, height });
  }

  const edges: DiagramEdge[] = [];
  let eid = 0;
  for (const o of sorted) {
    const from = byKey.get(keyOf(o.schema, o.name));
    if (from === undefined) continue;
    for (const fk of o.foreignKeys ?? []) {
      const to = byKey.get(keyOf(fk.refSchema, fk.refTable));
      if (to === undefined) continue; // target outside the selection: no edge, columns still marked above
      edges.push({
        id: `e${eid++}`,
        from,
        to,
        label: fk.name,
        columns: [...fk.columns],
        refColumns: [...fk.refColumns],
        self: from === to,
      });
    }
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to || a.label.localeCompare(b.label));

  return { nodes, edges };
}
