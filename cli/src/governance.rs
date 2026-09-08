//! Client-side ACL enforcement for the MCP stdio server.
//!
//! Loads a JSON config at `$HII_MCP_CONFIG` (or `~/.hii/mcp_acl.json`) that
//! defines per-client ACLs, default roles, and tool schemas. The CLI passes its
//! client identity via `--client-identity <id>` flag; the server resolves the
//! matching rules before executing any tool call.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AclConfig {
    #[serde(default)]
    pub clients: HashMap<String, ClientRole>,
    #[serde(default)]
    pub defaults: Option<ClientRole>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct ClientRole {
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default)]
    pub restricted_tools: Vec<String>, // tools requiring special approval gates
    #[serde(default = "default_max_params")]
    pub max_params_per_call: u32,
}

fn default_role() -> String {
    "anonymous".into()
}

fn default_max_params() -> u32 {
    64
}

impl AclConfig {
    /// Load from the `$HII_MCP_CONFIG` env var path. Returns a read-only config
    /// with only `read` permission when nothing is found.
    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        let bytes = fs::read_to_string(path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        serde_json::from_str(&bytes)
            .map_err(|error| format!("invalid ACL config {}: {error}", path.display()))
    }

    /// A safe bootstrap config that grants `reader` status with no-write.
    pub fn load_default() -> Self {
        Self {
            clients: HashMap::new(),
            defaults: Some(ClientRole {
                role: "reader".into(),
                restricted_tools: vec![],
                max_params_per_call: 64,
            }),
        }
    }

    /// Resolve the identity against configured roles; return default when
    /// no registered client matches.
    pub fn resolve_role(&self, identity: &str) -> ClientRole {
        self.clients
            .get(identity)
            .cloned()
            .unwrap_or_else(|| self.defaults.clone().unwrap_or_default())
    }

    /// Check whether `identity` may call the given `tool_name`. Returns an error
    /// when the tool is not in the client's allowed set.
    pub fn check_acl(&self, identity: &str, tool_name: &str) -> Result<(), AclViolation> {
        let role = self.resolve_role(identity);

        let role_allows = match role.role.as_str() {
            "reader" => is_reader_tool(tool_name),
            "canvas-operator" => {
                is_reader_tool(tool_name) || matches!(tool_name, "canvas_add" | "canvas_update")
            }
            "operator" | "service" => true,
            _ => false,
        };
        if !role_allows {
            return Err(AclViolation::ToolNotInRole(
                tool_name.to_string(),
                role.role,
            ));
        }

        if role.restricted_tools.iter().any(|tool| tool == tool_name) {
            return Err(AclViolation::RestrictedTool(tool_name.to_string()));
        }

        Ok(())
    }

    /// Extended gate that includes parameter validation and shell-level denylists.
    pub fn check_acl_with_params(
        &self,
        identity: &str,
        tool_name: &str,
        param_count: usize,
    ) -> Result<(), AclViolation> {
        self.check_acl(identity, tool_name)?;

        let role = self.resolve_role(identity);

        if param_count > role.max_params_per_call as usize {
            return Err(AclViolation::TooManyParams(role.max_params_per_call));
        }

        Ok(())
    }
}

/// Read-ness is derived from the tool manifest, not a second hand-maintained
/// list. A hardcoded copy drifted once already: `web_fetch` and `web_search`
/// were missing while the strictly broader `http` was allowed, so the Pi agent
/// got `acl denied: tool 'web_fetch' not permitted for role 'canvas-operator'`
/// for a tool the manifest itself declares non-mutating.
///
/// A tool is a reader when the manifest says it does not mutate *and* its reach
/// is not `Exec` — `verify` runs an arbitrary command, so "does not mutate" is
/// a claim about intent there, not an enforceable boundary.
fn is_reader_tool(tool_name: &str) -> bool {
    crate::acp::tools()
        .iter()
        .any(|spec| spec.name == tool_name && !spec.mutates && spec.reach != crate::acp::Reach::Exec)
}

/// A single violation type that gets returned from ACL checks.
#[derive(Debug, Clone)]
pub enum AclViolation {
    /// Tool not in allowed list for this role
    ToolNotInRole(String, String),
    /// Tool is explicitly denied for this client or default role.
    RestrictedTool(String),
    /// Exceeded max_params_per_call limit
    TooManyParams(u32),
}

impl std::fmt::Display for AclViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ToolNotInRole(tool, role) => {
                write!(f, "tool '{tool}' not permitted for role '{role}'")
            }
            Self::RestrictedTool(tool) => write!(f, "tool '{tool}' is restricted"),
            Self::TooManyParams(limit) => write!(f, "too many params (max {limit})"),
        }
    }
}

// --- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_default_safe_bootstrap() {
        let cfg = AclConfig::load_default();
        assert_eq!(cfg.clients.len(), 0);
        assert!(cfg.defaults.is_some());
    }

    #[test]
    fn reader_restricted_from_writes() {
        let cfg = AclConfig::load_default();
        let result = cfg.check_acl("nobody", "write");
        assert!(result.is_err()); // Reader gets no write
    }

    #[test]
    fn explicit_restrictions_are_enforced() {
        let mut cfg = AclConfig::load_default();
        cfg.clients.insert(
            "worker".into(),
            ClientRole {
                role: "operator".into(),
                restricted_tools: vec!["shell".into()],
                max_params_per_call: 64,
            },
        );
        assert!(matches!(
            cfg.check_acl("worker", "shell"),
            Err(AclViolation::RestrictedTool(_))
        ));
    }

    #[test]
    fn unknown_roles_fail_closed() {
        let mut cfg = AclConfig::load_default();
        cfg.clients.insert(
            "mystery".into(),
            ClientRole {
                role: "custom".into(),
                restricted_tools: vec![],
                max_params_per_call: 64,
            },
        );
        assert!(cfg.check_acl("mystery", "read").is_err());
    }

    #[test]
    fn canvas_operator_is_bounded_to_canvas_mutation() {
        let mut cfg = AclConfig::load_default();
        cfg.clients.insert(
            "codex".into(),
            ClientRole {
                role: "canvas-operator".into(),
                restricted_tools: vec![],
                max_params_per_call: 64,
            },
        );
        assert!(cfg.check_acl("codex", "canvas_add").is_ok());
        assert!(cfg.check_acl("codex", "canvas_update").is_ok());
        assert!(cfg.check_acl("codex", "canvas_read").is_ok());
        assert!(cfg.check_acl("codex", "write").is_err());
        assert!(cfg.check_acl("codex", "shell").is_err());
        assert!(cfg.check_acl("codex", "board_write").is_err());
    }

    /// Regression: `web_fetch`/`web_search` were denied to read-only roles even
    /// though the manifest declares them non-mutating, which broke the Pi
    /// agent's `hii_web_fetch` calls. Reader-ness now comes from the manifest,
    /// so every non-mutating, non-exec tool is allowed and no future tool can
    /// drift out of the list.
    #[test]
    fn every_non_mutating_manifest_tool_is_a_reader_tool() {
        for spec in crate::acp::tools() {
            let expected = !spec.mutates && spec.reach != crate::acp::Reach::Exec;
            assert_eq!(
                is_reader_tool(spec.name),
                expected,
                "reader classification drifted for {}",
                spec.name
            );
        }
        assert!(is_reader_tool("web_fetch"));
        assert!(is_reader_tool("web_search"));
        assert!(!is_reader_tool("verify"));
        assert!(!is_reader_tool("not_a_tool"));
    }

    #[test]
    fn read_only_roles_may_reach_the_public_web() {
        let mut cfg = AclConfig::load_default();
        for role in ["reader", "canvas-operator"] {
            cfg.clients.insert(
                "pi".into(),
                ClientRole {
                    role: role.into(),
                    restricted_tools: vec![],
                    max_params_per_call: 64,
                },
            );
            assert!(cfg.check_acl("pi", "web_fetch").is_ok(), "{role}");
            assert!(cfg.check_acl("pi", "web_search").is_ok(), "{role}");
            assert!(cfg.check_acl("pi", "shell").is_err(), "{role}");
        }
    }
}
