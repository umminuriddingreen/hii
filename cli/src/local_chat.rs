// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Headless access to the same durable chat core used by HII desktop.

use clap::Subcommand;
use hii_chat::{
    files::AppFiles,
    model::{MessagePart, SendRequest, Snapshot},
    provider::{validate_settings, OpenAiCompatible},
    runtime::RuntimeManager,
    service::{ConversationService, EventSink},
    store::Store,
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Subcommand, Debug)]
pub enum ChatCommand {
    /// List stored local conversations as JSON, including while desktop is open.
    List,
    /// Read a conversation and its message tree as JSON.
    Show { id: String },
    /// Create a local conversation (requires exclusive chat ownership).
    New,
    /// Inspect provider settings, or update fields while desktop is closed.
    Settings {
        #[arg(long)]
        endpoint: Option<String>,
        #[arg(long)]
        model_id: Option<String>,
        #[arg(long)]
        llama_server: Option<String>,
        #[arg(long)]
        gguf: Option<String>,
        #[arg(long, action = clap::ArgAction::Set)]
        managed: Option<bool>,
    },
    /// Stream a no-tools local generation as JSON snapshots, saving all output.
    Send {
        #[arg(long)]
        conversation: Option<String>,
        #[arg(long)]
        parent: Option<String>,
        #[arg(required = true, num_args = 1..)]
        prompt: Vec<String>,
    },
}

fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}
fn print(value: &impl serde::Serialize) -> Result<(), String> {
    println!("{}", serde_json::to_string(value).map_err(error)?);
    Ok(())
}

struct JsonEvents;
impl EventSink for JsonEvents {
    fn publish(&self, snapshot: Snapshot) {
        let _ = print(&snapshot);
    }
}

pub fn execute(action: ChatCommand) -> Result<(), String> {
    let root = hii_core::runtime_root()?;
    let database = std::env::var_os("HII_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("hii.db"));
    let read_only = matches!(
        &action,
        ChatCommand::List
            | ChatCommand::Show { .. }
            | ChatCommand::Settings {
                endpoint: None,
                model_id: None,
                llama_server: None,
                gguf: None,
                managed: None
            }
    );
    let files = if read_only {
        None
    } else {
        Some(Arc::new(
            AppFiles::acquire_database(&root, &database).map_err(error)?,
        ))
    };
    std::fs::create_dir_all(&root).map_err(error)?;
    let store = Arc::new(Store::open(&database).map_err(error)?);
    if files.is_some() {
        store.recover().map_err(error)?;
    }
    match action {
        ChatCommand::List => print(&store.list().map_err(error)?),
        ChatCommand::Show { id } => print(&store.snapshot(&id).map_err(error)?),
        ChatCommand::New => print(&store.create().map_err(error)?),
        ChatCommand::Settings { endpoint, model_id, llama_server, gguf, managed } => {
            let mut settings = store.settings().map_err(error)?;
            if let Some(value) = endpoint { settings.endpoint = value; }
            if let Some(value) = model_id { settings.model = value; }
            if let Some(value) = llama_server { settings.executable = value; }
            if let Some(value) = gguf { settings.model_path = value; }
            if let Some(value) = managed { settings.managed = value; }
            if !read_only {
                validate_settings(&settings).map_err(error)?;
                store.save_settings(&settings).map_err(error)?;
            }
            print(&settings)
        }
        ChatCommand::Send { conversation, parent, prompt } => {
            tokio::runtime::Runtime::new().map_err(error)?.block_on(async move {
                let settings = store.settings().map_err(error)?;
                validate_settings(&settings).map_err(error)?;
                let runtime = RuntimeManager::new(files.ok_or("Chat ownership was not acquired")?);
                if settings.managed {
                    runtime.start(&settings).map_err(error)?;
                    let deadline = Instant::now() + Duration::from_secs(180);
                    loop {
                        let status = runtime.status(&settings).await;
                        if status.state == "ready" { break; }
                        if !status.owned || Instant::now() > deadline {
                            return Err(status.error.unwrap_or("Local runtime startup timed out".into()));
                        }
                        tokio::select! {
                            _ = tokio::signal::ctrl_c() => return Err("Cancelled runtime startup".into()),
                            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                        }
                    }
                }
                let snapshot = match conversation {
                    Some(id) => store.snapshot(&id).map_err(error)?,
                    None => store.create().map_err(error)?,
                };
                let id = snapshot.conversation.id;
                let service = Arc::new(ConversationService::new(store.clone(), Arc::new(JsonEvents)));
                let generation = service.start(SendRequest {
                    conversation_id: id.clone(),
                    parent_id: parent.or(snapshot.conversation.active_leaf_id),
                    parts: vec![MessagePart::Text { text: prompt.join(" ") }],
                }, settings.clone(), Arc::new(OpenAiCompatible::new(&settings.endpoint).map_err(error)?)).map_err(error)?;
                loop {
                    if let Some(error) = service.failure(&generation.id) {
                        return Err(error);
                    }
                    let snapshot = store.snapshot(&id).map_err(error)?;
                    let record = snapshot.generations.iter().find(|g| g.id == generation.id).ok_or("Generation missing")?;
                    if record.status != "streaming" {
                        print(&snapshot)?;
                        return if record.status == "completed" { Ok(()) } else { Err(record.error.clone().unwrap_or_else(|| record.status.clone())) };
                    }
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => { service.cancel(&generation.id).map_err(error)?; },
                        _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                    }
                }
            })
        }
    }
}
