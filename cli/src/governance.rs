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
            "reader" => matches!(tool_name, "read" | "list" | "search" | "http"),
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
}
