// SPDX-License-Identifier: LicenseRef-BSL-1.1
use serde::{Deserialize, Serialize};

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessagePart {
    Text { text: String },
    Reasoning { text: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub parent_id: Option<String>,
    pub role: String,
    pub parts: Vec<MessagePart>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub active_leaf_id: Option<String>,
    pub revision: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Generation {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub status: String,
    pub model: String,
    pub endpoint: String,
    pub error: Option<String>,
    pub finish_reason: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub conversation: Conversation,
    pub messages: Vec<Message>,
    pub generations: Vec<Generation>,
    pub branch: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub endpoint: String,
    pub model: String,
    pub max_tokens: u32,
    pub managed: bool,
    pub executable: String,
    pub model_path: String,
    pub context_size: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            endpoint: "http://127.0.0.1:8080/v1".into(),
            model: String::new(),
            max_tokens: 512,
            managed: false,
            executable: String::new(),
            model_path: String::new(),
            context_size: 4096,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendRequest {
    pub conversation_id: String,
    pub parent_id: Option<String>,
    pub parts: Vec<MessagePart>,
}
