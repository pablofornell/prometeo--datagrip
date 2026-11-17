// @vitest-environment node
/** Punctuation shortcuts are matched by the character the layout produces, whatever key cap makes it. */
import { describe, expect, it } from "vitest";
import { eventKey, shortcutMatches } from "./actions";
import { chordFromEvent, normalizeShortcut } from "../features/settings/keymap-util";

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

describe("letters keep matching by position on layouts that type punctuation or other letters there", () => {
  it("Dvorak: Ctrl+Q/W/E/Z on the keys that type ' , . ;", () => {
    for (const [chord, key, code] of [
      ["Ctrl+Q", "'", "KeyQ"],
      ["Ctrl+W", ",", "KeyW"],
      ["Ctrl+E", ".", "KeyE"],
      ["Ctrl+Z", ";", "KeyZ"],
    ] as const) {
      expect(shortcutMatches(chord, ctrl(key, code)), chord).toBe(true);
      // and not the punctuation chord of the character typed
      expect(shortcutMatches("Ctrl+Comma", ctrl(key, code))).toBe(false);
      expect(shortcutMatches("Ctrl+.", ctrl(key, code))).toBe(false);
    }
  });
  it("Dvorak: the letters typed on the Comma/Period/Slash keys are those letters", () => {
    expect(shortcutMatches("Ctrl+W", ctrl("w", "Comma"))).toBe(true);
    expect(shortcutMatches("Ctrl+V", ctrl("v", "Period"))).toBe(true);
    expect(shortcutMatches("Ctrl+Z", ctrl("z", "Slash"))).toBe(true);
    expect(shortcutMatches("Ctrl+/", ctrl("z", "Slash"))).toBe(false);
    expect(shortcutMatches("Ctrl+Comma", ctrl("w", "Comma"))).toBe(false);
  });
  it("Greek: KeyQ types ';' and KeyW a Greek letter, both are Q and W", () => {
    expect(shortcutMatches("Ctrl+Q", ctrl(";", "KeyQ"))).toBe(true);
    expect(shortcutMatches("Ctrl+Shift+Q", ctrl(":", "KeyQ", true))).toBe(true);
    expect(shortcutMatches("Ctrl+W", ctrl("ς", "KeyW"))).toBe(true);
    expect(shortcutMatches("Ctrl+E", ctrl("ε", "KeyE"))).toBe(true);
  });
});

describe("the Keymap recorder and the matcher agree", () => {
  const layouts: Record<string, KeyboardEvent[]> = {
    US: [
      ctrl("/", "Slash"), ctrl("?", "Slash", true), ctrl("-", "Minus"), ctrl("=", "Equal"), ctrl("+", "Equal", true),
      ctrl("[", "BracketLeft"), ctrl("]", "BracketRight"), ctrl(".", "Period"), ctrl(",", "Comma"), ctrl("`", "Backquote"),
      ctrl('"', "Quote", true), ctrl(";", "Semicolon"), ev("\\", "Backslash", { altKey: true }), ev(">", "Period", { altKey: true, shiftKey: true }),
      ev("<", "Comma", { altKey: true, shiftKey: true }), ctrl("f", "KeyF", true), ctrl("0", "Digit0"), ev("5", "Digit5", { altKey: true }),
      ctrl(" ", "Space"), ctrl("Tab", "Tab", true), ev("F4", "F4"), ev("ArrowLeft", "ArrowLeft", { altKey: true }), ev("PageUp", "PageUp"),
      ev("Enter", "Enter", { ctrlKey: true }), ctrl("-", "NumpadSubtract"), ctrl("+", "NumpadAdd"), ctrl("0", "Numpad0"),
    ],
    ES: [
      ctrl("-", "Slash"), ctrl("+", "BracketRight"), ctrl("=", "Digit0", true), ctrl("ñ", "Semicolon"), ctrl("ç", "Backslash"),
      ctrl(",", "Comma"), ctrl(".", "Period"), ctrl("<", "IntlBackslash"), ctrl("º", "Backquote"), ctrl("0", "Digit0"), ctrl("a", "KeyA"),
    ],
    DE: [
      ctrl("-", "Slash"), ctrl("+", "BracketRight"), ctrl("=", "Digit0", true), ctrl("#", "Backslash"), ctrl("ü", "BracketLeft"),
      ctrl("ß", "Minus"), ctrl("^", "Backquote"), ctrl("z", "KeyY"), ctrl("y", "KeyZ"), ctrl("0", "Digit0"), ctrl(",", "Comma"), ctrl(".", "Period"),
    ],
    FR: [
      ctrl("-", "Digit6"), ctrl("=", "Equal"), ctrl("+", "Equal", true), ctrl("à", "Digit0"), ctrl("&", "Digit1"), ctrl("é", "Digit2"),
      ctrl(";", "Comma"), ctrl(":", "Period"), ctrl("!", "Slash"), ctrl("ù", "Quote"), ctrl("q", "KeyA"), ctrl("a", "KeyQ"), ctrl(",", "KeyM"),
      ev("'", "Digit4", { altKey: true }), ev("!", "Digit1", { ctrlKey: true, shiftKey: true }),
    ],
    Dvorak: [
      ctrl("'", "KeyQ"), ctrl(",", "KeyW"), ctrl(".", "KeyE"), ctrl(";", "KeyZ"), ctrl("w", "Comma"), ctrl("v", "Period"), ctrl("z", "Slash"),
      ctrl("-", "Quote"), ctrl("/", "BracketLeft"), ctrl("=", "BracketRight"), ctrl("[", "Minus"), ctrl("]", "Equal"), ctrl("s", "Semicolon"),
      ctrl("q", "KeyX"), ctrl("+", "BracketRight", true),
    ],
    Greek: [
      ctrl(";", "KeyQ"), ctrl(":", "KeyQ", true), ctrl("ς", "KeyW"), ctrl("ε", "KeyE"), ctrl("-", "Minus"), ctrl("=", "Equal"), ctrl("/", "Slash"),
      ctrl(".", "Period"), ctrl(",", "Comma"), ctrl("΄", "Quote"), ctrl("0", "Digit0"),
    ],
  };
  for (const [name, events] of Object.entries(layouts)) {
    it(`a recorded chord fires on the event it came from (${name})`, () => {
      for (const e of events) {
        const chord = chordFromEvent(e)!;
        expect(shortcutMatches(chord, e), `${e.key}/${e.code} -> ${chord}`).toBe(true);
        // the stored (normalized) spelling matches too
        expect(shortcutMatches(normalizeShortcut(chord), e), `${e.key}/${e.code} -> ${normalizeShortcut(chord)}`).toBe(true);
      }
    });
  }

  it("records the chords the registry spells (the same strings, so the conflict check finds them)", () => {
    expect(chordFromEvent(ctrl("-", "Slash"))).toBe("Ctrl+-"); // ES / DE zoom out
    expect(chordFromEvent(ctrl("-", "Digit6"))).toBe("Ctrl+-"); // FR
    expect(chordFromEvent(ctrl("/", "Slash"))).toBe("Ctrl+/");
    expect(chordFromEvent(ctrl("=", "Equal"))).toBe("Ctrl+=");
    expect(chordFromEvent(ctrl("+", "Equal", true))).toBe("Ctrl+Shift+Plus");
    expect(chordFromEvent(ctrl(";", "Comma"))).toBe("Ctrl+;"); // AZERTY: not Ctrl+Comma
    expect(chordFromEvent(ctrl(",", "Comma"))).toBe("Ctrl+Comma");
    expect(chordFromEvent(ctrl(".", "KeyE"))).toBe("Ctrl+E"); // Dvorak
    expect(chordFromEvent(ctrl("ς", "KeyW"))).toBe("Ctrl+W"); // Greek
  });

  it("an ES Ctrl+- recording does not collide with toggle comment, and collides with zoom out", () => {
    const e = ctrl("-", "Slash");
    expect(chordFromEvent(e)).not.toBe("Ctrl+/");
    expect(normalizeShortcut(chordFromEvent(e)!)).toBe(normalizeShortcut("Ctrl+-"));
  });
});
