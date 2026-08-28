use crate::{config::AppPaths, ollama::Message, receipt::Receipt};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::Path, process::Command};

/// Longest generated skill id. Bounds a filesystem-visible name derived from a goal.
const SKILL_ID_MAX: usize = 63;

#[derive(Debug, Deserialize)]
pub struct SkillCandidate {
    pub repeatable: bool,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

pub fn candidate_messages(
    goal: &str,
    summary: &str,
    checks: &[String],
    context: &str,
    active_sessions: &str,
) -> Vec<Message> {
    vec![
        Message::system(
            "You identify reusable, verified local workflows for HII. Be conservative. A workflow is repeatable only when the conversation demonstrates a concrete procedure with successful verification that would predictably help again. Greetings, one-off facts, speculative ideas, failed work, and generic coding are not skills. Return exactly one JSON object with repeatable (boolean), id, name, and description (strings), with no Markdown. Return lowercase kebab-case ids under 64 characters. Descriptions must say what the skill does and when to use it. Never propose registration or new permissions.",
        ),
        Message::user(format!(
            "Goal:\n{goal}\n\nOutcome:\n{summary}\n\nVerified checks:\n{}\n\nConversation context:\n{}\n\nActive HII sessions:\n{}",
            checks.join("\n"),
            crate::text::clip_hard(context, 12_000),
            crate::text::clip_hard(active_sessions, 4_000)
        )),
    ]
}

pub fn parse_candidate(raw: &str) -> Result<SkillCandidate, String> {
    let json = raw
        .find('{')
        .and_then(|start| raw.rfind('}').map(|end| &raw[start..=end]))
        .unwrap_or(raw);
    let mut candidate: SkillCandidate =
        serde_json::from_str(json).map_err(|error| format!("invalid skill analysis: {error}"))?;
    candidate.id = crate::text::slug(&candidate.id, SKILL_ID_MAX);
    candidate.name = candidate.name.trim().chars().take(160).collect();
    candidate.description = candidate.description.trim().chars().take(1_000).collect();
    if candidate.repeatable
        && (candidate.id.is_empty()
            || candidate.name.is_empty()
            || candidate.description.is_empty())
    {
        return Err("repeatable skill analysis was incomplete".into());
    }
    Ok(candidate)
}

pub fn honor_explicit_request(
    mut candidate: SkillCandidate,
    goal: &str,
    summary: &str,
) -> SkillCandidate {
    candidate.repeatable = true;
    if candidate.id.is_empty() {
        candidate.id = crate::text::slug(
            &goal
                .split_whitespace()
                .filter(|word| word.chars().any(char::is_alphanumeric))
                .take(7)
                .collect::<Vec<_>>()
                .join(" "),
            SKILL_ID_MAX,
        );
    }
    if candidate.name.is_empty() {
        candidate.name = candidate
            .id
            .split('-')
            .map(|word| {
                let mut chars = word.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    if candidate.description.is_empty() {
        candidate.description = format!(
            "Use when repeating this verified HII workflow: {}",
            summary.trim()
        )
        .chars()
        .take(1_000)
        .collect();
    }
    candidate
}

pub fn explicit_candidate(goal: &str, summary: &str) -> SkillCandidate {
    honor_explicit_request(
        SkillCandidate {
            repeatable: false,
            id: String::new(),
            name: String::new(),
            description: String::new(),
        },
        goal,
        summary,
    )
}

/// Why this receipt may not be promoted to a skill, if it may not.
///
/// A draft written with `--verification verified` is a durable claim that this
/// workflow is proven. Only a satisfied assessment with declared proof supports
/// that claim; `incidental` means nothing was declared, and a receipt with no
/// assessment predates declared outcomes entirely.
pub fn promotion_refusal(receipt: &Receipt) -> Option<String> {
    match receipt.completion.as_ref() {
        Some(completion) if completion.qualifies_for_high_trust() => None,
        Some(completion) if !completion.satisfied => Some(format!(
            "This run did not meet its declared outcome, so it cannot become a verified skill. {}",
            completion.unmet_requirements.join(" ")
        )),
        Some(completion) => Some(format!(
            "This run's proof is {}, not declared. Nothing was declared for it to prove, so it cannot become a verified skill.",
            completion.proof_strength.label()
        )),
        None => Some(
            "This receipt predates declared outcomes, so its proof is legacy and unclassified. It cannot become a verified skill."
                .to_string(),
        ),
    }
}

pub fn report_draft(
    paths: &AppPaths,
    receipt: &Receipt,
    receipt_path: &Path,
    candidate: &SkillCandidate,
    session_id: &str,
) -> Result<String, String> {
    if let Some(refusal) = promotion_refusal(receipt) {
        return Err(refusal);
    }
    let checks = receipt
        .verification
        .iter()
        .filter(|item| item.ok)
        .map(|item| item.command.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let output = Command::new("node")
        .arg(paths.repo.join("scripts/hii-cli.mjs"))
        .env("HII_RUNTIME_DIR", &paths.runtime)
        .args([
            "skill",
            "report",
            "--agent",
            "hii-rust-cli",
            "--agent-kind",
            "local-ollama",
            "--model",
            &receipt.model,
            "--session",
            session_id,
            "--project",
            "hii",
            "--coordinate",
            &receipt.workspace,
            "--intent",
            &receipt.goal,
            "--summary",
            &receipt.summary,
            "--actions",
            "Completed a verified conversational workspace workflow.",
            "--commands",
            &checks,
            "--capabilities",
            "hii.agent.workspace_run",
            "--outcome",
            "completed",
            "--verification",
            "verified",
            "--checks",
            &checks,
            "--proof",
            receipt_path.to_str().unwrap_or(""),
            "--risk",
            "change",
            "--permissions",
            "bounded local workspace",
            "--side-effects",
            "workspace-local changes and append-only HII receipts",
            "--repeatable",
            "--skill-id",
            &candidate.id,
            "--skill-name",
            &candidate.name,
            "--skill-description",
            &candidate.description,
        ])
        .current_dir(&paths.repo)
        .output()
        .map_err(|error| format!("could not create skill draft: {error}"))?;
    if output.status.success() {
        Ok(candidate.id.clone())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub fn list(paths: &AppPaths) -> Result<String, String> {
    let proposed = paths.runtime.join("skills/proposed");
    let mut rows = Vec::new();
    if proposed.is_dir() {
        for entry in fs::read_dir(&proposed)
            .map_err(|error| error.to_string())?
            .flatten()
        {
            if !entry.path().is_dir() {
                continue;
            }
            let manifest = entry.path().join("manifest.json");
            let value: Value = fs::read(&manifest)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or(Value::Null);
            let fallback_id = entry.file_name().to_string_lossy().to_string();
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(&fallback_id);
            let observations = value
                .get("observations")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let description = value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            rows.push(format!(
                "{id}  draft · {observations} proof(s)  {description}"
            ));
        }
    }
    rows.sort();
    Ok(if rows.is_empty() {
        "No skill drafts yet.".into()
    } else {
        rows.join("\n")
    })
}

pub fn active_sessions(paths: &AppPaths) -> String {
    let file = paths.runtime.join("daemon/instances.json");
    let value: Value = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    value
        .get("instances")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(30)
        .map(|item| {
            format!(
                "{} {} {}",
                item.get("id").and_then(Value::as_str).unwrap_or("agent"),
                item.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("observed"),
                item.get("title").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::completion::{CompletionAssessment, ProofStrength};

    fn receipt_with(completion: Option<CompletionAssessment>) -> Receipt {
        Receipt {
            schema_version: 6,
            id: "r1".into(),
            created_at_unix_ms: 0,
            finished_at_unix_ms: 0,
            status: "completed".into(),
            goal: "g".into(),
            workspace: "/tmp".into(),
            model: "m".into(),
            review_model: None,
            steps: 1,
            summary: "s".into(),
            verification: Vec::new(),
            git_status: String::new(),
            next: None,
            review: None,
            risk: "change".into(),
            authority: None,
            done_when: None,
            approvals: Vec::new(),
            artifacts: Vec::new(),
            reversible: None,
            context_sources: Vec::new(),
            preexisting_changes: Vec::new(),
            hooks: Vec::new(),
            outcome: "completed".into(),
            exit_code: 0,
            completion,
            model_source: None,
            autonomy_level: None,
            learning_candidates: Vec::new(),
            user_corrections: Vec::new(),
            failure_patterns: Vec::new(),
            skill_draft_ref: None,
            token_usage: None,
        }
    }

    fn assessment(satisfied: bool, proof_strength: ProofStrength) -> CompletionAssessment {
        CompletionAssessment {
            version: 1,
            satisfied,
            proof_strength,
            outcome_kind: None,
            unmet_requirements: Vec::new(),
            failed_checks: Vec::new(),
            missing_artifacts: Vec::new(),
            invalid_artifacts: Vec::new(),
            warnings: Vec::new(),
            evidence: Vec::new(),
        }
    }

    #[test]
    fn sanitizes_skill_ids() {
        let item = parse_candidate(r#"{"repeatable":true,"id":"Build HII!!!","name":"Build HII","description":"Use when building HII."}"#).unwrap();
        assert_eq!(item.id, "build-hii");
    }

    #[test]
    fn only_declared_satisfied_proof_may_become_a_verified_skill() {
        assert!(promotion_refusal(&receipt_with(Some(assessment(
            true,
            ProofStrength::Declared
        ))))
        .is_none());

        let incidental = promotion_refusal(&receipt_with(Some(assessment(
            true,
            ProofStrength::Incidental,
        ))))
        .expect("incidental proof must be refused");
        assert!(incidental.contains("incidental"), "{incidental}");

        let none = promotion_refusal(&receipt_with(Some(assessment(true, ProofStrength::None))))
            .expect("no proof must be refused");
        assert!(none.contains("none"), "{none}");

        let unsatisfied = promotion_refusal(&receipt_with(Some(assessment(
            false,
            ProofStrength::Declared,
        ))))
        .expect("an unsatisfied run must be refused");
        assert!(unsatisfied.contains("declared outcome"), "{unsatisfied}");

        // A receipt written before assessments existed carries legacy proof.
        let legacy = promotion_refusal(&receipt_with(None)).expect("legacy proof must be refused");
        assert!(legacy.contains("legacy"), "{legacy}");
    }
}
