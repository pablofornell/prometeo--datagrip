//! MCP permissions: which data sources an agent may read and write.
//!
//! A rule is set on a folder of the Database Explorer or on one data source; the data-source rule wins, a data
//! source without any rule has no access. A data source marked read-only in its own settings never gets write.
//! The frontend owns the folders (it pushes `groups`, data source id -> folder name); everything is computed here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct McpPerm {
    pub read: bool,
    pub write: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpPolicyInput {
    /// Folder name -> permission.
    pub folder_rules: BTreeMap<String, McpPerm>,
    /// Data source id -> permission (overrides the folder).
    pub source_rules: BTreeMap<String, McpPerm>,
    /// Data source id -> folder name.
    pub groups: BTreeMap<String, String>,
}

/// Which rule gave the permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpOrigin {
    Source,
    Folder,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEffectivePerm {
    #[serde(flatten)]
    pub perm: McpPerm,
    pub origin: McpOrigin,
    /// Write was forced off by the data source's read-only flag.
    pub read_only_source: bool,
}

impl McpEffectivePerm {
    pub fn visible(&self) -> bool {
        self.perm.read || self.perm.write
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPolicy {
    #[serde(flatten)]
    pub input: McpPolicyInput,
    /// Every known data source.
    pub effective: BTreeMap<String, McpEffectivePerm>,
}

/// The permission of one data source.
pub fn effective_for(input: &McpPolicyInput, id: &str, read_only: bool) -> McpEffectivePerm {
    let (mut perm, origin) = if let Some(p) = input.source_rules.get(id) {
        (*p, McpOrigin::Source)
    } else if let Some(p) = input.groups.get(id).and_then(|g| input.folder_rules.get(g)) {
        (*p, McpOrigin::Folder)
    } else {
        (McpPerm::default(), McpOrigin::None)
    };
    let read_only_source = read_only && perm.write;
    if read_only {
        perm.write = false;
    }
    McpEffectivePerm {
        perm,
        origin,
        read_only_source,
    }
}

/// The policy with the effective permission of every data source (`(id, read_only)`).
pub fn compute(input: &McpPolicyInput, sources: &[(String, bool)]) -> McpPolicy {
    McpPolicy {
        input: input.clone(),
        effective: sources
            .iter()
            .map(|(id, ro)| (id.clone(), effective_for(input, id, *ro)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perm(read: bool, write: bool) -> McpPerm {
        McpPerm { read, write }
    }

    fn input() -> McpPolicyInput {
        McpPolicyInput {
            folder_rules: [("Prod".to_string(), perm(true, false))].into(),
            source_rules: [("b".to_string(), perm(true, true))].into(),
            groups: [
                ("a".to_string(), "Prod".to_string()),
                ("b".to_string(), "Prod".to_string()),
                ("c".to_string(), "Nowhere".to_string()),
            ]
            .into(),
        }
    }

    #[test]
    fn no_rule_means_no_access() {
        let e = effective_for(&input(), "zzz", false);
        assert_eq!(e.perm, perm(false, false));
        assert_eq!(e.origin, McpOrigin::None);
        assert!(!e.visible());
        // a folder without a rule is the same
        assert_eq!(effective_for(&input(), "c", false).origin, McpOrigin::None);
    }

    #[test]
    fn folder_rule_applies_to_its_members() {
        let e = effective_for(&input(), "a", false);
        assert_eq!(e.perm, perm(true, false));
        assert_eq!(e.origin, McpOrigin::Folder);
        assert!(e.visible());
    }

    #[test]
    fn source_rule_wins_over_the_folder() {
        let e = effective_for(&input(), "b", false);
        assert_eq!(e.perm, perm(true, true));
        assert_eq!(e.origin, McpOrigin::Source);
        // also when the source rule is stricter than the folder
        let mut i = input();
        i.source_rules.insert("a".into(), perm(false, false));
        let e = effective_for(&i, "a", false);
        assert_eq!(e.perm, perm(false, false));
        assert_eq!(e.origin, McpOrigin::Source);
    }

    #[test]
    fn read_only_source_never_writes() {
        let e = effective_for(&input(), "b", true);
        assert_eq!(e.perm, perm(true, false));
        assert!(e.read_only_source);
        // nothing was granted: not reported as forced off
        let e = effective_for(&input(), "a", true);
        assert_eq!(e.perm, perm(true, false));
        assert!(!e.read_only_source);
    }

    #[test]
    fn compute_lists_every_source_and_serializes_flat() {
        let sources = vec![("a".to_string(), false), ("b".to_string(), true)];
        let p = compute(&input(), &sources);
        assert_eq!(p.effective.len(), 2);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["effective"]["b"]["write"], false);
        assert_eq!(v["effective"]["b"]["readOnlySource"], true);
        assert_eq!(v["effective"]["b"]["origin"], "source");
        assert_eq!(v["folderRules"]["Prod"]["read"], true);
        assert_eq!(v["groups"]["a"], "Prod");
    }

    #[test]
    fn input_accepts_missing_fields() {
        let i: McpPolicyInput =
            serde_json::from_str(r#"{"sourceRules":{"x":{"read":true}}}"#).unwrap();
        assert_eq!(i.source_rules["x"], perm(true, false));
        assert!(i.folder_rules.is_empty() && i.groups.is_empty());
    }
}
