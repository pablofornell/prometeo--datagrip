/**
 * `createMemo` and `createComputed` run their function at once, while the component is created. A memo that reads a
 * signal (or another memo) declared further down the component hits the `const` before its initialization and throws a
 * ReferenceError: the grid is then never created, and every table and result tab stays empty (0.2.1 - 0.3.1, the
 * Ctrl+Click foreign key underline read `fkHover` before its declaration).
 *
 * The tests run without a DOM, so the grid cannot be mounted here. This test reads the source instead: for every eager
 * computation of the component, each signal or memo it reads must be declared above it.
 */
import { describe, expect, it } from "vitest";
import source from "./DataGrid.tsx?raw";

/** End of the call whose `(` is at `open`: the index of the matching `)`. Skips strings, templates and comments. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    // a template literal: its `${...}` parts hold balanced code, count their parentheses as code
    if (ch === "`") continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return src.length;
}

/**
 * The `(` of the call whose name ends at `from`, past an optional type argument (`createMemo<((t: string) => boolean) |
 * null>(`); -1 when no call follows. An arrow's `=>` inside the type argument is no closing `>`.
 */
function callOpen(src: string, from: number): number {
  let i = from;
  while (/\s/.test(src[i] ?? "")) i++;
  if (src[i] === "<") {
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "<") depth++;
      else if (src[i] === ">" && src[i - 1] !== "=" && --depth === 0) break;
    }
    i++;
    while (/\s/.test(src[i] ?? "")) i++;
  }
  return src[i] === "(" ? i : -1;
}

/** Name -> position of each `const [name, setName] = createSignal` and `const name = createMemo` of the file. */
function declarations(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*createSignal\b/g)) out.set(m[1], m.index!);
  for (const m of src.matchAll(/const (\w+)\s*=\s*createMemo\b/g)) out.set(m[1], m.index!);
  return out;
}

/** Reads of a declared name before its declaration, inside an eager computation (`createMemo` / `createComputed`). */
function earlyReads(src: string): string[] {
  const decls = declarations(src);
  const found: string[] = [];
  for (const m of src.matchAll(/\b(createMemo|createComputed)\b/g)) {
    const open = callOpen(src, m.index! + m[0].length);
    if (open < 0) continue;
    const body = src.slice(open, closeParen(src, open) + 1);
    for (const [name, at] of decls) {
      if (at <= m.index!) continue;
      if (new RegExp(`(?<![\\w.])${name}\\(\\)`).test(body)) {
        const line = src.slice(0, m.index!).split("\n").length;
        found.push(`${name}() read at line ${line} before its declaration (line ${src.slice(0, at).split("\n").length})`);
      }
    }
  }
  return found;
}

describe("DataGrid declaration order", () => {
  it("finds the signals and memos of the component", () => {
    const d = declarations(source);
    expect(d.has("fkHover")).toBe(true);
    expect(d.has("linkRect")).toBe(true);
  });

  it("reads no signal or memo in an eager computation before its declaration", () => {
    expect(earlyReads(source)).toEqual([]);
  });

  it("looks into a memo whose type argument holds parentheses and an arrow", () => {
    const bad = [
      "const m = createMemo<((t: string) => boolean) | null>(() => (late() ? null : null));",
      "const [late, setLate] = createSignal(0);",
    ].join("\n");
    expect(earlyReads(bad)).toEqual(["late() read at line 1 before its declaration (line 2)"]);
  });

  it("reports a memo that reads a signal declared below it", () => {
    const bad = [
      "const early = createMemo(() => late() + 1);",
      "const [late, setLate] = createSignal(0);",
    ].join("\n");
    expect(earlyReads(bad)).toEqual(["late() read at line 1 before its declaration (line 2)"]);
  });
});
