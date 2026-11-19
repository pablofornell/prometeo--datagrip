/** Settings > Tools > MCP Server. The server belongs to the backend: this page acts on it at once (it is not part of OK / Apply). */
import { Show, createSignal } from "solid-js";
import { Button, Checkbox } from "../../components/ui";
import { Hint, L, NumberField, Row, Section, type Draft } from "../settings/widgets";
import { DEFAULT_PORT, MAX_PORT, MIN_PORT } from "./model";
import { busy, configure, status, unavailable } from "./store";

export function McpSettingsPage(props: { draft: Draft; openView: () => void }) {
  const q = () => props.draft.query();
  const [typed, setTyped] = createSignal<number | null>(null);
  const port = () => typed() ?? status()?.port ?? DEFAULT_PORT;
  const dirty = () => typed() !== null && typed() !== status()?.port;
  const apply = async () => {
    if (await configure(!!status()?.enabled, port())) setTyped(null);
  };
  return (
    <div class="st-page">
      <Section title="MCP Server" q={q()}>
        <Show when={!unavailable()} fallback={<Hint>This build has no MCP server.</Hint>}>
          <Row class="st-row-first">
            <Checkbox
              checked={!!status()?.enabled}
              disabled={!status() || busy()}
              onChange={(on) => void configure(on, port())}
              label={<L q={q()}>Enable MCP server</L>}
            />
          </Row>
          <Hint>Lets AI agents such as Claude Code connect to this app: they list the data sources you allow, read their schemas, run queries and, if you grant it, change data. Off by default.</Hint>
          <Row field class="st-row-gap">
            <span class="st-label">
              <L q={q()}>Port:</L>
            </span>
            <NumberField value={port()} min={MIN_PORT} max={MAX_PORT} onChange={(n) => setTyped(n)} />
            <Button disabled={!dirty() || busy()} onClick={() => void apply()}>
              Apply
            </Button>
          </Row>
          <Hint>
            Listens on 127.0.0.1 only; every request needs the token of this app. Applying restarts the server.
            <Show when={status()?.error}> {status()!.error}.</Show>
          </Hint>
          <Row class="st-row-gap">
            <Button onClick={props.openView}>Open MCP View</Button>
          </Row>
          <Hint>The MCP view has the install command, the permissions per data source and folder, and the log of what agents did. These options apply immediately.</Hint>
        </Show>
      </Section>
    </div>
  );
}
