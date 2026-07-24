//! Work contract + authority envelope (plan Phases 1, 5).
//!
//! Substantial work opens with a compact, inspectable contract that the agent
//! infers and the operator can correct. The `AUTHORITY` line binds to an
//! [`Authority`] envelope that gates tool use at one enforcement point, and the
//! `PAUSE IF` line names the boundaries where even an allowed action should ask
//! first.

use serde::{Deserialize, Serialize};

/// Risk-scoped authority envelope. Ordered from least to most power. `Yolo`
/// runs fully autonomous — no approval prompts — but the workspace/secret floors
/// enforced in `tools.rs` still apply, so it cannot escape the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Authority {
    ReadOnly,
    Workspace,
    ExternalPreview,
    ExternalCommit,
    Yolo,
}

/// What the authority layer decided about a single action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Meaningful boundary — ask before proceeding.
    Prompt,
    /// Outside the envelope entirely.
    Deny,
}

impl Authority {
    pub fn label(self) -> &'static str {
        match self {
            Authority::ReadOnly => "read-only",
            Authority::Workspace => "workspace",
            Authority::ExternalPreview => "external-preview",
            Authority::ExternalCommit => "external-commit",
            Authority::Yolo => "YOLO (unbounded)",
        }
    }

    /// Decide whether a tool action is allowed. `mutates` marks writes/edits or
    /// non-verification shell; `sensitive` marks boundary-crossing actions
    /// (network, push, publish, deploy, spend, production).
    pub fn decide(self, mutates: bool, sensitive: bool) -> Decision {
        match self {
            Authority::Yolo => Decision::Allow,
            Authority::ReadOnly if mutates => Decision::Deny,
            Authority::ReadOnly => Decision::Allow,
            Authority::Workspace if sensitive => Decision::Deny,
            Authority::Workspace => Decision::Allow,
            Authority::ExternalPreview if sensitive => Decision::Prompt,
            Authority::ExternalPreview => Decision::Allow,
            Authority::ExternalCommit => Decision::Allow,
        }
    }
}

/// Heuristic: does this shell command cross an external / hard-to-reverse
/// boundary? Used to decide when to pause for a semantic approval.
pub fn sensitive_shell(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "git push",
        "npm publish",
        "cargo publish",
        "wrangler deploy",
        "vercel",
        "netlify deploy",
        "gh release",
        "docker push",
        "kubectl apply",
        "terraform apply",
        "curl ",
        "wget ",
        "ssh ",
        "scp ",
        "rsync ",
        "stripe ",
        "aws ",
        "gcloud ",
    ];
    MARKERS.iter().any(|marker| c.contains(marker))
}

/// The editable work contract serialized into the receipt.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Contract {
    pub goal: String,
    pub scope: String,
    pub authority: Authority,
    pub done_when: String,
    pub pause_if: String,
}

impl Contract {
    /// Infer a starting contract from the goal + chosen authority. The strings
    /// are intentionally terse defaults the operator can override.
    pub fn infer(goal: &str, authority: Authority) -> Self {
        Contract {
            goal: goal.trim().to_string(),
            scope: "current workspace".to_string(),
            authority,
            done_when: "the goal is verified by an actual check".to_string(),
            pause_if: match authority {
                Authority::Yolo => "never (autonomous)".to_string(),
                _ => "an action would push, publish, deploy, spend, or leave the workspace"
                    .to_string(),
            },
        }
    }

    /// Render the contract banner shown at the start of substantial work.
    pub fn banner(&self) -> String {
        format!(
            "CONTRACT\n  GOAL       {}\n  SCOPE      {}\n  AUTHORITY  {}\n  DONE WHEN  {}\n  PAUSE IF   {}",
            self.goal,
            self.scope,
            self.authority.label(),
            self.done_when,
            self.pause_if,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yolo_allows_everything() {
        assert_eq!(Authority::Yolo.decide(true, true), Decision::Allow);
    }

    #[test]
    fn read_only_denies_mutation() {
        assert_eq!(Authority::ReadOnly.decide(true, false), Decision::Deny);
        assert_eq!(Authority::ReadOnly.decide(false, false), Decision::Allow);
    }

    #[test]
    fn workspace_denies_sensitive() {
        assert_eq!(Authority::Workspace.decide(true, true), Decision::Deny);
        assert_eq!(Authority::Workspace.decide(true, false), Decision::Allow);
    }

    #[test]
    fn preview_prompts_on_sensitive() {
        assert_eq!(
            Authority::ExternalPreview.decide(true, true),
            Decision::Prompt
        );
    }

    #[test]
    fn detects_sensitive_shell() {
        assert!(sensitive_shell("git push origin main"));
        assert!(sensitive_shell("curl https://example.com"));
        assert!(!sensitive_shell("cargo test"));
    }
}
