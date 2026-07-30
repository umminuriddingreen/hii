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

/// Recognizable file-removal commands always require a live operator approval,
/// even under YOLO authority. This is intentionally broader than `rm`: models
/// commonly reach deletion through Git, PowerShell, Python, Node, or `find`.
pub fn deletion_shell(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "rm ",
        "rm\t",
        "rmdir ",
        "unlink ",
        "git rm ",
        "find ",
        " -delete",
        "del ",
        "erase ",
        "remove-item ",
        "os.remove(",
        "os.unlink(",
        "shutil.rmtree(",
        "fs.unlink(",
        "fs.rm(",
        "remove_file(",
        "remove_dir(",
        "remove_dir_all(",
    ];
    MARKERS.iter().any(|marker| c.contains(marker))
        && !(c.contains("find ") && !c.contains(" -delete"))
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
                Authority::Yolo => "a command would delete files".to_string(),
                _ => {
                    "a command would delete files; external effects remain outside local authority"
                        .to_string()
                }
            },
        }
    }

    pub fn with_done_when(mut self, done_when: Option<&str>) -> Self {
        if let Some(value) = done_when.map(str::trim).filter(|value| !value.is_empty()) {
            self.done_when = value.to_string();
        }
        self
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

    #[test]
    fn detects_deletion_across_common_shells() {
        assert!(deletion_shell("rm -rf build"));
        assert!(deletion_shell("git rm old.rs"));
        assert!(deletion_shell("python -c 'import os; os.remove(\"x\")'"));
        assert!(deletion_shell("find . -name '*.tmp' -delete"));
        assert!(!deletion_shell("find . -name '*.rs' -print"));
        assert!(!deletion_shell("cargo test"));
    }

    #[test]
    fn operator_acceptance_criterion_overrides_default() {
        let contract = Contract::infer("ship", Authority::Workspace)
            .with_done_when(Some("all focused tests pass"));
        assert_eq!(contract.done_when, "all focused tests pass");
    }
}
