// @vitest-environment node
import { describe, expect, it } from "vitest";
import pkg from "../../../package.json";
import { type AboutInfo, aboutRows, formatBuildDate, formatVersionInfo, platformName } from "./aboutInfo";

const INFO: AboutInfo = {
  name: "Datum",
  version: "1.2.3",
  buildDate: "2026-11-16T09:30:00.000Z",
  tauriVersion: "2.9.0",
  platform: "Linux",
  license: "MIT",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
};

describe("formatVersionInfo", () => {
  it("lists the product, every row and the webview", () => {
    expect(formatVersionInfo(INFO)).toBe(
      [
        "Datum",
        "Version: 1.2.3",
        "Created by: Pablo Fornell",
        "Build date: 2026-11-16",
        "Tauri: 2.9.0",
        "Platform: Linux",
        "License: MIT",
        "WebView: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
      ].join("\n"),
    );
  });

  it("says so when there is no Tauri runtime", () => {
    const rows = aboutRows({ ...INFO, tauriVersion: null });
    expect(rows.find(([k]) => k === "Tauri")?.[1]).toBe("not available (running in a browser)");
  });
});

describe("formatBuildDate", () => {
  it("keeps the UTC day", () => {
    expect(formatBuildDate("2026-01-02T23:59:59.000Z")).toBe("2026-01-02");
  });
  it("returns text that is not a date unchanged", () => {
    expect(formatBuildDate("unknown")).toBe("unknown");
  });
});

describe("platformName", () => {
  it("recognizes the three desktop systems", () => {
    expect(platformName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120")).toBe("Windows");
    expect(platformName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("macOS");
    expect(platformName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("Linux");
    expect(platformName("curl/8.0")).toBe("unknown");
  });
});

describe("build-time constants", () => {
  it("take the version and the license from package.json", () => {
    expect(__APP_VERSION__).toBe(pkg.version);
    expect(__APP_LICENSE__).toBe(pkg.license);
    expect(Number.isNaN(new Date(__BUILD_DATE__).getTime())).toBe(false);
  });
});
