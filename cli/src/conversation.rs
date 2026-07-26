use crate::{
    agent::{choose_model, execute_tool, parse_action, Action},
    config::AppPaths,
    ollama::{ChatResult, ChatUsage, Message, Ollama},
    receipt::{
        find_receipt, redact_text, unix_ms, ConversationStore, Receipt, RunStore,
        VerificationRecord,
    },
    skills,
    tools::Toolbelt,
};
use serde_json::json;
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const AUTO_COMPACT_CHARS: usize = 64 * 1024;
const COMPACTION_TRANSCRIPT_CHARS: usize = 56 * 1024;

struct CompactionStats {
    before_messages: usize,
    before_chars: usize,
    after_chars: usize,
}

#[derive(Default)]
struct SessionUsage {
    calls: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_duration_ms: u64,
    latest_prompt_tokens: u64,
    latest_tokens_per_second: f64,
}

#[derive(Clone, Copy)]
enum ThinkingMode {
    Off,
    Compact,
    Detailed,
}

impl SessionUsage {
    fn record(&mut self, usage: &ChatUsage) {
        self.calls += 1;
        self.prompt_tokens += usage.prompt_tokens;
        self.completion_tokens += usage.completion_tokens;
        self.total_duration_ms += usage.total_duration_ms;
        self.latest_prompt_tokens = usage.prompt_tokens;
        self.latest_tokens_per_second = usage.tokens_per_second();
    }

    fn summary(&self) -> String {
        let context_percent = (self.latest_prompt_tokens as f64 / 32_768.0 * 100.0).min(100.0);
        format!(
            "{} in · {} out · {:.1} tok/s · {:.1}s · {:.0}% context",
            format_count(self.prompt_tokens),
            format_count(self.completion_tokens),
            self.latest_tokens_per_second,
            self.total_duration_ms as f64 / 1_000.0,
            context_percent
        )
    }
}

pub struct Conversation {
    paths: AppPaths,
    ollama: Ollama,
    model: String,
    tools: Toolbelt,
    messages: Vec<Message>,
    store: ConversationStore,
    max_steps: usize,
    usage: SessionUsage,
    last_skill_draft: Option<String>,
    thinking_mode: ThinkingMode,
}

impl Conversation {
    pub fn new(
        paths: AppPaths,
        workspace: PathBuf,
        requested_model: Option<String>,
        max_steps: usize,
    ) -> Result<Self, String> {
        let tools = Toolbelt::new(workspace)?;
        let ollama = Ollama::new(AppPaths::ollama_url());
        let model = choose_model(requested_model.as_deref(), &ollama.models()?)?;
        let store = ConversationStore::create(&paths.runtime)?;
        let messages = vec![Message::system(conversation_prompt(
            tools.workspace(),
            max_steps,
        ))];
        Ok(Self {
            paths,
            ollama,
            model,
            tools,
            messages,
            store,
            max_steps,
            usage: SessionUsage::default(),
            last_skill_draft: None,
            thinking_mode: ThinkingMode::Compact,
        })
    }

    pub fn reply(&mut self, input: &str) -> Result<String, String> {
        if self.context_chars() >= AUTO_COMPACT_CHARS {
            self.compact_internal("automatic")?;
        }
        self.store
            .event("user.message", json!({ "content": redact_text(input) }))?;
        self.messages.push(Message::user(input));

        let mut run: Option<RunStore> = None;
        let mut verification = Vec::new();
        let mut used_tools = false;
        let mut mutating_work = false;
        let mut parse_failures = 0usize;

        for step in 1..=self.max_steps {
            let raw = self
                .call_activity("thinking", self.messages.clone(), true)?
                .content;
            self.store.event(
                "model.action",
                json!({ "step": step, "content": redact_text(&raw) }),
            )?;
            let action = match parse_action(&raw) {
                Ok(action) => action,
                Err(error) => {
                    parse_failures += 1;
                    self.messages.push(Message::assistant(raw));
                    self.messages.push(Message::user(format!(
                        "Protocol error: {error}. Return exactly one valid JSON action."
                    )));
                    if parse_failures >= 3 {
                        return Err("the local model lost the conversation protocol".into());
                    }
                    continue;
                }
            };
            parse_failures = 0;
            match action {
                Action::Message { message } => {
                    if mutating_work && verification.is_empty() {
                        self.messages.push(Message::assistant(raw));
                        self.messages.push(Message::user(
                            "You changed or executed workspace state. Verify the result with the verify or http tool before replying.",
                        ));
                        continue;
                    }
                    let message = redact_text(&message);
                    self.messages.push(Message::assistant(message.clone()));
                    self.finish_backend_run(run, input, step, &message, verification)?;
                    self.store
                        .event("assistant.message", json!({ "content": message }))?;
                    return Ok(message);
                }
                Action::Final { summary, next, .. } => {
                    if mutating_work && verification.is_empty() {
                        self.messages.push(Message::assistant(raw));
                        self.messages.push(Message::user(
                            "Verify the workspace result before answering conversationally.",
                        ));
                        continue;
                    }
                    let message = match next.filter(|value| !value.trim().is_empty()) {
                        Some(next) => format!("{}\n\nNext: {next}", summary.trim()),
                        None => summary,
                    };
                    let message = redact_text(&message);
                    self.messages.push(Message::assistant(message.clone()));
                    self.finish_backend_run(run, input, step, &message, verification)?;
                    self.store
                        .event("assistant.message", json!({ "content": message }))?;
                    return Ok(message);
                }
                Action::Tool {
                    tool,
                    path,
                    query,
                    command,
                    content,
                    url,
                    old,
                    new,
                    replace_all,
                    offset,
                    limit,
                    ..
                } => {
                    used_tools = true;
                    let shell_evidence = tool == "shell"
                        && command.as_deref().is_some_and(shell_command_is_read_only);
                    mutating_work |=
                        tool == "write" || tool == "edit" || (tool == "shell" && !shell_evidence);
                    if run.is_none() {
                        let created = RunStore::create(&self.paths.runtime)?;
                        created.event(
                            "run.started",
                            json!({
                                "goal": redact_text(input),
                                "workspace": self.tools.workspace(),
                                "model": self.model,
                                "conversation": self.store.id
                            }),
                        )?;
                        run = Some(created);
                    }
                    let result = if crate::hii_tools::is_hii_tool(&tool) {
                        crate::hii_tools::execute(&self.paths.repo, &tool, query.as_deref())
                    } else {
                        execute_tool(
                            &self.tools,
                            crate::agent::ToolCall {
                                tool: &tool,
                                path: path.as_deref(),
                                query: query.as_deref(),
                                command: command.as_deref(),
                                content: content.as_deref(),
                                url: url.as_deref(),
                                old: old.as_deref(),
                                new: new.as_deref(),
                                replace_all,
                                offset,
                                limit,
                            },
                            false,
                        )
                    };
                    let safe_output = redact_text(&result.output);
                    if result.verification || shell_evidence {
                        verification.push(VerificationRecord {
                            command: command
                                .clone()
                                .or_else(|| url.clone())
                                .unwrap_or_else(|| tool.clone()),
                            ok: result.ok,
                            output: safe_output.clone(),
                        });
                    }
                    if let Some(run) = &run {
                        run.event(
                            "tool.result",
                            json!({
                                "step": step,
                                "tool": tool,
                                "ok": result.ok,
                                "verification": result.verification,
                                "output": safe_output
                            }),
                        )?;
                    }
                    self.messages.push(Message::assistant(raw));
                    self.messages.push(Message::user(format!(
                        "TOOL RESULT [{}]:\n{}",
                        if result.ok { "ok" } else { "error" },
                        safe_output
                    )));
                }
            }
        }

        if used_tools {
            self.finish_backend_run(
                run,
                input,
                self.max_steps,
                "I reached the workspace step limit before I could finish cleanly.",
                verification,
            )?;
        }
        Ok("I lost the thread there. Try saying that once more, a little more directly.".into())
    }

    pub fn compact(&mut self) -> Result<String, String> {
        let stats = self.compact_internal("manual")?;
        Ok(format!(
            "Compacted {} messages ({} characters) into a {}-character checkpoint.",
            stats.before_messages, stats.before_chars, stats.after_chars
        ))
    }

    pub fn clear(&mut self) -> Result<String, String> {
        let removed = self.messages.len().saturating_sub(1);
        let system = self
            .messages
            .first()
            .cloned()
            .ok_or_else(|| "conversation system context is missing".to_string())?;
        self.messages = vec![system];
        self.store.event(
            "conversation.cleared",
            json!({ "removed_messages": removed }),
        )?;
        Ok(if removed == 0 {
            "The conversation is already clear.".into()
        } else {
            format!("Cleared {removed} messages. We have a fresh context now.")
        })
    }

    /// Drop the most recent user↔assistant exchange from the working context so
    /// the operator can steer away from a wrong turn (plan Phase 8, conversational
    /// half). Environmental restore is git's job; this restores dialogue state.
    pub fn undo(&mut self) -> Result<String, String> {
        // Keep the leading system message(s); remove the last two entries.
        if self.messages.len() <= 1 {
            return Ok("Nothing to undo.".into());
        }
        let removed = self.messages.len().min(2);
        for _ in 0..removed {
            if self.messages.len() > 1 {
                self.messages.pop();
            }
        }
        self.store
            .event("conversation.undo", json!({ "removed_messages": removed }))?;
        let dirty = self.tools.git_snapshot();
        let hint = if dirty == "clean" || dirty == "not a git workspace" {
            String::new()
        } else {
            "\nWorkspace has uncommitted changes; use `git restore` / `git stash` to revert files."
                .into()
        };
        Ok(format!("Undid the last exchange.{hint}"))
    }

    /// Snapshot the current conversation to a new fork the operator can resume,
    /// leaving the live session untouched (plan Phase 8). Returns the fork id.
    pub fn fork(&self) -> Result<String, String> {
        let fork = ConversationStore::create(&self.paths.runtime)?;
        for message in &self.messages {
            fork.event(
                "forked.message",
                json!({ "role": message.role, "content": redact_text(&message.content) }),
            )?;
        }
        Ok(format!(
            "Forked this conversation to {}. The live session is unchanged.",
            fork.id
        ))
    }

    /// Graduate the session into a reusable skill in the HII registry (plan
    /// Phase 10). Writes a skill record under `~/.hii/skills/`.
    pub fn teach(&mut self, name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("usage: /teach <skill-name>".into());
        }
        let slug: String = name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let slug = slug.trim_matches('-').to_string();
        if slug.is_empty() {
            return Err("skill name must contain letters or digits".into());
        }
        let dir = self.paths.runtime.join("skills");
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let recent: Vec<String> = self
            .messages
            .iter()
            .filter(|m| m.role == "user")
            .rev()
            .take(3)
            .map(|m| redact_text(&m.content))
            .collect();
        let record = json!({
            "name": slug,
            "title": name,
            "source": "hii-cli:/teach",
            "created_at": chrono::Utc::now().to_rfc3339(),
            "workspace": self.tools.workspace().display().to_string(),
            "model": self.model,
            "goals": recent,
        });
        let path = dir.join(format!("{slug}.json"));
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&record).unwrap_or_default(),
        )
        .map_err(|error| error.to_string())?;
        self.last_skill_draft = Some(slug.clone());
        self.store
            .event("conversation.teach", json!({ "skill": slug }))?;
        Ok(format!("Taught skill `{slug}` → {}", path.display()))
    }

    pub fn status(&self) -> String {
        let learning = self
            .last_skill_draft
            .as_deref()
            .unwrap_or("none this session");
        format!(
            "{} messages · {} characters\n{}\n{}\n{}\nLearning draft: {}",
            self.messages.len().saturating_sub(1),
            self.context_chars(),
            self.model,
            self.tools.workspace().display(),
            self.usage.summary(),
            learning
        )
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    /// Run a direct shell command from the `!` grammar, bounded by the same
    /// workspace guards as the agent's shell tool.
    pub fn shell(&self, command: &str) -> String {
        if command.is_empty() {
            return "usage: !<command>".into();
        }
        self.tools.shell(command, false).output
    }

    #[cfg(feature = "preview")]
    pub fn workspace(&self) -> &std::path::Path {
        self.tools.workspace()
    }

    pub fn usage(&self) -> String {
        if self.usage.calls == 0 {
            "No model activity in this session yet.".into()
        } else {
            format!("{} calls · {}", self.usage.calls, self.usage.summary())
        }
    }

    pub fn activity_footer(&self) -> Option<String> {
        (self.usage.calls > 0).then(|| self.usage.summary())
    }

    pub fn skills(&self) -> Result<String, String> {
        skills::list(&self.paths)
    }

    pub fn thinking(&mut self, requested: Option<&str>) -> Result<String, String> {
        let Some(requested) = requested else {
            return Ok("Thinking activity: off | compact | detailed".into());
        };
        self.thinking_mode = match requested {
            "off" => ThinkingMode::Off,
            "compact" => ThinkingMode::Compact,
            "detailed" => ThinkingMode::Detailed,
            _ => return Err("thinking mode must be off, compact, or detailed".into()),
        };
        self.store
            .event("conversation.thinking_mode", json!({"mode": requested}))?;
        Ok(format!("Thinking activity set to {requested}."))
    }

    pub fn model(&mut self, requested: Option<&str>) -> Result<String, String> {
        let models = self.ollama.models()?;
        let Some(requested) = requested.filter(|value| !value.trim().is_empty()) else {
            let rows = models
                .iter()
                .map(|model| {
                    if model == &self.model {
                        format!("{model}  current")
                    } else {
                        model.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(rows);
        };
        let selected = choose_model(Some(requested), &models)?;
        let previous = std::mem::replace(&mut self.model, selected.clone());
        self.store.event(
            "conversation.model_changed",
            json!({ "from": previous, "to": selected }),
        )?;
        Ok(format!("Switched to {selected}."))
    }

    pub fn proof(&self, id: Option<&str>) -> Result<String, String> {
        let path = find_receipt(&self.paths.runtime, id)?;
        let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let receipt: Receipt = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let checks = receipt.verification.iter().filter(|check| check.ok).count();
        Ok(format!(
            "{}\n{}\n{} verified check(s)\n{}",
            receipt.status,
            receipt.summary,
            checks,
            path.display()
        ))
    }

    fn compact_internal(&mut self, reason: &str) -> Result<CompactionStats, String> {
        let before_messages = self.messages.len().saturating_sub(1);
        let before_chars = self.context_chars();
        if before_messages == 0 {
            return Ok(CompactionStats {
                before_messages,
                before_chars,
                after_chars: 0,
            });
        }

        let transcript = self.compaction_transcript();
        let summary = if before_chars <= 8_000 {
            transcript
        } else {
            let prompt = format!(
                "Compact this HII conversation into a durable checkpoint for continuing the same session. Preserve the user's goals, preferences, decisions, commitments, exact workspace facts, completed tool outcomes, unresolved questions, and next actions. Remove greetings, repetition, protocol JSON, hidden bookkeeping, run identifiers, and low-value chatter. Do not invent facts. Write concise plain text with short sections when useful.\n\n{transcript}"
            );
            let summary_messages = vec![
                Message::system("You compact conversation context faithfully and economically."),
                Message::user(prompt),
            ];
            redact_text(
                &self
                    .call_activity("compacting", summary_messages, false)?
                    .content,
            )
        };
        let system = self
            .messages
            .first()
            .cloned()
            .ok_or_else(|| "conversation system context is missing".to_string())?;
        let checkpoint = format!(
            "Conversation checkpoint. Treat this as prior context, not a new user request:\n{summary}"
        );
        let after_chars = checkpoint.chars().count();
        self.messages = vec![system, Message::system(checkpoint)];
        self.store.event(
            "conversation.compacted",
            json!({
                "reason": reason,
                "before_messages": before_messages,
                "before_chars": before_chars,
                "after_chars": after_chars,
                "summary": summary
            }),
        )?;
        Ok(CompactionStats {
            before_messages,
            before_chars,
            after_chars,
        })
    }

    fn context_chars(&self) -> usize {
        self.messages
            .iter()
            .skip(1)
            .map(|message| message.content.chars().count())
            .sum()
    }

    fn compaction_transcript(&self) -> String {
        let mut transcript = self
            .messages
            .iter()
            .skip(1)
            .map(|message| format!("{}: {}", message.role, redact_text(&message.content)))
            .collect::<Vec<_>>()
            .join("\n\n");
        let length = transcript.chars().count();
        if length > COMPACTION_TRANSCRIPT_CHARS {
            let tail: String = transcript
                .chars()
                .skip(length - COMPACTION_TRANSCRIPT_CHARS)
                .collect();
            transcript = format!("[older low-priority context omitted]\n\n{tail}");
        }
        transcript
    }

    fn call_activity(
        &mut self,
        phase: &str,
        messages: Vec<Message>,
        json: bool,
    ) -> Result<ChatResult, String> {
        let ollama = self.ollama.clone();
        let model = self.model.clone();
        let model_for_thread = model.clone();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let result = if json {
                ollama.chat_json_with_usage(&model_for_thread, &messages)
            } else {
                ollama.chat_text_with_usage(&model_for_thread, &messages)
            };
            let _ = sender.send(result);
        });

        self.receive_activity(phase, model, receiver)
    }

    fn receive_activity(
        &mut self,
        phase: &str,
        model: String,
        receiver: mpsc::Receiver<Result<ChatResult, String>>,
    ) -> Result<ChatResult, String> {
        let started = Instant::now();
        let frames = ["◐", "◓", "◑", "◒"];
        let mut frame = 0usize;
        let interactive =
            io::stdout().is_terminal() && !matches!(self.thinking_mode, ThinkingMode::Off);
        loop {
            match receiver.recv_timeout(Duration::from_millis(120)) {
                Ok(result) => {
                    if interactive {
                        print!("\x1b[2K\r");
                        let _ = io::stdout().flush();
                    }
                    let result = result?;
                    self.usage.record(&result.usage);
                    self.store.event(
                        "usage.model_call",
                        json!({
                            "model": model,
                            "phase": phase,
                            "prompt_tokens": result.usage.prompt_tokens,
                            "completion_tokens": result.usage.completion_tokens,
                            "prompt_duration_ms": result.usage.prompt_duration_ms,
                            "completion_duration_ms": result.usage.completion_duration_ms,
                            "total_duration_ms": result.usage.total_duration_ms,
                            "tokens_per_second": result.usage.tokens_per_second()
                        }),
                    )?;
                    return Ok(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if interactive {
                        let estimated_context = self.context_chars() / 4;
                        match self.thinking_mode {
                            ThinkingMode::Compact => print!(
                                "\r{} {} · {:.1}s",
                                frames[frame % frames.len()],
                                phase,
                                started.elapsed().as_secs_f64()
                            ),
                            ThinkingMode::Detailed => print!(
                                "\r{} {} · {:.1}s · {} · ~{} ctx",
                                frames[frame % frames.len()],
                                phase,
                                started.elapsed().as_secs_f64(),
                                compact_model_name(&model),
                                format_count(estimated_context as u64)
                            ),
                            ThinkingMode::Off => {}
                        }
                        let _ = io::stdout().flush();
                        frame += 1;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if interactive {
                        print!("\x1b[2K\r");
                    }
                    return Err("the local model activity worker stopped unexpectedly".into());
                }
            }
        }
    }

    fn finish_backend_run(
        &mut self,
        run: Option<RunStore>,
        input: &str,
        steps: usize,
        summary: &str,
        verification: Vec<VerificationRecord>,
    ) -> Result<(), String> {
        let Some(run) = run else {
            return Ok(());
        };
        let receipt = Receipt {
            schema_version: 1,
            id: run.id.clone(),
            created_at_unix_ms: run.started_at_unix_ms,
            finished_at_unix_ms: unix_ms(),
            status: "completed".into(),
            goal: redact_text(input),
            workspace: self.tools.workspace().display().to_string(),
            model: self.model.clone(),
            review_model: None,
            steps,
            summary: redact_text(summary),
            verification,
            git_status: self.tools.git_snapshot(),
            next: None,
            review: None,
            risk: "Conversation used bounded local workspace tools; details are stored in the backend receipt.".into(),
            authority: Some("workspace".into()),
            done_when: None,
            approvals: Vec::new(),
            artifacts: Vec::new(),
            reversible: None,
        };
        run.event(
            "run.finished",
            json!({ "status": receipt.status, "summary": receipt.summary }),
        )?;
        let receipt_path = run.finish(&self.paths.runtime, &receipt)?;
        if receipt.verification.iter().any(|check| check.ok) {
            let checks = receipt
                .verification
                .iter()
                .filter(|check| check.ok)
                .map(|check| check.command.clone())
                .collect::<Vec<_>>();
            let messages = skills::candidate_messages(
                &receipt.goal,
                &receipt.summary,
                &checks,
                &self.compaction_transcript(),
                &skills::active_sessions(&self.paths),
            );
            let explicit = explicit_skill_signal(input);
            match self
                .call_activity("learning", messages, false)
                .and_then(|result| skills::parse_candidate(&result.content))
            {
                Ok(candidate) if candidate.repeatable || explicit => {
                    let candidate = if explicit {
                        skills::honor_explicit_request(candidate, &receipt.goal, &receipt.summary)
                    } else {
                        candidate
                    };
                    self.persist_skill_candidate(&receipt, &receipt_path, &candidate)?;
                }
                Ok(_) => {}
                Err(_error) if explicit => {
                    let candidate = skills::explicit_candidate(&receipt.goal, &receipt.summary);
                    self.persist_skill_candidate(&receipt, &receipt_path, &candidate)?;
                }
                Err(error) => {
                    self.store.event(
                        "skill.analysis_failed",
                        json!({"error": redact_text(&error), "receipt": receipt.id}),
                    )?;
                }
            }
        }
        Ok(())
    }

    fn persist_skill_candidate(
        &mut self,
        receipt: &Receipt,
        receipt_path: &std::path::Path,
        candidate: &skills::SkillCandidate,
    ) -> Result<(), String> {
        match skills::report_draft(
            &self.paths,
            receipt,
            receipt_path,
            candidate,
            &self.store.id,
        ) {
            Ok(id) => {
                self.last_skill_draft = Some(id.clone());
                self.store.event(
                    "skill.draft_created",
                    json!({"id": id, "receipt": receipt.id}),
                )?;
            }
            Err(error) => {
                self.store.event(
                    "skill.draft_failed",
                    json!({"error": redact_text(&error), "receipt": receipt.id}),
                )?;
            }
        }
        Ok(())
    }
}

fn compact_model_name(model: &str) -> &str {
    model.strip_suffix("-mlx").unwrap_or(model)
}

fn format_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}m", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}k", value as f64 / 1_000.0)
    } else {
        value.to_string()
    }
}

fn shell_command_is_read_only(command: &str) -> bool {
    let lowered = command.trim().to_ascii_lowercase();
    let mutating_markers = [
        ">",
        "tee ",
        "sed -i",
        "perl -i",
        "mv ",
        "cp ",
        "mkdir ",
        "touch ",
        "git add",
        "git commit",
        "git switch",
        "git checkout",
        "npm install",
        "cargo fmt",
    ];
    if mutating_markers
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return false;
    }
    let read_only = [
        "rg ",
        "rg\t",
        "ls ",
        "ls\t",
        "cat ",
        "head ",
        "tail ",
        "sed -n",
        "find ",
        "pwd",
        "wc ",
        "stat ",
        "file ",
        "git status",
        "git diff",
        "git log",
        "git show",
        "git branch",
        "cargo test",
        "cargo check",
        "cargo clippy",
        "npm test",
        "npm run check",
        "npm run build",
        "python3 -m json.tool",
        "node --check",
    ];
    read_only.iter().any(|prefix| lowered.starts_with(prefix))
}

fn explicit_skill_signal(input: &str) -> bool {
    let input = input.to_ascii_lowercase();
    [
        "repeatable",
        "create a skill",
        "make this a skill",
        "learn this workflow",
        "save this workflow",
    ]
    .iter()
    .any(|signal| input.contains(signal))
}

fn conversation_prompt(workspace: &std::path::Path, max_steps: usize) -> String {
    format!(
        r#"You are HII, Ummi's conversational local workspace partner. Sound natural, direct, warm, and concise. Maintain continuity across the conversation.

For greetings, questions, reflection, or ordinary conversation, respond immediately with:
{{"type":"message","message":"your natural response"}}

Only use workspace tools when the user asks you to inspect, change, build, diagnose, or verify something. Use one tool at a time. After workspace work, answer naturally with what matters; never expose run IDs, model names, step counters, internal event paths, action JSON, or receipt boilerplate unless explicitly asked.

Workspace: {workspace}
Maximum tool steps per turn: {max_steps}

Tool action (the tool name is the type):
{{"type":"read|list|search|write|edit|shell|verify|http","path":"optional relative path","query":"for search","command":"for shell or verify","content":"for write","old":"exact text to replace (edit)","new":"replacement text (edit)","replace_all":false,"url":"for local http","reason":"short internal reason"}}

Do not publish, push, spend, message third parties, delete, read secrets, or leave the workspace. If you write or execute workspace state, verify it before replying. Return exactly one JSON object and no Markdown wrapper."#,
        workspace = workspace.display()
    )
}

#[cfg(test)]
mod tests {
    use super::shell_command_is_read_only;

    #[test]
    fn recognizes_read_only_shell_evidence() {
        assert!(shell_command_is_read_only("rg -n 'cli' Cargo.toml"));
        assert!(shell_command_is_read_only("git status --short"));
        assert!(!shell_command_is_read_only("cp source target"));
        assert!(!shell_command_is_read_only(
            "rg cli Cargo.toml > result.txt"
        ));
    }

    #[test]
    fn recognizes_explicit_skill_requests() {
        assert!(super::explicit_skill_signal(
            "Treat this as a repeatable workflow"
        ));
        assert!(super::explicit_skill_signal("Make this a skill"));
        assert!(!super::explicit_skill_signal("hello there"));
    }
}
