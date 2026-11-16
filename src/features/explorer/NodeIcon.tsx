import { type Component } from "solid-js";
import { Icon } from "../../components/ui";
import { theme } from "../../state/theme";
import { LOCAL, localIconUrl } from "./icons";

/** Colour class of an object-type icon (the `.dg-ico-*` filters of styles/ui.css). Keys, brand icons and the error icon keep their own colours. */
const TINT: Record<string, string> = {
  "dg/database": "schema",
  "dg/schema": "schema",
  "dg/server-objects-group": "schema",
  "dg/database-objects-group": "schema",
  [LOCAL + "object-group"]: "schema",
  "dg/table": "table",
  "data-schema": "view",
  "dg/materialized-view": "view",
  "dg/index": "index",
  "dg/index-unique": "index",
  "dg/routine": "routine",
  "dg/function": "routine",
  "dg/procedure": "routine",
  "dg/trigger": "misc",
  "dg/sequence": "misc",
  "dg/package": "misc",
  "dg/check-constraint": "misc",
  [LOCAL + "synonym"]: "misc",
  [LOCAL + "col"]: "column",
  [LOCAL + "col-dot"]: "column",
  [LOCAL + "col-index"]: "column",
  [LOCAL + "col-dot-index"]: "column",
};

/** Icon by key: explorer-local (`x:` prefix, theme-aware) or a name of the shared icon kit. */
export const NodeIcon: Component<{ name?: string; class?: string }> = (props) => {
  const local = () => !!props.name?.startsWith(LOCAL);
  const src = () => (local() ? localIconUrl(props.name!.slice(LOCAL.length), theme()) : undefined);
  const tint = () => (props.name && TINT[props.name] ? " dg-ico-" + TINT[props.name] : "");
  return <Icon name={local() ? undefined : props.name} src={src()} class={(props.class ?? "") + tint()} />;
};
