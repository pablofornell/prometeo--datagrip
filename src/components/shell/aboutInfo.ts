/**
 * What the About dialog shows, and the text of "Copy version info". The version, build date and license are build-time
 * constants (vite `define`, see vite.config.ts): the version and license come from package.json, the only place they are
 * written. The formatting is pure so it can be tested without a DOM.
 */

export interface AboutInfo {
  name: string;
  /** package.json version. */
  version: string;
  /** ISO 8601 timestamp of the build. */
  buildDate: string;
  /** Version of the Tauri runtime; `null` in a plain browser. */
  tauriVersion: string | null;
  /** Operating system, see `platformName`. */
  platform: string;
  /** SPDX id from package.json. */
  license: string;
  /** The webview's user agent string (useful in a bug report). */
  userAgent: string;
}

export const APP_NAME = "Prometeo DataGrip";

/** Operating system from a user agent string; `unknown` when it names none of the three. */
export function platformName(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Linux|X11/i.test(userAgent)) return "Linux";
  return "unknown";
}

/** `2026-11-16` from an ISO timestamp (UTC); the text itself when it is not a date. */
export function formatBuildDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** The rows of the dialog, in order: label and value. */
export function aboutRows(info: AboutInfo): [string, string][] {
  return [
    ["Version", info.version],
    ["Build date", formatBuildDate(info.buildDate)],
    ["Tauri", info.tauriVersion ?? "not available (running in a browser)"],
    ["Platform", info.platform],
    ["License", info.license],
  ];
}

/** Plain text for the clipboard: one `Label: value` per line under the product name, then the webview. */
export function formatVersionInfo(info: AboutInfo): string {
  const lines = aboutRows(info).map(([k, v]) => `${k}: ${v}`);
  return [info.name, ...lines, `WebView: ${info.userAgent}`].join("\n");
}
