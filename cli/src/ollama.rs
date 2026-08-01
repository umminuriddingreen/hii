use crate::attachments::ImagePayload;
use crate::budget::Cancel;
use crate::config::ModelProvider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
    time::Duration,
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

/// OpenAI-compatible `/v1/models` listing (served by LM Studio and Ollama).
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
            ModelProvider::LmStudio => {
                let response: OpenAiModels = self
                    .agent
                    .get(&format!("{}/v1/models", self.base_url))
                    .call()
                    .map_err(format_ureq)?
                    .into_json()
                    .map_err(|error| format!("invalid model listing: {error}"))?;
                Ok(response.data.into_iter().map(|model| model.id).collect())
            }
        }
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

    pub fn chat_json_with_usage(
        &self,
        model: &str,
        messages: &[Message],
    ) -> Result<ChatResult, String> {
        self.chat(model, messages, Some(action_schema()))
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
        let result = match self.provider {
            ModelProvider::Ollama => self.chat_ollama(model, messages, format),
            ModelProvider::LmStudio => self.chat_openai(model, messages, format),
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

    /// OpenAI-compatible chat (`/v1/chat/completions`), used for LM Studio. A
    /// requested JSON schema maps to `response_format: json_object` since not
    /// all backends honor a full schema constraint.
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
        if format.is_some() {
            body["response_format"] = json!({ "type": "json_object" });
        }
        let value: Value = self
            .agent
            .post(&format!("{}/v1/chat/completions", self.base_url))
            .send_json(body)
            .map_err(format_ureq)?
            .into_json()
            .map_err(|error| format!("invalid chat response: {error}"))?;
        let content = value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let usage = ChatUsage {
            prompt_tokens: value["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            completion_tokens: value["usage"]["completion_tokens"].as_u64().unwrap_or(0),
            prompt_duration_ms: 0,
            completion_duration_ms: 0,
            total_duration_ms: 0,
        };
        Ok(ChatResult {
            content,
            thinking: String::new(),
            usage,
        })
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
        if self.provider != ModelProvider::Ollama {
            let result = if json_format {
                self.chat_json_with_usage(model, messages)
            } else {
                self.chat_text_with_usage(model, messages)
            };
            if let Ok(chat) = &result {
                if !chat.thinking.is_empty() {
                    let _ = sender.send(ChatStreamEvent::Thinking(chat.thinking.clone()));
                }
                if !chat.content.is_empty() {
                    let _ = sender.send(ChatStreamEvent::Content(chat.content.clone()));
                }
            }
            let _ = sender.send(ChatStreamEvent::Done(result));
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
            body["format"] = action_schema();
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
}

fn openai_messages(messages: &[Message]) -> Value {
    Value::Array(
        messages
            .iter()
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
            })
            .collect(),
    )
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
    json!({
        "type": "object",
        "required": ["type"],
        "properties": {
            "type": {
                "enum": [
                    "read", "list", "search", "web_search", "web_fetch", "write", "edit", "shell", "verify", "http", "mcp_call",
                    "hii_context", "og_next", "caps_check", "board_read", "board_write",
                    "skill_search", "bridge_send", "bridge_read", "final", "message"
                ]
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
    let provider = match provider {
        ModelProvider::Ollama => "ollama",
        ModelProvider::LmStudio => "lmstudio",
    };
    let entry = json!({
        "ts": chrono_now(),
        "source": "hii-cli",
        "provider": provider,
        "model": model,
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_duration_ms": usage.total_duration_ms,
    });
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
            format!("Ollama returned HTTP {code}: {}", body.trim())
        }
        ureq::Error::Transport(error) => format!("cannot reach local Ollama: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{openai_messages, Message, RepetitionGuard};
    use crate::attachments::ImagePayload;

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
}
