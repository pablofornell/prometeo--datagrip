/** Export / copy of a result: the Export Data dialog (file, clipboard) and the quick copy of the Options menu. */
import { type ExportFormat, type ExportOptions, defaultExportOptions, exportQueryToString, exportToString } from "../../api/db";
import { notify } from "../../components/ui";
import { copyText } from "../../components/ui/clipboard";
import { type ExportSource, openExportDialog } from "../table/exportData";
import { type OutputHost, type ResultTab, currentOutput } from "./model";

import { extractorLabel } from "./extractors";

export { CLIPBOARD_EXTRACTORS, EXTRACTORS, extractorLabel, extractorMenuItems, isBinaryFormat } from "./extractors";
export { copyText };
export const formatLabel = extractorLabel;

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

function optionsFor(tab: ResultTab, host: OutputHost, format: ExportFormat): ExportOptions {
  return {
    ...defaultExportOptions(host.driver),
    format,
    tableName: tab.meta.find((c) => c.tableRef)?.tableRef ?? "result",
  };
}

/** Text of the whole result in `format`. Re-runs the query when not every row is loaded. */
async function resultText(tab: ResultTab, host: OutputHost, format: ExportFormat): Promise<string> {
  const o = optionsFor(tab, host, format);
  return tab.hasMore() ? exportQueryToString(host.dsId, tab.sql, o) : exportToString({ columns: tab.meta, rows: tab.rows }, o);
}

export async function copyResult(tab: ResultTab, host: OutputHost, format: ExportFormat): Promise<void> {
  try {
    await copyText(await resultText(tab, host, format));
    notify({ kind: "info", title: "Copied to the clipboard", body: `Result as ${formatLabel(format)}` });
  } catch (e) {
    notify({ kind: "error", title: "Cannot copy the result", body: errText(e) });
  }
}

/** What the Export Data dialog exports for a result tab: its loaded rows, or its statement again when it has more. */
function exportSource(tab: ResultTab, host: OutputHost): ExportSource {
  return {
    dsId: host.dsId,
    label: tab.title(),
    sql: tab.sql,
    options: optionsFor(tab, host, tab.extractor()),
    loaded: () => ({ columns: tab.meta, rows: tab.rows, complete: !tab.hasMore() }),
    onOptions: (o) => tab.setExtractor(o.format),
  };
}

/** The grid's Export Data button: the Export Data dialog (extractor, options, preview, output file). */
export function exportResultData(tab: ResultTab, host: OutputHost): void {
  openExportDialog(exportSource(tab, host));
}

/** `grid.export` without a target: Export Data to File of the selected result of the output. False when none. */
export function exportCurrentResult(): boolean {
  const out = currentOutput();
  const tab = out?.current();
  if (!out?.host || !tab) return false;
  exportResultData(tab, out.host);
  return true;
}
