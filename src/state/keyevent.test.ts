// @vitest-environment node
/** Punctuation shortcuts are matched by the character the layout produces, whatever key cap makes it. */
import { describe, expect, it } from "vitest";
import { eventKey, shortcutMatches } from "./actions";

interface Ev {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}
const ev = (key: string, code: string, mods: Partial<Ev> = {}): KeyboardEvent =>
  ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }) as KeyboardEvent;
const ctrl = (key: string, code: string, shift = false): KeyboardEvent => ev(key, code, { ctrlKey: true, shiftKey: shift });

const ZOOM_IN = ["Ctrl+=", "Ctrl+Plus", "Ctrl+Shift+Plus"];
const zoomIn = (e: KeyboardEvent) => ZOOM_IN.some((s) => shortcutMatches(s, e));
const zoomOut = (e: KeyboardEvent) => shortcutMatches("Ctrl+-", e);
const zoomReset = (e: KeyboardEvent) => shortcutMatches("Ctrl+0", e);

describe("zoom shortcuts per keyboard layout", () => {
  const layouts: Record<string, { in: KeyboardEvent[]; out: KeyboardEvent[]; reset: KeyboardEvent[] }> = {
    US: {
      in: [ctrl("=", "Equal"), ctrl("+", "Equal", true), ctrl("+", "NumpadAdd")],
      out: [ctrl("-", "Minus"), ctrl("-", "NumpadSubtract")],
      reset: [ctrl("0", "Digit0"), ctrl("0", "Numpad0")],
    },
    ES: {
      // "-" sits where US has "/", "+" is its own key, "=" is Shift+0
      in: [ctrl("+", "BracketRight"), ctrl("=", "Digit0", true), ctrl("+", "NumpadAdd")],
      out: [ctrl("-", "Slash"), ctrl("-", "NumpadSubtract")],
      reset: [ctrl("0", "Digit0")],
    },
    DE: {
      in: [ctrl("+", "BracketRight"), ctrl("=", "Digit0", true), ctrl("+", "NumpadAdd")],
      out: [ctrl("-", "Slash"), ctrl("-", "NumpadSubtract")],
      reset: [ctrl("0", "Digit0")],
    },
    FR: {
      // "-" is the digit-row key of the 6, "=" its own key, "+" is Shift+=, 0 is "à"
      in: [ctrl("=", "Equal"), ctrl("+", "Equal", true), ctrl("+", "NumpadAdd")],
      out: [ctrl("-", "Digit6"), ctrl("-", "NumpadSubtract")],
      reset: [ctrl("à", "Digit0"), ctrl("0", "Numpad0")],
    },
  };
  for (const [name, l] of Object.entries(layouts)) {
    it(`zooms in, out and resets on ${name}`, () => {
      for (const e of l.in) expect(zoomIn(e), `${e.key}/${e.code}`).toBe(true);
      for (const e of l.out) expect(zoomOut(e), `${e.key}/${e.code}`).toBe(true);
      for (const e of l.reset) expect(zoomReset(e), `${e.key}/${e.code}`).toBe(true);
      // and never the neighbour's shortcut
      for (const e of l.out) expect(zoomIn(e) || shortcutMatches("Ctrl+/", e) || shortcutMatches("Ctrl+6", e)).toBe(false);
    });
  }

  it("does not read Ctrl+- on ES as Ctrl+/ (the toggle comment key)", () => {
    expect(eventKey(ev("-", "Slash", { ctrlKey: true }))).toBe("-");
    expect(shortcutMatches("Ctrl+/", ctrl("-", "Slash"))).toBe(false);
  });
});

describe("existing punctuation chords on US", () => {
  const cases: [string, KeyboardEvent][] = [
    ["Ctrl+/", ctrl("/", "Slash")],
    ["Ctrl+Shift+/", ctrl("?", "Slash", true)],
    ["Ctrl+[", ctrl("[", "BracketLeft")],
    ["Ctrl+]", ctrl("]", "BracketRight")],
    ["Ctrl+.", ctrl(".", "Period")],
    ["Ctrl+Comma", ctrl(",", "Comma")],
    ["Ctrl+`", ctrl("`", "Backquote")],
    ["Ctrl+Shift+'", ctrl('"', "Quote", true)],
    ["Alt+\\", ev("\\", "Backslash", { altKey: true })],
    ["Alt+Shift+.", ev(">", "Period", { altKey: true, shiftKey: true })],
    ["Alt+Shift+Comma", ev("<", "Comma", { altKey: true, shiftKey: true })],
    ["Ctrl+Plus", ctrl("+", "Equal", true)],
    ["Ctrl+=", ctrl("=", "Equal")],
    ["Ctrl+-", ctrl("-", "Minus")],
    ["Ctrl+0", ctrl("0", "Digit0")],
    ["Ctrl+Shift+Tab", ctrl("Tab", "Tab", true)],
    ["Ctrl+Space", ctrl(" ", "Space")],
  ];
  for (const [chord, e] of cases) {
    it(`${chord} matches`, () => expect(shortcutMatches(chord, e)).toBe(true));
  }

  it("keeps the unshifted and shifted slash apart", () => {
    expect(shortcutMatches("Ctrl+/", ctrl("?", "Slash", true))).toBe(false);
    expect(shortcutMatches("Ctrl+Shift+/", ctrl("/", "Slash"))).toBe(false);
  });
});

describe("keys that keep matching by position", () => {
  it("letters, whatever the layout or Alt makes of them", () => {
    expect(eventKey(ev("å", "KeyA", { altKey: true }))).toBe("a"); // macOS Option+A
    expect(eventKey(ev("q", "KeyA"))).toBe("a"); // AZERTY
  });
  it("digits, also where the digit row types punctuation (AZERTY) or Shift symbols", () => {
    expect(shortcutMatches("Alt+1", ev("&", "Digit1", { altKey: true }))).toBe(true);
    expect(shortcutMatches("Alt+4", ev("'", "Digit4", { altKey: true }))).toBe(true);
    expect(shortcutMatches("Ctrl+Shift+1", ev("!", "Digit1", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it("macOS Alt+Shift+. whose character is not ASCII", () => {
    expect(shortcutMatches("Alt+Shift+.", ev("˘", "Period", { altKey: true, shiftKey: true }))).toBe(true);
  });
});
