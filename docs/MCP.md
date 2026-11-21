# MCP server

Datum contains a built-in [Model Context Protocol](https://modelcontextprotocol.io) server.
AI agents (for example Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot or OpenCode) connect to it. They can list the data sources that you allow, read
their schemas, run queries and, if you allow it, change data. All agent actions are recorded in a log
that the app keeps for 30 days. You see and examine them in the **MCP** view (View ▸ MCP, `Ctrl+Shift+M`).

The server is **off by default**.

## Transport and security

- Streamable HTTP, JSON responses only (no SSE stream): `POST http://127.0.0.1:<port>/mcp`.
  Default port: `7311`. `GET /mcp` returns `405`. `DELETE /mcp` ends the session.
- It listens on the loopback interface only (`127.0.0.1`). The `Host` header must be a loopback
  name, and a request that has an `Origin` header is refused (`403`). This stops DNS-rebinding
  attacks from web pages. Agents are not browsers and do not send `Origin`.
- Each request must have `Authorization: Bearer <token>`. The token is made when the server is
  first enabled, is kept in `<config_dir>/mcp.json` (owner-only file), and can be regenerated.
- A missing or bad token never gets HTTP `401` (the official TypeScript SDK then starts an OAuth flow
  and the agent never sees the real error). `initialize`, `ping` and `tools/list` still work; every
  `tools/call` returns a tool error that says how to fix it. These attempts are logged as `denied`
  under the fixed session `unauthorized` (client "unauthorized caller"), without the SQL or arguments
  the caller sent, and at most 60 per minute.
- The `Mcp-Session-Id` header is given in the `initialize` response and identifies the agent session.
- Tool errors are `isError: true` with one text block. They never contain `structuredContent`.

## Permissions

Each data source has two independent permissions: **read** and **write**.

- A rule can be set on a **folder** (the data-source folders of the Database Explorer) or on one
  **data source**. A data-source rule wins over its folder rule. A data source without any rule has
  no access. (Safe default.)
- A data source that is marked *read-only* in its own settings never gets write access.
- **read** allows `list_schemas`, `list_tables`, `describe_table`, `run_query`. Queries run on a
  separate read-only connection, never on your own consoles (see *How strong is "read-only"* below).
- **write** allows `execute_statement` (one statement, committed when it succeeds) on a separate
  connection. Transaction-control statements (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`,
  `SET TRANSACTION`, `SET autocommit`, ...) are refused, and a transaction a statement leaves open is
  rolled back and reported as an error.
- A data source with neither permission is invisible to agents.

### How strong is "read-only"

`run_query` is protected in layers, and none of them replaces a database account that only has the
rights you want the agent to have:

- A keyword pre-check refuses anything that is not a read statement (`SELECT`, `WITH` without a
  data-changing CTE, `VALUES`, `TABLE`, `SHOW`, `DESCRIBE`, `EXPLAIN` without `ANALYZE`, `PRAGMA`
  without `=`), `SELECT ... INTO` / `INTO OUTFILE`, `EXPLAIN PLAN` on Oracle (it writes the plan table),
  and well-known functions with side effects (`set_config`, `pg_terminate_backend`, `lo_import`,
  `dblink*`, `UTL_HTTP`, `DBMS_SCHEDULER`, ...). It exists for clear error messages; it is not a security
  boundary.
- The connection is opened read-only: PostgreSQL `default_transaction_read_only` (and every query also
  runs in its own `BEGIN READ ONLY` transaction, because a session setting can be switched off by a
  statement), MySQL `SET SESSION ... READ ONLY`, SQLite read-only open. **Oracle has no server-side
  read-only session: its gate is a client-side keyword check.**
- Functions that have side effects (for example an Oracle function with an autonomous transaction, or
  a PostgreSQL function that writes through `dblink`) can still write from inside a `SELECT`.

**The hard guarantee is a database user that only has `SELECT` rights.** For data you cannot afford to
lose, create such a user and use it in the data source.

In-memory SQLite data sources cannot be used by agents (each agent connection would see its own empty
database).

## Tools

| Tool | Needs | Arguments |
|---|---|---|
| `list_data_sources` | — | — (returns only the sources the agent can use, with their permissions) |
| `list_schemas` | read | `dataSourceId` |
| `list_tables` | read | `dataSourceId`, `schema?` |
| `describe_table` | read | `dataSourceId`, `table`, `schema?` (columns and DDL) |
| `run_query` | read | `dataSourceId`, `sql`, `maxRows?` (default 200, max 1000) — read statements only |
| `execute_statement` | write | `dataSourceId`, `sql` — one statement, committed when it succeeds |

## Connect an agent

The **Connect** tab of the MCP view gives the install snippet for the chosen agent, with the port and
the token filled in (the screen masks the token, the copy has the real one). The **Global** switch
(off by default) installs it for all your projects instead of only the current one. Both choices are
remembered. One-line commands run the same in bash, PowerShell and cmd; file entries are merged into
the file at the given path (on Windows `~` is `%USERPROFILE%`).

| Agent | This project (Global off) | All projects (Global on) | Check |
|---|---|---|---|
| Claude Code | `claude mcp add --transport http datum <url> --header "Authorization: Bearer <token>"` (local scope: only you, this project; add `--scope project` to share it in `.mcp.json`) | same with `--scope user` | `claude mcp list` |
| Codex CLI | `.codex/config.toml` (read only in trusted projects) | `~/.codex/config.toml` | `codex mcp list`, `/mcp` |
| Gemini CLI | `gemini mcp add --transport http --header "Authorization: Bearer <token>" datum <url>` (writes `.gemini/settings.json`) | same with `--scope user` (`~/.gemini/settings.json`) | `gemini mcp list` |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` | Cursor MCP settings |
| GitHub Copilot (VS Code, Copilot CLI) | `.mcp.json` at the workspace root | `~/.copilot/mcp-config.json` | `copilot mcp list`, VS Code *Chat: Open Customizations › MCP Servers* |
| OpenCode | `opencode mcp add datum --url <url> --header "Authorization=Bearer <token>"` | same with `--global` | `opencode mcp list` |

Codex has no command-line flag for a static header, so it gets a file entry:

```toml
[mcp_servers.datum]
url = "http://127.0.0.1:7311/mcp"

[mcp_servers.datum.http_headers]
Authorization = "Bearer <token>"
```

Cursor uses `{"mcpServers": {"datum": {"url": …, "headers": {"Authorization": "Bearer <token>"}}}}`;
GitHub Copilot the same with `"type": "http"` and `"tools": ["*"]`. Codex and GitHub Copilot do not get a
command because their `mcp add` cannot set the header (Codex) or has no project scope (Copilot CLI).

Sources (checked November 2026):
[Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/),
[Cursor](https://cursor.com/docs/context/mcp),
[VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
[OpenCode](https://opencode.ai/docs/mcp-servers/).

Upgrading from 0.5.x (when the app was called Prometeo DataGrip): the server is now called `datum`.
Remove the old registration and add the new one:

```sh
claude mcp remove prometeo-datagrip
claude mcp add --transport http datum http://127.0.0.1:7311/mcp \
  --header "Authorization: Bearer <token>"
```

The permissions, the token and the port are kept. A `.mcp.json` entry named `prometeo-datagrip`
must be renamed to `datum` too.

## Log

`<data_dir>/mcp/log.jsonl`, one JSON entry per line (at most 16 KiB each; larger SQL, arguments or
previews are cut). Entries older than 30 days are removed at start and every hour, and are never
shown; a file above 50 MiB is cut down to 40 MiB, oldest first. Each entry records the session, the tool, the data source, the SQL, the status
(`ok`, `error`, `denied`), the time, the row counts and a small preview of the result
(at most 20 rows, values cut to 200 characters).

## Contract between the backend and the frontend (Tauri commands)

All JSON is camelCase. Types for the frontend are in `src/api/types.ts` (`Mcp*`).

```ts
type McpPerm = { read: boolean; write: boolean };

type McpStatus = {
  enabled: boolean;          // the user setting
  running: boolean;          // the listener is bound
  port: number;
  endpoint: string;          // "http://127.0.0.1:7311/mcp"
  token: string;
  error: string | null;      // for example "Port 7311 is in use"
  startedAtMs: number | null;
  activeSessions: number;    // sessions seen in the last 10 minutes
  logRetentionDays: number;  // 30
};

type McpPolicyInput = {
  folderRules: Record<string, McpPerm>;   // folder name -> perm
  sourceRules: Record<string, McpPerm>;   // data-source id -> perm (overrides the folder)
  groups: Record<string, string>;         // data-source id -> folder name (pushed by the frontend)
};

type McpEffectivePerm = McpPerm & {
  origin: "source" | "folder" | "none";   // which rule gave it
  readOnlySource: boolean;                // write was forced off by the data source's read-only flag
};

type McpPolicy = McpPolicyInput & { effective: Record<string, McpEffectivePerm> }; // every known data source

type McpSession = {
  id: string;
  clientName: string;        // from initialize clientInfo.name, "unknown" if missing
  clientVersion: string | null;
  startedAtMs: number;
  lastSeenMs: number;
  active: boolean;           // seen in the last 10 minutes and not ended
  actionCount: number;       // tool calls
  errorCount: number;        // error + denied
  writeCount: number;        // execute_statement calls
  dataSourceIds: string[];
};

type McpLogStatus = "ok" | "error" | "denied";

type McpLogEntry = {
  id: string;
  tsMs: number;
  sessionId: string;
  clientName: string;
  kind: "session" | "tool";        // "session": initialize / end
  tool: string;                    // "initialize", "end", "run_query", ...
  dataSourceId: string | null;
  dataSourceName: string | null;
  sql: string | null;
  args: unknown | null;            // other arguments, small
  status: McpLogStatus;
  error: string | null;
  elapsedMs: number;
  rowCount: number | null;         // rows returned
  rowsAffected: number | null;     // rows changed
  truncated: boolean;              // more rows than returned
  preview: { columns: string[]; rows: (string | null)[][] } | null;
  summary: string;                 // one line, for example "Returned 12 rows from orders"
};

type McpLogQuery = {
  sessionId?: string; dataSourceId?: string; status?: McpLogStatus;
  text?: string; sinceMs?: number; untilMs?: number;
  limit?: number;                  // default 200, max 1000
  beforeTsMs?: number;             // paging: entries older than this
};

type McpEvent =
  | { type: "entry"; entry: McpLogEntry }
  | { type: "status"; status: McpStatus }
  | { type: "sessions" };          // the session list changed: fetch it again
```

| Command | Arguments | Result |
|---|---|---|
| `mcp_status` | — | `McpStatus` |
| `mcp_configure` | `enabled: boolean, port: number` | `McpStatus` (starts, stops or restarts) |
| `mcp_regenerate_token` | — | `McpStatus` |
| `mcp_get_policy` | — | `McpPolicy` |
| `mcp_set_policy` | `policy: McpPolicyInput` | `McpPolicy` |
| `mcp_sessions` | — | `McpSession[]` (newest first, last 30 days) |
| `mcp_log` | `query: McpLogQuery` | `McpLogEntry[]` (newest first) |
| `mcp_clear_log` | — | `null` |
| `mcp_subscribe` | `onEvent: Channel<McpEvent>` | `number` (subscription id) |
| `mcp_unsubscribe` | `id: number` | `null` |
