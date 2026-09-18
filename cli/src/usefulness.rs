//! Evidence-backed evaluation of HII's shared usefulness loop.
//!
//! The benchmark cases are data, not implementations. Every case enters the
//! same workspace agent and is graded from the same durable run events,
//! completion assessment, receipt, and learning record. A failed case names
//! the missing general primitive instead of inviting a prompt-specific patch.

use crate::{
    agent::{self, AutonomyLevel, RunOptions, RunOutput},
    budget::Budgets,
    config::AppPaths,
    contract::{Authority, OutcomeRequirements},
    receipt::{latest_receipt_pointer, Receipt},
    runlog::StreamPolicy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const SUITE_JSON: &str = include_str!("../../evals/usefulness-v1.json");
const RESULT_PATH: &str = "result.md";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkSuite {
    pub schema_version: u8,
    pub id: String,
    pub cases: Vec<BenchmarkCase>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkCase {
    pub id: String,
    pub category: String,
    pub intent: String,
    pub fixtures: Vec<FixtureFile>,
    pub expectations: Vec<FileExpectation>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FixtureFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExpectation {
    pub path: String,
    #[serde(default)]
    pub contains: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default = "default_min_bytes")]
    pub min_bytes: u64,
}

fn default_min_bytes() -> u64 {
    1
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Primitive {
    Intent,
    Context,
    Capability,
    Action,
    Observation,
    Verification,
    Memory,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub primitive: Primitive,
    pub passed: bool,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub id: String,
    pub category: String,
    pub intent: String,
    pub passed: bool,
    pub receipt_id: Option<String>,
    pub proof: Option<String>,
    pub stages: Vec<StageResult>,
    pub missing_primitives: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_class: Option<&'static str>,
    pub tools_used: Vec<String>,
    pub duration_ms: u128,
    pub model_calls: usize,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkReport {
    pub schema_version: u8,
    pub kind: &'static str,
    pub suite: String,
    pub benchmark_id: String,
    pub model: String,
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub duration_ms: u128,
    pub model_calls: usize,
    pub cases: Vec<CaseResult>,
    pub root: String,
    pub report: String,
}

#[derive(Clone, Debug)]
pub struct BenchmarkOptions {
    pub model: Option<String>,
    pub case: Option<String>,
    pub max_steps: usize,
    pub deadline: Duration,
}

#[derive(Debug, Deserialize)]
struct StoredEvent {
    kind: String,
    #[serde(default)]
    data: Value,
}

pub fn suite() -> Result<BenchmarkSuite, String> {
    let suite: BenchmarkSuite =
        serde_json::from_str(SUITE_JSON).map_err(|error| error.to_string())?;
    validate_suite(&suite)?;
    Ok(suite)
}

pub fn validate_only(case: Option<&str>) -> Result<Value, String> {
    let suite = suite()?;
    if let Some(case) = case {
        if !suite.cases.iter().any(|candidate| candidate.id == case) {
            return Err(format!("unknown usefulness case '{case}'"));
        }
    }
    let categories = suite
        .cases
        .iter()
        .fold(BTreeMap::new(), |mut counts, case| {
            *counts.entry(case.category.clone()).or_insert(0usize) += 1;
            counts
        });
    Ok(json!({
        "schemaVersion": 1,
        "kind": "hii.usefulness.benchmark.validation",
        "suite": suite.id,
        "cases": suite.cases.len(),
        "selectedCase": case,
        "categories": categories,
        "valid": true,
    }))
}

pub fn run(paths: &AppPaths, options: BenchmarkOptions) -> Result<BenchmarkReport, String> {
    let suite = suite()?;
    let selected = suite
        .cases
        .iter()
        .filter(|case| options.case.as_deref().is_none_or(|id| id == case.id))
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(format!(
            "unknown usefulness case '{}'",
            options.case.as_deref().unwrap_or_default()
        ));
    }

    let benchmark_id = format!("{:x}", crate::clock::unix_ms());
    let root = paths
        .runtime
        .join("benchmarks/usefulness")
        .join(&benchmark_id);
    let runtime = root.join("runtime");
    let workspaces = root.join("workspaces");
    fs::create_dir_all(&runtime).map_err(|error| error.to_string())?;
    fs::create_dir_all(&workspaces).map_err(|error| error.to_string())?;
    let isolated = AppPaths {
        repo: paths.repo.clone(),
        runtime,
    };
    let model_label = options
        .model
        .clone()
        .unwrap_or_else(|| "provider-default".into());
    let mut results = Vec::new();

    for case in selected {
        let workspace = workspaces.join(&case.id);
        fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
        prepare_workspace(&workspace, &case)?;
        let verifier = verifier_script(&case.expectations);
        let verifier_path = workspace.join(".hii-benchmark/verify.sh");
        write_file(&workspace, ".hii-benchmark/verify.sh", &verifier)?;

        let required = case
            .expectations
            .iter()
            .map(|expectation| format!("{}:md", expectation.path))
            .collect::<Vec<_>>();
        let outcome = OutcomeRequirements::from_flags(Some("file-artifact"), &required)?;
        let run = agent::run(
            &isolated,
            RunOptions {
                goal: case.intent.clone(),
                workspace: workspace.clone(),
                model: options.model.clone(),
                review: false,
                review_model: None,
                max_steps: options.max_steps,
                dry_run: false,
                verbose: false,
                authority: Authority::Workspace,
                done_when: Some(format!(
                    "{} exists, satisfies the declared benchmark assertions, and the verification command passes",
                    RESULT_PATH
                )),
                verify: vec!["sh .hii-benchmark/verify.sh".into()],
                outcome_requirements: outcome,
                use_context: true,
                context_sources: case
                    .fixtures
                    .iter()
                    .map(|fixture| format!("benchmark-fixture:{}:{}", case.id, fixture.path))
                    .collect(),
                system_context: Vec::new(),
                output: RunOutput::Quiet,
                stream: StreamPolicy::Never,
                allow_missing_verify_deps: false,
                budgets: Budgets {
                    max_steps: options.max_steps,
                    wall_clock: Some(options.deadline),
                    model_call: Some(options.deadline.min(Duration::from_secs(45))),
                    ..Budgets::default()
                },
                last_message: None,
                hooks: false,
                coding: false,
                skill_ids: Vec::new(),
                autonomy_level: AutonomyLevel::LocalFull,
            },
        );

        let (receipt, run_error) = match run {
            Ok(receipt) => (Some(receipt), None),
            Err(error) => (
                latest_receipt_pointer(&isolated.runtime, &workspace)
                    .and_then(|path| fs::read_to_string(path).ok())
                    .and_then(|raw| serde_json::from_str(&raw).ok()),
                Some(error),
            ),
        };
        let verifier_intact = fs::read_to_string(&verifier_path)
            .map(|after| after == verifier)
            .unwrap_or(false);
        results.push(assess_case(
            &case,
            receipt.as_ref(),
            &isolated.runtime,
            verifier_intact,
            run_error,
        ));
    }

    let passed = results.iter().filter(|case| case.passed).count();
    let duration_ms = results.iter().map(|case| case.duration_ms).sum();
    let model_calls = results.iter().map(|case| case.model_calls).sum();
    let report_path = root.join("report.json");
    let report = BenchmarkReport {
        schema_version: 1,
        kind: "hii.usefulness.benchmark",
        suite: suite.id,
        benchmark_id,
        model: model_label,
        total: results.len(),
        passed,
        failed: results.len() - passed,
        duration_ms,
        model_calls,
        cases: results,
        root: root.display().to_string(),
        report: report_path.display().to_string(),
    };
    fs::write(
        &report_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(report)
}

pub fn render(report: &BenchmarkReport, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(report).map_err(|error| error.to_string());
    }
    let mut output = format!(
        "HII usefulness benchmark — {}\nmodel  {}\nresult {}/{} passed · {} model calls · {} ms\n\n",
        report.suite,
        report.model,
        report.passed,
        report.total,
        report.model_calls,
        report.duration_ms
    );
    for case in &report.cases {
        output.push_str(&format!(
            "{}  {:<28} {}\n",
            if case.passed { "ok" } else { "!!" },
            case.id,
            if case.passed {
                "complete".into()
            } else {
                format!("missing {}", case.missing_primitives.join(", "))
            }
        ));
    }
    output.push_str(&format!("\nproof  {}", report.report));
    Ok(output)
}

fn validate_suite(suite: &BenchmarkSuite) -> Result<(), String> {
    if suite.schema_version != 1 {
        return Err(format!(
            "unsupported usefulness suite schema {}",
            suite.schema_version
        ));
    }
    if suite.cases.len() != 20 {
        return Err(format!(
            "usefulness-v1 must contain exactly 20 requests; found {}",
            suite.cases.len()
        ));
    }
    let mut ids = BTreeSet::new();
    let mut categories = BTreeMap::new();
    for case in &suite.cases {
        if case.id.trim().is_empty() || case.intent.trim().is_empty() {
            return Err("every usefulness case needs an id and intent".into());
        }
        if !ids.insert(case.id.clone()) {
            return Err(format!("duplicate usefulness case id '{}'", case.id));
        }
        *categories.entry(case.category.as_str()).or_insert(0usize) += 1;
        if case.fixtures.is_empty() || case.expectations.is_empty() {
            return Err(format!(
                "case '{}' needs context fixtures and declarative expectations",
                case.id
            ));
        }
        for fixture in &case.fixtures {
            safe_relative(&fixture.path)?;
        }
        for expectation in &case.expectations {
            safe_relative(&expectation.path)?;
            if expectation.path != RESULT_PATH {
                return Err(format!(
                    "case '{}' must use the shared {RESULT_PATH} artifact contract",
                    case.id
                ));
            }
        }
    }
    for category in [
        "find-understand",
        "organize",
        "decide",
        "create",
        "continue",
    ] {
        if categories.get(category) != Some(&4) {
            return Err(format!(
                "usefulness-v1 needs four '{category}' cases; found {}",
                categories.get(category).copied().unwrap_or(0)
            ));
        }
    }
    Ok(())
}

fn prepare_workspace(workspace: &Path, case: &BenchmarkCase) -> Result<(), String> {
    let instructions = format!(
        "# HII usefulness benchmark\n\nThis is an isolated, synthetic everyday-work fixture.\nUse only files inside this workspace. Inspect source files before acting.\nComplete the human request through the normal HII tools and write the final useful artifact to `{RESULT_PATH}`.\nDo not modify anything under `.hii-benchmark/`; it is pre-registered acceptance evidence.\nDo not use the network or invent missing facts. Cite fixture filenames in the result when the request depends on them.\n"
    );
    write_file(workspace, "AGENTS.md", &instructions)?;
    for fixture in &case.fixtures {
        write_file(workspace, &fixture.path, &fixture.content)?;
    }
    Ok(())
}

fn write_file(workspace: &Path, relative: &str, content: &str) -> Result<(), String> {
    safe_relative(relative)?;
    let path = workspace.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

fn safe_relative(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("benchmark path must stay relative: '{value}'"));
    }
    Ok(())
}

fn verifier_script(expectations: &[FileExpectation]) -> String {
    let mut script = String::from("#!/bin/sh\nset -eu\n");
    for expectation in expectations {
        let path = shell_quote(&expectation.path);
        script.push_str(&format!("test -f {path}\n"));
        script.push_str(&format!(
            "test \"$(wc -c < {path} | tr -d ' ')\" -ge {}\n",
            expectation.min_bytes
        ));
        for needle in &expectation.contains {
            script.push_str(&format!("grep -Fq -- {} {}\n", shell_quote(needle), path));
        }
        for needle in &expectation.excludes {
            script.push_str(&format!(
                "if grep -Fq -- {} {}; then exit 1; fi\n",
                shell_quote(needle),
                path
            ));
        }
    }
    script
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn assess_case(
    case: &BenchmarkCase,
    receipt: Option<&Receipt>,
    runtime: &Path,
    verifier_intact: bool,
    error: Option<String>,
) -> CaseResult {
    let events = receipt
        .map(|receipt| {
            runtime
                .join("runs/cli")
                .join(&receipt.id)
                .join("events.jsonl")
        })
        .map(read_events)
        .unwrap_or_default();
    let proof = receipt.map(|receipt| {
        runtime
            .join("runs/cli")
            .join(&receipt.id)
            .join("receipt.json")
    });
    let event = |kind: &str| events.iter().find(|event| event.kind == kind);
    let successful_tools = events
        .iter()
        .filter(|event| matches!(event.kind.as_str(), "tool.result" | "mcp.result"))
        .filter(|event| event.data.get("ok").and_then(Value::as_bool) == Some(true))
        .filter_map(|event| event.data.get("tool").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let observed_tools = successful_tools
        .iter()
        .filter(|tool| {
            matches!(
                tool.as_str(),
                "read" | "list" | "search" | "web_search" | "image_search" | "web_fetch"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let action_tools = successful_tools
        .iter()
        .filter(|tool| {
            !matches!(
                tool.as_str(),
                "verify" | "read" | "list" | "search" | "web_search" | "image_search" | "web_fetch"
            )
        })
        .cloned()
        .collect::<Vec<_>>();

    let intent_ok = receipt.is_some_and(|receipt| receipt.goal == case.intent)
        && event("run.started").is_some();
    let context_sources = event("contract")
        .and_then(|event| event.data.get("context_sources"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let context_ok = context_sources > 0 && !observed_tools.is_empty();
    let capability_ok = event("pipe.preflight").is_some_and(|event| {
        event.data.get("status").and_then(Value::as_str) == Some("ready")
            && event
                .data
                .get("capability")
                .is_some_and(|value| !value.is_null())
    });
    let action_ok = !action_tools.is_empty();
    let observation_ok = events.iter().any(|event| {
        matches!(event.kind.as_str(), "tool.result" | "mcp.result")
            && event.data.get("ok").and_then(Value::as_bool) == Some(true)
            && event
                .data
                .get("output")
                .and_then(Value::as_str)
                .is_some_and(|output| !output.trim().is_empty())
    });
    let verification_ok = receipt.is_some_and(|receipt| {
        receipt.status == "completed"
            && receipt.verification.iter().any(|check| check.ok)
            && receipt.completion.as_ref().is_some_and(|completion| {
                completion.satisfied
                    && completion.proof_strength == crate::completion::ProofStrength::Declared
            })
    }) && verifier_intact;
    let memory_ok = receipt.is_some_and(|receipt| {
        receipt
            .learning_candidates
            .iter()
            .any(|candidate| Path::new(candidate).is_file())
    }) && proof.as_ref().is_some_and(|path| path.is_file());

    let stage = |primitive, passed, evidence: Vec<String>, missing: &str| StageResult {
        primitive,
        passed,
        evidence,
        missing: (!passed).then(|| missing.to_string()),
    };
    let stages = vec![
        stage(
            Primitive::Intent,
            intent_ok,
            receipt
                .map(|receipt| vec![format!("receipt.goal={}", receipt.goal)])
                .unwrap_or_default(),
            "intent.capture",
        ),
        stage(
            Primitive::Context,
            context_ok,
            vec![
                format!("source-count={context_sources}"),
                format!("observation-tools={}", observed_tools.join(",")),
            ],
            if context_sources == 0 {
                "context.provenance"
            } else {
                "context.retrieval"
            },
        ),
        stage(
            Primitive::Capability,
            capability_ok,
            event("pipe.preflight")
                .map(|event| vec![event.data.to_string()])
                .unwrap_or_default(),
            "capability.resolution",
        ),
        stage(
            Primitive::Action,
            action_ok,
            action_tools
                .iter()
                .map(|tool| format!("tool={tool}"))
                .collect(),
            "action.execution",
        ),
        stage(
            Primitive::Observation,
            observation_ok,
            successful_tools
                .iter()
                .map(|tool| format!("result={tool}"))
                .collect(),
            "observation.feedback",
        ),
        stage(
            Primitive::Verification,
            verification_ok,
            receipt
                .map(|receipt| {
                    receipt
                        .verification
                        .iter()
                        .map(|check| format!("{}={}", check.command, check.ok))
                        .chain((!verifier_intact).then(|| "verifier-tampered".into()))
                        .collect()
                })
                .unwrap_or_default(),
            "verification.acceptance",
        ),
        stage(
            Primitive::Memory,
            memory_ok,
            receipt
                .map(|receipt| {
                    let mut evidence = vec![format!("receipt={}", receipt.id)];
                    evidence.extend(receipt.learning_candidates.clone());
                    evidence
                })
                .unwrap_or_default(),
            "memory.persistence",
        ),
    ];
    let missing_primitives = stages
        .iter()
        .filter_map(|stage| stage.missing.clone())
        .collect::<Vec<_>>();
    let provider_failure = receipt.is_some_and(|receipt| receipt.outcome == "provider-error");
    let failure_class = if missing_primitives.is_empty() {
        None
    } else if provider_failure {
        Some("capability failure")
    } else {
        stages
            .iter()
            .find(|stage| !stage.passed)
            .map(|stage| match stage.primitive {
                Primitive::Intent => "planning/reasoning failure",
                Primitive::Context => "context failure",
                Primitive::Capability => "capability failure",
                Primitive::Action => "execution failure",
                Primitive::Observation => "observation failure",
                Primitive::Verification => "verification failure",
                Primitive::Memory => "memory/continuity failure",
            })
    };
    let duration_ms = receipt.map_or(0, |receipt| {
        receipt
            .finished_at_unix_ms
            .saturating_sub(receipt.created_at_unix_ms)
    });
    let model_calls = events
        .iter()
        .filter(|event| {
            matches!(
                event.kind.as_str(),
                "model.reasoning_policy" | "model.provider_retry"
            )
        })
        .count();
    let (prompt_tokens, completion_tokens) = receipt
        .and_then(|receipt| receipt.token_usage.as_ref())
        .map_or((0, 0), |usage| {
            (usage.prompt_tokens, usage.completion_tokens)
        });
    CaseResult {
        id: case.id.clone(),
        category: case.category.clone(),
        intent: case.intent.clone(),
        passed: missing_primitives.is_empty(),
        receipt_id: receipt.map(|receipt| receipt.id.clone()),
        proof: proof.map(|path| path.display().to_string()),
        stages,
        missing_primitives,
        failure_class,
        tools_used: successful_tools.into_iter().collect(),
        duration_ms,
        model_calls,
        prompt_tokens,
        completion_tokens,
        error,
    }
}

fn read_events(path: PathBuf) -> Vec<StoredEvent> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{completion::CompletionAssessment, receipt::VerificationRecord};

    #[test]
    fn suite_is_twenty_declarative_requests_balanced_across_categories() {
        let suite = suite().expect("valid suite");
        assert_eq!(suite.cases.len(), 20);
        assert!(suite.cases.iter().all(|case| {
            case.expectations
                .iter()
                .all(|item| item.path == RESULT_PATH)
        }));
    }

    #[test]
    fn unsafe_fixture_paths_are_rejected() {
        for path in ["../escape", "/tmp/escape", ""] {
            assert!(safe_relative(path).is_err(), "{path} must be rejected");
        }
    }

    #[test]
    fn verifier_is_generated_from_data_and_fails_closed() {
        let script = verifier_script(&[FileExpectation {
            path: RESULT_PATH.into(),
            contains: vec!["source.txt".into()],
            excludes: vec!["invented".into()],
            min_bytes: 20,
        }]);
        assert!(script.contains("test -f 'result.md'"));
        assert!(script.contains("grep -Fq -- 'source.txt' 'result.md'"));
        assert!(script.contains("if grep -Fq -- 'invented' 'result.md'; then exit 1; fi"));
    }

    #[test]
    fn every_failed_stage_names_a_general_missing_primitive() {
        let case = suite().unwrap().cases.remove(0);
        let result = assess_case(
            &case,
            None,
            Path::new("/missing"),
            false,
            Some("no run".into()),
        );
        assert_eq!(result.stages.len(), 7);
        assert_eq!(result.missing_primitives.len(), 7);
        assert!(result
            .missing_primitives
            .iter()
            .all(|primitive| primitive.contains('.')));
    }

    #[test]
    fn proof_strength_must_be_declared_not_incidental() {
        let assessment = CompletionAssessment {
            version: 1,
            satisfied: true,
            proof_strength: crate::completion::ProofStrength::Incidental,
            outcome_kind: Some("file-artifact".into()),
            unmet_requirements: Vec::new(),
            failed_checks: Vec::new(),
            missing_artifacts: Vec::new(),
            invalid_artifacts: Vec::new(),
            warnings: Vec::new(),
            evidence: Vec::new(),
        };
        let receipt = Receipt {
            schema_version: 8,
            id: "run".into(),
            created_at_unix_ms: 0,
            finished_at_unix_ms: 1,
            status: "completed".into(),
            goal: "goal".into(),
            workspace: "/tmp".into(),
            model: "test".into(),
            review_model: None,
            steps: 1,
            summary: "done".into(),
            verification: vec![VerificationRecord {
                command: "check".into(),
                ok: true,
                output: String::new(),
            }],
            git_status: String::new(),
            next: None,
            review: None,
            risk: String::new(),
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
            completion: Some(assessment),
            model_source: None,
            autonomy_level: None,
            learning_candidates: Vec::new(),
            user_corrections: Vec::new(),
            failure_patterns: Vec::new(),
            skill_draft_ref: None,
            token_usage: None,
        };
        let verification = receipt.completion.as_ref().unwrap();
        assert!(!verification.proof_strength.qualifies_for_high_trust());
    }
}
