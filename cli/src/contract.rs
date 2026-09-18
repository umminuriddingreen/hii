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
    PersonalLocal,
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
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" => Ok(Authority::ReadOnly),
            "workspace" => Ok(Authority::Workspace),
            "personal-local" | "personal" | "mac" => Ok(Authority::PersonalLocal),
            "external-preview" | "preview" => Ok(Authority::ExternalPreview),
            "external-commit" | "commit" => Ok(Authority::ExternalCommit),
            "yolo" => Ok(Authority::Yolo),
            other => Err(format!(
                "unknown authority '{other}'; use read-only | workspace | personal-local | external-preview | external-commit | yolo"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Authority::ReadOnly => "read-only",
            Authority::Workspace => "workspace",
            Authority::PersonalLocal => "personal-local",
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
            Authority::PersonalLocal if sensitive => Decision::Prompt,
            Authority::PersonalLocal => Decision::Allow,
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

/// What kind of result the goal actually calls for.
///
/// Declared before or during run preparation. It is never inferred afterwards
/// from whatever files happened to appear, because a requirement invented after
/// execution proves nothing about what was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutcomeKind {
    /// An answer. A final response and the declared checks; no file required.
    Informational,
    /// One or more files that must exist and validate.
    FileArtifact,
    /// Reserved. Object creation, mutation, relation and projection outcomes
    /// land with governed object tools; declaring one today is refused rather
    /// than silently treated as satisfied.
    WorkspaceObject,
}

impl OutcomeKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "informational" | "info" => Ok(OutcomeKind::Informational),
            "file-artifact" | "file" | "artifact" => Ok(OutcomeKind::FileArtifact),
            "workspace-object" | "object" => Ok(OutcomeKind::WorkspaceObject),
            other => Err(format!(
                "unknown outcome '{other}'; use informational | file-artifact"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OutcomeKind::Informational => "informational",
            OutcomeKind::FileArtifact => "file-artifact",
            OutcomeKind::WorkspaceObject => "workspace-object",
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_min_count() -> usize {
    1
}

/// One declared required artifact.
///
/// `path` is workspace-relative. A trailing `*` makes it a prefix pattern, which
/// is the only wildcard form on purpose: a required outcome should name where
/// the result goes, not describe a search.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequirement {
    pub path: String,
    #[serde(default = "default_min_count")]
    pub min_count: usize,
    #[serde(default)]
    pub extension: Option<String>,
    #[serde(default = "default_true")]
    pub must_exist: bool,
    #[serde(default = "default_true")]
    pub must_be_file: bool,
    #[serde(default = "default_true")]
    pub must_be_non_empty: bool,
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

impl ArtifactRequirement {
    /// Parse `path[:ext][@sha256][xN]` from one `--require-artifact` flag.
    ///
    /// Only the path is mandatory, so the common case stays one word.
    pub fn parse(value: &str) -> Result<Self, String> {
        let raw = value.trim();
        if raw.is_empty() {
            return Err("--require-artifact needs a workspace-relative path".into());
        }
        let (rest, expected_sha256) = match raw.split_once('@') {
            Some((left, digest)) => {
                let digest = digest.trim().to_ascii_lowercase();
                if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(format!("'{digest}' is not a sha256 digest"));
                }
                (left.trim(), Some(digest))
            }
            None => (raw, None),
        };
        let (rest, min_count) = match rest.rsplit_once('x') {
            Some((left, count))
                if count.chars().all(|c| c.is_ascii_digit()) && !count.is_empty() =>
            {
                (left.trim(), count.parse::<usize>().unwrap_or(1).max(1))
            }
            _ => (rest, 1),
        };
        let (path, extension) = match rest.split_once(':') {
            Some((left, ext)) => (
                left.trim(),
                Some(ext.trim().trim_start_matches('.').to_string()),
            ),
            None => (rest, None),
        };
        if path.is_empty() {
            return Err("--require-artifact needs a workspace-relative path".into());
        }
        if path.starts_with('/') || path.contains("..") {
            return Err(format!(
                "required artifact '{path}' must stay inside the approved workspace root"
            ));
        }
        Ok(ArtifactRequirement {
            path: path.to_string(),
            min_count,
            extension,
            must_exist: true,
            must_be_file: true,
            must_be_non_empty: true,
            expected_sha256,
        })
    }
}

/// The outcome the run must actually produce to be called complete.
///
/// Optional and versioned. A contract without one keeps informational-task
/// behavior, so every contract written before this existed still means what it
/// meant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeRequirements {
    #[serde(default = "default_requirements_version")]
    pub version: u8,
    pub kind: OutcomeKind,
    #[serde(default = "default_true")]
    pub final_response_required: bool,
    #[serde(default = "default_true")]
    pub declared_checks_required: bool,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRequirement>,
}

fn default_requirements_version() -> u8 {
    1
}

impl OutcomeRequirements {
    /// A direct answer can finish when it returns a final response, but it does
    /// not become verified evidence merely by existing.
    pub fn informational_response() -> Self {
        OutcomeRequirements {
            version: 1,
            kind: OutcomeKind::Informational,
            final_response_required: true,
            declared_checks_required: false,
            artifacts: Vec::new(),
        }
    }

    pub fn build(kind: OutcomeKind, artifacts: Vec<ArtifactRequirement>) -> Result<Self, String> {
        if kind == OutcomeKind::WorkspaceObject {
            return Err(
                "workspace-object outcomes are not supported yet; governed object tools do not \
                 exist, so HII cannot verify one and will not pretend it can"
                    .into(),
            );
        }
        if kind == OutcomeKind::FileArtifact && artifacts.is_empty() {
            return Err(
                "a file-artifact outcome needs at least one --require-artifact path".into(),
            );
        }
        Ok(OutcomeRequirements {
            version: 1,
            kind,
            final_response_required: true,
            declared_checks_required: true,
            artifacts,
        })
    }

    /// Derive requirements from the flags actually given, if any were.
    pub fn from_flags(outcome: Option<&str>, artifacts: &[String]) -> Result<Option<Self>, String> {
        let parsed = artifacts
            .iter()
            .map(|value| ArtifactRequirement::parse(value))
            .collect::<Result<Vec<_>, _>>()?;
        match (outcome, parsed.is_empty()) {
            (None, true) => Ok(None),
            // Naming a required artifact is itself a declaration of a file
            // outcome; making the operator say it twice would be ceremony.
            (None, false) => Ok(Some(Self::build(OutcomeKind::FileArtifact, parsed)?)),
            (Some(kind), _) => Ok(Some(Self::build(OutcomeKind::parse(kind)?, parsed)?)),
        }
    }
}

/// The editable work contract serialized into the receipt.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Contract {
    pub goal: String,
    pub scope: String,
    pub authority: Authority,
    pub done_when: String,
    pub pause_if: String,
    /// Absent on every contract written before outcome requirements existed.
    #[serde(default)]
    pub outcome_requirements: Option<OutcomeRequirements>,
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
            outcome_requirements: None,
        }
    }

    pub fn with_outcome_requirements(mut self, requirements: Option<OutcomeRequirements>) -> Self {
        self.outcome_requirements = requirements;
        self
    }

    pub fn with_done_when(mut self, done_when: Option<&str>) -> Self {
        if let Some(value) = done_when.map(str::trim).filter(|value| !value.is_empty()) {
            self.done_when = value.to_string();
        }
        self
    }

    /// Render the contract banner shown at the start of substantial work.
    pub fn banner(&self) -> String {
        let mut banner = format!(
            "CONTRACT\n  GOAL       {}\n  SCOPE      {}\n  AUTHORITY  {}\n  DONE WHEN  {}\n  PAUSE IF   {}",
            self.goal,
            self.scope,
            self.authority.label(),
            self.done_when,
            self.pause_if,
        );
        if let Some(requirements) = &self.outcome_requirements {
            let artifacts = requirements
                .artifacts
                .iter()
                .map(|artifact| artifact.path.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            banner.push_str(&format!("\n  OUTCOME    {}", requirements.kind.label()));
            if !artifacts.is_empty() {
                banner.push_str(&format!("\n  MUST YIELD {artifacts}"));
            }
        }
        banner
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
    fn parses_operator_facing_authority_aliases() {
        assert_eq!(Authority::parse("read-only").unwrap(), Authority::ReadOnly);
        assert_eq!(
            Authority::parse("preview").unwrap(),
            Authority::ExternalPreview
        );
        assert!(Authority::parse("root").is_err());
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
