/** Small building blocks of the MCP view: switch, chips, empty state, permission toggles, segmented control. */
import { For, type JSX, Show, splitProps } from "solid-js";
import type { McpLogStatus } from "../../api/types";
import { Icon, tip } from "../../components/ui";
import { explorerDataSources } from "../explorer";
import { dsIconUrl } from "../output/dsicon";
import { STATUS_LABEL } from "./model";

/** On / off switch (role="switch"), 28 x 16. */
export function Toggle(props: { checked: boolean; onChange: (on: boolean) => void; label?: string; disabled?: boolean; busy?: boolean; class?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      class={"dg-mcp-switch" + (props.class ? " " + props.class : "")}
      classList={{ "dg-on": props.checked, "dg-busy": props.busy }}
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="dg-mcp-switch-knob" />
    </button>
  );
}

/** Quiet pill with an optional icon; `tone` colors it with one of the colour families. */
export function Chip(props: { tone?: "accent" | "success" | "warning" | "danger" | "info" | "special" | "neutral"; icon?: string; children: JSX.Element; title?: string; class?: string }): JSX.Element {
  return (
    <span class={"dg-mcp-chip" + (props.class ? " " + props.class : "")} data-tone={props.tone ?? "neutral"} {...tip(props.title)}>
      <Show when={props.icon}>
        <Icon name={props.icon} />
      </Show>
      {props.children}
    </span>
  );
}

/** A filter that is on, with a × to remove it. */
export function FilterChip(props: { children: JSX.Element; onRemove: () => void; title?: string; icon?: string }): JSX.Element {
  return (
    <span class="dg-mcp-filter" {...tip(props.title)}>
      <Show when={props.icon}>
        <Icon name={props.icon} />
      </Show>
      <span class="dg-mcp-filter-text">{props.children}</span>
      <button type="button" class="dg-mcp-filter-x" aria-label="Remove filter" onClick={props.onRemove}>
        <Icon name="close-small" />
      </button>
    </span>
  );
}

export function StatusPill(props: { status: McpLogStatus }): JSX.Element {
  return (
    <span class="dg-mcp-status" data-status={props.status}>
      <Icon name={props.status === "ok" ? "checkmark" : props.status === "denied" ? "dg/locked" : "error"} />
      {STATUS_LABEL[props.status]}
    </span>
  );
}

/** The data source of an entry: brand icon and name, with the data source color when it has one. */
export function DsChip(props: { id: string | null; name?: string | null; muted?: boolean }): JSX.Element {
  const ds = () => explorerDataSources().find((d) => d.id === props.id);
  return (
    <Show when={props.id || props.name}>
      <span class="dg-mcp-ds" {...tip(ds()?.name ?? props.name ?? undefined)} classList={{ "dg-muted": props.muted, "dg-colored": !!ds()?.color }} style={ds()?.color ? { "--dg-mcp-ds-color": ds()!.color! } : undefined}>
        <Show when={ds()} fallback={<Icon name="dg/dbms" />}>
          {(d) => <Icon src={dsIconUrl(d().driver)} />}
        </Show>
        <span class="dg-mcp-ds-name">{ds()?.name ?? props.name ?? props.id}</span>
      </span>
    </Show>
  );
}

/** Centered message for a list with nothing to show. */
export function EmptyState(props: { icon?: string; title: string; children?: JSX.Element; actions?: JSX.Element; compact?: boolean }): JSX.Element {
  return (
    <div class="dg-mcp-empty" classList={{ "dg-compact": props.compact }}>
      <Show when={props.icon}>
        <span class="dg-mcp-empty-icon">
          <Icon name={props.icon} size={props.compact ? 20 : 28} />
        </span>
      </Show>
      <div class="dg-mcp-empty-title">{props.title}</div>
      <Show when={props.children}>
        <div class="dg-mcp-empty-text">{props.children}</div>
      </Show>
      <Show when={props.actions}>
        <div class="dg-mcp-empty-actions">{props.actions}</div>
      </Show>
    </div>
  );
}

/** Segmented control for a handful of exclusive choices (the date range of the log). */
export function Segmented<T extends string>(props: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label?: string }): JSX.Element {
  return (
    <div class="dg-mcp-seg" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button type="button" role="radio" aria-checked={props.value === o.id} class="dg-mcp-seg-item" classList={{ "dg-selected": props.value === o.id }} onClick={() => props.onChange(o.id)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export type PermState = "on" | "off" | "inherited" | "locked";

/**
 * One permission flag of a row. `on` is a rule that grants it, `inherited` the same grant coming from the folder (dashed,
 * a click makes it an own rule), `locked` a write that the data source's read-only flag forbids.
 */
export function PermToggle(props: {
  kind: "read" | "write";
  state: PermState;
  onToggle: () => void;
  /** Tooltip. */
  title?: string;
  label?: string;
  disabled?: boolean;
}): JSX.Element {
  const [own, rest] = splitProps(props, ["kind", "state", "onToggle", "title", "label", "disabled"]);
  const on = () => own.state === "on" || own.state === "inherited";
  return (
    <button
      type="button"
      class="dg-mcp-perm"
      data-kind={own.kind}
      data-state={own.state}
      role="switch"
      aria-checked={on()}
      aria-label={`${own.kind === "read" ? "Read" : "Write"}${own.label ? " " + own.label : ""}`}
      disabled={own.disabled || own.state === "locked"}
      {...tip(own.title)}
      onClick={() => own.onToggle()}
      {...rest}
    >
      <Icon name={own.state === "locked" ? "dg/locked" : own.kind === "read" ? "show" : "edit"} />
      <span>{own.kind === "read" ? "Read" : "Write"}</span>
    </button>
  );
}
