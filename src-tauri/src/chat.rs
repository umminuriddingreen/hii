// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Native chat is a projection of shared Rust state in the local HII database.

use hii_chat::{
    files::AppFiles,
    model::{Conversation, Generation, SendRequest, Settings, Snapshot},
    provider::{validate_settings, OpenAiCompatible},
    runtime::{RuntimeManager, RuntimeStatus},
    service::{ConversationService, EventSink},
    store::Store,
};
use std::sync::Arc;
use tauri::{Emitter, State};

struct ChatEvents(tauri::AppHandle);

impl EventSink for ChatEvents {
    fn persistence_failed(&self, generation_id: &str, error: &str) {
        let _ = self.0.emit_to(
            "main",
            "hii://chat-error",
            serde_json::json!({
                "generationId": generation_id, "error": error
            }),
        );
    }

    fn publish(&self, snapshot: Snapshot) {
        if let Err(error) = self.0.emit_to("main", "hii://chat-updated", snapshot) {
            eprintln!("HII chat event failed: {error}");
        }
    }
}

pub struct ChatState {
    service: Arc<ConversationService>,
    runtime: RuntimeManager,
    control: tokio::sync::Mutex<()>,
}

impl ChatState {
    pub fn open(app: tauri::AppHandle) -> Result<Self, String> {
        let root = hii_core::runtime_root()?;
        let database = std::env::var_os("HII_DB_PATH")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("hii.db"));
        let files = Arc::new(AppFiles::acquire_database(&root, &database).map_err(error)?);
        let store = Arc::new(Store::open(&database).map_err(error)?);
        store.recover().map_err(error)?;
        let service = Arc::new(ConversationService::new(store, Arc::new(ChatEvents(app))));
        Ok(Self {
            service,
            runtime: RuntimeManager::new(files),
            control: tokio::sync::Mutex::new(()),
        })
    }

    pub fn shutdown(&self) {
        self.service.cancel_all();
        if let Err(error) = self.runtime.stop() {
            eprintln!("HII chat runtime stop failed: {error}");
        }
    }
}

type ApiResult<T> = Result<T, String>;
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn chat_conversation_list(state: State<ChatState>) -> ApiResult<Vec<Conversation>> {
    state.service.store.list().map_err(error)
}

#[tauri::command]
pub fn chat_conversation_create(state: State<ChatState>) -> ApiResult<Snapshot> {
    state.service.store.create().map_err(error)
}

#[tauri::command]
pub fn chat_conversation_get(state: State<ChatState>, id: String) -> ApiResult<Snapshot> {
    state.service.store.snapshot(&id).map_err(error)
}

#[tauri::command]
pub fn chat_conversation_select_branch(
    state: State<ChatState>,
    id: String,
    leaf: String,
) -> ApiResult<Snapshot> {
    state.service.store.select_branch(&id, &leaf).map_err(error)
}

#[tauri::command]
pub async fn chat_message_send(
    state: State<'_, ChatState>,
    request: SendRequest,
) -> ApiResult<Generation> {
    let _guard = state.control.lock().await;
    let settings = state.service.store.settings().map_err(error)?;
    let provider = Arc::new(OpenAiCompatible::new(&settings.endpoint).map_err(error)?);
    state
        .service
        .start(request, settings, provider)
        .map_err(error)
}

#[tauri::command]
pub fn chat_generation_stop(state: State<ChatState>, id: String) -> ApiResult<()> {
    state.service.cancel(&id).map_err(error)
}

#[tauri::command]
pub fn chat_settings_get(state: State<ChatState>) -> ApiResult<Settings> {
    state.service.store.settings().map_err(error)
}

#[tauri::command]
pub async fn chat_settings_set(state: State<'_, ChatState>, settings: Settings) -> ApiResult<()> {
    let _guard = state.control.lock().await;
    if state.service.has_active() {
        return Err("Stop generation before changing settings".into());
    }
    if state.runtime.owned() {
        return Err("Stop the managed runtime before changing settings".into());
    }
    validate_settings(&settings).map_err(error)?;
    state.service.store.save_settings(&settings).map_err(error)
}

#[tauri::command]
pub async fn chat_runtime_status(state: State<'_, ChatState>) -> ApiResult<RuntimeStatus> {
    let settings = state.service.store.settings().map_err(error)?;
    Ok(state.runtime.status(&settings).await)
}

#[tauri::command]
pub async fn chat_runtime_start(state: State<'_, ChatState>) -> ApiResult<()> {
    let _guard = state.control.lock().await;
    let settings = state.service.store.settings().map_err(error)?;
    state.runtime.start(&settings).map_err(error)
}

#[tauri::command]
pub async fn chat_runtime_stop(state: State<'_, ChatState>) -> ApiResult<()> {
    let _guard = state.control.lock().await;
    if state.service.has_active() {
        return Err("Stop generation before stopping the runtime".into());
    }
    state.runtime.stop().map_err(error)
}
