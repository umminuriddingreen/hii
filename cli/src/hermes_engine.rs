//! Hermes as a replaceable, per-run orchestration engine.
//!
//! HII launches Hermes in an isolated home with a random loopback API key and
//! exactly one model-facing toolset: the current `hii mcp` executable, bound to
//! the run's workspace and authority. Hermes owns transient conversation state;
//! HII still owns authority, verification, artifacts, and the canonical receipt.

use crate::{
    agent::{self, RunOptions, RunOutput},
    clock::unix_ms,
    completion::{self, CompletionInput},
    config::{AppPaths, ModelProvider},
    contract::Authority,
    receipt::{
        redact_text, EngineRecord, Outcome, Receipt, RunGuard, RunStore, TokenUsageRecord,
        VerificationRecord,
    },
    runlog::{Event, Human, Journal},
    tools::Toolbelt,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{BufRead, BufReader, IsTerminal, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const HERMES_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const HERMES_STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const HERMES_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SECRET_BYTES: u64 = 16 * 1024;
const MAX_ENGINE_OUTPUT_CHARS: usize = 16_000;

pub fn run(paths: &AppPaths, mut options: RunOptions) -> Result<Receipt, String> {
    if options.goal.trim().is_empty() {
        return Err("goal cannot be empty".into());
    }
    if options.review {
        return Err("--review is not yet supported by --engine hermes; HII still performs deterministic --verify checks".into());
    }
    agent::validate_declared_verification(&options.verify, None)?;
    if options.verify.is_empty() {
        return Err("--engine hermes requires at least one deterministic --verify command so HII, not Hermes, decides completion".into());
    }

    let effective_authority = if options.dry_run {
        Authority::ReadOnly
    } else {
        options.authority
    };
    let tools = Toolbelt::new(options.workspace.clone())?;
    if !options.allow_missing_verify_deps {
        agent::validate_declared_verification(&options.verify, Some(tools.workspace()))?;
    }
    let loaded_skills = options
        .skill_ids
        .iter()
        .map(|id| crate::skill_runtime::load(paths, id))
        .collect::<Result<Vec<_>, _>>()?;

    let saved_model = if options.model.is_none() {
        paths
            .user_model_preference()?
            .map(|preference| preference.model)
    } else {
        None
    };
    let model_source = if options.model.is_some() {
        "explicit"
    } else if saved_model.is_some() {
        "saved-user"
    } else if std::env::var_os("HII_MODEL").is_some() {
        "env"
    } else {
        "provider-default"
    }
    .to_string();
    let model_url = AppPaths::model_url();
    let provider = ModelProvider::discover(&model_url);
    let model = options
        .model
        .as_deref()
        .or(saved_model.as_deref())
        .unwrap_or_else(|| provider.default_model())
        .trim()
        .to_string();
    validate_single_line("model", &model)?;

    let invocation_sources = agent::bounded_context_sources(&options.context_sources);
    let mut capsule = if options.use_context {
        crate::context::ContextCapsule::build(&paths.runtime, tools.workspace())
    } else {
        crate::context::ContextCapsule::default()
    };
    for source in &invocation_sources {
        if !capsule.sources.contains(source) {
            capsule.sources.push(source.clone());
        }
    }

    let git_before = tools.git_snapshot();
    let store = RunStore::create(&paths.runtime)?;
    crate::run_context::set_origin(crate::run_context::WriteOrigin::Operator);
    let run_id = store.id.clone();
    let started_at = store.started_at_unix_ms;
    let run_dir = store.dir.clone();
    let mut guard = RunGuard::start(
        &paths.runtime,
        &run_dir,
        &run_id,
        draft_receipt(
            &run_id,
            started_at,
            &options,
            tools.workspace(),
            &model,
            &model_source,
            effective_authority,
            &capsule.sources,
        ),
    )?;
    let mut journal = Journal::new(store, options.output.mode(options.verbose), options.stream);
    for skill in &loaded_skills {
        crate::skill_lifecycle::record_invocation(paths, &skill.id, Some(&run_id))?;
    }
    journal.emit(Event::new("run.started").data(json!({
        "run_id": &run_id,
        "goal": redact_text(&options.goal),
        "workspace": tools.workspace(),
        "model": &model,
        "engine": "hermes",
        "authority": effective_authority.label(),
        "dry_run": options.dry_run,
        "max_steps": options.max_steps,
    })))?;

    let runtime = match ManagedHermes::start(
        paths,
        &run_id,
        tools.workspace(),
        effective_authority,
        &model,
        &model_url,
        options.max_steps,
        options.verbose,
    ) {
        Ok(runtime) => runtime,
        Err(error) => {
            checkpoint_and_return(&mut guard, Outcome::InfraError, &error, 0)?;
            return Err(error);
        }
    };
    let mut engine_record = runtime.engine_record();
    journal.emit(Event::new("engine.ready").data(json!({
        "engine": "hermes",
        "version": engine_record.version,
        "commit": engine_record.commit,
        "managed": true,
    })))?;

    if let Err(error) = runtime.client.preflight_toolsets() {
        checkpoint_and_return(&mut guard, Outcome::InfraError, &error, 0)?;
        return Err(error);
    }

    let instructions = engine_instructions(
        tools.workspace(),
        effective_authority,
        options.done_when.as_deref(),
        &options.verify,
        &capsule.text,
        &loaded_skills
            .iter()
            .map(|skill| (skill.id.as_str(), skill.instructions.as_str()))
            .collect::<Vec<_>>(),
    );
    let hermes_session_id = format!("hii-{run_id}");
    let hermes_run_id = match runtime.client.submit(
        &run_id,
        &hermes_session_id,
        &options.goal,
        &instructions,
        &model,
    ) {
        Ok(id) => id,
        Err(error) => {
            checkpoint_and_return(&mut guard, Outcome::ProviderError, &error, 0)?;
            return Err(error);
        }
    };
    engine_record.run_id = Some(hermes_run_id.clone());
    engine_record.session_id = Some(hermes_session_id.clone());
    journal.emit(Event::new("engine.run_started").data(json!({
        "engine": "hermes",
        "engine_run_id": &hermes_run_id,
        "engine_session_id": &hermes_session_id,
    })))?;

    agent::arm_interrupt();
    let cancel = agent::interrupt_signal().clone();
    cancel.reset();
    let (event_tx, event_rx) = mpsc::channel();
    let event_client = runtime.client.clone();
    let event_run_id = hermes_run_id.clone();
    thread::spawn(move || {
        let result = event_client.stream_events(&event_run_id, |event| {
            event_tx.send(StreamMessage::Event(event)).is_ok()
        });
        let _ = event_tx.send(StreamMessage::Finished(result));
    });

    let started_wait = Instant::now();
    let mut event_count = 0usize;
    let mut steps = 0usize;
    let mut approvals = Vec::new();
    let mut forced_outcome: Option<(Outcome, String)> = None;
    let mut terminal_event = None;
    loop {
        if cancel.is_cancelled() {
            let _ = runtime.client.stop(&hermes_run_id);
            forced_outcome = Some((
                Outcome::Interrupted,
                "Hermes run interrupted by operator.".into(),
            ));
            break;
        }
        if options
            .budgets
            .wall_clock
            .is_some_and(|limit| started_wait.elapsed() >= limit)
        {
            let _ = runtime.client.stop(&hermes_run_id);
            forced_outcome = Some((
                Outcome::Deadline,
                "Hermes run exceeded HII's wall-clock budget.".into(),
            ));
            break;
        }
        match event_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(StreamMessage::Event(engine_event)) => {
                event_count += 1;
                let event_kind = engine_event.kind.clone();
                let event_human = engine_event.human();
                if engine_event.kind == "tool.started" {
                    steps += 1;
                    if let Some(tool) = engine_event.data.get("tool").and_then(Value::as_str) {
                        if !is_hii_governed_tool(tool) {
                            let _ = runtime.client.stop(&hermes_run_id);
                            forced_outcome = Some((
                                Outcome::InfraError,
                                format!("Hermes attempted non-HII tool '{tool}'; run stopped fail-closed."),
                            ));
                        }
                    }
                }
                if engine_event.kind == "approval.request" {
                    let _ = runtime.client.deny_approval(&hermes_run_id);
                    approvals.push("Denied unexpected Hermes-side approval; HII MCP is the only authority surface.".into());
                }
                let terminal = matches!(
                    engine_event.kind.as_str(),
                    "run.completed" | "run.failed" | "run.cancelled"
                );
                journal.emit(
                    Event::new("engine.event")
                        .data(json!({
                            "engine": "hermes",
                            "kind": event_kind,
                            "data": engine_event.data,
                        }))
                        .human(event_human),
                )?;
                if forced_outcome.is_some() {
                    break;
                }
                if terminal {
                    terminal_event = Some(event_kind);
                    break;
                }
            }
            Ok(StreamMessage::Finished(Ok(()))) => break,
            Ok(StreamMessage::Finished(Err(error))) => {
                forced_outcome = Some((Outcome::ProviderError, error));
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    engine_record.events = event_count;

    let status = match runtime
        .client
        .wait_for_status(&hermes_run_id, HERMES_STATUS_TIMEOUT)
    {
        Ok(status) => status,
        Err(error) if forced_outcome.is_some() => HermesStatus {
            status: "unknown".into(),
            session_id: Some(hermes_session_id),
            model: Some(model.clone()),
            output: None,
            error: Some(error),
            usage: None,
        },
        Err(error) => {
            forced_outcome = Some((Outcome::ProviderError, error.clone()));
            HermesStatus {
                status: "unknown".into(),
                session_id: Some(hermes_session_id),
                model: Some(model.clone()),
                output: None,
                error: Some(error),
                usage: None,
            }
        }
    };
    if let Some(session_id) = status.session_id.clone() {
        engine_record.session_id = Some(session_id);
    }

    let mut verification = Vec::new();
    for command in &options.verify {
        let result = tools.shell(command, true);
        let output = redact_text(&result.output);
        journal.emit(
            Event::new("verification.completed")
                .data(json!({ "command": command, "ok": result.ok, "output": output }))
                .human(Human::ToolResult {
                    ok: result.ok,
                    verification: true,
                    detail: Some(command.clone()),
                }),
        )?;
        verification.push(VerificationRecord {
            command: command.clone(),
            ok: result.ok,
            output,
        });
    }

    let mut summary = redact_text(
        status
            .output
            .as_deref()
            .or(status.error.as_deref())
            .unwrap_or("Hermes ended without a final response."),
    );
    if summary.chars().count() > MAX_ENGINE_OUTPUT_CHARS {
        summary = summary.chars().take(MAX_ENGINE_OUTPUT_CHARS).collect();
        summary.push_str("…");
    }
    let git_status = tools.git_snapshot();
    let mut artifacts = agent::artifact_inventory(&git_before, &git_status)
        .into_iter()
        .filter_map(|path| agent::canonical_artifact_path(tools.workspace(), &path))
        .collect::<Vec<_>>();

    if let Some(path) = options.last_message.as_deref() {
        let target = agent::resolve_last_message_path(tools.workspace(), path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&target, format!("{summary}\n")).map_err(|error| error.to_string())?;
        if let Some(relative) =
            agent::canonical_artifact_path(tools.workspace(), &target.display().to_string())
        {
            artifacts.push(relative);
        }
    }
    artifacts.sort();
    artifacts.dedup();
    let preexisting_changes = agent::artifact_inventory("clean", &git_before);

    if forced_outcome.is_none() && status.status != "completed" {
        forced_outcome = Some((
            if status.status == "cancelled" {
                Outcome::Interrupted
            } else {
                Outcome::ProviderError
            },
            format!("Hermes run ended with status '{}'.", status.status),
        ));
    }
    if forced_outcome.is_none()
        && options.budgets.max_tokens > 0
        && status
            .usage
            .as_ref()
            .is_some_and(|usage| usage.total() > options.budgets.max_tokens)
    {
        forced_outcome = Some((
            Outcome::TokenBudget,
            format!(
                "Hermes exceeded HII's {} token budget.",
                options.budgets.max_tokens
            ),
        ));
    }
    let terminated = forced_outcome.as_ref().map(|(_, reason)| reason.as_str());
    let completion = completion::assess(CompletionInput {
        workspace: tools.workspace(),
        requirements: options.outcome_requirements.as_ref(),
        final_summary: (!summary.trim().is_empty()).then_some(summary.as_str()),
        declared_checks: &options.verify,
        verification: &verification,
        artifacts: &artifacts,
        terminated,
    });
    let outcome = forced_outcome
        .as_ref()
        .map(|(outcome, _)| *outcome)
        .unwrap_or_else(|| {
            if completion.satisfied {
                Outcome::Completed
            } else {
                Outcome::VerifyFailed
            }
        });
    if let Some((_, reason)) = &forced_outcome {
        summary = format!("{} {}", summary.trim(), reason).trim().to_string();
    }
    engine_record.termination_reason =
        Some(terminal_event.unwrap_or_else(|| outcome.label().to_string()));
    let token_usage = status.usage.map(|usage| TokenUsageRecord {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        budget: options.budgets.max_tokens,
    });
    let actual_model = status.model.unwrap_or(model);
    let mut receipt = Receipt {
        schema_version: 9,
        id: run_id.clone(),
        created_at_unix_ms: started_at,
        finished_at_unix_ms: unix_ms(),
        status: outcome.status().into(),
        goal: options.goal,
        workspace: tools.workspace().display().to_string(),
        model: actual_model,
        review_model: None,
        steps,
        summary,
        verification,
        git_status,
        next: None,
        review: None,
        risk: "Hermes ran as a managed local child with only HII MCP tools; HII independently verified the final workspace state.".into(),
        authority: Some(effective_authority.label().into()),
        done_when: options.done_when.take(),
        approvals,
        artifacts,
        reversible: Some(true),
        context_sources: capsule.sources,
        preexisting_changes,
        hooks: Vec::new(),
        outcome: outcome.label().into(),
        exit_code: outcome.exit_code(),
        completion: Some(completion),
        model_source: Some(model_source),
        autonomy_level: Some(options.autonomy_level.label().into()),
        learning_candidates: Vec::new(),
        user_corrections: Vec::new(),
        failure_patterns: Vec::new(),
        skill_draft_ref: None,
        token_usage,
        engine: Some(engine_record),
    };
    if let Ok(Some(path)) =
        crate::learning::record_from_receipt(&paths.runtime, &receipt, None, None)
    {
        receipt.learning_candidates.push(path.display().to_string());
    }
    let _ = crate::skill_lifecycle::grade_receipt(paths, &receipt);
    let proof = guard.finalize(&receipt)?;
    journal.emit(Event::new("run.finished").data(json!({
        "status": receipt.status,
        "summary": receipt.summary,
        "receipt": &receipt,
        "proof": &proof,
    })))?;
    journal.finish(&receipt, &proof);
    present(&options.output, options.verbose, &receipt, &proof);
    Ok(receipt)
}

fn checkpoint_and_return(
    guard: &mut RunGuard,
    outcome: Outcome,
    error: &str,
    steps: usize,
) -> Result<(), String> {
    guard.checkpoint_error(outcome, &redact_text(error), steps)
}

fn present(output: &RunOutput, verbose: bool, receipt: &Receipt, proof: &Path) {
    match output {
        RunOutput::Json => println!(
            "{}",
            json!({ "schemaVersion": 1, "receipt": receipt, "proof": proof })
        ),
        RunOutput::Jsonl | RunOutput::Quiet => {}
        RunOutput::Human if verbose => agent::print_receipt(receipt, proof),
        RunOutput::Human => {
            if std::io::stdout().is_terminal() {
                print!("\x1b[2K\r");
                let _ = std::io::stdout().flush();
            }
            println!("{}", receipt.summary);
        }
    }
}

fn draft_receipt(
    run_id: &str,
    started_at: u128,
    options: &RunOptions,
    workspace: &Path,
    model: &str,
    model_source: &str,
    authority: Authority,
    context_sources: &[String],
) -> Receipt {
    Receipt {
        schema_version: 9,
        id: run_id.into(),
        created_at_unix_ms: started_at,
        finished_at_unix_ms: 0,
        status: Outcome::Running.status().into(),
        goal: redact_text(&options.goal),
        workspace: workspace.display().to_string(),
        model: model.into(),
        review_model: None,
        steps: 0,
        summary: "Hermes engine run in progress.".into(),
        verification: Vec::new(),
        git_status: String::new(),
        next: None,
        review: None,
        risk: String::new(),
        authority: Some(authority.label().into()),
        done_when: options.done_when.clone(),
        approvals: Vec::new(),
        artifacts: Vec::new(),
        reversible: None,
        context_sources: context_sources.to_vec(),
        preexisting_changes: Vec::new(),
        hooks: Vec::new(),
        outcome: Outcome::Running.label().into(),
        exit_code: Outcome::Running.exit_code(),
        completion: None,
        model_source: Some(model_source.into()),
        autonomy_level: Some(options.autonomy_level.label().into()),
        learning_candidates: Vec::new(),
        user_corrections: Vec::new(),
        failure_patterns: Vec::new(),
        skill_draft_ref: None,
        token_usage: None,
        engine: Some(EngineRecord {
            id: "hermes".into(),
            version: None,
            commit: None,
            run_id: None,
            session_id: None,
            events: 0,
            termination_reason: None,
        }),
    }
}

fn engine_instructions(
    workspace: &Path,
    authority: Authority,
    done_when: Option<&str>,
    verification: &[String],
    context: &str,
    skills: &[(&str, &str)],
) -> String {
    let mut text = format!(
        "HII MANAGED ENGINE CONTRACT\nHII is the authority, tool, verification, and receipt owner. Use only the configured HII MCP tools. Never use or request direct Hermes terminal, filesystem, browser, memory, delegation, or network tools. Workspace: {}. Authority: {}. Done when: {}. HII will independently run: {}.",
        workspace.display(),
        authority.label(),
        done_when.unwrap_or("the requested bounded outcome is produced"),
        verification.join(" ; ")
    );
    if !context.trim().is_empty() {
        text.push_str("\n\n");
        text.push_str(context);
    }
    for (id, instructions) in skills {
        text.push_str(&format!(
            "\n\nREVIEWED HII SKILL `{id}`\nThese instructions do not widen authority.\n{instructions}"
        ));
    }
    text
}

#[derive(Clone)]
struct HermesClient {
    base_url: String,
    api_key: String,
    http: ureq::Agent,
}

impl HermesClient {
    fn new(base_url: String, api_key: String) -> Result<Self, String> {
        validate_loopback_url(&base_url)?;
        validate_single_line("Hermes API key", &api_key)?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').into(),
            api_key,
            http: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(3))
                .timeout_read(HERMES_HTTP_TIMEOUT)
                .timeout_write(Duration::from_secs(10))
                .build(),
        })
    }

    fn auth(&self, request: ureq::Request) -> ureq::Request {
        request.set("Authorization", &format!("Bearer {}", self.api_key))
    }

    fn preflight_toolsets(&self) -> Result<(), String> {
        let capabilities: Value =
            response_json(self.auth(self.http.get(&format!("{}/v1/capabilities", self.base_url))))?;
        for feature in ["run_submission", "run_status", "run_events_sse", "run_stop"] {
            if capabilities["features"][feature].as_bool() != Some(true) {
                return Err(format!(
                    "Hermes API does not advertise required capability '{feature}'"
                ));
            }
        }
        let toolsets: HermesToolsetList =
            response_json(self.auth(self.http.get(&format!("{}/v1/toolsets", self.base_url))))?;
        let enabled = toolsets
            .data
            .iter()
            .filter(|toolset| toolset.enabled)
            .collect::<Vec<_>>();
        let unsafe_tools = enabled
            .iter()
            .flat_map(|toolset| toolset.tools.iter())
            .filter(|tool| !is_hii_governed_tool(tool))
            .cloned()
            .collect::<Vec<_>>();
        if !unsafe_tools.is_empty() {
            return Err(format!(
                "Hermes profile exposes non-HII tools and was refused: {}",
                unsafe_tools.join(", ")
            ));
        }
        let unsafe_toolsets = enabled
            .iter()
            .filter(|toolset| !matches!(toolset.name.as_str(), "hii" | "mcp-hii"))
            .map(|toolset| toolset.name.clone())
            .collect::<Vec<_>>();
        if !unsafe_toolsets.is_empty() {
            return Err(format!(
                "Hermes enabled non-HII toolsets and was refused: {}",
                unsafe_toolsets.join(", ")
            ));
        }
        Ok(())
    }

    fn submit(
        &self,
        idempotency_key: &str,
        session_id: &str,
        input: &str,
        instructions: &str,
        model: &str,
    ) -> Result<String, String> {
        let response: Value = response_json_result(
            self.auth(self.http.post(&format!("{}/v1/runs", self.base_url)))
                .set("Idempotency-Key", idempotency_key)
                .send_json(json!({
                    "input": input,
                    "instructions": instructions,
                    "session_id": session_id,
                    "provider": "custom",
                    "model": model,
                })),
        )?;
        response["run_id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Hermes run submission returned no run_id".into())
    }

    fn stream_events(
        &self,
        run_id: &str,
        mut on_event: impl FnMut(HermesEvent) -> bool,
    ) -> Result<(), String> {
        let response = self.auth(self.http.get(&format!(
            "{}/v1/runs/{}/events",
            self.base_url,
            url_component(run_id)?
        )));
        let response = response.call().map_err(format_http_error)?;
        parse_sse(response.into_reader(), |event| on_event(event))
    }

    fn status(&self, run_id: &str) -> Result<HermesStatus, String> {
        response_json(self.auth(self.http.get(&format!(
            "{}/v1/runs/{}",
            self.base_url,
            url_component(run_id)?
        ))))
    }

    fn wait_for_status(&self, run_id: &str, timeout: Duration) -> Result<HermesStatus, String> {
        let started = Instant::now();
        loop {
            let status = self.status(run_id)?;
            if matches!(status.status.as_str(), "completed" | "failed" | "cancelled") {
                return Ok(status);
            }
            if started.elapsed() >= timeout {
                return Err(format!(
                    "Hermes run did not settle within {}s",
                    timeout.as_secs()
                ));
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn stop(&self, run_id: &str) -> Result<(), String> {
        response_empty(
            self.auth(self.http.post(&format!(
                "{}/v1/runs/{}/stop",
                self.base_url,
                url_component(run_id)?
            )))
            .send_json(json!({})),
        )
    }

    fn deny_approval(&self, run_id: &str) -> Result<(), String> {
        response_empty(
            self.auth(self.http.post(&format!(
                "{}/v1/runs/{}/approval",
                self.base_url,
                url_component(run_id)?
            )))
            .send_json(json!({ "decision": "deny" })),
        )
    }
}

struct ManagedHermes {
    client: HermesClient,
    child: Child,
    version: Option<String>,
    commit: Option<String>,
    log_path: PathBuf,
}

impl ManagedHermes {
    fn start(
        paths: &AppPaths,
        run_id: &str,
        workspace: &Path,
        authority: Authority,
        model: &str,
        model_url: &str,
        max_steps: usize,
        verbose: bool,
    ) -> Result<Self, String> {
        let engine_home = paths.runtime.join("engines/hermes/runs").join(run_id);
        fs::create_dir_all(&engine_home).map_err(|error| error.to_string())?;
        crate::store::write_private_atomic(&engine_home.join(".no-bundled-skills"), b"")?;
        let port = reserve_loopback_port()?;
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let api_key = URL_SAFE_NO_PAD.encode(secret);
        secret.fill(0);
        let client_identity = format!("hermes-engine-{run_id}");
        let acl_path = engine_home.join("mcp_acl.json");
        let role = if authority == Authority::ReadOnly {
            "reader"
        } else {
            "operator"
        };
        crate::store::write_json_private_atomic(
            &acl_path,
            &json!({
                "clients": {
                    client_identity.clone(): {
                        "role": role,
                        "restricted_tools": [],
                        "max_params_per_call": 64
                    }
                },
                "defaults": {
                    "role": "reader",
                    "restricted_tools": [],
                    "max_params_per_call": 64
                }
            }),
        )?;
        let hii = std::env::current_exe().map_err(|error| error.to_string())?;
        let model_base_url = openai_base_url(model_url);
        let config = json!({
            "_config_version": 44,
            "model": {
                "default": model,
                "provider": "custom",
                "base_url": model_base_url,
                "context_length": 65536
            },
            "agent": {
                "max_turns": if max_steps == 0 { 500 } else { max_steps },
                "verbose": false,
                "reasoning_effort": "medium"
            },
            "memory": {
                "memory_enabled": false,
                "user_profile_enabled": false
            },
            "compression": {
                "enabled": true,
                "threshold": 0.5,
                "target_ratio": 0.2,
                "protect_last_n": 20
            },
            "telemetry": { "shared_metrics": { "enabled": false } },
            "platform_toolsets": { "api_server": ["hii"] },
            "mcp_servers": {
                "hii": {
                    "command": hii,
                    "args": [
                        "--cwd", workspace,
                        "mcp",
                        "--authority", authority_cli_label(authority),
                        "--client-identity", client_identity
                    ],
                    "env": { "HII_MCP_CONFIG": acl_path },
                    "enabled": true,
                    "trust": "full",
                    "supports_parallel_tool_calls": false,
                    "tools": { "resources": false, "prompts": false }
                }
            },
            "gateway": {
                "multiplex_profiles": false,
                "api_server": {
                    "enabled": true,
                    "host": "127.0.0.1",
                    "port": port,
                    "key": "${API_SERVER_KEY}",
                    "max_concurrent_runs": 1
                }
            },
            "updates": { "pre_update_backup": false }
        });
        crate::store::write_json_private_atomic(&engine_home.join("config.yaml"), &config)?;
        let log_path = engine_home.join("gateway.log");
        let log = File::create(&log_path).map_err(|error| error.to_string())?;
        let log_err = log.try_clone().map_err(|error| error.to_string())?;
        let hermes_bin = std::env::var_os("HII_HERMES_BIN").unwrap_or_else(|| "hermes".into());
        let mut command = Command::new(hermes_bin);
        command.args(["gateway", "run"]);
        if verbose {
            command.arg("-v");
        }
        command
            .current_dir(workspace)
            .env("HERMES_HOME", &engine_home)
            .env("API_SERVER_ENABLED", "true")
            .env("API_SERVER_HOST", "127.0.0.1")
            .env("API_SERVER_PORT", port.to_string())
            .env("API_SERVER_KEY", &api_key)
            .env("OPENAI_BASE_URL", &model_base_url)
            .env(
                "OPENAI_API_KEY",
                read_model_api_key()?.unwrap_or_else(|| "no-key-required".into()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("could not start Hermes: {error}"))?;
        let client = HermesClient::new(format!("http://127.0.0.1:{port}"), api_key)?;
        let (version, commit) = installed_hermes_identity();
        let mut managed = Self {
            client,
            child,
            version,
            commit,
            log_path,
        };
        let started = Instant::now();
        loop {
            if managed
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                return Err(format!(
                    "Hermes exited during startup. {}",
                    read_log_tail(&managed.log_path)
                ));
            }
            let preflight_error = match managed
                .client
                .preflight_toolsets()
                .and_then(|_| validate_hii_mcp_cache(&engine_home))
            {
                Ok(()) => return Ok(managed),
                Err(error) => error,
            };
            if started.elapsed() >= HERMES_STARTUP_TIMEOUT {
                return Err(format!(
                    "Hermes did not expose its governed HII toolset within {}s: {}. {}",
                    HERMES_STARTUP_TIMEOUT.as_secs(),
                    preflight_error,
                    read_log_tail(&managed.log_path)
                ));
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    fn engine_record(&self) -> EngineRecord {
        EngineRecord {
            id: "hermes".into(),
            version: self.version.clone(),
            commit: self.commit.clone(),
            run_id: None,
            session_id: None,
            events: 0,
            termination_reason: None,
        }
    }
}

impl Drop for ManagedHermes {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Deserialize)]
struct HermesToolsetList {
    #[serde(default)]
    data: Vec<HermesToolset>,
}

#[derive(Debug, Deserialize)]
struct HermesToolset {
    name: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HermesStatus {
    status: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    usage: Option<HermesUsage>,
}

#[derive(Debug, Deserialize)]
struct HermesUsage {
    #[serde(default, alias = "prompt_tokens")]
    input_tokens: u64,
    #[serde(default, alias = "completion_tokens")]
    output_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

impl HermesUsage {
    fn total(&self) -> u64 {
        if self.total_tokens > 0 {
            self.total_tokens
        } else {
            self.input_tokens.saturating_add(self.output_tokens)
        }
    }
}

#[derive(Clone, Debug)]
struct HermesEvent {
    kind: String,
    data: Value,
}

impl HermesEvent {
    fn human(&self) -> Human {
        match self.kind.as_str() {
            "tool.started" => Human::Line(format!(
                "Hermes tool {}",
                self.data
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )),
            "tool.completed" => Human::ToolResult {
                ok: self.data.get("error").and_then(Value::as_bool) != Some(true),
                verification: false,
                detail: self
                    .data
                    .get("tool")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            _ => Human::Silent,
        }
    }
}

enum StreamMessage {
    Event(HermesEvent),
    Finished(Result<(), String>),
}

fn parse_sse(
    reader: impl Read,
    mut on_event: impl FnMut(HermesEvent) -> bool,
) -> Result<(), String> {
    let mut event_name = String::new();
    let mut data = String::new();
    for line in BufReader::new(reader).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.is_empty() {
            if !data.is_empty() {
                let value: Value = serde_json::from_str(&data)
                    .unwrap_or_else(|_| json!({ "text": redact_text(&data) }));
                let kind = if event_name.is_empty() {
                    value
                        .get("event")
                        .or_else(|| value.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("message")
                        .to_string()
                } else {
                    event_name.clone()
                };
                if !on_event(HermesEvent { kind, data: value }) {
                    return Ok(());
                }
            }
            event_name.clear();
            data.clear();
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event_name = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.trim_start());
        }
    }
    if !data.is_empty() {
        let value: Value =
            serde_json::from_str(&data).unwrap_or_else(|_| json!({ "text": redact_text(&data) }));
        let kind = if event_name.is_empty() {
            value
                .get("event")
                .or_else(|| value.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("message")
                .to_string()
        } else {
            event_name
        };
        let _ = on_event(HermesEvent { kind, data: value });
    }
    Ok(())
}

fn is_hii_governed_tool(tool: &str) -> bool {
    tool == "clarify" || tool.starts_with("mcp__hii__")
}

fn validate_hii_mcp_cache(engine_home: &Path) -> Result<(), String> {
    let path = engine_home.join("cache/mcp_schema_cache.json");
    let metadata = fs::metadata(&path)
        .map_err(|_| "Hermes has not finished discovering the HII MCP server".to_string())?;
    if metadata.len() > 1024 * 1024 {
        return Err("Hermes HII MCP schema cache is unexpectedly large".into());
    }
    let cache: Value = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("invalid Hermes MCP schema cache: {error}"))?;
    let tools = cache
        .get("hii")
        .and_then(|server| server.get("tools"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Hermes did not cache the configured HII MCP server".to_string())?;
    let discovered = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let expected = crate::acp::tools()
        .iter()
        .filter(|tool| crate::acp::is_directly_executable(tool.name))
        .map(|tool| tool.name)
        .collect::<BTreeSet<_>>();
    if discovered != expected {
        let missing = expected
            .difference(&discovered)
            .copied()
            .collect::<Vec<_>>();
        let unexpected = discovered
            .difference(&expected)
            .copied()
            .collect::<Vec<_>>();
        return Err(format!(
            "Hermes HII MCP discovery mismatch (missing: {}; unexpected: {})",
            missing.join(", "),
            unexpected.join(", ")
        ));
    }
    Ok(())
}

fn response_json<T: for<'de> Deserialize<'de>>(request: ureq::Request) -> Result<T, String> {
    response_json_result(request.call())
}

fn response_json_result<T: for<'de> Deserialize<'de>>(
    response: Result<ureq::Response, ureq::Error>,
) -> Result<T, String> {
    let response = response.map_err(format_http_error)?;
    response.into_json().map_err(|error| error.to_string())
}

fn response_empty(request: Result<ureq::Response, ureq::Error>) -> Result<(), String> {
    request.map(|_| ()).map_err(format_http_error)
}

fn format_http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let mut body = String::new();
            let _ = response
                .into_reader()
                .take(8 * 1024)
                .read_to_string(&mut body);
            format!("Hermes API HTTP {status}: {}", redact_text(body.trim()))
        }
        ureq::Error::Transport(error) => format!("cannot reach managed Hermes API: {error}"),
    }
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn openai_base_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

fn authority_cli_label(authority: Authority) -> &'static str {
    match authority {
        Authority::ReadOnly => "read-only",
        Authority::Workspace => "workspace",
        Authority::ExternalPreview => "external-preview",
        Authority::ExternalCommit => "external-commit",
        Authority::Yolo => "yolo",
    }
}

fn validate_loopback_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|error| format!("invalid Hermes URL: {error}"))?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err(
            "managed Hermes API must use http://127.0.0.1:<port> or http://localhost:<port>".into(),
        );
    }
    if url.port().is_none() {
        return Err("managed Hermes API requires an explicit loopback port".into());
    }
    Ok(())
}

fn validate_single_line(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(format!(
            "{label} must be non-empty and contain no control characters"
        ));
    }
    Ok(())
}

fn url_component(value: &str) -> Result<String, String> {
    validate_single_line("Hermes run id", value)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Hermes run id contains unsafe URL characters".into());
    }
    Ok(value.to_string())
}

fn read_model_api_key() -> Result<Option<String>, String> {
    let Some(path) = std::env::var_os("HII_MODEL_API_KEY_FILE") else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        format!(
            "cannot inspect HII_MODEL_API_KEY_FILE {}: {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("HII_MODEL_API_KEY_FILE must be a regular non-symlink file".into());
    }
    if metadata.len() > MAX_SECRET_BYTES {
        return Err("HII_MODEL_API_KEY_FILE is unexpectedly large".into());
    }
    let value = fs::read_to_string(&path).map_err(|error| {
        format!(
            "cannot read HII_MODEL_API_KEY_FILE {}: {error}",
            path.display()
        )
    })?;
    let value = value.trim().to_string();
    validate_single_line("HII model API key", &value)?;
    Ok(Some(value))
}

fn installed_hermes_identity() -> (Option<String>, Option<String>) {
    let hermes_bin = std::env::var_os("HII_HERMES_BIN").unwrap_or_else(|| "hermes".into());
    let Ok(output) = Command::new(hermes_bin).arg("--version").output() else {
        return (None, None);
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or_default();
    let version = line
        .split_whitespace()
        .find(|part| {
            part.starts_with('v') && part[1..].chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .map(|part| part.trim_start_matches('v').to_string());
    let commit = line
        .split_once("upstream ")
        .map(|(_, value)| {
            value
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string()
        })
        .filter(|value| !value.is_empty());
    (version, commit)
}

fn read_log_tail(path: &Path) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return "No Hermes startup log was available.".into();
    };
    let tail = raw.lines().rev().take(12).collect::<Vec<_>>();
    let mut tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    tail = redact_text(&tail);
    if tail.trim().is_empty() {
        "Hermes startup log was empty.".into()
    } else {
        format!("Hermes log tail:\n{tail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn sse_parser_preserves_structured_engine_events() {
        let input = b": keepalive\n\nevent: tool.started\ndata: {\"tool\":\"mcp__hii__read\"}\n\nevent: run.completed\ndata: {\"status\":\"completed\"}\n\n";
        let mut events = Vec::new();
        parse_sse(Cursor::new(input), |event| {
            events.push(event);
            true
        })
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "tool.started");
        assert_eq!(events[1].kind, "run.completed");
    }

    #[test]
    fn tool_boundary_allows_only_hii_mcp_and_clarification() {
        assert!(is_hii_governed_tool("mcp__hii__read"));
        assert!(is_hii_governed_tool("clarify"));
        assert!(!is_hii_governed_tool("terminal"));
        assert!(!is_hii_governed_tool("write_file"));
        assert!(!is_hii_governed_tool("browser_navigate"));
    }

    #[test]
    fn engine_api_must_remain_on_explicit_loopback_port() {
        assert!(validate_loopback_url("http://127.0.0.1:8642").is_ok());
        assert!(validate_loopback_url("http://localhost:8642").is_ok());
        assert!(validate_loopback_url("https://127.0.0.1:8642").is_err());
        assert!(validate_loopback_url("http://example.com:8642").is_err());
        assert!(validate_loopback_url("http://127.0.0.1").is_err());
    }

    #[test]
    fn model_endpoint_gets_exactly_one_v1_suffix() {
        assert_eq!(
            openai_base_url("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080/v1"
        );
        assert_eq!(
            openai_base_url("http://127.0.0.1:8080/v1/"),
            "http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    fn url_component_rejects_path_injection() {
        assert!(url_component("run_abc-123").is_ok());
        assert!(url_component("../status").is_err());
        assert!(url_component("run/stop").is_err());
    }

    #[test]
    fn mcp_cache_must_match_the_direct_hii_surface_exactly() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("cache")).unwrap();
        let tools = crate::acp::tools()
            .iter()
            .filter(|tool| crate::acp::is_directly_executable(tool.name))
            .map(|tool| json!({ "name": tool.name }))
            .collect::<Vec<_>>();
        fs::write(
            home.path().join("cache/mcp_schema_cache.json"),
            serde_json::to_vec(&json!({ "hii": { "tools": tools } })).unwrap(),
        )
        .unwrap();
        assert!(validate_hii_mcp_cache(home.path()).is_ok());

        fs::write(
            home.path().join("cache/mcp_schema_cache.json"),
            br#"{"hii":{"tools":[{"name":"shell"},{"name":"unexpected"}]}}"#,
        )
        .unwrap();
        assert!(validate_hii_mcp_cache(home.path()).is_err());
    }
}
