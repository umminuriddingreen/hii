//! The single skill-learning lifecycle.
//!
//! Skill competence was previously recorded in three unrelated places that
//! never agreed: draft manifests under `~/.hii/skills/proposed/*` counted
//! "observations", `~/.hii/learning/records.jsonl` appended unapproved
//! candidates, and `~/.hii/skills/*.json` held hand-registered skills with no
//! evidence at all. Nothing consumed any of it, so 117 drafts accumulated at
//! one observation each and none ever advanced.
//!
//! This module defines one canonical representation projected from all three.
//! The old stores are read, never written and never deleted — they remain the
//! source of truth for their own history, and this is the view derived from
//! them.
//!
//! # What a state means
//!
//! - `Proposed`  — something suggested this workflow is reusable. No evidence.
//! - `Observed`  — it ran and succeeded, but nothing was declared up front, so
//!                 there is no satisfied claim behind the success.
//! - `Verified`  — at least one run declared an outcome and met it.
//! - `Trusted`   — repeatedly verified, with no recent failures.
//! - `Rejected`  — a human said no. Only a human clears this.
//!
//! # Competence is not authority
//!
//! A `Trusted` skill is one HII expects to work. It is *not* a skill allowed to
//! act. Nothing here grants permission, widens an authority envelope, or is
//! consulted when deciding whether an action may run — that stays with the
//! authority envelope and `governance`. A skill can be fully trusted and still
//! require approval for every side effect it has.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::config::AppPaths;
use crate::receipt::Receipt;

/// Verified runs needed before a skill is trusted. Two is deliberate: one
/// verified run proves the workflow can work, a second proves the first was not
/// a coincidence of that particular workspace.
const TRUST_THRESHOLD: u32 = 3;

/// Confidence below which an earned state degrades. Failures are what move a
/// skill across this line.
const DEGRADE_BELOW: f32 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillState {
    Rejected,
    Proposed,
    Observed,
    Verified,
    Trusted,
}

impl SkillState {
    pub fn label(self) -> &'static str {
        match self {
            SkillState::Rejected => "rejected",
            SkillState::Proposed => "proposed",
            SkillState::Observed => "observed",
            SkillState::Verified => "verified",
            SkillState::Trusted => "trusted",
        }
    }

    /// Whether a skill in this state should surface as a usable capability.
    pub fn is_promoted(self) -> bool {
        matches!(self, SkillState::Verified | SkillState::Trusted)
    }
}

/// What a single observed run actually established.
///
/// `Inconclusive` is a distinct outcome rather than a failed one on purpose: a
/// draft citing a receipt that no longer exists proves nothing, and scoring
/// that as a failure would invent a history of breakage for workflows nobody
/// ever ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Met a declared outcome. The only outcome that can promote a skill.
    Verified,
    /// Ran and did not fail, but proved no declared claim.
    Succeeded,
    Failed,
    Inconclusive,
}

/// One execution HII observed, and what its receipt actually proved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub receipt_id: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverrideKind {
    Promoted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanOverride {
    pub kind: OverrideKind,
    pub reason: String,
    pub at_unix_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub state: SkillState,
    /// Which legacy stores this was projected from, so a record can always be
    /// traced back rather than appearing to come from nowhere.
    #[serde(default)]
    pub origins: Vec<String>,
    #[serde(default)]
    pub observations: Vec<Observation>,
    #[serde(default)]
    pub verified_count: u32,
    #[serde(default)]
    pub success_count: u32,
    #[serde(default)]
    pub failure_count: u32,
    /// 0.0–1.0. Competence only; says nothing about what the skill may do.
    #[serde(default)]
    pub confidence: f32,
    #[serde(default)]
    pub human_override: Option<HumanOverride>,
}

impl SkillRecord {
    fn new(id: String, name: String, description: String, origin: &str) -> Self {
        SkillRecord {
            id,
            name,
            description,
            state: SkillState::Proposed,
            origins: vec![origin.to_string()],
            observations: Vec::new(),
            verified_count: 0,
            success_count: 0,
            failure_count: 0,
            confidence: 0.0,
            human_override: None,
        }
    }

    /// Recompute counters, confidence, and state from the observation history.
    ///
    /// State is always derived, never assigned: a record cannot drift into a
    /// state its own evidence does not support.
    pub fn recompute(&mut self) {
        let count = |wanted: Outcome| {
            self.observations
                .iter()
                .filter(|observation| observation.outcome == wanted)
                .count() as u32
        };
        self.verified_count = count(Outcome::Verified);
        self.success_count = count(Outcome::Succeeded);
        self.failure_count = count(Outcome::Failed);
        // Inconclusive observations are deliberately counted nowhere: they are
        // recorded for audit but must not move a skill in either direction.

        let credit = self.verified_count as f32 + (self.success_count as f32 * 0.25);
        let total = credit + self.failure_count as f32;
        self.confidence = if total <= 0.0 { 0.0 } else { credit / total };

        // A human verdict outranks derived evidence in both directions, and is
        // recorded separately so an earned state is never confused for a
        // granted one.
        if let Some(decision) = &self.human_override {
            self.state = match decision.kind {
                OverrideKind::Rejected => SkillState::Rejected,
                OverrideKind::Promoted => SkillState::Verified,
            };
            return;
        }

        // Promotion depends on verified executions. Observation count alone
        // never promotes: that is exactly how 117 one-observation drafts would
        // have silently become skills.
        let earned = if self.verified_count >= TRUST_THRESHOLD {
            SkillState::Trusted
        } else if self.verified_count >= 1 {
            SkillState::Verified
        } else if self.success_count >= 1 {
            SkillState::Observed
        } else {
            SkillState::Proposed
        };

        // Failures degrade. A skill that has started failing loses a step of
        // standing rather than holding a claim its recent history contradicts.
        self.state = if self.failure_count > 0 && self.confidence < DEGRADE_BELOW {
            match earned {
                SkillState::Trusted => SkillState::Verified,
                SkillState::Verified => SkillState::Observed,
                other => other,
            }
        } else {
            earned
        };
    }

    fn observe(&mut self, observation: Observation) {
        if self
            .observations
            .iter()
            .any(|existing| existing.receipt_id == observation.receipt_id)
        {
            return;
        }
        self.observations.push(observation);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    #[serde(default = "schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub skills: BTreeMap<String, SkillRecord>,
}

fn schema_version() -> u8 {
    1
}

pub fn store_path(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("skills/lifecycle.json")
}

pub fn load(paths: &AppPaths) -> Lifecycle {
    let path = store_path(paths);
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| Lifecycle {
            schema_version: schema_version(),
            skills: BTreeMap::new(),
        })
}

pub fn save(paths: &AppPaths, lifecycle: &Lifecycle) -> Result<(), String> {
    let path = store_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(lifecycle).map_err(|error| error.to_string())?;
    // Write-then-rename: a lifecycle truncated by a crash would silently reset
    // every skill's standing to proposed.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, raw).map_err(|error| error.to_string())?;
    fs::rename(&temp, &path).map_err(|error| error.to_string())
}

/// Project the legacy stores into the canonical lifecycle.
///
/// Idempotent and additive: it never lowers a record below what its evidence
/// supports, never deletes a source store, and never invents a verified run.
/// Existing human overrides survive re-migration.
pub fn migrate(paths: &AppPaths) -> Lifecycle {
    let mut lifecycle = load(paths);
    let runtime = &paths.runtime;

    project_registered(&mut lifecycle, &runtime.join("skills"));
    project_drafts(paths, &mut lifecycle, &runtime.join("skills/proposed"));
    project_learning(&mut lifecycle, &runtime.join("learning/records.jsonl"));

    for record in lifecycle.skills.values_mut() {
        record.recompute();
    }
    lifecycle
}

/// Hand-registered skills in `~/.hii/skills/*.json`. A human wrote these into
/// the registry deliberately, which is itself an explicit promotion — recorded
/// as an override so it is never mistaken for evidence HII gathered.
fn project_registered(lifecycle: &mut Lifecycle, dir: &Path) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for file in read.flatten() {
        let path = file.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('_') || name == "lifecycle.json" {
            continue;
        }
        let Some(value) = read_json(&path) else {
            continue;
        };
        let Some(id) = string(&value, "id") else {
            continue;
        };
        let record = lifecycle.skills.entry(id.clone()).or_insert_with(|| {
            SkillRecord::new(
                id.clone(),
                string(&value, "name").unwrap_or_else(|| id.clone()),
                string(&value, "description").unwrap_or_default(),
                "registry",
            )
        });
        remember_origin(record, "registry");
        if record.human_override.is_none() {
            record.human_override = Some(HumanOverride {
                kind: OverrideKind::Promoted,
                reason: "registered in the HII skills registry by a human".into(),
                at_unix_ms: 0,
            });
        }
    }
}

/// Draft manifests. A draft's `observations` field counts how many times a
/// *draft was written*, not how many times the workflow was verified — so it
/// contributes no credit. Only the receipts it cites can promote it, and only
/// if those receipts actually qualify.
fn project_drafts(paths: &AppPaths, lifecycle: &mut Lifecycle, dir: &Path) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for file in read.flatten() {
        let manifest = file.path().join("manifest.json");
        let Some(value) = read_json(&manifest) else {
            continue;
        };
        let fallback = file.file_name().to_string_lossy().to_string();
        let id = string(&value, "id").unwrap_or(fallback);
        let record = lifecycle.skills.entry(id.clone()).or_insert_with(|| {
            SkillRecord::new(
                id.clone(),
                string(&value, "name").unwrap_or_else(|| id.clone()),
                string(&value, "description").unwrap_or_default(),
                "draft",
            )
        });
        remember_origin(record, "draft");
        for receipt_id in string_array(&value, "sourceReceiptIds") {
            let observation = observe_receipt(paths, &receipt_id);
            record.observe(observation);
        }
    }
}

/// Learning candidates. These already carry an `approved` flag that nothing
/// ever set, and cite the receipt they came from.
fn project_learning(lifecycle: &mut Lifecycle, path: &Path) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(id) = string(&value, "id") else {
            continue;
        };
        let record = lifecycle.skills.entry(id.clone()).or_insert_with(|| {
            SkillRecord::new(
                id.clone(),
                string(&value, "summary").unwrap_or_else(|| id.clone()),
                string(&value, "summary").unwrap_or_default(),
                "learning",
            )
        });
        remember_origin(record, "learning");
        // `approved` was never wired to anything; treat it as a human promotion
        // only when actually true, and let evidence speak otherwise.
        if value.get("approved").and_then(Value::as_bool) == Some(true)
            && record.human_override.is_none()
        {
            record.human_override = Some(HumanOverride {
                kind: OverrideKind::Promoted,
                reason: "approved in the legacy learning store".into(),
                at_unix_ms: 0,
            });
        }
    }
}

/// Read what a receipt actually proved. A receipt that is missing, unreadable,
/// or predates completion assessments proves nothing — it must not count as
/// either a success or a failure, or migration would fabricate history.
fn observe_receipt(paths: &AppPaths, receipt_id: &str) -> Observation {
    let path = paths
        .runtime
        .join("runs")
        .join("cli")
        .join(receipt_id)
        .join("receipt.json");
    let Some(receipt) = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Receipt>(&bytes).ok())
    else {
        return Observation {
            receipt_id: receipt_id.to_string(),
            outcome: Outcome::Inconclusive,
            note: "receipt unavailable; counts as neither success nor failure".into(),
        };
    };
    observation_from_receipt(&receipt)
}

/// The one place a receipt becomes evidence, so the promotion standard cannot
/// diverge between migration and live recording.
pub fn observation_from_receipt(receipt: &Receipt) -> Observation {
    let unsatisfied = receipt
        .completion
        .as_ref()
        .is_some_and(|completion| !completion.satisfied);
    let (outcome, note) = if receipt
        .completion
        .as_ref()
        .is_some_and(|completion| completion.qualifies_for_high_trust())
    {
        (Outcome::Verified, "declared outcome satisfied")
    } else if receipt.status == "failed" || unsatisfied {
        (Outcome::Failed, "run did not meet its declared outcome")
    } else if receipt.status == "completed" {
        (Outcome::Succeeded, "ran without declared proof")
    } else {
        // Cancelled, interrupted, or still running: the workflow was never
        // given a chance to prove or disprove itself.
        (
            Outcome::Inconclusive,
            "run did not reach a conclusive outcome",
        )
    };
    Observation {
        receipt_id: receipt.id.clone(),
        outcome,
        note: note.into(),
    }
}

/// Record a live execution against a skill and persist the new standing.
pub fn record_execution(
    paths: &AppPaths,
    skill_id: &str,
    receipt: &Receipt,
) -> Result<SkillState, String> {
    let mut lifecycle = load(paths);
    let record = lifecycle
        .skills
        .entry(skill_id.to_string())
        .or_insert_with(|| {
            SkillRecord::new(skill_id.to_string(), skill_id.to_string(), String::new(), "execution")
        });
    record.observe(observation_from_receipt(receipt));
    record.recompute();
    let state = record.state;
    save(paths, &lifecycle)?;
    Ok(state)
}

pub fn promote(paths: &AppPaths, id: &str, reason: Option<&str>) -> Result<String, String> {
    decide(
        paths,
        id,
        OverrideKind::Promoted,
        reason.unwrap_or("promoted by operator"),
    )
}

pub fn reject(paths: &AppPaths, id: &str, reason: Option<&str>) -> Result<String, String> {
    decide(
        paths,
        id,
        OverrideKind::Rejected,
        reason.unwrap_or("rejected by operator"),
    )
}

fn decide(
    paths: &AppPaths,
    id: &str,
    kind: OverrideKind,
    reason: &str,
) -> Result<String, String> {
    let mut lifecycle = migrate(paths);
    let record = lifecycle.skills.get_mut(id).ok_or_else(|| {
        format!("no skill `{id}` in the lifecycle; run `hii skills` to see what is tracked")
    })?;
    record.human_override = Some(HumanOverride {
        kind,
        reason: reason.to_string(),
        at_unix_ms: crate::receipt::unix_ms(),
    });
    record.recompute();
    let state = record.state;
    let verified = record.verified_count;
    save(paths, &lifecycle)?;
    Ok(format!(
        "{id} is now {} by operator decision ({reason}).\nEarned evidence is unchanged: {verified} verified execution(s).\nThis changes competence only — it grants no authority.",
        state.label()
    ))
}

/// Every skill the lifecycle considers usable today.
pub fn promoted(lifecycle: &Lifecycle) -> Vec<&SkillRecord> {
    let mut records: Vec<&SkillRecord> = lifecycle
        .skills
        .values()
        .filter(|record| record.state.is_promoted())
        .collect();
    records.sort_by(|a, b| b.state.cmp(&a.state).then_with(|| a.id.cmp(&b.id)));
    records
}

pub fn status(paths: &AppPaths, json: bool) -> Result<String, String> {
    let lifecycle = migrate(paths);
    save(paths, &lifecycle)?;
    if json {
        return serde_json::to_string_pretty(&lifecycle).map_err(|error| error.to_string());
    }
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for record in lifecycle.skills.values() {
        *counts.entry(record.state.label()).or_default() += 1;
    }
    let mut lines = vec![format!(
        "HII skill lifecycle — {} tracked",
        lifecycle.skills.len()
    )];
    for state in [
        SkillState::Trusted,
        SkillState::Verified,
        SkillState::Observed,
        SkillState::Proposed,
        SkillState::Rejected,
    ] {
        lines.push(format!(
            "  {:9} {}",
            state.label(),
            counts.get(state.label()).copied().unwrap_or(0)
        ));
    }
    lines.push(String::new());
    lines.push(
        "Promotion requires verified executions. `hii skills promote <id>` overrides explicitly."
            .into(),
    );
    Ok(lines.join("\n"))
}

fn remember_origin(record: &mut SkillRecord, origin: &str) {
    if !record.origins.iter().any(|existing| existing == origin) {
        record.origins.push(origin.to_string());
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|found| !found.is_empty())
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_with(observations: Vec<Observation>) -> SkillRecord {
        record_named("test", observations)
    }

    fn record_named(id: &str, observations: Vec<Observation>) -> SkillRecord {
        let mut record = SkillRecord::new(id.into(), "Test".into(), String::new(), "test");
        record.observations = observations;
        record.recompute();
        record
    }

    fn observation(id: &str, outcome: Outcome) -> Observation {
        Observation {
            receipt_id: id.into(),
            outcome,
            note: String::new(),
        }
    }

    fn verified(id: &str) -> Observation {
        observation(id, Outcome::Verified)
    }

    fn plain_success(id: &str) -> Observation {
        observation(id, Outcome::Succeeded)
    }

    fn failure(id: &str) -> Observation {
        observation(id, Outcome::Failed)
    }

    #[test]
    fn no_evidence_stays_proposed() {
        assert_eq!(record_with(vec![]).state, SkillState::Proposed);
    }

    #[test]
    fn observation_count_alone_never_promotes() {
        // The failure mode this whole module exists to prevent: many runs that
        // proved nothing must not add up to a verified skill.
        let observations = (0..20)
            .map(|index| plain_success(&format!("r{index}")))
            .collect();
        assert_eq!(record_with(observations).state, SkillState::Observed);
    }

    #[test]
    fn one_verified_execution_promotes_to_verified() {
        assert_eq!(record_with(vec![verified("r1")]).state, SkillState::Verified);
    }

    #[test]
    fn repeated_verification_earns_trust() {
        let record = record_with(vec![verified("r1"), verified("r2"), verified("r3")]);
        assert_eq!(record.state, SkillState::Trusted);
    }

    #[test]
    fn failures_reduce_confidence_and_degrade_state() {
        let strong = record_with(vec![verified("r1")]);
        assert_eq!(strong.state, SkillState::Verified);

        let degraded = record_with(vec![verified("r1"), failure("r2"), failure("r3")]);
        assert!(degraded.confidence < strong.confidence);
        assert_eq!(degraded.state, SkillState::Observed);
        assert_eq!(degraded.failure_count, 2);
    }

    #[test]
    fn trusted_degrades_only_one_step() {
        let record = record_with(vec![
            verified("r1"),
            verified("r2"),
            verified("r3"),
            failure("f1"),
            failure("f2"),
            failure("f3"),
            failure("f4"),
        ]);
        assert_eq!(record.state, SkillState::Verified);
    }

    #[test]
    fn duplicate_receipts_are_not_counted_twice() {
        let mut record = SkillRecord::new("test".into(), "Test".into(), String::new(), "test");
        record.observe(verified("same"));
        record.observe(verified("same"));
        record.recompute();
        assert_eq!(record.verified_count, 1);
    }

    #[test]
    fn human_rejection_outranks_verified_evidence() {
        let mut record = record_with(vec![verified("r1"), verified("r2"), verified("r3")]);
        record.human_override = Some(HumanOverride {
            kind: OverrideKind::Rejected,
            reason: "unsafe".into(),
            at_unix_ms: 1,
        });
        record.recompute();
        assert_eq!(record.state, SkillState::Rejected);
        // The evidence is preserved, not erased, so the decision stays auditable.
        assert_eq!(record.verified_count, 3);
    }

    #[test]
    fn human_promotion_lifts_a_skill_with_no_evidence() {
        let mut record = record_with(vec![]);
        record.human_override = Some(HumanOverride {
            kind: OverrideKind::Promoted,
            reason: "operator".into(),
            at_unix_ms: 1,
        });
        record.recompute();
        assert_eq!(record.state, SkillState::Verified);
        assert_eq!(record.verified_count, 0);
    }

    #[test]
    fn a_receipt_with_no_completion_assessment_proves_nothing() {
        let raw = serde_json::json!({
            "schema_version": 1,
            "id": "legacy-run",
            "created_at_unix_ms": 0u64,
            "finished_at_unix_ms": 0u64,
            "status": "completed",
            "goal": "g",
            "workspace": "/tmp",
            "model": "m",
            "review_model": null,
            "steps": 1,
            "summary": "s",
            "verification": [],
            "git_status": "",
            "next": null,
            "review": null,
            "risk": "low",
        });
        let receipt: Receipt = serde_json::from_value(raw).expect("legacy receipt parses");
        let observation = observation_from_receipt(&receipt);
        assert_ne!(
            observation.outcome,
            Outcome::Verified,
            "legacy proof must not verify a skill"
        );
    }

    /// Migration must never promote a draft on its own say-so.
    ///
    /// Runs against this machine's real draft store, which is the population
    /// that motivated the lifecycle: 117 manifests, every one claiming one
    /// "observation", none carrying a receipt that proved anything. If a change
    /// to the projection rules ever lets those through, this fails loudly
    /// instead of quietly minting a hundred trusted skills. Skipped where no
    /// draft store exists, so it never fails on a clean checkout.
    #[test]
    fn migrating_real_drafts_promotes_nothing() {
        let Ok(paths) = AppPaths::discover() else {
            return;
        };
        if !paths.runtime.join("skills/proposed").is_dir() {
            return;
        }
        let lifecycle = migrate(&paths);
        let drafts: Vec<&SkillRecord> = lifecycle
            .skills
            .values()
            .filter(|record| record.origins.iter().any(|origin| origin == "draft"))
            .filter(|record| record.human_override.is_none())
            .collect();
        assert!(
            !drafts.is_empty(),
            "expected real draft manifests to project into the lifecycle"
        );
        for record in drafts {
            if record.state.is_promoted() {
                assert!(
                    record.verified_count >= 1,
                    "draft `{}` was promoted to {} with {} verified execution(s); \
                     promotion must rest on verified evidence, not observation count",
                    record.id,
                    record.state.label(),
                    record.verified_count
                );
            }
        }
    }

    /// The counterpart risk: a draft citing a receipt that no longer exists must
    /// not be scored as a failure either, or migration would invent a history of
    /// breakage for workflows nobody ever ran.
    #[test]
    fn a_missing_receipt_counts_as_neither_success_nor_failure() {
        let Ok(paths) = AppPaths::discover() else {
            return;
        };
        let observation = observe_receipt(&paths, "definitely-not-a-real-receipt-id");
        assert_eq!(observation.outcome, Outcome::Inconclusive);
        let record = record_with(vec![observation]);
        assert_eq!(record.failure_count, 0);
        assert_eq!(record.state, SkillState::Proposed);
    }

    #[test]
    fn promoted_returns_only_verified_and_trusted() {
        let mut lifecycle = Lifecycle::default();
        lifecycle
            .skills
            .insert("a".into(), record_named("a", vec![verified("r1")]));
        lifecycle
            .skills
            .insert("b".into(), record_named("b", vec![plain_success("r2")]));
        lifecycle.skills.insert("c".into(), record_named("c", vec![]));
        let promoted = promoted(&lifecycle);
        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].id, "a");
    }
}
