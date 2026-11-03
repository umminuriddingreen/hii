// SPDX-License-Identifier: Apache-2.0
//! HII-owned bounded inference jobs. No shell execution, model downloads, or hosted routing.
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

type Error = String;
type ApiError = (StatusCode, String);
const LEASE_SECS: u64 = 180;

#[derive(Subcommand, Debug)]
pub enum ComputeCommand {
    /// Run the shared queue. Bind is loopback unless explicitly changed.
    Serve {
        #[arg(long, default_value = "127.0.0.1:6138")]
        listen: SocketAddr,
        #[arg(long)]
        state: Option<PathBuf>,
    },
    /// Contribute this machine's HII native runtime (CUDA or Metal/MLX).
    Worker {
        #[arg(long, default_value = "http://127.0.0.1:6138")]
        coordinator: String,
        /// Explicit local HII native model origin; no automatic compatibility fallback.
        #[arg(long)]
        runtime: String,
        #[arg(long)]
        name: String,
        /// Allow HTTP on a trusted private network instead of HTTPS.
        #[arg(long)]
        allow_insecure_lan: bool,
        /// Process at most one job and exit (useful for supervised workers).
        #[arg(long)]
        once: bool,
    },
    /// Submit bounded text inference. Model must be installed on a contributor.
    Submit {
        #[arg(long, default_value = "http://127.0.0.1:6138")]
        coordinator: String,
        #[arg(long)]
        model: String,
        #[arg(long)]
        prompt: String,
        #[arg(long, default_value_t = 128)]
        max_tokens: u32,
        #[arg(long)]
        allow_insecure_lan: bool,
    },
    /// Inspect a job and its result/worker receipt.
    Job {
        id: String,
        #[arg(long, default_value = "http://127.0.0.1:6138")]
        coordinator: String,
        #[arg(long)]
        allow_insecure_lan: bool,
    },
    /// Inspect contributors that have contacted this coordinator recently.
    Nodes {
        #[arg(long, default_value = "http://127.0.0.1:6138")]
        coordinator: String,
        #[arg(long)]
        allow_insecure_lan: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Request {
    pub model: String,
    pub prompt: String,
    pub max_tokens: u32,
}

impl Request {
    fn validate(&self) -> Result<(), ApiError> {
        if self.model.is_empty()
            || self.model.len() > 256
            || self.prompt.is_empty()
            || self.prompt.len() > 32_768
            || !(1..=4096).contains(&self.max_tokens)
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "model, prompt, or token limit invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub request: Request,
    pub status: String,
    pub worker: Option<String>,
    pub lease: Option<String>,
    pub deadline: u64,
    pub created: u64,
    pub completed: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub platform: String,
    pub architecture: String,
    pub models: Vec<String>,
    #[serde(default)]
    pub last_seen: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    jobs: BTreeMap<String, Job>,
    nodes: BTreeMap<String, Node>,
}

#[derive(Clone)]
pub struct Queue {
    store: Arc<Mutex<Store>>,
    file: PathBuf,
    client_token: String,
    worker_token: String,
    _lock: Arc<fs::File>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

impl Queue {
    pub fn open(file: PathBuf, client_token: String, worker_token: String) -> Result<Self, Error> {
        if client_token.len() < 32 || worker_token.len() < 32 || client_token == worker_token {
            return Err("Set distinct HII_COMPUTE_CLIENT_TOKEN and HII_COMPUTE_WORKER_TOKEN (at least 32 characters each)".into());
        }
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(file.with_extension("lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| "Another coordinator owns this queue".to_string())?;
        let mut store: Store = if file.exists() {
            serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            Store::default()
        };
        // Restart invalidates leases: delayed results from the old process cannot win.
        for job in store.jobs.values_mut().filter(|j| j.status == "running") {
            job.status = "queued".into();
            job.lease = None;
            job.deadline = 0;
        }
        store.nodes.clear();
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            file,
            client_token,
            worker_token,
            _lock: Arc::new(lock),
        })
    }

    fn authorize(&self, headers: &HeaderMap, worker: bool) -> Result<(), ApiError> {
        let expected = if worker {
            &self.worker_token
        } else {
            &self.client_token
        };
        let got = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if got != format!("Bearer {expected}") {
            return Err((
                StatusCode::UNAUTHORIZED,
                "invalid compute credential".into(),
            ));
        }
        Ok(())
    }

    fn save(&self, store: &Store) -> Result<(), ApiError> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(internal)?;
        }
        let tmp = self.file.with_extension("tmp");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp).map_err(internal)?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec(store).map_err(internal)?)
            .map_err(internal)?;
        file.sync_all().map_err(internal)?;
        drop(file);
        fs::rename(tmp, &self.file).map_err(internal)
    }
}

pub fn router(queue: Queue) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"kind":"hii.compute", "ok":true})) }),
        )
        .route("/jobs", post(submit))
        .route("/jobs/{id}", get(job))
        .route("/nodes", get(nodes))
        .route("/claim", post(claim))
        .route("/finish/{id}", post(finish))
        .layer(DefaultBodyLimit::max(1_048_576))
        .with_state(queue)
}

async fn submit(
    State(q): State<Queue>,
    h: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Json<Job>, ApiError> {
    q.authorize(&h, false)?;
    request.validate()?;
    let mut store = q.store.lock().await;
    if store.jobs.len() >= 10_000 {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "queue retention limit reached".into(),
        ));
    }
    let job = Job {
        id: Uuid::new_v4().to_string(),
        request,
        status: "queued".into(),
        worker: None,
        lease: None,
        deadline: 0,
        created: now(),
        completed: None,
        result: None,
        error: None,
    };
    let mut next = store.clone();
    next.jobs.insert(job.id.clone(), job.clone());
    q.save(&next)?;
    *store = next;
    Ok(Json(job))
}

async fn job(
    State(q): State<Queue>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Job>, ApiError> {
    q.authorize(&h, false)?;
    let mut value = q
        .store
        .lock()
        .await
        .jobs
        .get(&id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "unknown job".into()))?;
    value.lease = None; // Only the assigned worker receives the completion capability.
    Ok(Json(value))
}

async fn nodes(State(q): State<Queue>, h: HeaderMap) -> Result<Json<Vec<Node>>, ApiError> {
    q.authorize(&h, false)?;
    let store = q.store.lock().await;
    Ok(Json(
        store
            .nodes
            .values()
            .filter(|n| {
                now().saturating_sub(n.last_seen) < 30
                    || store.jobs.values().any(|j| {
                        j.status == "running"
                            && j.deadline > now()
                            && j.worker.as_deref() == Some(n.name.as_str())
                    })
            })
            .cloned()
            .collect(),
    ))
}

async fn claim(
    State(q): State<Queue>,
    h: HeaderMap,
    Json(mut node): Json<Node>,
) -> Result<Json<Option<Job>>, ApiError> {
    q.authorize(&h, true)?;
    if node.name.is_empty()
        || node.name.len() > 128
        || node.models.len() > 256
        || node.models.iter().any(|m| m.len() > 256)
    {
        return Err((StatusCode::BAD_REQUEST, "invalid node advertisement".into()));
    }
    node.last_seen = now();
    let mut store = q.store.lock().await;
    let mut next = store.clone();
    next.nodes.insert(node.name.clone(), node.clone());
    let result = next
        .jobs
        .values_mut()
        .find(|j| {
            (j.status == "queued" || (j.status == "running" && j.deadline <= now()))
                && node.models.contains(&j.request.model)
        })
        .map(|j| {
            j.status = "running".into();
            j.worker = Some(node.name.clone());
            j.lease = Some(Uuid::new_v4().to_string());
            j.deadline = now() + LEASE_SECS;
            j.clone()
        });
    // Heartbeats are transient; persist only if a job was leased.
    if result.is_some() {
        q.save(&next)?;
    }
    *store = next;
    Ok(Json(result))
}

#[derive(Deserialize, Serialize)]
struct Completion {
    lease: String,
    result: Option<Value>,
    error: Option<String>,
}

async fn finish(
    State(q): State<Queue>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(c): Json<Completion>,
) -> Result<Json<Value>, ApiError> {
    q.authorize(&h, true)?;
    if c.result.is_some() == c.error.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            "supply exactly one result or error".into(),
        ));
    }
    let mut store = q.store.lock().await;
    let mut next = store.clone();
    let j = next
        .jobs
        .get_mut(&id)
        .ok_or((StatusCode::NOT_FOUND, "unknown job".into()))?;
    if j.status != "running" || j.deadline <= now() || j.lease.as_deref() != Some(c.lease.as_str())
    {
        return Err((StatusCode::CONFLICT, "stale or invalid job lease".into()));
    }
    j.status = if c.error.is_some() {
        "failed"
    } else {
        "completed"
    }
    .into();
    j.completed = Some(now());
    j.result = c.result;
    j.error = c.error;
    j.lease = None;
    q.save(&next)?;
    *store = next;
    Ok(Json(
        json!({"ok":true, "kind":"hii.compute.receipt", "job":id, "evidence":"worker-reported; model output is not independently verified"}),
    ))
}

fn credential(key: &str) -> Result<String, Error> {
    let value = std::env::var(key).map_err(|_| {
        format!("Set {key}; credentials are read from environment, never CLI arguments")
    })?;
    if value.len() < 32 {
        return Err(format!("{key} must have at least 32 characters"));
    }
    Ok(value)
}

fn origin(value: &str, insecure: bool, local_only: bool) -> Result<String, Error> {
    let u = reqwest::Url::parse(value).map_err(|e| e.to_string())?;
    let local = matches!(
        u.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
        || (local_only && !local)
        || (u.scheme() == "http" && !local && !insecure)
    {
        return Err("Use an HTTP(S) origin; native runtime must be loopback. Remote coordinator requires HTTPS or explicit --allow-insecure-lan".into());
    }
    Ok(value.trim_end_matches('/').into())
}

fn client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}
async fn decode(r: reqwest::Response) -> Result<Value, Error> {
    let status = r.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    r.json().await.map_err(|e| e.to_string())
}
fn print(value: &impl Serialize) -> Result<(), Error> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    Ok(())
}

pub fn run(command: ComputeCommand) -> Result<(), Error> {
    tokio::runtime::Runtime::new()
        .map_err(|e| e.to_string())?
        .block_on(execute(command))
}

async fn execute(command: ComputeCommand) -> Result<(), Error> {
    match command {
        ComputeCommand::Serve { listen, state } => {
            let file = state.unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".hii/compute/queue.json")
            });
            let q = Queue::open(
                file,
                credential("HII_COMPUTE_CLIENT_TOKEN")?,
                credential("HII_COMPUTE_WORKER_TOKEN")?,
            )?;
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .map_err(|e| e.to_string())?;
            eprintln!(
                "HII compute queue listening on {}",
                listener.local_addr().map_err(|e| e.to_string())?
            );
            axum::serve(listener, router(q))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await
                .map_err(|e| e.to_string())
        }
        ComputeCommand::Worker {
            coordinator,
            runtime,
            name,
            allow_insecure_lan,
            once,
        } => {
            let coordinator = origin(&coordinator, allow_insecure_lan, false)?;
            let runtime = origin(&runtime, false, true)?;
            let token = credential("HII_COMPUTE_WORKER_TOKEN")?;
            let c = client()?;
            loop {
                let result = work_once(&c, &coordinator, &runtime, &name, &token).await;
                match result {
                    Ok(Some(receipt)) => {
                        print(&receipt)?;
                        if once {
                            return Ok(());
                        }
                    }
                    Ok(None) => {
                        if once {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        if once {
                            return Err(e);
                        }
                        eprintln!("worker unavailable: {e}");
                    }
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
        ComputeCommand::Submit {
            coordinator,
            model,
            prompt,
            max_tokens,
            allow_insecure_lan,
        } => {
            let request = Request {
                model,
                prompt,
                max_tokens,
            };
            request.validate().map_err(|(_, e)| e)?;
            let url = origin(&coordinator, allow_insecure_lan, false)?;
            let r = client()?
                .post(format!("{url}/jobs"))
                .bearer_auth(credential("HII_COMPUTE_CLIENT_TOKEN")?)
                .json(&request)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            print(&decode(r).await?)
        }
        ComputeCommand::Job {
            id,
            coordinator,
            allow_insecure_lan,
        } => {
            Uuid::parse_str(&id).map_err(|e| e.to_string())?;
            inspect(&coordinator, &format!("jobs/{id}"), allow_insecure_lan).await
        }
        ComputeCommand::Nodes {
            coordinator,
            allow_insecure_lan,
        } => inspect(&coordinator, "nodes", allow_insecure_lan).await,
    }
}

async fn inspect(url: &str, resource: &str, insecure: bool) -> Result<(), Error> {
    let url = origin(url, insecure, false)?;
    let r = client()?
        .get(format!("{url}/{resource}"))
        .bearer_auth(credential("HII_COMPUTE_CLIENT_TOKEN")?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    print(&decode(r).await?)
}

async fn work_once(
    c: &reqwest::Client,
    coordinator: &str,
    runtime: &str,
    name: &str,
    token: &str,
) -> Result<Option<Value>, Error> {
    let runtime_token = std::env::var("HII_COMPUTE_RUNTIME_TOKEN").ok();
    let auth = |r: reqwest::RequestBuilder| match &runtime_token {
        Some(t) => r.bearer_auth(t),
        None => r,
    };
    let models = decode(
        auth(c.get(format!("{runtime}/v1/models")))
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    let models: Vec<String> = models["data"]
        .as_array()
        .ok_or("Native HII runtime returned an invalid model catalog")?
        .iter()
        .filter_map(|m| m["id"].as_str().map(str::to_string))
        .collect();
    let node = Node {
        name: name.into(),
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        models,
        last_seen: 0,
    };
    let value = decode(
        c.post(format!("{coordinator}/claim"))
            .bearer_auth(token)
            .json(&node)
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    if value.is_null() {
        return Ok(None);
    }
    let job: Job = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let response = async {
        let r = auth(c.post(format!("{runtime}/v1/chat/completions"))).json(&json!({"model":job.request.model,"messages":[{"role":"user","content":job.request.prompt}],"max_tokens":job.request.max_tokens,"stream":false,"temperature":0})).send().await.map_err(|e|e.to_string())?;
        let value = decode(r).await?;
        if value["choices"][0]["message"]["content"].as_str().is_none() { return Err("Native HII runtime returned no completion".into()); }
        Ok::<_, Error>(value)
    }.await;
    let completion = match response {
        Ok(result) => Completion {
            lease: job.lease.ok_or("Missing lease")?,
            result: Some(result),
            error: None,
        },
        Err(error) => Completion {
            lease: job.lease.ok_or("Missing lease")?,
            result: None,
            error: Some(error),
        },
    };
    let receipt = decode(
        c.post(format!("{coordinator}/finish/{}", job.id))
            .bearer_auth(token)
            .json(&completion)
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    Ok(Some(receipt))
}

#[cfg(test)]
mod tests;
