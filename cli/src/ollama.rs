use crate::attachments::ImagePayload;
use crate::budget::Cancel;
use crate::config::{ModelProvider, OX_ALPHA_WEB_MODEL, OX_ALPHA_WEB_URL};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::ToSocketAddrs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(skip)]
    pub image_mime_types: Vec<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
            images: Vec::new(),
            image_mime_types: Vec::new(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            images: Vec::new(),
            image_mime_types: Vec::new(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            images: Vec::new(),
            image_mime_types: Vec::new(),
        }
    }

    pub fn user_with_images(content: impl Into<String>, images: Vec<ImagePayload>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            images: images.iter().map(|image| image.base64.clone()).collect(),
            image_mime_types: images.into_iter().map(|image| image.mime_type).collect(),
        }
    }
}

/// Collapse HII's independently governed system contexts into the single
/// leading system message required by OpenAI-compatible local servers.
fn provider_messages(messages: &[Message]) -> Vec<Message> {
    let system = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.trim())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut normalized = Vec::with_capacity(messages.len());
    if !system.is_empty() {
        normalized.push(Message::system(system));
    }
    normalized.extend(
        messages
            .iter()
            .filter(|message| message.role != "system")
            .cloned(),
    );
    normalized
}

#[derive(Debug, Default, Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ResponseMessage,
    #[serde(default)]
    prompt_eval_count: u64,
    #[serde(default)]
    eval_count: u64,
    #[serde(default)]
    prompt_eval_duration: u64,
    #[serde(default)]
    eval_duration: u64,
    #[serde(default)]
    total_duration: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ChatUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub prompt_duration_ms: u64,
    pub completion_duration_ms: u64,
    pub total_duration_ms: u64,
}

impl ChatUsage {
    pub fn tokens_per_second(&self) -> f64 {
        if self.completion_duration_ms == 0 {
            0.0
        } else {
            self.completion_tokens as f64 / (self.completion_duration_ms as f64 / 1_000.0)
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChatResult {
    pub content: String,
    pub thinking: String,
    pub usage: ChatUsage,
}

/// Sent when a generation is abandoned rather than failing on its own.
pub const CANCELLED: &str = "generation cancelled";

#[derive(Debug)]
pub enum ChatStreamEvent {
    Thinking(String),
    Content(String),
    Done(Result<ChatResult, String>),
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<ModelTag>,
}

#[derive(Debug, Deserialize)]
struct ModelTag {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RunningModelsResponse {
    #[serde(default)]
    models: Vec<RunningModel>,
}

#[derive(Debug, Deserialize)]
struct RunningModel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    model: String,
}

/// OpenAI-compatible `/v1/models` listing used by LM Studio and HII.
#[derive(Debug, Deserialize)]
struct OpenAiModels {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Clone)]
pub struct Ollama {
    base_url: String,
    provider: ModelProvider,
    agent: ureq::Agent,
}

impl Ollama {
    pub fn new(base_url: String) -> Self {
        let provider = ModelProvider::discover(&base_url);
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(600))
            .timeout_write(Duration::from_secs(30))
            .build();
        Self {
            base_url,
            provider,
            agent,
        }
    }

    /// Choose the lowest-friction local runtime. An explicit model URL always
    /// wins; otherwise a ready HII endpoint wins over Ollama.
    pub fn discover() -> Self {
        if std::env::var_os("HII_MODEL_URL").is_some()
            || std::env::var_os("HII_OLLAMA_URL").is_some()
            || std::env::var_os("HII_RAPID_MLX_URL").is_some()
            || std::env::var_os("HII_MODEL_PROVIDER").is_some()
        {
            return Self::new(crate::config::AppPaths::model_url());
        }
        if crate::config::AppPaths::discover()
            .ok()
            .and_then(|paths| paths.user_model_preference().ok().flatten())
            .and_then(|preference| preference.provider)
            .as_deref()
            == Some(ModelProvider::OxAlphaWeb.id())
        {
            return Self::new(OX_ALPHA_WEB_URL.to_string());
        }
        Self::for_mode("auto")
    }

    pub fn for_mode(_mode: &str) -> Self {
        Self::new("http://127.0.0.1:11435".to_string())
    }

    pub fn provider_label(&self) -> &'static str {
        self.provider.label()
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn provider(&self) -> ModelProvider {
        self.provider
    }

    /// Bring a local provider up when none is listening yet, preferring HII's
    /// own native runner so inference stays inside a runtime HII owns. The
    /// native runner is only started when its weights were already acquired —
    /// model download stays an explicit operator action. Ollama remains an
    /// explicit compatibility provider, never an automatic runtime dependency.
    /// An explicitly pinned model URL is never second-guessed.
    pub fn ensure_reachable(self) -> Result<Self, String> {
        if self.provider == ModelProvider::OxAlphaWeb {
            ox_alpha_browser_adapter()?;
            return Ok(self);
        }
        if endpoint_ready(&self.base_url) {
            return Ok(self);
        }
        if pinned_model_url() {
            return Err(self.unreachable_error());
        }
        if let Some(native) = start_native_runner() {
            return Ok(native);
        }
        Err(self.unreachable_error())
    }

    fn unreachable_error(&self) -> String {
        format!(
            "cannot reach {} at {}. Bring up HII's own runtime with \
`hii-native-runner serve` (acquire weights first: `hii runner model start --model <id>`), \
or explicitly pin a compatibility provider with HII_MODEL_URL=<url> (or HII_RAPID_MLX_URL=<url>).",
            self.provider_label(),
            self.base_url
        )
    }

    pub fn models(&self) -> Result<Vec<String>, String> {
        match self.provider {
            ModelProvider::Ollama => {
                let response: TagsResponse = self
                    .agent
                    .get(&format!("{}/api/tags", self.base_url))
                    .call()
                    .map_err(format_ureq)?
                    .into_json()
                    .map_err(|error| format!("invalid Ollama model response: {error}"))?;
                Ok(response
                    .models
                    .into_iter()
                    .map(|model| model.name)
                    .collect())
            }
            ModelProvider::LmStudio | ModelProvider::Native | ModelProvider::RapidMlx => {
                let response: OpenAiModels = self
                    .agent
                    .get(&format!("{}/v1/models", self.base_url))
                    .call()
                    .map_err(format_ureq)?
                    .into_json()
                    .map_err(|error| format!("invalid model listing: {error}"))?;
                Ok(response.data.into_iter().map(|model| model.id).collect())
            }
            ModelProvider::OxAlphaWeb => {
                ox_alpha_browser_adapter()?;
                Ok(vec![OX_ALPHA_WEB_MODEL.to_string()])
            }
        }
    }

    /// Return models that the provider explicitly reports as loaded now.
    ///
    /// Ollama exposes this distinction at `/api/ps`. OpenAI-compatible local
    /// runtimes only expose a model catalog, so `None` means "not observable"
    /// rather than "nothing loaded". The short timeout keeps status surfaces
    /// from hanging behind a stalled local provider.
    pub fn running_models(&self) -> Result<Option<Vec<String>>, String> {
        if self.provider != ModelProvider::Ollama {
            return Ok(None);
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(1))
            .timeout_read(Duration::from_secs(2))
            .timeout_write(Duration::from_secs(2))
            .build();
        let response: RunningModelsResponse = agent
            .get(&format!("{}/api/ps", self.base_url))
            .call()
            .map_err(format_ureq)?
            .into_json()
            .map_err(|error| format!("invalid Ollama running-model response: {error}"))?;
        Ok(Some(
            response
                .models
                .into_iter()
                .filter_map(|model| {
                    let name = if model.name.trim().is_empty() {
                        model.model
                    } else {
                        model.name
                    };
                    (!name.trim().is_empty()).then_some(name)
                })
                .collect(),
        ))
    }

    pub fn model_supports_vision(&self, model: &str) -> Result<Option<bool>, String> {
        if self.provider != ModelProvider::Ollama {
            return Ok(None);
        }
        let value: Value = self
            .agent
            .post(&format!("{}/api/show", self.base_url))
            .send_json(json!({ "model": model }))
            .map_err(format_ureq)?
            .into_json()
            .map_err(|error| format!("invalid Ollama model details: {error}"))?;
        Ok(Some(value["capabilities"].as_array().is_some_and(
            |items| items.iter().any(|item| item.as_str() == Some("vision")),
        )))
    }

    pub fn chat_text(&self, model: &str, messages: &[Message]) -> Result<String, String> {
        Ok(self.chat_text_with_usage(model, messages)?.content)
    }

    pub fn chat_text_with_usage(
        &self,
        model: &str,
        messages: &[Message],
    ) -> Result<ChatResult, String> {
        self.chat(model, messages, None)
    }

    fn chat(
        &self,
        model: &str,
        messages: &[Message],
        format: Option<Value>,
    ) -> Result<ChatResult, String> {
        let messages = provider_messages(messages);
        let result = match self.provider {
            ModelProvider::Ollama => self.chat_ollama(model, &messages, format),
            ModelProvider::LmStudio | ModelProvider::Native | ModelProvider::RapidMlx => {
                self.chat_openai(model, &messages, format)
            }
            ModelProvider::OxAlphaWeb => self.chat_website(model, &messages),
        };
        if let Ok(chat) = &result {
            log_llm_request(model, self.provider, &chat.usage);
        }
        result
    }

    fn chat_ollama(
        &self,
        model: &str,
        messages: &[Message],
        format: Option<Value>,
    ) -> Result<ChatResult, String> {
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "think": false,
            "keep_alive": "10m",
            "options": {
                "temperature": 0.1,
                "num_ctx": 32768,
                "repeat_penalty": 1.1,
                "repeat_last_n": 256
            }
        });
        if let Some(format) = format {
            body["format"] = format;
        }
        let response: ChatResponse = self
            .agent
            .post(&format!("{}/api/chat", self.base_url))
            .send_json(body)
            .map_err(format_ureq)?
            .into_json()
            .map_err(|error| format!("invalid Ollama chat response: {error}"))?;
        Ok(ChatResult {
            content: response.message.content,
            thinking: response.message.thinking,
            usage: ChatUsage {
                prompt_tokens: response.prompt_eval_count,
                completion_tokens: response.eval_count,
                prompt_duration_ms: response.prompt_eval_duration / 1_000_000,
                completion_duration_ms: response.eval_duration / 1_000_000,
                total_duration_ms: response.total_duration / 1_000_000,
            },
        })
    }

    /// OpenAI-compatible chat (`/v1/chat/completions`), used for LM Studio and
    /// HII. A requested JSON schema maps to `response_format:
    /// json_object` since not all backends honor a full schema constraint.
    fn chat_openai(
        &self,
        model: &str,
        messages: &[Message],
        format: Option<Value>,
    ) -> Result<ChatResult, String> {
        let mut body = json!({
            "model": model,
            "messages": openai_messages(messages),
            "stream": false,
            "temperature": 0.1,
        });
        // The blocking path is the structured/JSON path; it mirrors the Ollama
        // branch's `"think": false` and asks for an answer directly.
        apply_thinking(&mut body, false);
        if format.is_some() {
            body["response_format"] = json!({ "type": "json_object" });
        }
        let started = Instant::now();
        let value: Value = self
            .agent
            .post(&format!("{}/v1/chat/completions", self.base_url))
            .send_json(body)
            .map_err(format_ureq)?
            .into_json()
            .map_err(|error| format!("invalid chat response: {error}"))?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let message = &value["choices"][0]["message"];
        let content = message["content"].as_str().unwrap_or_default().to_string();
        // Reasoning arrives under a provider-specific key on the message, the
        // same set the streaming path already handles.
        let thinking = openai_reasoning_delta(message)
            .unwrap_or_default()
            .to_string();
        // Prefer what the backend reports; otherwise time the call here. Without
        // a first-token signal the whole call counts as completion time.
        let (prompt_duration_ms, completion_duration_ms, total_duration_ms) =
            openai_reported_durations(&value["usage"]).unwrap_or((0, elapsed_ms, elapsed_ms));
        let usage = ChatUsage {
            prompt_tokens: value["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            completion_tokens: value["usage"]["completion_tokens"].as_u64().unwrap_or(0),
            prompt_duration_ms,
            completion_duration_ms,
            total_duration_ms,
        };
        Ok(ChatResult {
            content,
            thinking,
            usage,
        })
    }

    /// Ox Alpha is controlled through the rendered website DOM in HII's
    /// headless Chromium worker. HII supplies its bounded action protocol in
    /// the prompt and remains the only tool executor.
    fn chat_website(&self, model: &str, messages: &[Message]) -> Result<ChatResult, String> {
        run_ox_alpha_browser(model, messages, &Cancel::new(), None)
    }

    /// Stream an Ollama response so provider-supplied thinking can be rendered
    /// without inserting it into the next model request.
    /// Stream a completion.
    ///
    /// `cancel` is checked once per received chunk so a run can abandon a
    /// generation in progress. The agent-level read timeout cannot do this: it
    /// resets on every chunk, so a model emitting one token per second holds the
    /// socket open indefinitely while satisfying it.
    pub fn chat_with_stream(
        &self,
        model: &str,
        messages: &[Message],
        json_format: bool,
        think: bool,
        cancel: &Cancel,
        sender: mpsc::Sender<ChatStreamEvent>,
    ) {
        self.chat_with_stream_format(model, messages, json_format, true, think, cancel, sender);
    }

    /// Retry a structured action request without a provider-side grammar.
    /// Some local backends reject both schema and broad JSON constraints before
    /// returning any tokens; HII still validates the action with its own parser.
    pub fn chat_with_stream_unconstrained(
        &self,
        model: &str,
        messages: &[Message],
        think: bool,
        cancel: &Cancel,
        sender: mpsc::Sender<ChatStreamEvent>,
    ) {
        self.chat_with_stream_format(model, messages, false, false, think, cancel, sender);
    }

    #[allow(clippy::too_many_arguments)]
    fn chat_with_stream_format(
        &self,
        model: &str,
        messages: &[Message],
        json_format: bool,
        strict_json_schema: bool,
        think: bool,
        cancel: &Cancel,
        sender: mpsc::Sender<ChatStreamEvent>,
    ) {
        if self.provider == ModelProvider::OxAlphaWeb {
            let result = run_ox_alpha_browser(model, messages, cancel, Some(&sender));
            if let Ok(result) = &result {
                log_llm_request(model, self.provider, &result.usage);
            }
            let _ = sender.send(ChatStreamEvent::Done(result));
            return;
        }
        if self.provider != ModelProvider::Ollama {
            self.chat_openai_with_stream(model, messages, json_format, think, cancel, sender);
            return;
        }

        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "think": think,
            "keep_alive": "10m",
            "options": {
                "temperature": 0.1,
                "num_ctx": 32768,
                "repeat_penalty": 1.1,
                "repeat_last_n": 256
            }
        });
        if json_format {
            body["format"] = if strict_json_schema {
                action_schema()
            } else {
                json!("json")
            };
        }
        let response = match self
            .agent
            .post(&format!("{}/api/chat", self.base_url))
            .send_json(body)
            .map_err(format_ureq)
        {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(ChatStreamEvent::Done(Err(error)));
                return;
            }
        };

        let mut content = String::new();
        let mut thinking = String::new();
        let mut usage = ChatUsage::default();
        // Models commonly rehearse a structured action in private thinking before
        // emitting the same JSON publicly. Keep the channels independent so that
        // one valid action is not counted as another thinking-loop repetition.
        let mut thinking_repetition = RepetitionGuard::default();
        let mut content_repetition = RepetitionGuard::default();
        for line in BufReader::new(response.into_reader()).lines() {
            if cancel.is_cancelled() {
                let _ = sender.send(ChatStreamEvent::Done(Err(CANCELLED.into())));
                return;
            }
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = sender.send(ChatStreamEvent::Done(Err(format!(
                        "failed to read Ollama stream: {error}"
                    ))));
                    return;
                }
            };
            let chunk: ChatResponse = match serde_json::from_str(&line) {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = sender.send(ChatStreamEvent::Done(Err(format!(
                        "invalid Ollama stream response: {error}"
                    ))));
                    return;
                }
            };
            if !chunk.message.thinking.is_empty() {
                thinking.push_str(&chunk.message.thinking);
                if thinking_repetition.observe(&chunk.message.thinking) {
                    let _ = sender.send(ChatStreamEvent::Done(Err(
                        "MODEL LOOP DETECTED — the current generation repeated the same substantial block three times. The session is preserved; revise or retry the request."
                            .into(),
                    )));
                    return;
                }
                let _ = sender.send(ChatStreamEvent::Thinking(chunk.message.thinking));
            }
            if !chunk.message.content.is_empty() {
                if content_repetition.observe(&chunk.message.content) {
                    let _ = sender.send(ChatStreamEvent::Done(Err(
                        "MODEL LOOP DETECTED — the current generation repeated the same substantial block three times. The session is preserved; revise or retry the request."
                            .into(),
                    )));
                    return;
                }
                let _ = sender.send(ChatStreamEvent::Content(chunk.message.content.clone()));
            }
            content.push_str(&chunk.message.content);
            usage = ChatUsage {
                prompt_tokens: chunk.prompt_eval_count,
                completion_tokens: chunk.eval_count,
                prompt_duration_ms: chunk.prompt_eval_duration / 1_000_000,
                completion_duration_ms: chunk.eval_duration / 1_000_000,
                total_duration_ms: chunk.total_duration / 1_000_000,
            };
        }
        let result = ChatResult {
            content,
            thinking,
            usage,
        };
        log_llm_request(model, self.provider, &result.usage);
        let _ = sender.send(ChatStreamEvent::Done(Ok(result)));
    }

    fn chat_openai_with_stream(
        &self,
        model: &str,
        messages: &[Message],
        json_format: bool,
        think: bool,
        cancel: &Cancel,
        sender: mpsc::Sender<ChatStreamEvent>,
    ) {
        let started = Instant::now();
        let request = {
            let mut body = json!({
                "model": model,
                "messages": openai_messages(messages),
                "stream": true,
                "stream_options": { "include_usage": true },
                "temperature": 0.1,
            });
            apply_thinking(&mut body, think);
            if json_format {
                body["response_format"] = json!({ "type": "json_object" });
            }
            self.agent
                .post(&format!("{}/v1/chat/completions", self.base_url))
                .send_json(body)
                .map_err(format_ureq)
        };
        let response = match request {
            Ok(response) => response,
            Err(error) => {
                let _ = sender.send(ChatStreamEvent::Done(Err(error)));
                return;
            }
        };
        let result = consume_openai_sse(response, started, cancel, Some(&sender));
        if let Ok(result) = &result {
            log_llm_request(model, self.provider, &result.usage);
        }
        let _ = sender.send(ChatStreamEvent::Done(result));
    }
}

fn ox_alpha_browser_adapter() -> Result<PathBuf, String> {
    let path = std::env::var_os("HII_OXALPHA_BROWSER_ADAPTER")
        .map(PathBuf::from)
        .or_else(|| {
            crate::config::AppPaths::discover()
                .ok()
                .map(|paths| paths.repo.join("browser/dist/src/oxalpha-main.js"))
        })
        .ok_or_else(|| {
            "Ox Alpha requires HII's Chromium worker; set HII_ROOT to a HII checkout".to_string()
        })?;
    if !path.is_file() {
        return Err(format!(
            "Ox Alpha browser adapter is missing at {}; run `npm --prefix browser run build`",
            path.display()
        ));
    }
    Ok(path)
}

fn ox_alpha_browser_prompt(messages: &[Message]) -> String {
    let mut prompt = String::from(
        "This conversation is being relayed by HII through the Ox Alpha website UI. HII owns and executes every tool. Follow the HII runtime instructions below exactly and return its flat JSON action protocol when a tool is needed.\n",
    );
    for message in messages {
        prompt.push('\n');
        prompt.push_str(&message.role.to_ascii_uppercase());
        prompt.push_str(":\n");
        prompt.push_str(&message.content);
        prompt.push('\n');
    }
    prompt
}

fn run_ox_alpha_browser(
    model: &str,
    messages: &[Message],
    cancel: &Cancel,
    sender: Option<&mpsc::Sender<ChatStreamEvent>>,
) -> Result<ChatResult, String> {
    let adapter = ox_alpha_browser_adapter()?;
    let started = Instant::now();
    let mut child = Command::new("node")
        .arg(&adapter)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start HII Chromium for Ox Alpha: {error}"))?;
    let request = json!({
        "model": model,
        "prompt": ox_alpha_browser_prompt(messages),
    });
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| "Ox Alpha browser adapter stdin is unavailable".to_string())?;
    serde_json::to_writer(&mut input, &request)
        .map_err(|error| format!("could not encode Ox Alpha browser request: {error}"))?;
    input
        .flush()
        .map_err(|error| format!("could not send Ox Alpha browser request: {error}"))?;
    drop(input);

    let output = child
        .stdout
        .take()
        .ok_or_else(|| "Ox Alpha browser adapter stdout is unavailable".to_string())?;
    let mut content = String::new();
    let mut first_token_at = None;
    let mut done = false;
    for line in BufReader::new(output).lines() {
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        let line = line.map_err(|error| format!("failed to read Ox Alpha DOM stream: {error}"))?;
        let event: Value = serde_json::from_str(&line)
            .map_err(|error| format!("invalid Ox Alpha DOM stream event: {error}"))?;
        match event["type"].as_str() {
            Some("delta") => {
                let delta = event["content"].as_str().unwrap_or_default();
                if !delta.is_empty() {
                    first_token_at.get_or_insert_with(Instant::now);
                    content.push_str(delta);
                    if let Some(sender) = sender {
                        let _ = sender.send(ChatStreamEvent::Content(delta.to_string()));
                    }
                }
            }
            Some("done") => done = true,
            Some("error") => {
                let _ = child.wait();
                return Err(format!(
                    "Ox Alpha browser failed: {}",
                    event["message"].as_str().unwrap_or("unknown DOM error")
                ));
            }
            _ => {}
        }
    }
    let status = child
        .wait()
        .map_err(|error| format!("could not finish Ox Alpha browser adapter: {error}"))?;
    if !status.success() || !done || content.trim().is_empty() {
        return Err("Ox Alpha browser closed before a complete rendered response".into());
    }
    let total_duration_ms = started.elapsed().as_millis() as u64;
    let prompt_duration_ms = first_token_at
        .map(|at| at.duration_since(started).as_millis() as u64)
        .unwrap_or(total_duration_ms);
    Ok(ChatResult {
        content: content.clone(),
        thinking: String::new(),
        usage: ChatUsage {
            prompt_tokens: ox_alpha_browser_prompt(messages).chars().count() as u64 / 4,
            completion_tokens: content.chars().count() as u64 / 4,
            prompt_duration_ms,
            completion_duration_ms: total_duration_ms.saturating_sub(prompt_duration_ms),
            total_duration_ms,
        },
    })
}

fn consume_openai_sse(
    response: ureq::Response,
    started: Instant,
    cancel: &Cancel,
    sender: Option<&mpsc::Sender<ChatStreamEvent>>,
) -> Result<ChatResult, String> {
    let mut content = String::new();
    let mut thinking = String::new();
    let mut usage = ChatUsage::default();
    let mut reported_durations = None;
    let mut first_token_at = None;
    let mut content_repetition = RepetitionGuard::default();
    for line in BufReader::new(response.into_reader()).lines() {
        if cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        let line = line.map_err(|error| format!("failed to read model stream: {error}"))?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|error| format!("invalid model stream response: {error}"))?;
        if let Some(error) = value.get("error") {
            return Err(format!(
                "model stream error: {}",
                provider_error_message(error)
            ));
        }
        let delta = &value["choices"][0]["delta"];
        if let Some(text) = openai_reasoning_delta(delta) {
            first_token_at.get_or_insert_with(Instant::now);
            thinking.push_str(text);
            if let Some(sender) = sender {
                let _ = sender.send(ChatStreamEvent::Thinking(text.to_string()));
            }
        }
        if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
            first_token_at.get_or_insert_with(Instant::now);
            if content_repetition.observe(text) {
                return Err(
                    "MODEL LOOP DETECTED — the current generation repeated the same substantial block three times. The session is preserved; revise or retry the request."
                        .into(),
                );
            }
            content.push_str(text);
            if let Some(sender) = sender {
                let _ = sender.send(ChatStreamEvent::Content(text.to_string()));
            }
        }
        if let Some(value) = value.get("usage") {
            usage.prompt_tokens = value["prompt_tokens"].as_u64().unwrap_or(0);
            usage.completion_tokens = value["completion_tokens"].as_u64().unwrap_or(0);
            reported_durations = reported_durations.or_else(|| openai_reported_durations(value));
        }
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let (prompt_ms, completion_ms, total_ms) = reported_durations.unwrap_or_else(|| {
        let prompt_ms = first_token_at
            .map(|at: Instant| at.duration_since(started).as_millis() as u64)
            .unwrap_or(0);
        (prompt_ms, elapsed_ms.saturating_sub(prompt_ms), elapsed_ms)
    });
    usage.prompt_duration_ms = prompt_ms;
    usage.completion_duration_ms = completion_ms;
    usage.total_duration_ms = total_ms;
    Ok(ChatResult {
        content,
        thinking,
        usage,
    })
}

fn provider_error_message(value: &Value) -> String {
    value
        .get("message")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .unwrap_or("unknown provider error")
        .to_string()
}

fn pinned_model_url() -> bool {
    std::env::var_os("HII_MODEL_URL").is_some()
        || std::env::var_os("HII_OLLAMA_URL").is_some()
        || std::env::var_os("HII_RAPID_MLX_URL").is_some()
}

/// Wait for the native runner while showing the operator that startup is
/// happening. A first run has to fetch weights, so the wait is long and silence
/// would read as a hang; the runner's own log tail is the progress report.
fn wait_ready_verbose(
    base_url: &str,
    timeout: Duration,
    log: &std::path::Path,
    child: &mut std::process::Child,
) -> bool {
    use std::io::{IsTerminal, Write};

    let show = std::io::stderr().is_terminal();
    let started = std::time::Instant::now();
    let frames = ['|', '/', '-', '\\'];
    let mut tick = 0usize;
    while started.elapsed() < timeout {
        if endpoint_ready(base_url) {
            if show {
                eprint!("\r\x1b[2K");
                let _ = std::io::stderr().flush();
            }
            return true;
        }
        // A runner that has already exited will never listen; report what it
        // said rather than spending the whole timeout waiting on a dead process.
        if matches!(child.try_wait(), Ok(Some(_))) {
            if show {
                eprint!("\r\x1b[2K");
                let _ = std::io::stderr().flush();
            }
            eprintln!("hii: HII exited during startup — {}", log_tail(log));
            eprintln!("hii: full startup log at {}", log.display());
            return false;
        }
        if show {
            let detail = log_tail(log);
            eprint!(
                "\r\x1b[2K{} starting HII ({}s){}",
                frames[tick % frames.len()],
                started.elapsed().as_secs(),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(" — {detail}")
                }
            );
            let _ = std::io::stderr().flush();
        }
        tick += 1;
        std::thread::sleep(Duration::from_millis(250));
    }
    if show {
        eprint!("\r\x1b[2K");
        let _ = std::io::stderr().flush();
    }
    false
}

/// Last non-empty log line, trimmed to one terminal line's worth of detail.
fn log_tail(log: &std::path::Path) -> String {
    let Ok(text) = std::fs::read_to_string(log) else {
        return String::new();
    };
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    line.chars()
        .rev()
        .take(96)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Return the model only when a completed native-runner manifest proves that a
/// prior explicit acquisition loaded it successfully. `pending-load` is written
/// before Hugging Face access begins, so accepting it here would turn bare
/// `hii` startup into implicit model acquisition.
fn acquired_native_model(manifest: &Value) -> Option<String> {
    let integrity = manifest.get("integrity")?.as_str()?.trim();
    if integrity.is_empty() || integrity == "pending-load" {
        return None;
    }
    let model = manifest.get("model")?.as_str()?.trim();
    (!model.is_empty()).then(|| model.to_string())
}

/// Start HII only when weights were acquired explicitly beforehand.
/// Missing, malformed, or pending manifests fail closed without spawning the
/// runner, network access, or a model download.
fn start_native_runner() -> Option<Ollama> {
    let native_url = "http://127.0.0.1:11435";
    let paths = crate::config::AppPaths::discover().ok()?;
    let model_home = paths.runtime.join("models");
    let binary = paths.repo.join("target/release/hii-native-runner");
    if !binary.is_file() {
        return None;
    }
    let manifest: Value = std::fs::read(model_home.join("runtime-manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
    let model = acquired_native_model(&manifest)?;

    let log = paths.runtime.join("logs/native-runner.log");
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    let mut child = spawn_logged(
        binary.to_str()?,
        &[
            "serve",
            "--model",
            &model,
            "--model-home",
            model_home.to_str()?,
        ],
        &log,
    )?;
    wait_ready_verbose(native_url, Duration::from_secs(60), &log, &mut child)
        .then(|| Ollama::new(native_url.to_string()))
}

/// Spawn the runner detached from this terminal but with its output kept, so
/// startup progress and any failure survive for the wait loop and the operator.
fn spawn_logged(
    program: &str,
    args: &[&str],
    log: &std::path::Path,
) -> Option<std::process::Child> {
    let out = std::fs::File::create(log).ok()?;
    let err = out.try_clone().ok()?;
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(out))
        .stderr(std::process::Stdio::from(err))
        .spawn()
        .ok()
}

fn endpoint_ready(base_url: &str) -> bool {
    let address = base_url
        .strip_prefix("http://")
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or(base_url);
    let Ok(mut addresses) = address.to_socket_addrs() else {
        return false;
    };
    addresses.next().is_some_and(|address| {
        std::net::TcpStream::connect_timeout(&address, Duration::from_millis(120)).is_ok()
    })
}

/// Durations an OpenAI-compatible backend reported itself, in milliseconds.
/// Ollama-style backends report nanoseconds here; HII and LM Studio
/// report nothing, which is why callers fall back to client-side wall clock.
fn openai_reported_durations(usage: &Value) -> Option<(u64, u64, u64)> {
    let prompt = usage["prompt_eval_duration"].as_u64();
    let completion = usage["eval_duration"].as_u64();
    let total = usage["total_duration"].as_u64();
    if prompt.is_none() && completion.is_none() && total.is_none() {
        return None;
    }
    Some((
        prompt.unwrap_or(0) / 1_000_000,
        completion.unwrap_or(0) / 1_000_000,
        total.unwrap_or(0) / 1_000_000,
    ))
}

/// Apply the operator's reasoning setting to an OpenAI-compatible request body.
///
/// Ollama has a first-class `"think"` field; the OpenAI wire format has none,
/// so each server invents its own. HII's runner (mlx-vlm) reads a **top-level**
/// `enable_thinking` and, failing that, the OpenAI-standard `reasoning_effort`;
/// it then splits the model's `<think>` block out into `reasoning_content`,
/// which [`openai_reasoning_delta`] already understands. `chat_template_kwargs`
/// — the spelling vLLM uses — is silently ignored there: sending it produced
/// byte-identical output for `true` and `false` against the live 9B runner,
/// which is exactly how this stayed unnoticed. Send both keys so the setting
/// lands on either server, and pair them so a backend that honors only one
/// still agrees with the other.
fn apply_thinking(body: &mut Value, think: bool) {
    body["enable_thinking"] = json!(think);
    body["reasoning_effort"] = json!(if think { "medium" } else { "none" });
}

fn openai_reasoning_delta(delta: &Value) -> Option<&str> {
    ["reasoning_content", "reasoning", "thinking"]
        .into_iter()
        .find_map(|key| delta[key].as_str().filter(|text| !text.is_empty()))
}

fn openai_messages(messages: &[Message]) -> Value {
    // Some OpenAI-compatible chat templates (including Qwen through MLX-VLM)
    // require exactly one system message and require it to be first. HII keeps
    // independently managed system contexts internally so they can be replaced
    // or removed by feature; collapse them only at the provider boundary.
    let system = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.trim())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let ordered = (!system.is_empty())
        .then(|| json!({ "role": "system", "content": system }))
        .into_iter()
        .chain(
            messages
                .iter()
                .filter(|message| message.role != "system")
                .map(|message| {
                    if message.images.is_empty() {
                        return json!({ "role": message.role, "content": message.content });
                    }
                    let mut content = vec![json!({ "type": "text", "text": message.content })];
                    for (index, image) in message.images.iter().enumerate() {
                        let mime = message
                            .image_mime_types
                            .get(index)
                            .map(String::as_str)
                            .unwrap_or("image/png");
                        content.push(json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{mime};base64,{image}") }
                        }));
                    }
                    json!({ "role": message.role, "content": content })
                }),
        )
        .collect();
    Value::Array(ordered)
}

#[derive(Default)]
struct RepetitionGuard {
    text: String,
    last_checked_at: usize,
}

impl RepetitionGuard {
    fn observe(&mut self, delta: &str) -> bool {
        self.text.push_str(delta);
        if self.text.len().saturating_sub(self.last_checked_at) < 128 {
            return false;
        }
        self.last_checked_at = self.text.len();
        let words = self
            .text
            .split_whitespace()
            .map(|word| {
                word.trim_matches(|character: char| !character.is_alphanumeric())
                    .to_ascii_lowercase()
            })
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>();
        const BLOCK_WORDS: usize = 28;
        if words.len() < BLOCK_WORDS * 3 {
            return false;
        }
        let tail = &words[words.len() - BLOCK_WORDS..];
        words
            .windows(BLOCK_WORDS)
            .filter(|window| *window == tail)
            .take(3)
            .count()
            >= 3
    }
}

fn action_schema() -> Value {
    let mut action_types = crate::acp::action_type_names(true);
    action_types.push("mcp_call");
    json!({
        "type": "object",
        "required": ["type"],
        "properties": {
            "type": {
                "enum": action_types
            },
            "path": { "type": "string" },
            "query": { "type": "string" },
            "command": { "type": "string" },
            "content": { "type": "string" },
            "url": { "type": "string" },
            "old": { "type": "string" },
            "new": { "type": "string" },
            "replace_all": { "type": "boolean" },
            "offset": { "type": "integer" },
            "limit": { "type": "integer" },
            "reason": { "type": "string" },
            "summary": { "type": "string" },
            "message": { "type": "string" },
            "server": { "type": "string" },
            "tool": { "type": "string" },
            "arguments": { "type": "object" },
            "verification": { "type": "array", "items": { "type": "string" } },
            "next": { "type": ["string", "null"] }
        }
    })
}

/// Append a compact record of a model call to `~/.hii/traces/llm_requests.jsonl`
/// (per the HII LLM-tracking rule). Best-effort: logging never fails a run.
fn log_llm_request(model: &str, provider: ModelProvider, usage: &ChatUsage) {
    use std::io::Write;
    let runtime = std::env::var_os("HII_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| crate::config::home_dir().ok().map(|home| home.join(".hii")));
    let Some(runtime) = runtime else {
        return;
    };
    let dir = runtime.join("traces");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut entry = json!({
        "ts": chrono_now(),
        "source": "hii-cli",
        "provider": provider.id(),
        "model": model,
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_duration_ms": usage.total_duration_ms,
        "origin": crate::run_context::origin().label(),
    });
    // Without this the trace is unattributable: cost and latency are recorded,
    // but nothing says which run spent it. Absent outside a run (`hii find`,
    // `hii proof`), where there is no receipt to point at.
    if let Some(run_id) = crate::run_context::run_id() {
        entry["receipt_id"] = json!(run_id);
    }
    if let Some(conversation_id) = crate::run_context::conversation_id() {
        entry["conversation_id"] = json!(conversation_id);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("llm_requests.jsonl"))
    {
        let _ = writeln!(file, "{entry}");
    }
}

fn chrono_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn format_ureq(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            format!("model provider returned HTTP {code}: {}", body.trim())
        }
        ureq::Error::Transport(error) => format!("cannot reach local model provider: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        acquired_native_model, apply_thinking, openai_messages, openai_reasoning_delta, openai_reported_durations,
        ox_alpha_browser_prompt, provider_messages, ChatUsage, Message, Ollama, RepetitionGuard,
    };
    use crate::attachments::ImagePayload;
    use crate::config::ModelProvider;

    #[test]
    fn reported_durations_are_absent_for_backends_that_do_not_time_themselves() {
        // HII and LM Studio return a usage block with tokens only, which
        // is why every session since the native default went to zero timings.
        let usage = serde_json::json!({ "prompt_tokens": 11070, "completion_tokens": 11 });
        assert_eq!(openai_reported_durations(&usage), None);
    }

    #[test]
    fn reported_durations_convert_provider_nanoseconds_to_milliseconds() {
        let usage = serde_json::json!({
            "prompt_eval_duration": 2_000_000u64,
            "eval_duration": 8_000_000u64,
            "total_duration": 10_000_000u64,
        });
        assert_eq!(openai_reported_durations(&usage), Some((2, 8, 10)));
    }

    #[test]
    fn reasoning_is_read_from_a_completed_message_not_only_a_stream_delta() {
        let message =
            serde_json::json!({ "content": "done", "reasoning_content": "weighing options" });
        assert_eq!(openai_reasoning_delta(&message), Some("weighing options"));
        let plain = serde_json::json!({ "content": "done" });
        assert_eq!(openai_reasoning_delta(&plain), None);
    }

    #[test]
    fn wall_clock_timing_makes_throughput_reportable() {
        // The fallback attributes the untimed call to completion so
        // tokens_per_second stops reading 0.0 on the native path.
        let usage = ChatUsage {
            prompt_tokens: 11_070,
            completion_tokens: 20,
            prompt_duration_ms: 0,
            completion_duration_ms: 2_000,
            total_duration_ms: 2_000,
        };
        assert_eq!(usage.tokens_per_second(), 10.0);
    }

    #[test]
    fn detects_three_substantial_repeated_blocks() {
        let block = "I should stop checking the same file and run one actual verification command before I answer the operator because another read is only observation and cannot prove the changed website works. ";
        let mut guard = RepetitionGuard::default();
        assert!(!guard.observe(block));
        assert!(!guard.observe(block));
        assert!(guard.observe(block));
    }

    #[test]
    fn does_not_treat_short_or_distinct_activity_as_a_loop() {
        let mut guard = RepetitionGuard::default();
        assert!(!guard.observe("checking the workspace "));
        assert!(!guard.observe("running the test "));
        assert!(!guard.observe("returning the result "));
    }

    #[test]
    fn private_rehearsal_does_not_count_against_visible_content() {
        let block = "I will emit exactly one bounded write action with the supplied local content, then wait for the tool result before running the requested verification action. ";
        let mut thinking = RepetitionGuard::default();
        let mut content = RepetitionGuard::default();

        assert!(!thinking.observe(block));
        assert!(!thinking.observe(block));
        assert!(!content.observe(block));
    }

    use super::action_schema;

    #[test]
    fn action_schema_uses_local_model_friendly_flat_types() {
        let schema = action_schema();
        let types = schema["properties"]["type"]["enum"]
            .as_array()
            .expect("type enum");
        assert!(types.iter().any(|value| value == "write"));
        assert!(types.iter().any(|value| value == "verify"));
        assert!(!types.iter().any(|value| value == "tool"));
        let bytes = serde_json::to_vec(&schema).expect("serialize schema").len();
        assert!(bytes <= 1_000, "action schema grew to {bytes} bytes");
    }

    #[test]
    fn openai_images_use_data_url_content_parts() {
        let message = Message::user_with_images(
            "Describe this reference",
            vec![ImagePayload {
                mime_type: "image/png".into(),
                base64: "aW1hZ2U=".into(),
            }],
        );
        let value = openai_messages(&[message]);
        assert_eq!(value[0]["content"][0]["type"], "text");
        assert_eq!(value[0]["content"][1]["type"], "image_url");
        assert_eq!(
            value[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,aW1hZ2U="
        );
    }

    #[test]
    fn openai_messages_merge_all_system_context_at_the_beginning() {
        let value = openai_messages(&[
            Message::system("primary identity"),
            Message::user("hello"),
            Message::system("context capsule"),
            Message::system("active authority"),
        ]);
        let messages = value.as_array().expect("message array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(
            messages[0]["content"],
            "primary identity\n\ncontext capsule\n\nactive authority"
        );
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hello");
    }

    /// The reasoning setting must reach OpenAI-compatible backends on the
    /// fields they actually read. `chat_template_kwargs` is not one of them:
    /// against the live mlx-vlm runner it produced byte-identical output for
    /// both settings, while `enable_thinking` yields a populated
    /// `reasoning_content` for `true` and none for `false`.
    #[test]
    fn the_reasoning_setting_reaches_openai_compatible_backends() {
        let mut on = json!({ "model": "m" });
        apply_thinking(&mut on, true);
        assert_eq!(on["enable_thinking"], json!(true));
        assert_eq!(on["reasoning_effort"], json!("medium"));

        let mut off = json!({ "model": "m" });
        apply_thinking(&mut off, false);
        assert_eq!(off["enable_thinking"], json!(false));
        assert_eq!(off["reasoning_effort"], json!("none"));

        // The two controls must never disagree: a backend honoring only one of
        // them still has to land on the operator's setting.
        for think in [true, false] {
            let mut body = json!({});
            apply_thinking(&mut body, think);
            assert_eq!(
                body["enable_thinking"].as_bool().expect("enable_thinking"),
                body["reasoning_effort"] != json!("none")
            );
        }
    }

    #[test]
    fn every_provider_receives_one_leading_system_message() {
        let messages = provider_messages(&[
            Message::system("primary"),
            Message::user("hello"),
            Message::system("late authority"),
        ]);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, "primary\n\nlate authority");
        assert_eq!(messages[1].role, "user");
    }

    #[test]
    fn openai_stream_accepts_common_reasoning_delta_names() {
        for key in ["reasoning_content", "reasoning", "thinking"] {
            let mut delta = serde_json::Map::new();
            delta.insert(key.into(), serde_json::Value::String("trace".into()));
            assert_eq!(
                openai_reasoning_delta(&serde_json::Value::Object(delta)),
                Some("trace")
            );
        }
    }

    #[test]
    fn automatic_runtime_is_hii_native() {
        let client = Ollama::for_mode("auto");
        assert_eq!(client.base_url(), "http://127.0.0.1:11435");
        assert_eq!(client.provider(), ModelProvider::Native);
    }

    #[test]
    fn website_dom_prompt_keeps_hii_instructions_and_conversation_roles() {
        let prompt = ox_alpha_browser_prompt(&[
            Message::system("HII tool protocol"),
            Message::user("inspect"),
            Message::assistant("working"),
        ]);
        assert!(prompt.contains("HII owns and executes every tool"));
        assert!(prompt.contains("SYSTEM:\nHII tool protocol"));
        assert!(prompt.contains("USER:\ninspect"));
        assert!(prompt.contains("ASSISTANT:\nworking"));
    }

    #[test]
    fn pending_native_manifest_never_authorizes_startup() {
        let manifest = serde_json::json!({
            "model": "Qwen/Qwen3-4B",
            "integrity": "pending-load"
        });
        assert_eq!(acquired_native_model(&manifest), None);
    }

    #[test]
    fn completed_native_manifest_authorizes_its_model() {
        let manifest = serde_json::json!({
            "model": "Qwen/Qwen3.5-35B-A3B",
            "integrity": "sha256-inventory-proof"
        });
        assert_eq!(
            acquired_native_model(&manifest).as_deref(),
            Some("Qwen/Qwen3.5-35B-A3B")
        );
    }
}
