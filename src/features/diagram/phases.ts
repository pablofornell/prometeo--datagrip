/** The phase lines of a diagram that is loading (see `<Loading>`): what the user reads while nothing is drawn yet. */

/** Before the first tables arrive: the data source is connecting, then its schema metadata is read. */
export function loadPhase(connected: boolean, dsName: string): string {
  return connected ? "Reading schema metadata…" : `Connecting to ${dsName}…`;
}

/** Layout + edge routing of `tables` boxes (runs in the worker; the diagram on screen stays until it lands). */
export function layoutPhase(tables: number): string {
  return `Laying out ${tables} ${tables === 1 ? "table" : "tables"}…`;
}
