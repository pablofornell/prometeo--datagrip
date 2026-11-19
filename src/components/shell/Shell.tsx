import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { FilesToolWindow } from "../../features/files";
import {
  type ToolWindowAnchor,
  anchorOf,
  commitLayout,
  effectiveSize,
  maxSizeOf,
  maximizedToolWindow,
  MIN_BOTTOM,
  MIN_LEFT,
  MIN_RIGHT,
  GAP,
  setBodyBox,
  setToolWindowSize,
  visibleAt,
} from "../../state/layout";
import { Slot } from "../../state/slots";
import { isMcpView, mcpLeftWidth } from "../../state/view";
import { Splitter } from "../ui/Splitter";
import { EditorArea } from "./EditorArea";
import { ExplorerBodyPlaceholder, ExplorerToolbarPlaceholder, OutputBodyPlaceholder } from "./Placeholders";
import { ToolWindowPanel } from "./ToolWindowPanel";

/**
 * The island layout: a grid with a left, a right and a bottom dock around the editor. Every tool window panel
 * stays at the same place in the DOM (its body keeps its state when it is moved to another anchor); its anchor
 * only picks the grid area (shell.css). Sizes are persisted per window.
 *
 * In the MCP view (state/view.ts) the right and bottom docks collapse, the editor island is hidden (not unmounted) and the
 * `mcp.view` slot takes the editor's place; the left column stays.
 */
export function Shell(): JSX.Element {
  let body!: HTMLDivElement;
  const [bodyW, setBodyW] = createSignal(1600);

  onMount(() => {
    const measure = () => {
      setBodyBox(body.clientWidth, body.clientHeight);
      setBodyW(body.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    measure();
    onCleanup(() => ro.disconnect());
  });

  // the MCP view is mounted the first time it is shown, then kept alive (hidden) so its scroll and filters stay
  const [mcpMounted, setMcpMounted] = createSignal(isMcpView());
  createEffect(() => isMcpView() && setMcpMounted(true));

  /** Anchor of the maximized window (it spans the editor area). */
  const maxAnchor = (): ToolWindowAnchor | null => {
    const id = maximizedToolWindow();
    return id ? anchorOf(id) : null;
  };
  const mcp = isMcpView;
  const shown = (a: ToolWindowAnchor) => !!visibleAt(a);
  const splitter = (a: ToolWindowAnchor) =>
    shown(a) && maxAnchor() !== a && !(a !== "bottom" && maxAnchor() === "bottom") && (!mcp() || a === "left");

  /** Size of the dock at an anchor: the MCP view only keeps the left one (and may narrow it). */
  const sizeAt = (a: ToolWindowAnchor): number => {
    if (mcp()) return a === "left" ? mcpLeftWidth(effectiveSize("left"), bodyW(), MIN_LEFT) : 0;
    return effectiveSize(a);
  };

  const columns = () => {
    const l = sizeAt("left");
    const r = sizeAt("right");
    return `${l}px ${l ? GAP : 0}px minmax(0, 1fr) ${r ? GAP : 0}px ${r}px`;
  };
  const rows = () => {
    const b = sizeAt("bottom");
    return maxAnchor() === "bottom" && !mcp() ? "0px 0px minmax(0, 1fr)" : `minmax(0, 1fr) ${b ? GAP : 0}px ${b}px`;
  };

  const sizeOf = (a: ToolWindowAnchor) => ({
    size: sizeAt(a),
    onResize: (px: number) => {
      const id = visibleAt(a);
      if (id) setToolWindowSize(id, px);
    },
  });

  return (
    <div
      class="dg-body"
      ref={body}
      data-max={maxAnchor() ?? undefined}
      data-view={mcp() ? "mcp" : undefined}
      style={{ "grid-template-columns": columns(), "grid-template-rows": rows() }}
    >
      <ToolWindowPanel
        id="explorer"
        fallbackToolbar={ExplorerToolbarPlaceholder}
        fallbackBody={ExplorerBodyPlaceholder}
      />
      <ToolWindowPanel id="files" fallbackBody={FilesToolWindow} />
      <ToolWindowPanel id="output" fallbackBody={OutputBodyPlaceholder} />
      <ToolWindowPanel id="services" />
      <ToolWindowPanel id="run" />
      <ToolWindowPanel id="notifications" />
      <Show when={splitter("left")}>
        <Splitter
          class="dg-split-left"
          orientation="vertical"
          {...sizeOf("left")}
          min={MIN_LEFT}
          max={() => maxSizeOf("left")}
          onResizeEnd={commitLayout}
        />
      </Show>
      <EditorArea />
      <Show when={mcpMounted()}>
        <Slot id="mcp.view" />
      </Show>
      <Show when={splitter("right")}>
        <Splitter
          class="dg-split-right"
          orientation="vertical"
          {...sizeOf("right")}
          min={MIN_RIGHT}
          max={() => maxSizeOf("right")}
          reverse
          onResizeEnd={commitLayout}
        />
      </Show>
      <Show when={splitter("bottom")}>
        <Splitter
          class="dg-split-bottom"
          orientation="horizontal"
          {...sizeOf("bottom")}
          min={MIN_BOTTOM}
          max={() => maxSizeOf("bottom")}
          reverse
          onResizeEnd={commitLayout}
        />
      </Show>
    </div>
  );
}
