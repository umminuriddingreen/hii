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

#[derive(Clone)]
pub struct Ollama {
    base_url: String,
    agent: ureq::Agent,
}

impl Ollama {
    pub fn new(base_url: String) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(600))
            .timeout_write(Duration::from_secs(30))
            .build();
        Self { base_url, agent }
    }

    pub fn models(&self) -> Result<Vec<String>, String> {
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

    pub fn chat_json(&self, model: &str, messages: &[Message]) -> Result<String, String> {
        Ok(self.chat_json_with_usage(model, messages)?.content)
    }

    pub fn chat_json_with_usage(
        &self,
        model: &str,
        messages: &[Message],
    ) -> Result<ChatResult, String> {
        let schema = json!({
            "type": "object",
            "required": ["type"],
            "properties": {
                "type": { "enum": ["tool", "final", "message"] },
                "tool": { "enum": ["read", "list", "search", "write", "shell", "verify", "http"] },
                "path": { "type": "string" },
                "query": { "type": "string" },
                "command": { "type": "string" },
                "content": { "type": "string" },
                "url": { "type": "string" },
                "reason": { "type": "string" },
                "summary": { "type": "string" },
                "message": { "type": "string" },
                "verification": { "type": "array", "items": { "type": "string" } },
                "next": { "type": ["string", "null"] }
            }
        });
        self.chat(model, messages, Some(schema))
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
