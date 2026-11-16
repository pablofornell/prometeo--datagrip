// @vitest-environment node
/** The copy button is a keyboard control: reachable with Tab, visibly focused, named, and "Copied" is announced. */
import { describe, expect, it } from "vitest";
import source from "./CopyButton.tsx?raw";
import css from "../../styles/ui.css?raw";

describe("CopyButton", () => {
  it("is in the tab order (no tabindex=-1) and does not grab the focus by itself", () => {
    expect(source).not.toMatch(/tabindex/i);
    expect(source).not.toMatch(/autofocus|\.focus\(/i);
  });

  it("has an accessible name and a polite live region that is always rendered", () => {
    expect(source).toMatch(/aria-label=\{props\.tooltip \?\? "Copy"\}/);
    expect(source).toMatch(/aria-live="polite"/);
    expect(source).toMatch(/role="status"/);
  });

  it("keeps Enter and Space away from the global keymap (the button clicks natively)", () => {
    expect(source).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
    expect(source).toMatch(/stopPropagation/);
  });

  it("draws a focus ring with the focus token", () => {
    expect(css).toMatch(/\.dg-copy-btn:focus-visible\s*\{[^}]*outline:[^;]*var\(--dg-focus-ring\)/);
  });
});
