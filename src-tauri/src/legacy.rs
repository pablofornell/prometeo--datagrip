//! Upgrade path from 0.5.x, when the app was called Prometeo DataGrip (identifier `dev.prometeo.datagrip`):
//! the `PROMETEO_*` environment variables are still read, and the per-user config / data / WebView folders of the
//! old identifier are copied once into those of the new one, so an existing install keeps its data sources, settings,
//! scratches and window geometry. Everything here is best effort: it never deletes the old data and a failure is
//! reported (a log line and a notice in the UI) but never keeps the app from starting.
//!
//! The copy runs in [`adopt_all`], called by `run()` BEFORE `tauri::Builder` exists: the window-state plugin reads
//! `.window-state.json` while it is set up (before the `.setup` hook), and the WebView creates its data folder as
//! soon as the window is built (the copy fills in around whatever is there, but it is cleaner before).

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::store::StartupNotice;

/// Identifier of the current app: the name of its config / data folders.
const APP_ID: &str = "dev.datum.desktop";
/// Identifier of the 0.5.x app (a sibling folder of the current one).
const LEGACY_APP_ID: &str = "dev.prometeo.datagrip";
/// Written into a folder when the 0.5.x contents were copied into it: no further copy is made after that. While it
/// is absent (no copy yet, or one that failed) the entries the folder lacks are filled in at each start.
const MARKER: &str = ".migrated-from-prometeo";
/// A lock older than this is the leftover of a start that died: it is taken over.
const LOCK_TTL: Duration = Duration::from_secs(10 * 60);
/// Folders (at any depth) that are not copied: WebView caches are rebuilt by the engine.
const CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "GrShaderCache",
    "ShaderCache",
    "WebKitCache",
    // also covers `Service Worker/CacheStorage`
    "CacheStorage",
];
/// Folder (at the top level only) that is not copied: the old `prometeo.*.log` files would never be pruned.
const LOGS_DIR: &str = "logs";
/// Files of the config folder that hold absolute paths into the old folders (open scratch tabs, file targets,
/// opened files): rewritten to the new folder while they are copied.
const PATH_FILES: &[&str] = &["ui-state.json", "file-access.json"];

/// The runtime variable `DATUM_<name>`, else the legacy `PROMETEO_<name>` (read for one more release).
pub fn env_os(name: &str) -> Option<OsString> {
    std::env::var_os(format!("DATUM_{name}"))
        .or_else(|| std::env::var_os(format!("PROMETEO_{name}")))
}

/// What [`adopt_legacy_dir`] did, for the log (the logger is not up yet when the folders are adopted).
#[derive(Debug, PartialEq, Eq)]
pub enum Adopted {
    /// Nothing to do: already copied, not the app's own folder, there is no legacy one, or another start is copying.
    Nothing,
    /// The contents of the legacy folder were copied.
    Copied(PathBuf),
    /// The copy failed; the legacy folder is untouched and the copy is tried again at the next start.
    Failed(PathBuf, String),
}

impl Adopted {
    /// Logs the outcome (nothing for [`Adopted::Nothing`]).
    pub fn log(&self, dir: &Path) {
        match self {
            Adopted::Nothing => {}
            Adopted::Copied(from) => tracing::info!(
                "migrated the settings and data from {} to {}",
                from.display(),
                dir.display()
            ),
            Adopted::Failed(from, e) => tracing::warn!(
                "could not migrate the settings and data from {} to {}: {e}",
                from.display(),
                dir.display()
            ),
        }
    }
}

impl Adopted {
    /// The notice the UI shows for a failed copy (nothing for the other outcomes).
    pub fn notice(&self, dir: &Path) -> Option<StartupNotice> {
        let Adopted::Failed(from, e) = self else {
            return None;
        };
        Some(StartupNotice {
            file: "migration".into(),
            message: format!(
                "Datum could not copy the settings and data of Prometeo DataGrip from {} to {}: {e}. Datum started without them and tries again at the next start; the old folder was not changed.",
                from.display(),
                dir.display()
            ),
            backup: None,
        })
    }
}

/// The per-user base folders the OS (and so Tauri's path resolver) puts app folders under.
pub struct Bases {
    pub config: Option<PathBuf>,
    pub data: Option<PathBuf>,
    pub local_data: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Bases {
    /// The same `dirs` locations Tauri's `app_config_dir` / `app_data_dir` / `app_local_data_dir` join the
    /// identifier to.
    pub fn from_os() -> Self {
        Bases {
            config: dirs::config_dir(),
            data: dirs::data_dir(),
            local_data: dirs::data_local_dir(),
            home: dirs::home_dir(),
        }
    }
}

/// The folders of the app (named `id`) that may hold 0.5.x data, without duplicates (the folders are equal on
/// Linux for data / local data, on Windows for config / data, and on macOS for all three):
/// - the config folder, unless `DATUM_CONFIG_DIR` overrides it;
/// - the data folder, unless `DATUM_DATA_DIR` overrides it;
/// - without an override, where the WebView keeps its storage (localStorage: tabs, layout): the local data folder
///   (Tauri puts it there on Linux and Windows, `%LOCALAPPDATA%\<id>\EBWebView` on Windows) and, on macOS,
///   `~/Library/WebKit/<id>` (WKWebView's default store, named after the bundle identifier). The macOS one is
///   best effort: it is WebKit's own layout, not something this app controls.
pub fn plan_dirs(
    bases: &Bases,
    id: &str,
    config_overridden: bool,
    data_overridden: bool,
    macos: bool,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut add = |dir: Option<PathBuf>| {
        if let Some(dir) = dir {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    };
    if !config_overridden {
        add(bases.config.as_ref().map(|d| d.join(id)));
    }
    if !data_overridden {
        add(bases.data.as_ref().map(|d| d.join(id)));
    }
    if !config_overridden && !data_overridden {
        add(bases.local_data.as_ref().map(|d| d.join(id)));
        if macos {
            add(bases
                .home
                .as_ref()
                .map(|h| h.join("Library").join("WebKit").join(id)));
        }
    }
    dirs
}

/// One time, at the start of the app and before anything is created in the new folders (see the module doc): copies
/// the 0.5.x folders into the folders of the app `id` (the identifier of `tauri.conf.json`), honouring the
/// `DATUM_CONFIG_DIR` / `DATUM_DATA_DIR` overrides (and their `PROMETEO_*` names). Returns the outcome per folder,
/// for the log.
pub fn adopt_all(id: &str) -> Vec<(Adopted, PathBuf)> {
    let dirs = plan_dirs(
        &Bases::from_os(),
        id,
        env_os("CONFIG_DIR").is_some(),
        env_os("DATA_DIR").is_some(),
        cfg!(target_os = "macos"),
    );
    let rewrites = path_rewrites(&dirs);
    dirs.into_iter()
        .map(|dir| (adopt_legacy_dir(&dir, &rewrites), dir))
        .collect()
}

/// The 0.5.x folder next to `dir`, when `dir` is the folder of the current app (derived from its parent, so the
/// OS-specific base path is not repeated here).
fn legacy_sibling(dir: &Path) -> Option<PathBuf> {
    if dir.file_name()? != APP_ID {
        return None;
    }
    Some(dir.parent()?.join(LEGACY_APP_ID))
}

/// `(old folder, new folder)` for each of `dirs`, as JSON string contents (that is how a path sits in a `.json`
/// file: backslashes doubled on Windows). The canonical form of the old folder (the one the file-access policy
/// stores, which resolves symlinks) is added when it differs.
fn path_rewrites(dirs: &[PathBuf]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |from: &Path, to: &Path| {
        let pair = (json_escape(from), json_escape(to));
        if !out.contains(&pair) {
            out.push(pair);
        }
    };
    for dir in dirs {
        let Some(legacy) = legacy_sibling(dir) else {
            continue;
        };
        add(&legacy, dir);
        if let (Ok(from), Some(parent)) = (fs::canonicalize(&legacy), dir.parent()) {
            if let Ok(parent) = fs::canonicalize(parent) {
                add(&from, &parent.join(APP_ID));
            }
        }
    }
    out
}

fn json_escape(p: &Path) -> String {
    let quoted = Value::String(p.to_string_lossy().into_owned()).to_string();
    quoted[1..quoted.len() - 1].to_string()
}

/// `text` with each old folder path of `rewrites` replaced by the new one. Only a whole path segment matches: the
/// old folder must be followed by a path separator, a closing quote or the end (not `dev.prometeo.datagrip2`).
fn rewrite_paths(text: &str, rewrites: &[(String, String)]) -> String {
    let mut text = text.to_string();
    for (from, to) in rewrites {
        let mut out = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some(i) = rest.find(from.as_str()) {
            let after = &rest[i + from.len()..];
            let whole = matches!(after.chars().next(), None | Some('/' | '\\' | '"'));
            out.push_str(&rest[..i]);
            out.push_str(if whole { to } else { from });
            rest = after;
        }
        out.push_str(rest);
        text = out;
    }
    text
}

/// One time: when the 0.5.x folder next to `dir` (a config, data or WebView folder of the app) exists and `dir` has no
/// [`MARKER`], copies its contents into `dir`, with the paths inside [`PATH_FILES`] rewritten (`rewrites`, see
/// [`path_rewrites`]). The legacy folder is never modified.
///
/// The copy is made in a private temporary sibling first. A missing or empty `dir` is replaced by it (all or
/// nothing); otherwise (the app already made files there, e.g. after a start whose copy failed) the top-level
/// entries `dir` lacks are moved in and the ones it has are left whole, never mixed (a WebView profile must not
/// end up with files of two). The marker is written only after all of that worked, so a failed copy is tried again
/// at the next start, however much the app wrote meanwhile. A lock file next to `dir` keeps two starts at the same
/// time from copying together (this runs before the single-instance check): a fresh lock means another start is on
/// it and this one skips.
pub fn adopt_legacy_dir(dir: &Path, rewrites: &[(String, String)]) -> Adopted {
    let Some(legacy) = legacy_sibling(dir) else {
        return Adopted::Nothing;
    };
    if !legacy.is_dir() || dir.join(MARKER).exists() {
        return Adopted::Nothing;
    }
    let lock = match Lock::take(dir) {
        Ok(Some(lock)) => lock,
        Ok(None) => return Adopted::Nothing,
        Err(e) => return Adopted::Failed(legacy, e),
    };
    // another start may have finished between the check above and the lock
    if dir.join(MARKER).exists() {
        return Adopted::Nothing;
    }
    let result = copy_into(&legacy, dir, rewrites);
    drop(lock);
    match result {
        Ok(()) => Adopted::Copied(legacy),
        Err(e) => Adopted::Failed(legacy, e),
    }
}

/// `<dir name><suffix>` next to `dir`.
fn sibling(dir: &Path, suffix: &str) -> PathBuf {
    let mut name = dir.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    dir.with_file_name(name)
}

/// The lock file `<dir>.migrating.lock`, removed when dropped.
struct Lock(PathBuf);

impl Lock {
    /// `Ok(None)`: another start holds a fresh lock. A stale one (older than [`LOCK_TTL`]) is taken over.
    fn take(dir: &Path) -> Result<Option<Lock>, String> {
        let path = sibling(dir, ".migrating.lock");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = write!(f, "{}", std::process::id());
                    return Ok(Some(Lock(path)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let age = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok());
                    if age.is_some_and(|a| a < LOCK_TTL) {
                        return Ok(None);
                    }
                    let _ = fs::remove_file(&path);
                }
                Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
            }
        }
        Ok(None)
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn is_missing_or_empty(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Copies `legacy` into `dir` (the lock is held). The temporary folder has a name of its own (process id and time),
/// and the ones of dead starts are removed.
fn copy_into(legacy: &Path, dir: &Path, rewrites: &[(String, String)]) -> Result<(), String> {
    let prefix = sibling(dir, ".migrating-");
    if let (Some(parent), Some(prefix)) = (dir.parent(), prefix.file_name()) {
        let prefix = prefix.to_string_lossy().into_owned();
        for e in fs::read_dir(parent).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = sibling(dir, &format!(".migrating-{}-{nanos}", std::process::id()));
    let result = copy_tree(legacy, &tmp, true)
        .and_then(|()| rewrite_path_files(&tmp, rewrites))
        .and_then(|()| install(legacy, &tmp, dir));
    // after a successful rename `tmp` is gone; after a merge it is what is left of the entries that were kept
    let _ = fs::remove_dir_all(&tmp);
    result
}

/// Puts the copy `tmp` in place of `dir`: a missing or empty `dir` is replaced by it (rename, so all or nothing);
/// otherwise the top-level entries `dir` does not have are moved in. The marker comes last.
fn install(legacy: &Path, tmp: &Path, dir: &Path) -> Result<(), String> {
    let marker = format!("copied from {}\n", legacy.display());
    let write_marker = |at: &Path| {
        fs::write(at.join(MARKER), &marker)
            .map_err(|e| format!("cannot write the marker in {}: {e}", at.display()))
    };
    if is_missing_or_empty(dir) {
        // `remove_dir` refuses a folder with content
        match fs::remove_dir(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot replace {}: {e}", dir.display())),
        }?;
        write_marker(tmp)?;
        fs::rename(tmp, dir).map_err(|e| format!("cannot move the copy to {}: {e}", dir.display()))
    } else {
        merge_missing(tmp, dir)?;
        write_marker(dir)
    }
}

/// Moves the top-level entries of `from` that `into` does not have into it. An entry that exists stays as it is,
/// whole: nothing is merged below the top level.
fn merge_missing(from: &Path, into: &Path) -> Result<(), String> {
    let entries = fs::read_dir(from).map_err(|e| format!("cannot read {}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", from.display()))?;
        let (src, dst) = (entry.path(), into.join(entry.file_name()));
        match fs::symlink_metadata(&dst) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::rename(&src, &dst)
                .map_err(|e| format!("cannot move {} to {}: {e}", src.display(), dst.display()))?,
            Ok(_) => {}
            Err(e) => return Err(format!("cannot inspect {}: {e}", dst.display())),
        }
    }
    Ok(())
}

/// Applies [`rewrite_paths`] to the [`PATH_FILES`] of the (still private) copy `dir`.
fn rewrite_path_files(dir: &Path, rewrites: &[(String, String)]) -> Result<(), String> {
    for name in PATH_FILES {
        let path = dir.join(name);
        // not a UTF-8 text file (or not there): nothing to rewrite
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let new = rewrite_paths(&text, rewrites);
        if new != text {
            fs::write(&path, new).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Recursive copy of the files and folders under `from` into `to` (`top`: `from` is the root of the copy). Symlinks
/// are recreated as symlinks, whatever they point to. Cache folders ([`CACHE_DIRS`]), the top-level `logs` and
/// special files (sockets, ...) are skipped.
fn copy_tree(from: &Path, to: &Path, top: bool) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("cannot create {}: {e}", to.display()))?;
    let entries = fs::read_dir(from).map_err(|e| format!("cannot read {}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", from.display()))?;
        let path = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot inspect {}: {e}", path.display()))?;
        let name = entry.file_name();
        if kind.is_dir() && ((top && name == LOGS_DIR) || CACHE_DIRS.iter().any(|c| name == *c)) {
            continue;
        }
        if kind.is_symlink() {
            copy_symlink(&path, &target)?;
        } else if kind.is_dir() {
            copy_tree(&path, &target, false)?;
        } else if kind.is_file() {
            fs::copy(&path, &target).map_err(|e| format!("cannot copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Recreates the symlink `link` as `target`, pointing to the same place.
#[cfg(unix)]
fn copy_symlink(link: &Path, target: &Path) -> Result<(), String> {
    let to = fs::read_link(link).map_err(|e| format!("cannot read {}: {e}", link.display()))?;
    std::os::unix::fs::symlink(to, target)
        .map_err(|e| format!("cannot link {}: {e}", target.display()))
}

/// Recreates the symlink `link` as `target`. Creating one needs a privilege on Windows: when it is missing the link
/// is skipped with a warning.
#[cfg(windows)]
fn copy_symlink(link: &Path, target: &Path) -> Result<(), String> {
    let to = fs::read_link(link).map_err(|e| format!("cannot read {}: {e}", link.display()))?;
    let made = if fs::metadata(link).is_ok_and(|m| m.is_dir()) {
        std::os::windows::fs::symlink_dir(&to, target)
    } else {
        std::os::windows::fs::symlink_file(&to, target)
    };
    if let Err(e) = made {
        tracing::warn!("skipped the symlink {}: {e}", link.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `<root>/dev.prometeo.datagrip` with a file and a nested one; returns `(root, legacy, new)`.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(LEGACY_APP_ID);
        fs::create_dir_all(legacy.join("logs")).unwrap();
        fs::write(legacy.join("data-sources.json"), "old sources").unwrap();
        fs::write(legacy.join("logs").join("prometeo.log"), "old log").unwrap();
        let new = root.path().join(APP_ID);
        (root, legacy, new)
    }

    fn read(p: PathBuf) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn copies_the_legacy_folder_when_the_new_one_is_missing() {
        let (_root, legacy, new) = fixture();
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Copied(legacy.clone()));
        assert_eq!(read(new.join("data-sources.json")), "old sources");
        // the old logs are not copied (they would never be pruned)
        assert!(!new.join("logs").exists());
        assert!(new.join(MARKER).is_file());
        // the old data stays where it was
        assert_eq!(read(legacy.join("data-sources.json")), "old sources");
        assert!(!legacy.join(MARKER).exists());
        assert_nothing_left_beside(&new);
    }

    /// No lock and no temporary folder next to `new`.
    fn assert_nothing_left_beside(new: &Path) {
        let left: Vec<_> = fs::read_dir(new.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".migrating"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn copies_into_an_empty_folder() {
        let (_root, _legacy, new) = fixture();
        fs::create_dir_all(&new).unwrap();
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        assert!(new.join("data-sources.json").is_file());
    }

    #[test]
    fn a_second_start_after_a_copy_changes_nothing() {
        let (_root, _legacy, new) = fixture();
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        // even if the user deleted every file meanwhile
        fs::remove_file(new.join("data-sources.json")).unwrap();
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Nothing);
        assert!(!new.join("data-sources.json").exists());
    }

    #[test]
    fn does_nothing_without_a_legacy_folder_or_for_a_custom_folder() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            adopt_legacy_dir(&root.path().join(APP_ID), &[]),
            Adopted::Nothing
        );
        assert!(!root.path().join(APP_ID).exists());

        // a folder that is not `dev.datum.desktop` (not derived from the OS location) is never touched
        let (root, _legacy, _new) = fixture();
        assert_eq!(
            adopt_legacy_dir(&root.path().join("elsewhere"), &[]),
            Adopted::Nothing
        );
        assert!(!root.path().join("elsewhere").exists());
    }

    #[test]
    fn a_failed_copy_is_reported_and_leaves_the_legacy_folder_untouched() {
        let (root, legacy, _new) = fixture();
        // the parent of the target is a file, so the temporary sibling cannot be created
        let blocker = root.path().join("blocker");
        fs::write(&blocker, "x").unwrap();
        let new = blocker.join(APP_ID);
        assert!(copy_into(&legacy, &new, &[]).is_err());
        assert_eq!(read(legacy.join("data-sources.json")), "old sources");
    }

    /// Makes the legacy `data-sources.json` unreadable so that copying fails; `false` when that has no effect (root).
    #[cfg(unix)]
    fn make_unreadable(legacy: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        let file = legacy.join("data-sources.json");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        fs::read(&file).is_err()
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_is_tried_again_at_the_next_start() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, legacy, new) = fixture();
        fs::write(legacy.join("ui-state.json"), "old ui").unwrap();
        // first start: the copy fails
        if !make_unreadable(&legacy) {
            return;
        }
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Failed(..)));
        assert!(!new.join("data-sources.json").exists());
        assert!(!new.join(MARKER).exists());
        assert_nothing_left_beside(&new);
        // ...and the app went on: it wrote its own files in the new folder
        fs::create_dir_all(new.join("logs")).unwrap();
        fs::write(new.join("logs").join("datum.2026-01-01.log"), "new log").unwrap();
        fs::write(new.join(".window-state.json"), "{}").unwrap();
        fs::write(new.join("ui-state.json"), "new ui").unwrap();
        fs::write(new.join("history.jsonl"), "new history").unwrap();
        fs::create_dir_all(new.join("localstorage")).unwrap();
        fs::write(new.join("localstorage").join("file.localstorage"), "new").unwrap();
        fs::set_permissions(
            legacy.join("data-sources.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        // second start: the missing entries are filled in around what is there, nothing is overwritten
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Copied(legacy));
        assert_eq!(read(new.join("data-sources.json")), "old sources");
        assert_eq!(read(new.join("ui-state.json")), "new ui");
        assert_eq!(read(new.join("history.jsonl")), "new history");
        assert_eq!(
            read(new.join("logs").join("datum.2026-01-01.log")),
            "new log"
        );
        assert_eq!(read(new.join(".window-state.json")), "{}");
        assert_eq!(
            read(new.join("localstorage").join("file.localstorage")),
            "new"
        );
        assert!(new.join(MARKER).is_file());
        assert_nothing_left_beside(&new);

        // third start: done
        fs::remove_file(new.join("data-sources.json")).unwrap();
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Nothing);
        assert!(!new.join("data-sources.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failure_becomes_a_notice_that_names_the_old_folder() {
        let (_root, legacy, new) = fixture();
        if !make_unreadable(&legacy) {
            return;
        }
        let outcome = adopt_legacy_dir(&new, &[]);
        let notice = outcome.notice(&new).expect("a failed copy has a notice");
        assert!(notice.message.contains(&legacy.display().to_string()));
        assert!(Adopted::Nothing.notice(&new).is_none());
    }

    #[test]
    fn existing_top_level_entries_are_kept_whole_and_the_missing_ones_arrive() {
        let (_root, legacy, new) = fixture();
        fs::create_dir_all(legacy.join("scratches")).unwrap();
        fs::write(legacy.join("scratches").join("a.sql"), "old scratch").unwrap();
        fs::create_dir_all(legacy.join("webview")).unwrap();
        fs::write(legacy.join("webview").join("CURRENT"), "old").unwrap();
        fs::write(legacy.join("webview").join("MANIFEST"), "old").unwrap();
        fs::create_dir_all(new.join("webview")).unwrap();
        fs::write(new.join("webview").join("CURRENT"), "new").unwrap();
        fs::write(new.join("data-sources.json"), "new sources").unwrap();

        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        assert_eq!(read(new.join("data-sources.json")), "new sources");
        assert_eq!(read(new.join("scratches").join("a.sql")), "old scratch");
        // one profile, not a mix of two
        assert_eq!(read(new.join("webview").join("CURRENT")), "new");
        assert!(!new.join("webview").join("MANIFEST").exists());
        assert!(new.join(MARKER).is_file());
    }

    #[test]
    fn caches_and_logs_are_not_copied() {
        let (_root, legacy, new) = fixture();
        for dir in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "DawnCache",
            "GrShaderCache",
            "ShaderCache",
            "WebKitCache",
            "CacheStorage",
            "EBWebView/Default/Cache",
            "EBWebView/Default/Service Worker/CacheStorage",
        ] {
            fs::create_dir_all(legacy.join(dir)).unwrap();
            fs::write(legacy.join(dir).join("blob"), "cache").unwrap();
        }
        fs::create_dir_all(legacy.join("EBWebView/Default/Local Storage")).unwrap();
        fs::write(
            legacy.join("EBWebView/Default/Local Storage/leveldb"),
            "keep",
        )
        .unwrap();
        // `logs` is only skipped at the top level
        fs::create_dir_all(legacy.join("scratches/logs")).unwrap();
        fs::write(legacy.join("scratches/logs/a.sql"), "keep").unwrap();

        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        for dir in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "DawnCache",
            "GrShaderCache",
            "ShaderCache",
            "WebKitCache",
            "CacheStorage",
            "EBWebView/Default/Cache",
            "EBWebView/Default/Service Worker/CacheStorage",
            "logs",
        ] {
            assert!(!new.join(dir).exists(), "{dir}");
        }
        assert_eq!(
            read(new.join("EBWebView/Default/Local Storage/leveldb")),
            "keep"
        );
        assert_eq!(read(new.join("scratches/logs/a.sql")), "keep");
        assert!(new.join("data-sources.json").is_file());
    }

    fn lock_path(new: &Path) -> PathBuf {
        new.with_file_name(format!("{APP_ID}.migrating.lock"))
    }

    #[test]
    fn a_fresh_lock_skips_the_copy_and_is_left_alone() {
        let (_root, _legacy, new) = fixture();
        fs::write(lock_path(&new), "4242").unwrap();
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Nothing);
        assert!(!new.exists());
        // not ours to remove
        assert_eq!(read(lock_path(&new)), "4242");
    }

    #[test]
    fn a_stale_lock_is_taken_over_and_removed_at_the_end() {
        let (_root, _legacy, new) = fixture();
        let lock = lock_path(&new);
        fs::write(&lock, "4242").unwrap();
        let old = SystemTime::now() - LOCK_TTL - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        assert!(new.join("data-sources.json").is_file());
        assert!(!lock.exists());
    }

    #[test]
    fn the_marker_is_checked_again_once_the_lock_is_held() {
        // a start that finished is never repeated, and its lock is gone
        let (_root, _legacy, new) = fixture();
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        assert_eq!(adopt_legacy_dir(&new, &[]), Adopted::Nothing);
        assert!(!lock_path(&new).exists());
    }

    #[test]
    fn the_temporary_folders_of_dead_starts_are_removed() {
        let (root, _legacy, new) = fixture();
        let dead = root.path().join(format!("{APP_ID}.migrating-1-2"));
        fs::create_dir_all(dead.join("x")).unwrap();
        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        assert!(!dead.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_recreated_as_symlinks() {
        use std::os::unix::fs::symlink;
        let (root, legacy, new) = fixture();
        let outside = root.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("shared.json"), "shared").unwrap();
        symlink(outside.join("shared.json"), legacy.join("link.json")).unwrap();
        symlink(&outside, legacy.join("linked-dir")).unwrap();
        symlink("data-sources.json", legacy.join("relative")).unwrap();
        // links that would never end when followed, or lead nowhere, are just links too
        symlink(root.path().join("missing"), legacy.join("dangling")).unwrap();
        symlink(&legacy, legacy.join("loop")).unwrap();

        assert!(matches!(adopt_legacy_dir(&new, &[]), Adopted::Copied(_)));
        for (name, to) in [
            ("link.json", outside.join("shared.json")),
            ("linked-dir", outside.clone()),
            ("relative", PathBuf::from("data-sources.json")),
            ("dangling", root.path().join("missing")),
            ("loop", legacy.clone()),
        ] {
            assert!(fs::symlink_metadata(new.join(name))
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read_link(new.join(name)).unwrap(), to, "{name}");
        }
        assert_eq!(read(new.join("relative")), "old sources");
    }

    #[test]
    fn paths_into_the_old_folder_are_rewritten_in_the_copied_state_files() {
        let (_root, legacy, new) = fixture();
        let old_scratch = format!("{}/scratches/a.sql", legacy.display());
        let ui = serde_json::json!({
            "tabs": {"list": [{"kind": "file", "data": {"path": old_scratch}}]},
            "fileTargets": {old_scratch.clone(): "ds1"},
            "other": format!("{}2/x", legacy.display()),
        });
        fs::write(legacy.join("ui-state.json"), ui.to_string()).unwrap();
        fs::write(
            legacy.join("file-access.json"),
            serde_json::json!({"files": [old_scratch], "folders": []}).to_string(),
        )
        .unwrap();
        // not a state file: copied as it is
        fs::write(legacy.join("notes.txt"), old_scratch.clone()).unwrap();

        let rewrites = path_rewrites(std::slice::from_ref(&new));
        assert!(matches!(
            adopt_legacy_dir(&new, &rewrites),
            Adopted::Copied(_)
        ));
        let new_scratch = format!("{}/scratches/a.sql", new.display());
        let got: Value = serde_json::from_str(&read(new.join("ui-state.json"))).unwrap();
        assert_eq!(got["tabs"]["list"][0]["data"]["path"], new_scratch);
        assert_eq!(got["fileTargets"][&new_scratch], "ds1");
        // only the exact folder: a longer name is left alone
        assert_eq!(got["other"], format!("{}2/x", legacy.display()));
        let fa: Value = serde_json::from_str(&read(new.join("file-access.json"))).unwrap();
        assert_eq!(fa["files"][0], new_scratch);
        assert_eq!(read(new.join("notes.txt")), old_scratch);
        // the old files are untouched (compared as JSON: on Windows the file holds the path with doubled backslashes)
        let old: Value = serde_json::from_str(&read(legacy.join("ui-state.json"))).unwrap();
        assert_eq!(old["tabs"]["list"][0]["data"]["path"], old_scratch);
    }

    #[test]
    fn rewrite_paths_matches_whole_segments_and_json_escapes() {
        let from = Path::new(r"C:\Users\u\AppData\Roaming\dev.prometeo.datagrip");
        let to = Path::new(r"C:\Users\u\AppData\Roaming\dev.datum.desktop");
        assert_eq!(
            json_escape(from),
            r"C:\\Users\\u\\AppData\\Roaming\\dev.prometeo.datagrip"
        );
        let pairs = vec![(json_escape(from), json_escape(to))];
        let text = r#"{"p":"C:\\Users\\u\\AppData\\Roaming\\dev.prometeo.datagrip\\scratches\\a.sql","d":"C:\\Users\\u\\AppData\\Roaming\\dev.prometeo.datagrip","x":"C:\\Users\\u\\AppData\\Roaming\\dev.prometeo.datagrip-copy\\a"}"#;
        let out = rewrite_paths(text, &pairs);
        assert!(out.contains(r"Roaming\\dev.datum.desktop\\scratches\\a.sql"));
        assert!(out.contains(r#"Roaming\\dev.datum.desktop","x""#));
        assert!(out.contains(r"dev.prometeo.datagrip-copy"));
        assert_eq!(rewrite_paths("no paths", &pairs), "no paths");
    }

    fn bases(config: &str, data: &str, local: &str) -> Bases {
        Bases {
            config: Some(PathBuf::from(config)),
            data: Some(PathBuf::from(data)),
            local_data: Some(PathBuf::from(local)),
            home: Some(PathBuf::from("/Users/u")),
        }
    }

    fn paths(v: Vec<PathBuf>) -> Vec<String> {
        v.iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn plans_the_folders_per_os_without_duplicates() {
        // Linux: data and local data are the same folder
        let linux = bases("/h/.config", "/h/.local/share", "/h/.local/share");
        assert_eq!(
            paths(plan_dirs(&linux, APP_ID, false, false, false)),
            [
                "/h/.config/dev.datum.desktop",
                "/h/.local/share/dev.datum.desktop"
            ]
        );
        // Windows: config and data are Roaming, the WebView lives in Local
        let win = bases("/R", "/R", "/L");
        assert_eq!(
            paths(plan_dirs(&win, APP_ID, false, false, false)),
            ["/R/dev.datum.desktop", "/L/dev.datum.desktop"]
        );
        // macOS: one Application Support folder, and the WebKit store named after the identifier
        let mac = bases(
            "/Users/u/Library/AS",
            "/Users/u/Library/AS",
            "/Users/u/Library/AS",
        );
        assert_eq!(
            paths(plan_dirs(&mac, APP_ID, false, false, true)),
            [
                "/Users/u/Library/AS/dev.datum.desktop",
                "/Users/u/Library/WebKit/dev.datum.desktop"
            ]
        );
    }

    #[test]
    fn an_override_takes_its_folder_and_the_webview_ones_out() {
        let linux = bases("/h/.config", "/h/.local/share", "/h/.local/share");
        assert_eq!(
            paths(plan_dirs(&linux, APP_ID, true, false, false)),
            ["/h/.local/share/dev.datum.desktop"]
        );
        assert_eq!(
            paths(plan_dirs(&linux, APP_ID, false, true, false)),
            ["/h/.config/dev.datum.desktop"]
        );
        assert!(plan_dirs(&linux, APP_ID, true, true, true).is_empty());
        // an unknown base folder is skipped
        let none = Bases {
            config: None,
            data: None,
            local_data: None,
            home: None,
        };
        assert!(plan_dirs(&none, APP_ID, false, false, true).is_empty());
    }
}
