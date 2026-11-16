/**
 * Logic of the User/Schema selector (SchemaPicker.tsx), kept free of the UI so that it is unit tested: the labels per
 * DBMS, the type-ahead match, the sections of the list (current / others / system) and the schema filter the quick
 * show / hide toggle writes. The filter itself is `datasource/schemaModel.ts`, its storage `state/schema-filter.ts`.
 */
import type { DataSource, SchemaChoice } from "../../api/db";
import { type SchemaFilter, type SchemaItem, filterOrDefault, isVisible, serializeFilter, toggleItem } from "../datasource/schemaModel";

type Driver = DataSource["driver"];

/** The words the selector uses for what the data source calls a schema. */
export interface SchemaNouns {
  /** Button / popup title: `User/Schema` (Oracle), `Schema` (PostgreSQL, SQLite), `Database` (MySQL). */
  title: string;
  /** Lower case singular and plural, for the messages. */
  one: string;
  many: string;
  currentSection: string;
  othersSection: string;
  systemSection: string;
}

export function schemaNouns(driver: Driver): SchemaNouns {
  switch (driver) {
    case "oracle":
      return { title: "User/Schema", one: "user", many: "users", currentSection: "Current user", othersSection: "Users", systemSection: "System users" };
    case "mysql":
      return { title: "Database", one: "database", many: "databases", currentSection: "Current database", othersSection: "Databases", systemSection: "System databases" };
    default:
      return { title: "Schema", one: "schema", many: "schemas", currentSection: "Current schema", othersSection: "Schemas", systemSection: "System schemas" };
  }
}

/** Can the session be switched to another schema (SQLite has one per file; Data Sources > Options can turn it off)? */
export const canSwitchSchema = (ds: Pick<DataSource, "driver" | "options">): boolean => ds.driver !== "sqlite" && ds.options?.switchSchema !== "disabled";

// ---------------------------------------------------------------- type-ahead

const isWordChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/i.test(c);

/**
 * How well `query` matches `name`, lower is better, null when it does not: 0 same name, 1 prefix, 2 starts a word
 * (`app` in `my_app`), 3 inside a word, 4 the initials of the words (`oi` for `order_items`). An empty query matches all.
 */
export function matchRank(name: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  for (let i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + 1)) if (!isWordChar(n[i - 1])) return 2;
  if (n.includes(q)) return 3;
  const initials = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toLowerCase())
    .join("");
  return initials.startsWith(q) ? 4 : null;
}

// ---------------------------------------------------------------- the list

export interface PickerRow {
  choice: SchemaChoice;
  /** The schema the session is in now. */
  current: boolean;
  /** The explorer lists it (schema filter). */
  visible: boolean;
}

export interface PickerSection {
  id: "current" | "others" | "system";
  label: string;
  rows: PickerRow[];
}

export interface SectionArgs {
  choices: readonly SchemaChoice[];
  driver: Driver;
  /** Name of the session's current schema, null when it is not known yet. */
  current: string | null;
  query: string;
  /** System ones are listed only when asked for (the current one always is). */
  showSystem: boolean;
  isVisible: (c: SchemaChoice) => boolean;
}

/**
 * The sections of the popup: the current user / schema on its own, the others by name (by match quality while typing),
 * the system ones last. A section without a row is left out.
 */
export function buildSections(a: SectionArgs): PickerSection[] {
  const n = schemaNouns(a.driver);
  const ranked: { c: SchemaChoice; rank: number }[] = [];
  for (const c of a.choices) {
    const rank = matchRank(c.name, a.query);
    if (rank !== null) ranked.push({ c, rank });
  }
  const byName = (x: { c: SchemaChoice; rank: number }, y: { c: SchemaChoice; rank: number }) =>
    x.rank - y.rank || x.c.name.localeCompare(y.c.name, undefined, { sensitivity: "base" }) || (x.c.name < y.c.name ? -1 : x.c.name > y.c.name ? 1 : 0);
  const row = (c: SchemaChoice): PickerRow => ({ choice: c, current: a.current !== null && c.name === a.current, visible: a.isVisible(c) });
  const cur = ranked.filter((x) => a.current !== null && x.c.name === a.current);
  const rest = ranked.filter((x) => !(a.current !== null && x.c.name === a.current));
  const sections: PickerSection[] = [
    { id: "current", label: n.currentSection, rows: cur.map((x) => row(x.c)) },
    { id: "others", label: n.othersSection, rows: rest.filter((x) => !x.c.system).sort(byName).map((x) => row(x.c)) },
    { id: "system", label: n.systemSection, rows: a.showSystem ? rest.filter((x) => x.c.system).sort(byName).map((x) => row(x.c)) : [] },
  ];
  return sections.filter((s) => s.rows.length);
}

/** Rows of all sections in display order: what the arrow keys walk. */
export const flatRows = (sections: readonly PickerSection[]): PickerRow[] => sections.flatMap((s) => s.rows);

/** The index the arrow keys land on: `delta` steps from `from`, wrapping around; -1 when the list is empty. */
export function stepIndex(from: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (((from + delta) % length) + length) % length;
}

// ---------------------------------------------------------------- the schema filter

export const itemOf = (c: SchemaChoice): SchemaItem => ({ path: c.path, name: c.name, system: c.system, isDefault: c.default });
const itemsOf = (choices: readonly SchemaChoice[]): SchemaItem[] => choices.map(itemOf);

/** The filter of a data source as the selector reads it (`raw` is the stored text, absent = the default view). */
export function filterFor(raw: string | undefined, choices: readonly SchemaChoice[]): SchemaFilter {
  return filterOrDefault(raw, itemsOf(choices));
}

/** Does the explorer list `c` with the stored filter `raw`? */
export const isChoiceVisible = (raw: string | undefined, choices: readonly SchemaChoice[], c: SchemaChoice): boolean => isVisible(filterFor(raw, choices), itemOf(c));

/**
 * An Oracle user that owns no object the account can see has nothing to list in the explorer (its tree only shows
 * users with objects), so showing or hiding it would change nothing.
 */
export const hasNothingToShow = (c: SchemaChoice): boolean => c.hasObjects === false;

/** The stored text after showing / hiding `c`: `undefined` when that is the default view again. */
export function toggledFilter(raw: string | undefined, choices: readonly SchemaChoice[], c: SchemaChoice, show: boolean): string | undefined {
  return serializeFilter(toggleItem(filterFor(raw, choices), itemOf(c), show), itemsOf(choices));
}

/**
 * Switching to a schema the explorer hides must not leave the explorer without it: the stored text that shows it, or
 * `null` when nothing has to change (it is listed already, or there is nothing of it to list).
 */
export function filterShowing(raw: string | undefined, choices: readonly SchemaChoice[], name: string): { value: string | undefined } | null {
  const c = choices.find((x) => x.name === name);
  if (!c || hasNothingToShow(c) || isChoiceVisible(raw, choices, c)) return null;
  return { value: toggledFilter(raw, choices, c, true) };
}
