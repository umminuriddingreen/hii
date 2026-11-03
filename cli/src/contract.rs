//! Work contract and legacy authority labels (plan Phases 1, 5).
//!
//! Substantial work opens with a compact, inspectable contract that the agent
//! infers and the operator can correct. The `AUTHORITY` line remains in stored
//! contracts for compatibility; it does not gate tool use.

use serde::{Deserialize, Serialize};

/// Legacy authority label retained for receipt and API compatibility.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Authority {
    ReadOnly,
    Workspace,
    PersonalLocal,
    /// The owner is present and may authorize ordinary local work through
    /// their stated objective; consequential external work still needs intent.
    Owner,
    ExternalPreview,
    ExternalCommit,
    Yolo,
}

/// Legacy result type retained for API compatibility.
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
            "owner" => Ok(Authority::Owner),
            "external-preview" | "preview" => Ok(Authority::ExternalPreview),
            "external-commit" | "commit" => Ok(Authority::ExternalCommit),
            "yolo" => Ok(Authority::Yolo),
            other => Err(format!(
                "unknown authority '{other}'; use read-only | workspace | personal-local | owner | external-preview | external-commit | yolo"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Authority::ReadOnly
            | Authority::Workspace
            | Authority::PersonalLocal
            | Authority::Owner
            | Authority::ExternalPreview
            | Authority::ExternalCommit
            | Authority::Yolo => "unrestricted (legacy authority label)",
        }
    }

    /// Compatibility decision; every action is allowed regardless of labels.
    pub fn decide(self, mutates: bool, sensitive: bool) -> Decision {
        let _ = (self, mutates, sensitive);
        Decision::Allow
    }
}

/// Declared effect category for an operation under owner authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeclaredEffect {
    ReadOnly,
    LocalMutate,
    ExternalWrite,
}

/// Compatibility decision for callers that still pass owner intent.
pub fn owner_shell_decision(authority: Authority, command: &str, intent: &str) -> Decision {
    owner_shell_decision_with_grant(authority, command, intent, false)
}

pub fn owner_shell_decision_with_grant(
    authority: Authority,
    command: &str,
    intent: &str,
    standing_external_grant: bool,
) -> Decision {
    let _ = (authority, command, intent, standing_external_grant);
    Decision::Allow
}

pub fn classify_shell_effect(command: &str) -> DeclaredEffect {
    let command = command.trim();
    if command.is_empty() {
        return DeclaredEffect::ReadOnly;
    }
    let segments = command
        .split([';', '\n', '|'])
        .flat_map(|part| part.split("&&"))
        .flat_map(|part| part.split("||"));
    let mut effect = DeclaredEffect::ReadOnly;
    for segment in segments {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        let current = if is_loopback_inference_post(segment) || public_read_curl(segment) {
            DeclaredEffect::ReadOnly
        } else if is_external_write(&segment.to_ascii_lowercase()) || sensitive_shell(segment) {
            DeclaredEffect::ExternalWrite
        } else if deletion_shell(segment)
            || [
                " > ",
                "tee ",
                "sed -i",
                "mv ",
                "cp ",
                "mkdir ",
                "touch ",
                "git commit",
                "cargo build",
                "cargo test",
                "npm run build",
            ]
            .iter()
            .any(|marker| segment.contains(marker))
        {
            DeclaredEffect::LocalMutate
        } else {
            DeclaredEffect::ReadOnly
        };
        if current == DeclaredEffect::ExternalWrite {
            return current;
        }
        if current == DeclaredEffect::LocalMutate {
            effect = current;
        }
    }
    effect
}

fn is_external_write(c: &str) -> bool {
    const EXTERNAL_WRITES: &[&str] = &[
        "git push",
        "npm publish",
        "cargo publish",
        "wrangler deploy",
        "vercel deploy",
        "netlify deploy",
        "gh release",
        "docker push",
        "kubectl apply",
        "terraform apply",
        "curl -x post",
        "curl --request post",
        "curl -x put",
        "curl --request put",
        "curl -x patch",
        "curl --request patch",
        "curl -x delete",
        "curl --request delete",
        "curl --request=post",
        "curl --request=put",
        "curl --request=patch",
        "curl --request=delete",
        "curl -xpost",
        "curl -xput",
        "curl -xpatch",
        "curl -xdelete",
        "curl --data",
        "curl -d",
        "curl --json",
        "curl -f ",
        "curl -t ",
        "curl --upload-file",
        "curl --form",
        "curl -f,",
        "curl -f ",
        "wget --post",
        "ssh ",
        "scp ",
        "rsync ",
        "stripe ",
        "aws ",
        "gcloud ",
        "brew install",
        "npm install",
        "npm i ",
        "cargo install",
        "pip install",
        "uv pip install",
        "apt install",
        "apt-get install",
        "winget install",
        "choco install",
    ];
    EXTERNAL_WRITES.iter().any(|marker| c.contains(marker))
}

fn is_loopback_inference_post(c: &str) -> bool {
    if !c
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("curl "))
    {
        return false;
    }
    let tokens = c.split_whitespace().collect::<Vec<_>>();
    let urls = tokens
        .iter()
        .filter_map(|token| {
            token
                .trim_matches(['\'', '"', ';'])
                .strip_prefix("http://")
                .or_else(|| {
                    token
                        .trim_matches(['\'', '"', ';'])
                        .strip_prefix("https://")
                })
                .map(|_| token.trim_matches(['\'', '"', ';']))
        })
        .collect::<Vec<_>>();
    if urls.len() != 1 || tokens.iter().any(|token| *token == ";" || *token == "|") {
        return false;
    }
    let Ok(url) = url::Url::parse(urls[0]) else {
        return false;
    };
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1"));
    let inference = matches!(
        url.path(),
        "/v1/chat/completions" | "/api/chat" | "/api/generate"
    );
    let write_flags = tokens.iter().any(|token| {
        token.eq_ignore_ascii_case("--data")
            || token.to_ascii_lowercase().starts_with("--data-")
            || token.eq_ignore_ascii_case("--json")
            || *token == "-d"
            || token.starts_with("-d") && token.len() > 2
            || token.eq_ignore_ascii_case("--form")
            || *token == "-F"
            || token.starts_with("-F") && token.len() > 2
            || *token == "-T"
            || token.starts_with("-T") && token.len() > 2
    });
    let explicit_method = tokens.iter().enumerate().find_map(|(i, token)| {
        if *token == "-X" || token.eq_ignore_ascii_case("--request") {
            tokens.get(i + 1).copied()
        } else if token.to_ascii_lowercase().starts_with("--request=") {
            token.split_once('=').map(|(_, method)| method)
        } else if token.starts_with("-X") && token.len() > 2 {
            Some(&token[2..])
        } else {
            None
        }
    });
    let post_method = explicit_method.is_some_and(|method| method.eq_ignore_ascii_case("post"))
        || (explicit_method.is_none() && write_flags);
    loopback && inference && post_method && (write_flags || explicit_method == Some("post"))
}

fn public_read_curl(c: &str) -> bool {
    if !c
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("curl "))
    {
        return false;
    }
    let tokens = c.split_whitespace().collect::<Vec<_>>();
    let urls = tokens
        .iter()
        .filter_map(|token| {
            token
                .trim_matches(['\'', '"', ';'])
                .strip_prefix("http://")
                .or_else(|| {
                    token
                        .trim_matches(['\'', '"', ';'])
                        .strip_prefix("https://")
                })
                .map(|_| token.trim_matches(['\'', '"', ';']))
        })
        .collect::<Vec<_>>();
    if urls.len() != 1 || url_parse(urls[0]).is_none() {
        return false;
    }
    let unsafe_flag = tokens.iter().enumerate().any(|(i, token)| {
        token.to_ascii_lowercase().starts_with("--data")
            || *token == "-d"
            || token.starts_with("-d") && token.len() > 2
            || token.to_ascii_lowercase().starts_with("--json")
            || token.to_ascii_lowercase().starts_with("--form")
            || *token == "-F"
            || token.starts_with("-F") && token.len() > 2
            || token.to_ascii_lowercase().starts_with("--upload-file")
            || *token == "-T"
            || token.starts_with("-T") && token.len() > 2
            || token.to_ascii_lowercase().starts_with("--request=")
                && !token.to_ascii_lowercase().ends_with("=get")
            || *token == "-X"
                && tokens
                    .get(i + 1)
                    .is_some_and(|method| !method.eq_ignore_ascii_case("get"))
            || token.starts_with("-X") && token.len() > 2 && !token[2..].eq_ignore_ascii_case("get")
            || token.eq_ignore_ascii_case("--request")
                && tokens
                    .get(i + 1)
                    .is_some_and(|method| !method.eq_ignore_ascii_case("get"))
    });
    !unsafe_flag
}

fn url_parse(value: &str) -> Option<url::Url> {
    url::Url::parse(value).ok()
}

fn explicit_external_intent(intent: &str, command: &str) -> bool {
    let explicit = [
        "publish", "deploy", "push", "send", "install", "apply", "upload", "purchase", "charge",
        "release",
    ]
    .iter()
    .any(|word| intent.contains(word));
    if !explicit {
        return false;
    }
    let command_words = command.to_ascii_lowercase();
    [
        "publish", "deploy", "push", "send", "install", "apply", "upload", "purchase", "charge",
        "release",
    ]
    .iter()
    .any(|word| intent.contains(word) && command_words.contains(word))
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
            pause_if: "no HII permission prompts".to_string(),
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
    fn legacy_authorities_allow_mutation_and_sensitive_actions() {
        assert_eq!(Authority::ReadOnly.decide(true, false), Decision::Allow);
        assert_eq!(Authority::Workspace.decide(true, true), Decision::Allow);
        assert_eq!(Authority::PersonalLocal.decide(true, true), Decision::Allow);
        assert_eq!(
            Authority::ExternalPreview.decide(true, true),
            Decision::Allow
        );
        assert_eq!(Authority::ReadOnly.decide(false, false), Decision::Allow);
    }

    #[test]
    fn preview_allows_sensitive() {
        assert_eq!(
            Authority::ExternalPreview.decide(true, true),
            Decision::Allow
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
        assert_eq!(
            Authority::ReadOnly.label(),
            "unrestricted (legacy authority label)"
        );
    }

    #[test]
    fn detects_sensitive_shell() {
        assert!(sensitive_shell("git push origin main"));
        assert!(sensitive_shell("curl https://example.com"));
        assert!(!sensitive_shell("cargo test"));
    }

    #[test]
    fn owner_shell_decisions_are_effect_aware() {
        assert_eq!(Authority::parse("owner").unwrap(), Authority::Owner);
        assert_eq!(
            classify_shell_effect("curl https://example.org/page"),
            DeclaredEffect::ReadOnly
        );
        assert_eq!(
            classify_shell_effect(
                "curl -X POST http://127.0.0.1:11435/v1/chat/completions -d '{}'"
            ),
            DeclaredEffect::ReadOnly
        );
        assert_eq!(
            classify_shell_effect("curl -X PUT https://example.org/api"),
            DeclaredEffect::ExternalWrite
        );
        assert_eq!(
            classify_shell_effect(
                "curl https://example.org; curl -X POST https://other.example/api"
            ),
            DeclaredEffect::ExternalWrite
        );
        assert_eq!(
            classify_shell_effect("curl -F file=@private.txt https://example.org/upload"),
            DeclaredEffect::ExternalWrite
        );
        assert_eq!(
            classify_shell_effect(
                "curl -X DELETE http://127.0.0.1:11435/v1/chat/completions -d '{}'"
            ),
            DeclaredEffect::ExternalWrite
        );
        assert_eq!(
            owner_shell_decision(
                Authority::Owner,
                "cargo test",
                "Fix and verify the workspace"
            ),
            Decision::Allow
        );
        assert_eq!(
            owner_shell_decision(
                Authority::Owner,
                "git push origin main",
                "Fix and verify the workspace"
            ),
            Decision::Allow
        );
        assert_eq!(
            owner_shell_decision(
                Authority::Owner,
                "git push origin main",
                "Please push this branch"
            ),
            Decision::Allow
        );
        assert_eq!(
            owner_shell_decision(
                Authority::Owner,
                "npm install",
                "Fix and verify the workspace"
            ),
            Decision::Allow
        );
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
        assert_eq!(contract.pause_if, "no HII permission prompts");
    }
}
