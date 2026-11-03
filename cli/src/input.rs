//! Shared local input discovery for the HTTP, MCP, and terminal surfaces.

use crate::{config::AppPaths, contract::Authority, conversation::Conversation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tokio::net::TcpListener;

pub const MAX_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_QUERY_BYTES: usize = 2 * 1024;
pub const MAX_RESULTS: usize = 20;
pub const MAX_PENDING_JOBS: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    /// Explicit local indexes: information, capabilities, commands, services, agents.
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub source: String,
    pub id: Option<String>,
    pub title: String,
    pub summary: String,
    pub status: Option<String>,
    pub data: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub trigger: String,
    pub completion: String,
    pub description: String,
    pub requires_arguments: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestResponse {
    pub suggestions: Vec<Suggestion>,
    pub search_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRequest {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputText {
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub state: String,
    pub input: String,
    pub created_at_unix_ms: u128,
    pub updated_at_unix_ms: u128,
    pub cancellation_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("input text must not be empty".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("input text exceeds {MAX_TEXT_BYTES} bytes"));
    }
    Ok(())
}

/// Static command autocomplete: no provider calls or runtime registry scans.
pub fn suggest(text: &str, limit: Option<usize>, public_test: bool) -> SuggestResponse {
    let query = text.trim();
    let search_hint = query
        .strip_prefix('?')
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_string);
    let suggestions = command_catalog(public_test)
        .suggest(query)
        .into_iter()
        .take(limit.unwrap_or(8).clamp(1, MAX_RESULTS))
        .map(|entry| Suggestion {
            trigger: entry.trigger,
            completion: entry.completion,
            description: entry.description,
            requires_arguments: entry.requires_arguments,
        })
        .collect();
    SuggestResponse {
        suggestions,
        search_hint,
    }
}

pub fn command_catalog(public_test: bool) -> &'static crate::tui::SlashCommandCatalog {
    use std::sync::OnceLock;
    static OWNER: OnceLock<crate::tui::SlashCommandCatalog> = OnceLock::new();
    static TEST: OnceLock<crate::tui::SlashCommandCatalog> = OnceLock::new();
    if public_test {
        TEST.get_or_init(|| crate::tui::SlashCommandCatalog::load(true))
    } else {
        OWNER.get_or_init(|| crate::tui::SlashCommandCatalog::load(false))
    }
}

/// Search captured information and capabilities by default. Agent and service
/// discovery runs only when the caller names those sources explicitly.
pub fn search(paths: &AppPaths, request: &SearchRequest) -> Result<Vec<SearchHit>, String> {
    if request.query.trim().is_empty() {
        return Err("search query must not be empty".into());
    }
    if request.query.len() > MAX_QUERY_BYTES {
        return Err(format!("search query exceeds {MAX_QUERY_BYTES} bytes"));
    }
    let sources = [
        "information",
        "capabilities",
        "commands",
        "services",
        "agents",
    ];
    if request
        .sources
        .iter()
        .any(|value| !sources.contains(&value.as_str()))
    {
        return Err(format!("sources must be {}", sources.join(", ")));
    }
    let limit = request.limit.unwrap_or(8).clamp(1, MAX_RESULTS);
    let explicit = !request.sources.is_empty();
    let include = |source: &str| {
        if explicit {
            request.sources.iter().any(|value| value == source)
        } else {
            matches!(source, "information" | "capabilities" | "commands")
        }
    };
    let mut hits = Vec::new();
    if include("information") {
        for result in hii_core::information::search(&paths.runtime, &request.query, limit)
            .map_err(|error| error.to_string())?
        {
            hits.push(SearchHit {
                source: "information".into(),
                id: result.id.clone(),
                title: result.title.clone(),
                summary: result.excerpt.clone(),
                status: Some("captured".into()),
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            });
        }
    }
    if include("capabilities") {
        let entries = crate::capability_index::load_all(paths);
        for result in crate::capability_index::search(&entries, &request.query, limit) {
            hits.push(SearchHit {
                source: "capability".into(),
                id: Some(result.entry.id.clone()),
                title: result.entry.name.clone(),
                summary: result.entry.description.clone(),
                status: Some(result.entry.status.clone()),
                data: serde_json::to_value(result).unwrap_or(Value::Null),
            });
        }
    }
    if include("commands") {
        for entry in command_catalog(false)
            .suggest(&request.query)
            .into_iter()
            .take(limit)
        {
            if entry.trigger == "?" {
                continue;
            }
            hits.push(SearchHit {
                source: "command".into(),
                id: Some(entry.trigger.clone()),
                title: entry.completion,
                summary: entry.description,
                status: Some("available".into()),
                data: json!({"requiresArguments":entry.requires_arguments}),
            });
        }
    }
    if include("services") {
        for offer in crate::service::offers(paths, &request.query, Some(limit)) {
            hits.push(SearchHit {
                source: "service".into(),
                id: Some(offer.id.clone()),
                title: offer.name.clone(),
                summary: offer.description.clone(),
                status: Some(offer.status.clone()),
                data: serde_json::to_value(offer).unwrap_or(Value::Null),
            });
        }
    }
    if include("agents") {
        let status = crate::agents::AgentManager::new(paths).list()?;
        if !status.starts_with("No active HII agent sessions.")
            && status
                .to_ascii_lowercase()
                .contains(&request.query.to_ascii_lowercase())
        {
            hits.push(SearchHit {
                source: "agent".into(),
                id: None,
                title: "Active HII agents".into(),
                summary: status.clone(),
                status: Some("observed".into()),
                data: json!({"sessions": status.lines().take(limit).collect::<Vec<_>>()}),
            });
        }
    }
    hits.truncate(limit.min(MAX_RESULTS));
    Ok(hits)
}

#[derive(Clone)]
pub struct InputController {
    sender: mpsc::SyncSender<String>,
    state: Arc<Mutex<ControllerState>>,
    cancel: Arc<Mutex<Option<crate::budget::Cancel>>>,
    session_initialized: Arc<AtomicBool>,
    authority: Authority,
}

#[derive(Default)]
struct ControllerState {
    jobs: HashMap<String, Job>,
    order: VecDeque<String>,
}

pub type Dispatcher = fn(
    &AppPaths,
    &mut Conversation,
    &str,
    Option<Authority>,
) -> Result<crate::DispatchResult, String>;

impl InputController {
    pub fn new(
        paths: AppPaths,
        workspace: PathBuf,
        authority: Authority,
        dispatcher: Dispatcher,
    ) -> Self {
        Self::new_inner(paths, workspace, authority, dispatcher, None)
    }

    fn new_inner(
        paths: AppPaths,
        workspace: PathBuf,
        authority: Authority,
        dispatcher: Dispatcher,
        sessionless_dispatcher: Option<fn(&str) -> Result<crate::DispatchResult, String>>,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<String>(MAX_PENDING_JOBS);
        let state = Arc::new(Mutex::new(ControllerState::default()));
        let cancel = Arc::new(Mutex::new(None));
        let session_initialized = Arc::new(AtomicBool::new(false));
        let worker_state = state.clone();
        let worker_cancel = cancel.clone();
        let worker_session_initialized = session_initialized.clone();
        let worker_authority = authority;
        thread::Builder::new()
            .name("hii-input-worker".into())
            .spawn(move || {
                let mut conversation: Option<Conversation> = None;
                while let Ok(id) = receiver.recv() {
                    let job_cancel = crate::budget::Cancel::new();
                    let input = {
                        let mut state = worker_state.lock().expect("input state poisoned");
                        let Some(job) = state.jobs.get_mut(&id) else {
                            continue;
                        };
                        if job.state == "cancelled" {
                            continue;
                        }
                        job.state = "running".into();
                        job.updated_at_unix_ms = now_ms();
                        *worker_cancel.lock().expect("input cancel poisoned") =
                            Some(job_cancel.clone());
                        job.input.clone()
                    };
                    let result = (|| {
                        if job_cancel.is_cancelled() {
                            return Ok(crate::DispatchResult {
                                text: String::new(),
                                show_activity: false,
                                cancelled: true,
                                exit: false,
                            });
                        }
                        if let Some(query) = input
                            .strip_prefix('?')
                            .map(str::trim)
                            .filter(|q| !q.is_empty())
                        {
                            let response = search(
                                &paths,
                                &SearchRequest {
                                    query: query.into(),
                                    sources: Vec::new(),
                                    limit: Some(8),
                                },
                            )?;
                            return Ok(crate::DispatchResult {
                                text: serde_json::to_string(&response)
                                    .map_err(|error| error.to_string())?,
                                show_activity: false,
                                cancelled: job_cancel.is_cancelled(),
                                exit: false,
                            });
                        }
                        // Queue semantics can be verified without discovering or starting
                        // a model. Production always takes the conversational path.
                        if let Some(dispatch) = sessionless_dispatcher {
                            return dispatch(&input);
                        }
                        if conversation.is_none() {
                            let mut session = Conversation::new_session(
                                paths.clone(),
                                workspace.clone(),
                                None,
                                crate::config::DEFAULT_MAX_STEPS,
                                false,
                                false,
                            )?;
                            session.permissions(Some(worker_authority.label()))?;
                            conversation = Some(session);
                            worker_session_initialized.store(true, Ordering::Release);
                        }
                        let session = conversation.as_mut().expect("session initialized");
                        session.begin_request_cancel(job_cancel.clone());
                        let cancelled = worker_state
                            .lock()
                            .ok()
                            .and_then(|state| {
                                state.jobs.get(&id).map(|job| job.cancellation_requested)
                            })
                            .unwrap_or(false);
                        if cancelled || job_cancel.is_cancelled() {
                            session.end_request_cancel();
                            return Ok(crate::DispatchResult {
                                text: String::new(),
                                show_activity: false,
                                cancelled: true,
                                exit: false,
                            });
                        }
                        dispatcher(&paths, session, &input, Some(worker_authority))
                    })();
                    if let Some(session) = conversation.as_mut() {
                        session.end_request_cancel();
                    }
                    let mut exit_session = false;
                    if let Ok(mut state) = worker_state.lock() {
                        if let Some(job) = state.jobs.get_mut(&id) {
                            job.updated_at_unix_ms = now_ms();
                            match result {
                                Ok(output) => {
                                    exit_session = output.exit;
                                    job.state = if output.cancelled || job_cancel.is_cancelled() {
                                        "cancelled"
                                    } else {
                                        "completed"
                                    }
                                    .into();
                                    job.result = (!output.text.is_empty()).then_some(output.text);
                                }
                                Err(error) => {
                                    if job_cancel.is_cancelled() {
                                        job.state = "cancelled".into();
                                        job.error = Some(error);
                                    } else {
                                        job.state = "failed".into();
                                        job.error = Some(error);
                                    }
                                }
                            }
                        }
                        // Publish the terminal state before clearing the active token:
                        // a concurrent cancel must either cancel this run or observe it
                        // as terminal, never report a cancellation that was not applied.
                        if let Ok(mut current) = worker_cancel.lock() {
                            *current = None;
                        }
                        prune_jobs(&mut state);
                    }
                    if exit_session {
                        // `/exit` closes only this private API conversation. The HTTP
                        // controller remains available and lazily creates a fresh one.
                        conversation = None;
                        worker_session_initialized.store(false, Ordering::Release);
                    }
                }
            })
            .expect("could not start HII input worker");
        Self {
            sender,
            state,
            cancel,
            session_initialized,
            authority,
        }
    }

    pub fn submit(&self, text: &str) -> Result<Job, String> {
        validate_text(text)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let job = Job {
            id: id.clone(),
            state: "queued".into(),
            input: text.into(),
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
            cancellation_requested: false,
            result: None,
            error: None,
        };
        {
            let mut state = self.state.lock().map_err(|_| "input state unavailable")?;
            let active = state
                .jobs
                .values()
                .filter(|job| matches!(job.state.as_str(), "queued" | "running"))
                .count();
            if active >= MAX_PENDING_JOBS {
                return Err("input queue is full".into());
            }
            state.jobs.insert(id.clone(), job.clone());
            state.order.push_back(id.clone());
            prune_jobs(&mut state);
        }
        if self.sender.try_send(id.clone()).is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.jobs.remove(&id);
                state.order.retain(|item| item != &id);
            }
            return Err("input queue is full".into());
        }
        Ok(job)
    }

    pub fn job(&self, id: &str) -> Option<Job> {
        self.state.lock().ok()?.jobs.get(id).cloned()
    }

    pub fn status(&self) -> Vec<Job> {
        self.state
            .lock()
            .map(|state| {
                state
                    .order
                    .iter()
                    .filter_map(|id| state.jobs.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn authority(&self) -> Authority {
        self.authority
    }

    pub fn cancel(&self, id: &str) -> Result<Job, String> {
        let mut state = self.state.lock().map_err(|_| "input state unavailable")?;
        let job = state.jobs.get_mut(id).ok_or("input job not found")?;
        match job.state.as_str() {
            "queued" => job.state = "cancelled".into(),
            "running" => {
                job.cancellation_requested = true;
                if let Some(cancel) = self
                    .cancel
                    .lock()
                    .map_err(|_| "input cancel unavailable")?
                    .as_ref()
                {
                    cancel.cancel(crate::budget::CancelReason::Client);
                }
            }
            _ => return Ok(job.clone()),
        }
        job.updated_at_unix_ms = now_ms();
        let updated = job.clone();
        prune_jobs(&mut state);
        Ok(updated)
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn prune_jobs(state: &mut ControllerState) {
    let mut terminal_count = state
        .order
        .iter()
        .filter(|id| is_terminal_job(state, id))
        .count();
    while terminal_count > 128 {
        let Some(index) = state.order.iter().position(|id| is_terminal_job(state, id)) else {
            break;
        };
        if let Some(id) = state.order.remove(index) {
            state.jobs.remove(&id);
            terminal_count -= 1;
        }
    }
}

fn is_terminal_job(state: &ControllerState, id: &str) -> bool {
    state
        .jobs
        .get(id)
        .is_none_or(|job| matches!(job.state.as_str(), "completed" | "failed" | "cancelled"))
}

#[derive(Clone)]
struct HttpState {
    paths: AppPaths,
    controller: InputController,
    token: Arc<str>,
    port: u16,
}

pub fn serve_http(paths: AppPaths, controller: InputController, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("input API port must be between 1 and 65535".into());
    }
    let (token_path, token) = input_token(&paths)?;
    let state = HttpState {
        paths,
        controller,
        token: Arc::from(token),
        port,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async move {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|error| format!("could not bind input API to loopback: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let config_path = state.paths.runtime.join("config/input-http.json");
        crate::store::write_json_private_atomic(
            &config_path,
            &json!({
                "schemaVersion": 1,
                "address": "127.0.0.1",
                "port": address.port(),
                "authority": serde_json::to_value(state.controller.authority())
                    .unwrap_or(Value::String("read-only".into())),
                "tokenFile": token_path.display().to_string()
            }),
        )?;
        let state = HttpState {
            paths: state.paths.clone(),
            controller: state.controller.clone(),
            token: state.token.clone(),
            port: address.port(),
        };
        eprintln!(
            "HII input API listening at http://{address}/v1/input; authority {}; bearer token file: {}",
            state.controller.authority().label(), token_path.display()
        );
        let app = http_router(state);
        axum::serve(listener, app)
            .await
            .map_err(|error| format!("input API stopped: {error}"))
    })
}

fn http_router(state: HttpState) -> Router {
    Router::new()
        .route("/v1/input/suggest", post(http_suggest))
        .route("/v1/input/search", post(http_search))
        .route("/v1/input/submit", post(http_submit))
        .route("/v1/input/queue", post(http_submit))
        .route("/v1/input/status", get(http_status))
        .route("/v1/input/status/{id}", get(http_job))
        .route("/v1/input/cancel/{id}", post(http_cancel))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_TEXT_BYTES))
        .route_layer(middleware::from_fn_with_state(state.clone(), http_guard))
        .with_state(state)
}

async fn http_guard(
    State(state): State<HttpState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, "cross-origin requests are denied").into_response();
    }
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|value| value == state.token.as_ref());
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "bearer token required").into_response();
    }
    next.run(request).await
}

async fn http_suggest(
    State(_state): State<HttpState>,
    Json(request): Json<SuggestRequest>,
) -> Json<SuggestResponse> {
    Json(suggest(&request.text, request.limit, false))
}

async fn http_search(
    State(state): State<HttpState>,
    Json(request): Json<SearchRequest>,
) -> Response {
    match search(&state.paths, &request) {
        Ok(results) => Json(json!({"query":request.query,"results":results})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn http_submit(State(state): State<HttpState>, Json(request): Json<InputText>) -> Response {
    match state.controller.submit(&request.text) {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err(error) if error == "input queue is full" => {
            (StatusCode::TOO_MANY_REQUESTS, error).into_response()
        }
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn http_status(State(state): State<HttpState>) -> Json<Value> {
    Json(json!({
        "jobs":state.controller.status(),
        "authority":serde_json::to_value(state.controller.authority())
            .unwrap_or(Value::String("read-only".into())),
        "sessionInitialized":state.controller.session_initialized.load(Ordering::Acquire),
        "address":"127.0.0.1",
        "port":state.port,
        "streaming":false
    }))
}

async fn http_job(State(state): State<HttpState>, Path(id): Path<String>) -> Response {
    match state.controller.job(&id) {
        Some(job) => Json(job).into_response(),
        None => (StatusCode::NOT_FOUND, "input job not found").into_response(),
    }
}

async fn http_cancel(State(state): State<HttpState>, Path(id): Path<String>) -> Response {
    match state.controller.cancel(&id) {
        Ok(job) => Json(job).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, error).into_response(),
    }
}

fn input_token(paths: &AppPaths) -> Result<(PathBuf, String), String> {
    let path = paths.runtime.join("config/input-http.token");
    let parent = path.parent().ok_or("input token has no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if let Ok(token) = std::fs::read_to_string(&path) {
        let token = token.trim().to_string();
        if !token.is_empty() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|error| error.to_string())?;
            }
            return Ok((path, token));
        }
        return Err("input bearer token file is empty".into());
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            use std::io::Write;
            writeln!(file, "{token}").map_err(|error| error.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            return Ok((path, existing.trim().to_string()));
        }
        Err(error) => return Err(format!("could not create input bearer token: {error}")),
    }
    Ok((path, token))
}

/// Forward MCP job control to the already-running CLI input server. Suggestion
/// and local search remain in-process; execution always shares one controller.
pub fn forward_http(
    paths: &AppPaths,
    tool: &str,
    arguments: &Value,
    caller_authority: Authority,
) -> Result<Value, String> {
    let config_path = paths.runtime.join("config/input-http.json");
    let config: Value = crate::store::read_json(&config_path).ok_or_else(|| {
        "HII input controller is not running; start `hii input serve` first".to_string()
    })?;
    let port = config["port"]
        .as_u64()
        .filter(|port| (1..=u16::MAX as u64).contains(port))
        .ok_or("input controller port is unavailable")?;
    let token_path = paths.runtime.join("config/input-http.token");
    let token = std::fs::read_to_string(token_path)
        .map_err(|_| {
            "HII input controller token is unavailable; restart `hii input serve`".to_string()
        })?
        .trim()
        .to_string();
    let base = format!("http://127.0.0.1:{port}/v1/input");
    let (method, endpoint, body) = match tool {
        "input_submit" => (
            "POST",
            "submit".to_string(),
            Some(json!({"text":arguments["text"]})),
        ),
        "input_queue" => (
            "POST",
            "queue".to_string(),
            Some(json!({"text":arguments["text"]})),
        ),
        "input_status" => {
            let id = arguments["jobId"].as_str();
            (
                "GET",
                id.map(|id| format!("status/{id}"))
                    .unwrap_or_else(|| "status".into()),
                None,
            )
        }
        "input_cancel" => {
            let id = arguments["jobId"]
                .as_str()
                .ok_or("input_cancel requires jobId")?;
            ("POST", format!("cancel/{id}"), None)
        }
        _ => return Err(format!("unsupported input control: {tool}")),
    };
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(1))
        .timeout_read(std::time::Duration::from_secs(4))
        .timeout_write(std::time::Duration::from_secs(2))
        .build();
    let auth = format!("Bearer {token}");
    let live = agent
        .get(&format!("{base}/status"))
        .set("Authorization", &auth)
        .call()
        .map_err(|_| {
            "HII input controller is not reachable; start `hii input serve` first".to_string()
        })?
        .into_json::<Value>()
        .map_err(|_| "HII input controller returned invalid status".to_string())?;
    let server_authority = Authority::parse(
        live["authority"]
            .as_str()
            .ok_or("input controller authority is unavailable")?,
    )?;
    if live["port"].as_u64() != Some(port) {
        return Err("input controller configuration does not match the live server".into());
    }
    if matches!(tool, "input_submit" | "input_queue" | "input_cancel")
        && caller_authority != server_authority
    {
        return Err(format!(
            "MCP authority {} does not match input controller authority {}; use the same explicit authority",
            caller_authority.label(),
            server_authority.label()
        ));
    }
    let endpoint = if tool == "input_status" {
        let id = arguments["jobId"].as_str();
        if let Some(id) = id {
            validate_job_id(id)?;
            format!("status/{id}")
        } else {
            "status".into()
        }
    } else if tool == "input_cancel" {
        let id = arguments["jobId"]
            .as_str()
            .ok_or("input_cancel requires jobId")?;
        validate_job_id(id)?;
        format!("cancel/{id}")
    } else {
        endpoint
    };
    let url = format!("{base}/{endpoint}");
    let request = match method {
        "GET" => agent.get(&url),
        _ => agent.post(&url),
    }
    .set("Authorization", &auth);
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    }
    .map_err(|error| match error {
        ureq::Error::Transport(_) => {
            "HII input controller is not reachable; start `hii input serve` first".to_string()
        }
        ureq::Error::Status(_, response) => response
            .into_string()
            .unwrap_or_else(|_| "input controller rejected the request".into()),
    })?;
    response
        .into_json()
        .map_err(|error| format!("invalid input controller response: {error}"))
}

fn validate_job_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "jobId must be a UUID".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Method, Uri};
    use tower::ServiceExt;

    fn test_dispatcher(
        _paths: &AppPaths,
        _conversation: &mut Conversation,
        _text: &str,
        _authority: Option<Authority>,
    ) -> Result<crate::DispatchResult, String> {
        std::thread::sleep(std::time::Duration::from_millis(100));
        Ok(crate::DispatchResult {
            text: "ok".into(),
            show_activity: false,
            cancelled: false,
            exit: false,
        })
    }

    fn test_paths() -> (AppPaths, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "hii-input-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        (
            AppPaths {
                repo: root.clone(),
                runtime: root.join(".hii"),
            },
            root,
        )
    }

    #[test]
    fn local_suggestions_keep_search_offline_and_bounded() {
        let response = suggest("?plan", Some(1000), false);
        assert_eq!(response.search_hint.as_deref(), Some("plan"));
        assert!(response.suggestions.len() <= MAX_RESULTS);
        assert!(response.suggestions.iter().any(|item| item.trigger == "?"));
    }

    #[test]
    fn input_limits_are_checked_before_queueing() {
        assert!(validate_text("write a report").is_ok());
        assert!(validate_text("  ").is_err());
        assert!(validate_text(&"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(validate_job_id("../status").is_err());
        assert!(validate_job_id(&uuid::Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn queued_jobs_can_be_cancelled_without_running_them() {
        let (paths, root) = test_paths();
        let controller = InputController::new_inner(
            paths.clone(),
            root.clone(),
            Authority::ReadOnly,
            test_dispatcher,
            Some(|input| {
                // Any dispatch of the cancelled second job fails this test.
                assert_eq!(input, "first task");
                std::thread::sleep(std::time::Duration::from_millis(100));
                Ok(crate::DispatchResult {
                    text: "ok".into(),
                    show_activity: false,
                    cancelled: false,
                    exit: false,
                })
            }),
        );
        let first = controller.submit("first task").unwrap();
        let second = controller.submit("second task").unwrap();
        assert_eq!(controller.cancel(&second.id).unwrap().state, "cancelled");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if controller
                .job(&first.id)
                .is_some_and(|job| job.state == "completed")
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(controller.job(&second.id).unwrap().state, "cancelled");
        assert_eq!(
            controller.job(&first.id).unwrap().state,
            "completed",
            "first job: {:?}",
            controller.job(&first.id)
        );
        drop(controller);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn http_routes_require_bearer_token_and_deny_origins_and_large_bodies() {
        let (paths, root) = test_paths();
        let controller = InputController::new(
            paths.clone(),
            root.clone(),
            Authority::ReadOnly,
            test_dispatcher,
        );
        let app = http_router(HttpState {
            paths,
            controller,
            token: Arc::from("secret-test-token"),
            port: 4187,
        });
        let request = |headers: Vec<(&'static str, String)>, body: String| {
            let mut builder = Request::builder()
                .method(Method::POST)
                .uri(Uri::from_static("/v1/input/suggest"));
            for (name, value) in headers {
                builder = builder.header(name, value);
            }
            builder.body(Body::from(body)).unwrap()
        };
        let unauthorized = app
            .clone()
            .oneshot(request(vec![], "{}".into()))
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let cross_origin = app
            .clone()
            .oneshot(request(
                vec![
                    ("authorization", "Bearer secret-test-token".into()),
                    ("origin", "https://example.invalid".into()),
                ],
                "{}".into(),
            ))
            .await
            .unwrap();
        assert_eq!(cross_origin.status(), StatusCode::FORBIDDEN);
        let oversized = app
            .oneshot(request(
                vec![
                    ("authorization", "Bearer secret-test-token".into()),
                    ("content-type", "application/json".into()),
                ],
                format!("{{\"text\":\"{}\"}}", "x".repeat(MAX_TEXT_BYTES)),
            ))
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn job_history_pruning_removes_only_old_terminal_entries() {
        let mut state = ControllerState::default();
        for index in 0..130 {
            let id = index.to_string();
            state.order.push_back(id.clone());
            state.jobs.insert(
                id.clone(),
                Job {
                    id,
                    state: "completed".into(),
                    input: "done".into(),
                    created_at_unix_ms: index,
                    updated_at_unix_ms: index,
                    cancellation_requested: false,
                    result: None,
                    error: None,
                },
            );
            prune_jobs(&mut state);
        }
        assert_eq!(state.order.len(), 128);
        assert!(!state.jobs.contains_key("0"));
        assert!(state.jobs.contains_key("129"));
    }

    #[test]
    fn terminal_history_prunes_behind_an_oldest_running_job() {
        let mut state = ControllerState::default();
        state.order.push_back("running".into());
        state.jobs.insert(
            "running".into(),
            Job {
                id: "running".into(),
                state: "running".into(),
                input: "long task".into(),
                created_at_unix_ms: 0,
                updated_at_unix_ms: 0,
                cancellation_requested: false,
                result: None,
                error: None,
            },
        );
        for index in 0..140 {
            let id = format!("terminal-{index}");
            state.order.push_back(id.clone());
            state.jobs.insert(
                id.clone(),
                Job {
                    id,
                    state: "cancelled".into(),
                    input: "queued task".into(),
                    created_at_unix_ms: index,
                    updated_at_unix_ms: index,
                    cancellation_requested: true,
                    result: None,
                    error: None,
                },
            );
        }

        prune_jobs(&mut state);

        assert_eq!(state.jobs["running"].state, "running");
        assert_eq!(state.jobs.len(), 129);
        assert!(!state.jobs.contains_key("terminal-0"));
        assert!(state.jobs.contains_key("terminal-139"));
    }
}
