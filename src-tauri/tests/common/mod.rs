//! Shared helpers for the integration tests.

/// The value of the variable `var` (`DATUM_<name>`), else of its 0.5.x name `PROMETEO_<name>`, so a shell that was
/// set up for the old name does not silently skip the database tests. Empty counts as unset.
pub fn env_url(var: &str) -> Option<String> {
    let legacy = var.strip_prefix("DATUM_").map(|n| format!("PROMETEO_{n}"));
    std::iter::once(var.to_string())
        .chain(legacy)
        .find_map(|v| std::env::var(v).ok().filter(|u| !u.is_empty()))
}
