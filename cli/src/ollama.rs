use crate::config::ModelProvider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: Message,
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
    pub usage: ChatUsage,
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

    pub fn chat_json(&self, model: &str, messages: &[Message]) -> Result<String, String> {
        Ok(self.chat_json_with_usage(model, messages)?.content)
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
                "num_ctx": 32768
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
            "messages": messages,
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
        Ok(ChatResult { content, usage })
    }
}

fn action_schema() -> Value {
    json!({
        "type": "object",
        "required": ["type"],
        "properties": {
            "type": {
                "enum": [
                    "read", "list", "search", "write", "edit", "shell", "verify", "http",
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
    }
}
