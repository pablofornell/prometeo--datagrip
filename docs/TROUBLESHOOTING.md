# Troubleshooting

## First: find the logs

**Help > Open Log Folder** opens the folder in the file manager. The same folder is:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\dev.datum.desktop\logs` |
| macOS | `~/Library/Application Support/dev.datum.desktop/logs` |
| Linux | `~/.local/share/dev.datum.desktop/logs` |

`datum.YYYY-MM-DD.log` holds the daily log (7 days are kept) and `panic.log` holds panic
messages and backtraces. Logging defaults to `INFO`; to get more detail, close the app, set
`DATUM_LOG=debug` (or a full filter such as `info,datum=debug`) and start it
again. An invalid filter string falls back to `INFO` instead of failing.

When reporting a problem, include the app version, OS, the steps to reproduce and the relevant
log lines. Read the excerpt before sharing it: logs can contain SQL text and connection
details. Never paste passwords.

## The app does not start

1. Check that the WebView2 Runtime is installed (Windows). Windows 11 and current Windows 10
   include it; otherwise install the Evergreen Runtime from Microsoft.
2. Start the app from a terminal to see messages that never reach the log, for example
   `npm run tauri dev` or `target\release\datum.exe`.
3. If the log folder cannot be created, the app still starts and prints
   `cannot start logging: ...` to stderr. Check the permissions of the data directory.
4. A corrupt settings file does not block startup: the app renames it to
   `<name>.corrupt-<unix seconds>`, starts with defaults and lists the file in the startup
   warnings. Look in the configuration folder (`data-sources.json`, `ui-state.json`).

## Launching again does nothing

This is expected. The app is single-instance: a second launch hands control to the running copy
and restores its main window (unminimize, show, focus). If the window is on another virtual
desktop or behind other windows, check the taskbar before assuming the app is stuck.

## The window is missing or off-screen

The window position, size and maximized state are restored on startup. A saved position that
does not intersect any connected monitor is ignored, but a stale multi-monitor layout can still
leave the window hard to find.

1. Close the app.
2. Delete `.window-state.json` in the configuration folder:
   - Windows: `%APPDATA%\dev.datum.desktop\`
   - macOS: `~/Library/Application Support/dev.datum.desktop/`
   - Linux: `~/.config/dev.datum.desktop/`
3. Start the app again. It opens centered at the default size.

**Window > Layouts > Reset Layout** restores the tool windows and splitters without touching
saved connections.

## A connection fails

- The error message comes from the server or driver and is shown in full. Check host, port,
  database name, user and SSL mode first.
- Use **Test Connection** in the Data Sources dialog to test unsaved settings.
- PostgreSQL: check `pg_hba.conf` and whether the server listens on the expected interface.
- MySQL/MariaDB: check the bind address and user grants for the client host.
- Oracle: the first start of a container or a fresh database can take minutes; wait until it
  accepts connections.
- Oracle 10g / 11g: these releases work (tested with 10.2 and 11.2). "connections to this
  database server are not supported" means an older server (9i or before). A "not implemented"
  error about native network encryption or data integrity means the server requires it
  (`SQLNET.ENCRYPTION_SERVER` / `SQLNET.CRYPTO_CHECKSUM_SERVER` = `REQUIRED`), which the driver
  does not do. Oracle XE 10g allows 40 processes: when the listener refuses connections
  (ORA-12516), close sessions or raise `PROCESSES`.
- If the connection drops while a query runs (server restart, `pg_terminate_backend`, `KILL`),
  the app reports a lost connection and marks the session. Reconnect from the explorer; an open
  transaction cannot be recovered and must be repeated.

## A query is slow or the grid is paging forever

The grid fetches rows in pages. Very large results are not loaded at once; use the paging
controls, add a `WHERE` clause, or export the query to a file instead. `Ctrl+F2` cancels the
running statement.

## Saves fail

Console and scratch files are saved automatically. On a failed save the app shows one
notification per file and keeps the tab marked as unsaved; it reports the same file again only
after a later save succeeds. Check that the data directory is writable and that the disk is not
full, then save again with `Ctrl+S`.

## Disk usage grows

- Logs rotate daily and only the last 7 files are kept.
- Query history keeps the newest 5000 entries or 10 MB, whichever comes first.
- Consoles are small `.sql` files under the data directory.

If the folders are much larger, inspect them before deleting anything: they may contain files
you attached to the project.

## Reset the application

Close the app first. To reset the UI only, delete `ui-state.json` and `.window-state.json` in
the configuration folder. To remove everything, rename (do not delete) both the configuration
and data folders listed above; the app recreates them with defaults on the next start. Export
your data sources and settings from **File > Manage IDE Settings** before a full reset if you
want to restore them. If you upgraded from 0.5 and the old `dev.prometeo.datagrip` folders are still
there, rename those too, or the app copies them over again on the next start.

## Build problems

- **`rustc` is older than 1.99**: Cargo's `rust-version` requires 1.99.0 or newer. Run
  `rustup update`, or install exactly the CI compiler with
  `rustup toolchain install 1.99.0 --component rustfmt --component clippy` and select it.
  Make sure no `RUSTUP_TOOLCHAIN` environment variable forces an old toolchain.
- **`link.exe not found` / missing Windows SDK**: install Visual Studio 2022 Build Tools with
  the **Desktop development with C++** workload, or build with the GNU toolchain
  (`rustup toolchain install stable-x86_64-pc-windows-gnu` plus MinGW-w64).
- **`npm ci` refuses to install**: the lockfile and `package.json` disagree. Run `npm install`,
  verify the app still builds, and commit the updated `package-lock.json`.
- **Cargo waits on a lock**: another Cargo process uses the shared `target/` directory. Wait for
  it to finish; do not delete the lock file.
- **`InvalidPackageType` while bundling**: `bundle.targets` is `"all"` and builds only the
  host's package types. Build Linux installers on Linux and Windows installers on Windows.
- **Formatting or Clippy failures in CI**: run `cargo fmt --all` and
  `cargo clippy --workspace --all-targets -- -D warnings` locally with Rust 1.99.0 or newer.
  CI uses exactly 1.99.0.

Database integration tests are not part of CI. Start the containers with `make db-up` and run
`make test-all` locally; the tests skip when their `DATUM_*_URL` variables are absent.

## Upgrading from 0.5

Datum was called Prometeo DataGrip up to 0.5.x. The identifier of the app changed
(`dev.prometeo.datagrip` to `dev.datum.desktop`), so 1.0 is **not an in-place upgrade**: it installs as a
separate app, "Datum", next to "Prometeo DataGrip", and the old app keeps working. On its first start Datum
copies the data of the old install once. After checking that everything arrived, uninstall the old app (its
folders and credential entries are not removed by Datum or by the uninstaller; delete them yourself when you no
longer need them).

What is copied, from the `dev.prometeo.datagrip` folder to the `dev.datum.desktop` one next to it:

| OS | Copied |
|---|---|
| Linux | `~/.config/dev.prometeo.datagrip` (data sources, settings, window geometry) and `~/.local/share/dev.prometeo.datagrip` (consoles, scratches, query history, MCP log, and the WebView storage that holds the editor tabs and layout) |
| Windows | `%APPDATA%\dev.prometeo.datagrip` (data sources, settings, window geometry, consoles, scratches, history) and `%LOCALAPPDATA%\dev.prometeo.datagrip` (the WebView2 profile: editor tabs and layout) |
| macOS | `~/Library/Application Support/dev.prometeo.datagrip` (everything above) and, best effort, `~/Library/WebKit/dev.prometeo.datagrip` (WebKit's storage for the app: editor tabs and layout). The WebKit folder is laid out by macOS, not by Datum, and this copy has not been verified on a real Mac; if the tabs and layout do not come over, the data sources, settings and scratches still do. WebKit caches (`~/Library/Caches`) are not copied |

Also:

- Data source passwords stored in the OS credential store are read from the old entry the first time they
  are needed. The old entry stays (the old app may still use it), also when you delete the data source in Datum.
- Scratch files and file targets keep working: the paths of the open scratch tabs, file targets and opened
  files that point into the old folder are rewritten to the new one while copying.
- The copy happens before the window exists, so the window geometry is restored too.
- It runs once per folder and then writes a `.migrated-from-prometeo` marker; nothing is copied after that.
  Until the marker exists (no copy yet, or one that failed) each start copies what the new folder lacks:
  an entry (`data-sources.json`, `scratches/`, a WebView folder, ...) that is already there is kept whole and
  never overwritten or mixed with the old one. If a copy fails Datum starts without the old data, shows a
  notice with the path of the old folder (the reason is in `datum.YYYY-MM-DD.log`) and tries again at the next
  start.
- Symlinks in the old folders are recreated as symlinks (on Windows, where creating one needs a privilege,
  they are skipped with a warning in the log). WebView cache folders (`Cache`, `Code Cache`, `GPUCache`,
  `CacheStorage`, ...) and the old `logs/` folder are not copied.
- Two Datum starts at the same time do not copy together: a lock file `dev.datum.desktop.migrating.lock` next
  to the new folder makes the second one skip (a lock older than 10 minutes is ignored and removed).
- Nothing is copied when `DATUM_CONFIG_DIR` / `DATUM_DATA_DIR` are set.
- **Changes made in the old app after the copy are not copied again.** Use one app or the other; to redo
  the copy, rename the new `dev.datum.desktop` folders (see
  [Reset the application](#reset-the-application)) while the old ones are still there.
- The `PROMETEO_*` variables below are still read, as a fallback, in this release (also by the integration
  tests, for the `PROMETEO_*_URL` variables).

## Environment overrides

Useful for demos, tests and portable setups; set them before launching the app:

| Variable | Effect |
|---|---|
| `DATUM_CONFIG_DIR` | Configuration folder (`data-sources.json`, `ui-state.json`) |
| `DATUM_DATA_DIR` | Data folder (logs, consoles, history, WebView storage) |
| `DATUM_LOG` | Log filter (`debug`, or a full `tracing` filter) |
| `DATUM_NO_KEYRING=1` | Do not use the OS credential store (tests and headless runs) |

The 0.5.x names (`PROMETEO_CONFIG_DIR`, `PROMETEO_DATA_DIR`, `PROMETEO_LOG`, `PROMETEO_NO_KEYRING`) are
still read when the `DATUM_*` one is not set; they will be removed in a later release.

`DATUM_CONFIG_DIR` does not move the window state: `.window-state.json` always stays in the OS
application config folder listed under
[The window is missing or off-screen](#the-window-is-missing-or-off-screen), because the window-state
plugin resolves it from the platform config directory and ignores the override.

**Help > Open Log Folder** is scoped to the default data folder. When `DATUM_DATA_DIR` points
somewhere else, open `<that folder>/logs` manually in the file manager; everything else (logging,
consoles, history) already uses the override.

See [BUILD-WINDOWS.md](BUILD-WINDOWS.md) for build instructions and
[USER-GUIDE.md](USER-GUIDE.md) for feature usage.
