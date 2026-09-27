//! The single completion assessment.
//!
//! Before this, "completed" was decided independently in three places — the
//! agent loop, the daemon, and the frontend — with three different rules. A run
//! could be completed on one surface and failed on another, and the weakest rule
//! won wherever it was consulted first.
//!
//! There is now one assessment. It is computed here, persisted in the receipt,
//! and consumed by everything downstream. A surface may present the assessment;
//! it may not invent its own.
//!
//! The standard it applies: a run is completed only when its declared outcome
//! requirements are actually satisfied. A final summary is a claim, a passing
//! check is evidence about one command, and an artifact that appeared is not
//! proof that the requested artifact exists.

use crate::contract::{ArtifactRequirement, OutcomeRequirements};
use crate::receipt::VerificationRecord;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// What the assessment could actually stand on.
///
/// `declared` means the contract named checks or artifacts and they were met.
/// `incidental` means nothing was declared and the only evidence is a tool call
/// the model chose, which happened to exit zero. That is the standard every
/// pre-requirements run was held to, so it stays completable — but it is
/// labelled, so no consumer can read it as stronger than it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProofStrength {
    Declared,
    Incidental,
    None,
}

impl ProofStrength {
    pub fn label(self) -> &'static str {
        match self {
            ProofStrength::Declared => "declared",
            ProofStrength::Incidental => "incidental",
            ProofStrength::None => "none",
        }
    }

    /// Whether this strength may unlock high-trust behaviour: capability and
    /// skill promotion, verified workflows, VERIFIED_BY relations, trusted
    /// generated provenance, automatic external effects, and any label that says
    /// "verified".
    ///
    /// `incidental` and `none` are not weaker verification — they mean nothing
    /// was declared, so there is no claim that was satisfied.
    pub fn qualifies_for_high_trust(self) -> bool {
        matches!(self, ProofStrength::Declared)
    }
}

/// What was found at a required artifact path. Recorded whether or not it
/// satisfied the requirement, so a failure says what was actually there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEvidence {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub bytes: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// The structured verdict persisted in the receipt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionAssessment {
    pub version: u8,
    pub satisfied: bool,
    pub proof_strength: ProofStrength,
    #[serde(default)]
    pub outcome_kind: Option<String>,
    #[serde(default)]
    pub unmet_requirements: Vec<String>,
    #[serde(default)]
    pub failed_checks: Vec<String>,
    #[serde(default)]
    pub missing_artifacts: Vec<String>,
    #[serde(default)]
    pub invalid_artifacts: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<ArtifactEvidence>,
}

impl CompletionAssessment {
    /// A run that was interrupted, cancelled, or failed to execute. Kept as a
    /// constructor so no caller has to hand-build an "unsatisfied" verdict and
    /// accidentally leave `satisfied` true.
    pub fn terminated(reason: &str) -> Self {
        CompletionAssessment {
            version: 1,
            satisfied: false,
            proof_strength: ProofStrength::None,
            outcome_kind: None,
            unmet_requirements: vec![reason.to_string()],
            failed_checks: Vec::new(),
            missing_artifacts: Vec::new(),
            invalid_artifacts: Vec::new(),
            warnings: Vec::new(),
            evidence: Vec::new(),
        }
    }

    /// The single gate for high-trust behaviour: the declared outcome was met
    /// *and* something was actually declared for it to meet.
    pub fn qualifies_for_high_trust(&self) -> bool {
        self.satisfied && self.proof_strength.qualifies_for_high_trust()
    }
}

/// Everything the assessment is allowed to look at.
pub struct CompletionInput<'a> {
    pub workspace: &'a Path,
    pub requirements: Option<&'a OutcomeRequirements>,
    /// The model's final summary, if it produced one.
    pub final_summary: Option<&'a str>,
    /// Checks the contract declared up front.
    pub declared_checks: &'a [String],
    /// Every verification record captured during the run.
    pub verification: &'a [VerificationRecord],
    /// Paths the run touched or that git reports changed, workspace-relative.
    pub artifacts: &'a [String],
    /// Set when the run ended for a reason that is not "the work finished".
    pub terminated: Option<&'a str>,
}

pub fn assess(input: CompletionInput<'_>) -> CompletionAssessment {
    if let Some(reason) = input.terminated {
        return CompletionAssessment::terminated(reason);
    }

    let mut unmet: Vec<String> = Vec::new();
    let mut failed_checks: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut evidence: Vec<ArtifactEvidence> = Vec::new();

    let has_final = input
        .final_summary
        .map(|summary| !summary.trim().is_empty())
        .unwrap_or(false);
    if !has_final {
        unmet.push("The run ended without a final response.".into());
    }

    // A declared check is satisfied only by a record for that exact command
    // whose process succeeded. A different command exiting zero is evidence
    // about that other command, not about this requirement.
    for command in input.declared_checks {
        let record = input
            .verification
            .iter()
            .rev()
            .find(|entry| entry.command == *command);
        match record {
            Some(entry) if entry.ok => {}
            Some(_) => failed_checks.push(command.clone()),
            None => {
                failed_checks.push(command.clone());
                warnings.push(format!("Declared check never ran: {command}"));
            }
        }
    }
    if !failed_checks.is_empty() {
        unmet.push("Declared verification did not pass.".into());
    }

    let requirements = input.requirements;
    let outcome_kind = requirements.map(|value| value.kind.label().to_string());

    if let Some(requirements) = requirements {
        if requirements.declared_checks_required && input.declared_checks.is_empty() {
            unmet.push(
                "The contract declares an outcome but no verification check, so nothing would \
                 have proven it."
                    .into(),
            );
        }
        for requirement in &requirements.artifacts {
            evaluate_artifact(
                input.workspace,
                requirement,
                input.artifacts,
                &mut missing,
                &mut invalid,
                &mut evidence,
            );
        }
        if !missing.is_empty() {
            unmet.push("Required artifacts were not produced.".into());
        }
        if !invalid.is_empty() {
            unmet.push("Required artifacts did not satisfy their declared requirements.".into());
        }
    }

    // Proof strength describes the evidence, not the verdict.
    //
    // A declared check only counts if it could have failed. Without this floor,
    // `--verify true` mints a declared proof, and since declared proof is what
    // promotes a skill to verified, the entire competence standard becomes
    // satisfiable by typing a word that does nothing.
    let substantive_checks = input
        .declared_checks
        .iter()
        .any(|check| !crate::declaration::is_vacuous(check));
    let declared_evidence = requirements.is_some_and(|requirements| {
        requirements.declared_checks_required || !requirements.artifacts.is_empty()
    });
    let proof_strength = if declared_evidence || substantive_checks {
        ProofStrength::Declared
    } else if input.verification.iter().any(|entry| entry.ok) {
        ProofStrength::Incidental
    } else {
        ProofStrength::None
    };

    if proof_strength == ProofStrength::Incidental {
        warnings.push(
            "No outcome or check was declared. Completion rests on a tool call the model chose \
             that exited zero, which is not proof the goal was met."
                .into(),
        );
        if !input.declared_checks.is_empty() {
            warnings.push(
                "Every declared check was a command that cannot fail, so nothing was actually \
                 claimed. Declare a check that would fail if the goal were not met."
                    .into(),
            );
        }
    }

    // Legacy floor: a contract that declared nothing still needs some passing
    // check, exactly as before requirements existed.
    if requirements.is_none()
        && input.declared_checks.is_empty()
        && !input.verification.iter().any(|entry| entry.ok)
    {
        unmet.push("No verification passed.".into());
    }

    CompletionAssessment {
        version: 1,
        satisfied: unmet.is_empty(),
        proof_strength,
        outcome_kind,
        unmet_requirements: unmet,
        failed_checks,
        missing_artifacts: missing,
        invalid_artifacts: invalid,
        warnings,
        evidence,
    }
}

/// Resolve a required path inside the approved root and check it against the
/// requirement. Anything that escapes the root is rejected outright rather than
/// counted.
fn evaluate_artifact(
    workspace: &Path,
    requirement: &ArtifactRequirement,
    inventory: &[String],
    missing: &mut Vec<String>,
    invalid: &mut Vec<String>,
    evidence: &mut Vec<ArtifactEvidence>,
) {
    let matches = resolve_matches(workspace, requirement, inventory);
    if matches.is_empty() {
        missing.push(requirement.path.clone());
        evidence.push(ArtifactEvidence {
            path: requirement.path.clone(),
            exists: false,
            is_file: false,
            bytes: 0,
            sha256: None,
        });
        return;
    }

    let mut satisfying = 0usize;
    // Candidates that were found but failed a specific check. Each one already
    // records a concrete reason in `missing`/`invalid`, so the shortfall it
    // causes must not be re-reported as a bare count below.
    let mut explained = 0usize;
    for relative in &matches {
        let absolute = workspace.join(relative);
        if !inside(workspace, &absolute) {
            invalid.push(format!(
                "{relative} resolves outside the approved workspace root"
            ));
            explained += 1;
            continue;
        }
        let metadata = fs::metadata(&absolute).ok();
        let exists = metadata.is_some();
        let is_file = metadata
            .as_ref()
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        let bytes = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let sha256 = is_file.then(|| digest_of(&absolute)).flatten();
        evidence.push(ArtifactEvidence {
            path: relative.clone(),
            exists,
            is_file,
            bytes,
            sha256: sha256.clone(),
        });

        if requirement.must_exist && !exists {
            missing.push(relative.clone());
            explained += 1;
            continue;
        }
        // A directory never satisfies a file requirement unless the contract
        // explicitly relaxed `must_be_file`.
        if requirement.must_be_file && !is_file {
            invalid.push(format!("{relative} is not a regular file"));
            explained += 1;
            continue;
        }
        if requirement.must_be_non_empty && bytes == 0 {
            invalid.push(format!("{relative} is empty"));
            explained += 1;
            continue;
        }
        if let Some(expected) = &requirement.extension {
            let actual = Path::new(relative)
                .extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if actual != expected.to_ascii_lowercase() {
                invalid.push(format!(
                    "{relative} has extension '{actual}', not '{expected}'"
                ));
                explained += 1;
                continue;
            }
        }
        if let Some(expected) = &requirement.expected_sha256 {
            match &sha256 {
                Some(actual) if actual == expected => {}
                Some(actual) => {
                    invalid.push(format!("{relative} hashes to {actual}, not {expected}"));
                    explained += 1;
                    continue;
                }
                None => {
                    invalid.push(format!("{relative} could not be hashed"));
                    explained += 1;
                    continue;
                }
            }
        }
        satisfying += 1;
    }

    // Only report a bare shortfall for candidates that never showed up at all.
    // A candidate that was found and then rejected is already reported with its
    // real reason, and calling it "missing" would claim a file that was just
    // hashed does not exist.
    let shortfall = requirement.min_count.saturating_sub(satisfying);
    if shortfall > explained {
        missing.push(format!(
            "{} (needed {}, found {satisfying})",
            requirement.path, requirement.min_count
        ));
    }
}

/// Candidate paths for one requirement, de-duplicated so the same file listed
/// twice in the inventory counts once.
fn resolve_matches(
    workspace: &Path,
    requirement: &ArtifactRequirement,
    inventory: &[String],
) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |value: String| {
        if !found.contains(&value) {
            found.push(value);
        }
    };

    if let Some(prefix) = requirement.path.strip_suffix('*') {
        for entry in inventory {
            if entry.starts_with(prefix) {
                push(entry.clone());
            }
        }
        return found;
    }

    // An exact path is checked on disk whether or not the inventory noticed it:
    // the requirement is about the file existing, not about git having seen it.
    if workspace.join(&requirement.path).exists() {
        push(requirement.path.clone());
    }
    for entry in inventory {
        if entry == &requirement.path {
            push(entry.clone());
        }
    }
    found
}

fn inside(root: &Path, candidate: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let resolved: PathBuf = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.to_path_buf());
    resolved.starts_with(&root)
}

fn digest_of(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let digest = ring::digest::digest(&ring::digest::SHA256, &bytes);
    Some(
        digest
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::OutcomeKind;
    use std::fs;

    fn workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hii-completion-{}", uuid()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The clock alone is not unique enough: these tests run in parallel and
    /// macOS reports coarser than nanosecond resolution, so two workspaces could
    /// collide and one test would see another's files.
    fn uuid() -> String {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!(
            "{:x}-{:x}-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    fn check(command: &str, ok: bool) -> VerificationRecord {
        VerificationRecord {
            command: command.into(),
            ok,
            output: String::new(),
        }
    }

    fn input<'a>(
        workspace: &'a Path,
        requirements: Option<&'a OutcomeRequirements>,
        declared: &'a [String],
        verification: &'a [VerificationRecord],
        artifacts: &'a [String],
    ) -> CompletionInput<'a> {
        CompletionInput {
            workspace,
            requirements,
            final_summary: Some("done"),
            declared_checks: declared,
            verification,
            artifacts,
            terminated: None,
        }
    }

    fn file_outcome(paths: &[&str]) -> OutcomeRequirements {
        OutcomeRequirements::build(
            OutcomeKind::FileArtifact,
            paths
                .iter()
                .map(|value| ArtifactRequirement::parse(value).unwrap())
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn informational_task_completes_without_an_artifact() {
        let dir = workspace();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements =
            OutcomeRequirements::build(OutcomeKind::Informational, Vec::new()).unwrap();
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &[],
        ));
        assert!(assessment.satisfied, "{assessment:?}");
        assert_eq!(assessment.proof_strength, ProofStrength::Declared);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn direct_answer_completes_without_becoming_verified_evidence() {
        let dir = workspace();
        let requirements = OutcomeRequirements::informational_response();
        let assessment = assess(input(&dir, Some(&requirements), &[], &[], &[]));
        assert!(assessment.satisfied, "{assessment:?}");
        assert_eq!(assessment.proof_strength, ProofStrength::None);
        assert!(!assessment.qualifies_for_high_trust());
        let _ = fs::remove_dir_all(dir);
    }

    /// A hash mismatch has one cause and must be reported once, with its real
    /// reason. Reporting it again as a bare shortfall told the operator the file
    /// was "missing" immediately after the same pass hashed it.
    #[test]
    fn rejected_artifact_is_not_also_reported_as_missing() {
        let dir = workspace();
        fs::write(dir.join("notes.md"), "hello\n").unwrap();
        let wrong = "0".repeat(64);
        let declared = vec!["test -f notes.md".to_string()];
        let verification = vec![check("test -f notes.md", true)];
        let requirements = file_outcome(&[&format!("notes.md@{wrong}")]);
        let artifacts = vec!["notes.md".to_string()];
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &artifacts,
        ));

        assert!(!assessment.satisfied, "{assessment:?}");
        assert!(
            assessment.missing_artifacts.is_empty(),
            "a hashed file must never be called missing: {assessment:?}"
        );
        assert_eq!(assessment.invalid_artifacts.len(), 1, "{assessment:?}");
        assert!(assessment.invalid_artifacts[0].contains("hashes to"));
        // The evidence still proves what was actually on disk.
        assert!(assessment.evidence[0].exists);
        assert!(assessment.evidence[0].sha256.is_some());
        let _ = fs::remove_dir_all(dir);
    }

    /// The suppression above is scoped to the shortfall a rejection explains. A
    /// requirement asking for two files that gets one rejected and one absent is
    /// still short by an unexplained file, so the count is still reported.
    #[test]
    fn unexplained_shortfall_is_still_reported() {
        let dir = workspace();
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::write(dir.join("out/a.md"), "").unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["out/a.md x2"]);
        let artifacts = vec!["out/a.md".to_string()];
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &artifacts,
        ));

        assert!(!assessment.satisfied, "{assessment:?}");
        // One candidate was found and rejected as empty; the second never
        // appeared at all, so the shortfall is real and must be stated.
        assert_eq!(assessment.invalid_artifacts.len(), 1, "{assessment:?}");
        assert_eq!(assessment.missing_artifacts.len(), 1, "{assessment:?}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn artifact_task_with_no_artifacts_does_not_complete() {
        let dir = workspace();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["out/report.md"]);
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &[],
        ));
        assert!(!assessment.satisfied);
        assert_eq!(assessment.missing_artifacts, vec!["out/report.md"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_required_file_does_not_complete() {
        let dir = workspace();
        fs::write(dir.join("report.md"), "").unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["report.md"]);
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &[],
        ));
        assert!(!assessment.satisfied);
        assert!(assessment.invalid_artifacts[0].contains("empty"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn valid_required_artifact_completes_and_is_hashed() {
        let dir = workspace();
        fs::write(dir.join("report.md"), "real content").unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["report.md"]);
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &["report.md".to_string()],
        ));
        assert!(assessment.satisfied, "{assessment:?}");
        assert_eq!(assessment.evidence.len(), 1);
        assert!(assessment.evidence[0].sha256.is_some());
        assert_eq!(assessment.evidence[0].bytes, 12);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn directory_does_not_satisfy_a_file_requirement() {
        let dir = workspace();
        fs::create_dir_all(dir.join("report.md")).unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["report.md"]);
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &[],
        ));
        assert!(!assessment.satisfied);
        assert!(assessment.invalid_artifacts[0].contains("not a regular file"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn duplicate_inventory_entries_count_once() {
        let dir = workspace();
        fs::write(dir.join("a.md"), "x").unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["out*x2"]);
        let inventory = vec!["out-a".to_string(), "out-a".to_string()];
        fs::write(dir.join("out-a"), "x").unwrap();
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &inventory,
        ));
        assert!(
            !assessment.satisfied,
            "one file cannot satisfy a count of 2"
        );
        assert_eq!(assessment.evidence.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extension_mismatch_does_not_complete() {
        let dir = workspace();
        fs::write(dir.join("report.txt"), "x").unwrap();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", true)];
        let requirements = file_outcome(&["report.txt:md"]);
        let assessment = assess(input(
            &dir,
            Some(&requirements),
            &declared,
            &verification,
            &[],
        ));
        assert!(!assessment.satisfied);
        assert!(assessment.invalid_artifacts[0].contains("extension"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_required_artifact_may_not_escape_the_workspace() {
        assert!(ArtifactRequirement::parse("../outside.md").is_err());
        assert!(ArtifactRequirement::parse("/etc/passwd").is_err());
    }

    #[test]
    fn a_failing_declared_check_blocks_completion() {
        let dir = workspace();
        let declared = vec!["cargo test".to_string()];
        let verification = vec![check("cargo test", false)];
        let assessment = assess(input(&dir, None, &declared, &verification, &[]));
        assert!(!assessment.satisfied);
        assert_eq!(assessment.failed_checks, vec!["cargo test"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn declared_check_uses_the_latest_attempt_after_recovery_or_regression() {
        let dir = workspace();
        let declared = vec!["cargo test".to_string()];
        let recovered = vec![check("cargo test", false), check("cargo test", true)];
        let assessment = assess(input(&dir, None, &declared, &recovered, &[]));
        assert!(assessment.satisfied, "{assessment:?}");
        let regressed = vec![check("cargo test", true), check("cargo test", false)];
        let assessment = assess(input(&dir, None, &declared, &regressed, &[]));
        assert!(!assessment.satisfied);
        assert_eq!(assessment.failed_checks, declared);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_declared_check_that_never_ran_is_not_satisfied_by_another_one() {
        let dir = workspace();
        let declared = vec!["cargo test".to_string()];
        // A different command exiting zero says nothing about the declared one.
        let verification = vec![check("ls", true)];
        let assessment = assess(input(&dir, None, &declared, &verification, &[]));
        assert!(!assessment.satisfied);
        assert!(assessment.warnings.iter().any(|w| w.contains("never ran")));
        let _ = fs::remove_dir_all(dir);
    }

    /// Receipt 19fcb7de23b-721e: a notification goal that notified nothing,
    /// closed as completed because one model-chosen command exited zero while
    /// its own output reported a configuration-load failure.
    #[test]
    fn the_reproduced_configuration_load_false_positive_no_longer_completes() {
        let dir = workspace();
        let verification = vec![VerificationRecord {
            command: "cd /Users/ummi/hii && npx svelte-check --tsconfig tsconfig.json".into(),
            ok: true,
            output: "svelte-check found 0 errors and 0 warnings\nError while loading config at /Users/ummi/hii/runtime/workstation/vite.config.ts".into(),
        }];
        let requirements = file_outcome(&["notified.txt"]);
        let assessment = assess(input(&dir, Some(&requirements), &[], &verification, &[]));

        assert!(!assessment.satisfied);
        // It fails for the real reason: nothing was declared to prove the goal,
        // and the declared outcome was never produced.
        assert!(assessment
            .unmet_requirements
            .iter()
            .any(|reason| reason.contains("no verification check")));
        assert_eq!(assessment.missing_artifacts, vec!["notified.txt"]);
        let _ = fs::remove_dir_all(dir);
    }

    /// The same run under a legacy contract stays completable, but its evidence
    /// is labelled for what it is.
    #[test]
    fn a_legacy_contract_without_requirements_stays_compatible_but_labelled() {
        let dir = workspace();
        let verification = vec![check("npx svelte-check", true)];
        let assessment = assess(input(&dir, None, &[], &verification, &[]));
        assert!(assessment.satisfied);
        assert_eq!(assessment.proof_strength, ProofStrength::Incidental);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("not proof")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_legacy_contract_with_no_passing_check_does_not_complete() {
        let dir = workspace();
        let assessment = assess(input(&dir, None, &[], &[], &[]));
        assert!(!assessment.satisfied);
        assert_eq!(assessment.proof_strength, ProofStrength::None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_without_a_final_response_does_not_complete() {
        let dir = workspace();
        let verification = vec![check("cargo test", true)];
        let mut candidate = input(&dir, None, &[], &verification, &[]);
        candidate.final_summary = None;
        let assessment = assess(candidate);
        assert!(!assessment.satisfied);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_interrupted_run_can_never_be_completed() {
        let dir = workspace();
        let verification = vec![check("cargo test", true)];
        let mut candidate = input(&dir, None, &[], &verification, &[]);
        candidate.terminated = Some("Interrupted by operator");
        let assessment = assess(candidate);
        assert!(!assessment.satisfied);
        assert_eq!(assessment.proof_strength, ProofStrength::None);
        let _ = fs::remove_dir_all(dir);
    }

    /// The gate that keeps the promotion standard from being free.
    #[test]
    fn a_check_that_cannot_fail_does_not_confer_declared_proof() {
        let declared = vec!["true".to_string()];
        let assessment = assess(CompletionInput {
            workspace: Path::new("."),
            requirements: None,
            final_summary: Some("done"),
            declared_checks: &declared,
            verification: &[check("true", true)],
            artifacts: &[],
            terminated: None,
        });
        assert_ne!(
            assessment.proof_strength,
            ProofStrength::Declared,
            "`--verify true` must not mint a declared proof"
        );
        assert!(!assessment.qualifies_for_high_trust());
    }

    #[test]
    fn a_real_check_still_confers_declared_proof() {
        let declared = vec!["cargo test".to_string()];
        let assessment = assess(CompletionInput {
            workspace: Path::new("."),
            requirements: None,
            final_summary: Some("done"),
            declared_checks: &declared,
            verification: &[check("cargo test", true)],
            artifacts: &[],
            terminated: None,
        });
        assert_eq!(assessment.proof_strength, ProofStrength::Declared);
    }

    #[test]
    fn workspace_object_outcomes_are_refused_rather_than_faked() {
        let error = OutcomeRequirements::build(OutcomeKind::WorkspaceObject, Vec::new())
            .expect_err("must refuse");
        assert!(error.contains("not supported yet"));
    }
}
