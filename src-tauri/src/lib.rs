mod commands;
pub mod files;
mod legacy;
pub mod mcp;
pub mod state;
pub mod store;

use std::io::Write;
use std::path::Path;

use tauri::{Manager, RunEvent, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;

pub use state::AppState;

/// Daily log files kept in `<data dir>/logs` (about a week of history).
const LOG_FILES_KEPT: usize = 7;

/// Starts the file logger: `<data dir>/logs/datum.<date>.log`, INFO unless `DATUM_LOG` (or the 0.5.x name
/// `PROMETEO_LOG`) says otherwise (`DATUM_LOG=debug`, or a full `tracing` filter such as `info,datum_lib=debug`).
fn init_logging(log_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(log_dir)
        .map_err(|e| format!("Cannot create the log folder {}: {e}", log_dir.display()))?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("datum")
        .filename_suffix("log")
        .max_log_files(LOG_FILES_KEPT)
        .build(log_dir)
        .map_err(|e| format!("Cannot open a log file in {}: {e}", log_dir.display()))?;
    let filter = EnvFilter::try_from_env("DATUM_LOG")
        .or_else(|_| EnvFilter::try_from_env("PROMETEO_LOG"))
        .unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(appender)
        .with_ansi(false)
        .try_init()
        .map_err(|e| format!("Cannot start logging: {e}"))
}

/// Writes the panic and its backtrace to `<logs>/panic.log` (flushed and synced before the process aborts),
/// then runs the previous hook.
fn install_panic_hook(log_dir: &Path) {
    let path = log_dir.join("panic.log");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        let text = format!(
            "[{ts}] PANIC at {location}: {message}\n{}\n",
            std::backtrace::Backtrace::force_capture()
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(text.as_bytes());
            let _ = f.flush();
            let _ = f.sync_all();
        }
        previous(info);
    }));
}

pub fn run() {
    let context = tauri::generate_context!();
    // 0.5.x (Prometeo DataGrip) hands its settings and data over to the folders of this app, copied once and never
    // touching the old ones. It has to happen before the Builder: the window-state plugin loads its file while it is
    // set up, and the WebView creates its data folder as soon as the window exists. The outcome is logged from
    // `.setup`, once the logger is up, and a failure is shown to the user as a startup notice.
    let adopted = legacy::adopt_all(&context.config().identifier);
    let app = tauri::Builder::default()
        // must be the first plugin: a second launch has to reach the first instance before it creates windows
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            let paths = app.path();
            // DATUM_CONFIG_DIR / DATUM_DATA_DIR (or the 0.5.x PROMETEO_* names) override the OS locations (demos,
            // tests)
            let config_dir = match legacy::env_os("CONFIG_DIR") {
                Some(d) => d.into(),
                None => paths.app_config_dir()?,
            };
            let data_dir = match legacy::env_os("DATA_DIR") {
                Some(d) => d.into(),
                None => paths.app_data_dir()?,
            };
            // Logging must not keep the app from starting: a failure is reported on stderr (visible in dev builds).
            let log_dir = data_dir.join("logs");
            if let Err(e) = init_logging(&log_dir) {
                eprintln!("cannot start logging: {e}");
            }
            install_panic_hook(&log_dir);
            for (outcome, dir) in &adopted {
                outcome.log(dir);
            }
            // one line per start, so a log sent from another machine tells the version and the OS
            tracing::info!(
                "Datum {} started ({} {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            // The WebView keeps its own storage (localStorage: explorer state, tabs, layout). Under an overridden
            // data / config dir it must live there too, or the state of one profile leaks into another.
            let webview_dir = legacy::env_os("DATA_DIR")
                .map(|d| std::path::PathBuf::from(d).join("webview"))
                .or_else(|| {
                    legacy::env_os("CONFIG_DIR")
                        .map(|d| std::path::PathBuf::from(d).join("webview"))
                });
            let state = AppState::open(config_dir, data_dir)?;
            // a failed copy of the 0.5.x data is told to the user (once, with the other startup notices)
            for (outcome, dir) in &adopted {
                if let Some(notice) = outcome.notice(dir) {
                    state.add_startup_notice(notice);
                }
            }
            // the MCP server is off by default; start it when the user turned it on in an earlier run
            tauri::async_runtime::block_on(state.mcp.start_if_enabled());
            app.manage(state);
            // the main window is declared in tauri.conf.json with `create: false`: built here to set the WebView data directory
            for cfg in app.config().app.windows.iter().filter(|w| !w.create) {
                let mut builder = WebviewWindowBuilder::from_config(app.handle(), cfg)?;
                if let Some(dir) = &webview_dir {
                    std::fs::create_dir_all(dir)?;
                    builder = builder.data_directory(dir.clone());
                }
                builder.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_data_sources,
            commands::save_data_source,
            commands::delete_data_source,
            commands::duplicate_data_source,
            commands::copy_data_source_password,
            commands::export_data_sources,
            commands::import_data_sources,
            commands::import_data_sources_text,
            commands::export_settings,
            commands::import_settings,
            commands::choose_open_json,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::connected_data_sources,
            commands::open_session,
            commands::close_session,
            commands::session_in_transaction,
            commands::session_tx_status,
            commands::session_state,
            commands::introspect,
            commands::list_schemas,
            commands::set_session_schema,
            commands::get_ddl,
            commands::find_usages,
            commands::schema_snapshot,
            commands::schema_model,
            commands::execute,
            commands::fetch_more,
            commands::cancel,
            commands::close_execution,
            commands::explain_plan,
            commands::cancel_session,
            commands::table_data,
            commands::apply_changes,
            commands::table_data_in_session,
            commands::apply_changes_in_session,
            commands::fetch_cell,
            commands::choose_value_save_path,
            commands::write_value_file,
            commands::choose_value_file,
            commands::read_value_file,
            commands::choose_export_path,
            commands::default_export_path,
            commands::approve_export_path,
            commands::export_query,
            commands::export_query_to_string,
            commands::export_result,
            commands::export_to_string,
            commands::cancel_export,
            commands::choose_import_file,
            commands::import_preview,
            commands::import_file,
            commands::cancel_import,
            commands::run_sql_file,
            commands::cancel_script,
            commands::dump_schema,
            commands::cancel_dump,
            commands::open_dump_folder,
            commands::split_statements,
            commands::statement_at,
            commands::history_list,
            commands::history_search,
            commands::history_clear,
            commands::get_ui_state,
            commands::set_ui_state,
            commands::flush_ui_state,
            commands::list_consoles,
            commands::read_console,
            commands::write_console,
            commands::create_console,
            commands::delete_console,
            commands::rename_console,
            commands::choose_open_files,
            commands::choose_attach_folder,
            commands::detach_file_root,
            commands::file_roots,
            commands::read_file,
            commands::write_file,
            commands::list_dir,
            commands::list_scratches,
            commands::create_scratch,
            commands::delete_scratch,
            commands::rename_scratch,
            commands::mcp_status,
            commands::mcp_configure,
            commands::mcp_regenerate_token,
            commands::mcp_get_policy,
            commands::mcp_set_policy,
            commands::mcp_sessions,
            commands::mcp_log,
            commands::mcp_clear_log,
            commands::mcp_subscribe,
            commands::mcp_unsubscribe,
        ])
        .build(context)
        .expect("error while building Datum");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.try_state::<AppState>();
            // make sure the debounced ui-state write is not lost on exit; it is written before the lock is released,
            // so that a relaunch reads the final state and not the one from before the last debounce
            if let Some(state) = &state {
                if let Err(e) = state.ui.flush() {
                    tracing::error!("cannot save ui state: {e}");
                }
            }
            // the plugin keeps its lock until this handler returns: release it before the (bounded) connection close,
            // so that a relaunch during the shutdown starts a new instance instead of being forwarded to this dying one
            tauri_plugin_single_instance::destroy(handle);
            if let Some(state) = state {
                // roll back open transactions and close the connections in an orderly way
                tauri::async_runtime::block_on(state.shutdown());
            }
        }
    });
}
