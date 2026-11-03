//! Bounded remote MCP connection discovery and OAuth continuation.
//!
//! This module deliberately keeps remote connection state separate from local stdio
//! clients. The only built-in endpoint is Notion's official MCP service.
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand::{distributions::Alphanumeric, Rng};
use ring::digest::{digest, SHA256};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        mpsc::{self, Receiver, TryRecvError},
        Mutex,
    },
    thread,
    time::Duration,
};
use url::Url;

const NOTION_URL: &str = "https://mcp.notion.com/mcp";
const CACHE_VERSION: u8 = 1;
const SCHEMA_TTL_HOURS: i64 = 24;
const READY_TTL_MINUTES: i64 = 5;
const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OAUTH_METADATA_BYTES: u64 = 64 * 1024;
const MAX_REMOTE_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MCP_PROTOCOL: &str = "2025-03-26";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
    pub destructive: bool,
    pub open_world: bool,
}
#[derive(Clone, Debug)]
pub struct RemoteCallPlan {
    pub tool: String,
    pub arguments: Value,
    pub decision: crate::contract::Decision,
}
#[derive(Clone, Debug)]
pub struct RemoteCallResult {
    pub server: String,
    pub tool: String,
    pub ok: bool,
    pub output: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RemoteCache {
    version: u8,
    signature: String,
    refreshed_at: Option<DateTime<Utc>>,
    ready_at: Option<DateTime<Utc>>,
    tools: Vec<RemoteTool>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    state: String,
    verifier: String,
    redirect_uri: String,
    token_url: String,
    client_id: String,
    created_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    token_url: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
}
#[derive(Clone, Debug)]
pub enum EnsureResult {
    Ready {
        server: String,
        tools: Vec<RemoteTool>,
    },
    WaitingForAccess {
        auth_url: String,
        specific_step: String,
    },
    Unavailable {
        reason: String,
    },
}

pub struct ConnectionManager {
    root: PathBuf,
    cache: RemoteCache,
    pending: Option<Pending>,
    callback: Option<Mutex<Receiver<String>>>,
}
impl ConnectionManager {
    pub fn disabled(runtime: &Path) -> Self {
        Self {
            root: runtime.join("mcp"),
            cache: RemoteCache {
                version: CACHE_VERSION,
                ..Default::default()
            },
            pending: None,
            callback: None,
        }
    }
    pub fn load(runtime: &Path) -> Result<Self, String> {
        let root = runtime.join("mcp");
        fs::create_dir_all(&root).map_err(|e| format!("cannot create MCP cache: {e}"))?;
        let path = root.join("notion-cache.json");
        let cache = private_read(&path, MAX_METADATA_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RemoteCache>(&bytes).ok())
            .filter(|cache| cache.version == CACHE_VERSION)
            .unwrap_or_else(|| RemoteCache {
                version: CACHE_VERSION,
                ..Default::default()
            });
        let pending = None;
        Ok(Self {
            root,
            cache,
            pending,
            callback: None,
        })
    }
    /// Discovers only Notion for intents that clearly require Notion context. Tool schemas
    /// are refreshed at most once per config signature per 24 hours; readiness lasts five minutes.
    pub fn ensure_for_intent(&mut self, intent: &str) -> Result<EnsureResult, String> {
        self.poll_pending_auth()?;
        let lower = intent.to_lowercase();
        if !["notion", "workspace page", "notion page", "notion database"]
            .iter()
            .any(|w| lower.contains(w))
        {
            return Ok(EnsureResult::Unavailable {
                reason: "No trusted connection is relevant to this intent.".into(),
            });
        }
        let sig = signature(NOTION_URL);
        let mut tokens = match load_tokens("notion") {
            Ok(Some(t)) => t,
            Ok(None) => return self.authorization_or_unavailable(),
            Err(reason) => return Ok(EnsureResult::Unavailable { reason }),
        };
        if tokens
            .expires_at
            .is_some_and(|t| t <= Utc::now() + ChronoDuration::seconds(60))
        {
            match refresh_tokens(&tokens) {
                Ok(Some(updated)) => {
                    store_tokens("notion", &updated)?;
                    tokens = updated;
                }
                Ok(None) | Err(_) => {
                    self.cache.tools.clear();
                    self.cache.ready_at = None;
                    self.persist_cache()?;
                    return self.authorization_or_unavailable();
                }
            }
        }
        if self.cache.version == CACHE_VERSION
            && self.cache.signature == sig
            && self
                .cache
                .ready_at
                .is_some_and(|t| Utc::now() - t < ChronoDuration::minutes(READY_TTL_MINUTES))
        {
            return Ok(EnsureResult::Ready {
                server: "notion".into(),
                tools: self.cache.tools.clone(),
            });
        }
        let schemas_fresh = self.cache.version == CACHE_VERSION
            && self.cache.signature == sig
            && self
                .cache
                .refreshed_at
                .is_some_and(|t| Utc::now() - t < ChronoDuration::hours(SCHEMA_TTL_HOURS));
        if schemas_fresh {
            let mut probe = probe_ready(NOTION_URL, &tokens.access_token);
            if matches!(&probe, Err(RemoteError::Unauthorized)) && tokens.refresh_token.is_some() {
                if let Ok(Some(updated)) = refresh_tokens(&tokens) {
                    store_tokens("notion", &updated)?;
                    tokens = updated;
                    probe = probe_ready(NOTION_URL, &tokens.access_token);
                }
            }
            match probe {
                Ok(()) => {
                    self.cache.ready_at = Some(Utc::now());
                    self.persist_cache()?;
                    return Ok(EnsureResult::Ready {
                        server: "notion".into(),
                        tools: self.cache.tools.clone(),
                    });
                }
                Err(RemoteError::Unauthorized) => {
                    self.cache.tools.clear();
                    self.cache.ready_at = None;
                    self.cache.refreshed_at = None;
                    self.persist_cache()?;
                    return self.authorization_or_unavailable();
                }
                Err(error) => {
                    self.cache.tools.clear();
                    self.cache.ready_at = None;
                    self.cache.refreshed_at = None;
                    self.persist_cache()?;
                    return Ok(EnsureResult::Unavailable {
                        reason: error.to_string(),
                    });
                }
            }
        }
        let mut discovery = list_tools(NOTION_URL, &tokens.access_token);
        if matches!(&discovery, Err(RemoteError::Unauthorized)) && tokens.refresh_token.is_some() {
            if let Ok(Some(updated)) = refresh_tokens(&tokens) {
                store_tokens("notion", &updated)?;
                tokens = updated;
                discovery = list_tools(NOTION_URL, &tokens.access_token);
            }
        }
        match discovery {
            Ok(tools) => {
                self.cache = RemoteCache {
                    version: CACHE_VERSION,
                    signature: sig,
                    refreshed_at: Some(Utc::now()),
                    ready_at: Some(Utc::now()),
                    tools: tools.clone(),
                };
                self.persist_cache()?;
                Ok(EnsureResult::Ready {
                    server: "notion".into(),
                    tools,
                })
            }
            Err(RemoteError::Unauthorized) => {
                self.cache.tools.clear();
                self.cache.ready_at = None;
                self.persist_cache()?;
                self.authorization_or_unavailable()
            }
            Err(e) => {
                self.cache.tools.clear();
                self.cache.ready_at = None;
                self.persist_cache()?;
                Ok(EnsureResult::Unavailable {
                    reason: e.to_string(),
                })
            }
        }
    }
    pub fn pending_auth_url(&self) -> Option<String> {
        self.pending
            .as_ref()
            .and_then(|_| read_auth_url(&self.root).ok())
    }
    /// Nonblocking callback poll for the ordinary turn loop. A successful callback
    /// exchanges the code, stores credentials, and lets the next ensure call continue.
    pub fn poll_pending_auth(&mut self) -> Result<bool, String> {
        let polled = match self.callback.as_ref() {
            Some(receiver) => receiver
                .lock()
                .map_err(|_| "Notion callback poll lock was poisoned")?
                .try_recv(),
            None => return Ok(false),
        };
        let callback = match Some(polled) {
            Some(Ok(value)) => Some(value),
            Some(Err(TryRecvError::Empty)) | None => None,
            Some(Err(TryRecvError::Disconnected)) => {
                self.callback = None;
                self.pending = None;
                let _ = fs::remove_file(self.root.join("notion-auth-url"));
                return Ok(false);
            }
        };
        if let Some(callback) = callback {
            if let Err(error) = self.complete_pending_auth(&callback) {
                self.pending = None;
                self.callback = None;
                clear_pending_secure(&self.root)?;
                let _ = fs::remove_file(self.root.join("notion-auth-url"));
                return Err(error);
            }
            return Ok(true);
        }
        Ok(false)
    }
    pub fn plan_remote_call(
        &self,
        tool_name: &str,
        arguments: Value,
        authority: crate::contract::Authority,
    ) -> Result<RemoteCallPlan, String> {
        if !arguments.is_object() {
            return Err("MCP tool arguments must be a JSON object".into());
        }
        let tool = self
            .cache
            .tools
            .iter()
            .find(|tool| tool.name == tool_name)
            .ok_or_else(|| format!("unknown cached Notion MCP tool: {tool_name}"))?;
        if arguments.to_string().len() > 96 * 1024 {
            return Err("MCP arguments exceed the 96 KiB request budget".into());
        }
        crate::mcp_client::validate_argument_shape(&arguments, &tool.input_schema, "arguments", 0)?;
        use crate::contract::{Authority, Decision};
        let mutates = !tool.read_only;
        let decision = if authority == Authority::ReadOnly && (mutates || tool.destructive) {
            Decision::Deny
        } else if tool.destructive {
            Decision::Prompt
        } else if authority == Authority::Owner {
            Decision::Allow
        } else if mutates && matches!(authority, Authority::ExternalCommit | Authority::Yolo) {
            Decision::Allow
        } else if mutates {
            Decision::Prompt
        } else {
            authority.decide(false, false)
        };
        Ok(RemoteCallPlan {
            tool: tool.name.clone(),
            arguments,
            decision,
        })
    }
    /// Execute an approved remote call. Provenance is returned with every result.
    pub(crate) fn call_remote(
        &mut self,
        plan: &RemoteCallPlan,
        approved: bool,
        cancel: &crate::budget::Cancel,
    ) -> Result<RemoteCallResult, String> {
        if cancel.is_cancelled() {
            return Err(format!(
                "MCP call canceled before request ({:?})",
                cancel.reason()
            ));
        }
        if plan.decision == crate::contract::Decision::Deny
            || (plan.decision == crate::contract::Decision::Prompt && !approved)
        {
            return Err("Notion MCP action requires an explicit authority decision".into());
        }
        let mut tokens = load_tokens("notion")?.ok_or("Notion access is not connected")?;
        if tokens
            .expires_at
            .is_some_and(|t| t <= Utc::now() + ChronoDuration::seconds(60))
        {
            tokens = refresh_tokens(&tokens)?.ok_or("Notion access expired; reconnect access")?;
            store_tokens("notion", &tokens)?;
        }
        let mut output = call_remote_tool(
            NOTION_URL,
            &tokens.access_token,
            &plan.tool,
            &plan.arguments,
            cancel,
        );
        if matches!(&output, Err(RemoteError::Unauthorized)) {
            if let Ok(Some(updated)) = refresh_tokens(&tokens) {
                store_tokens("notion", &updated)?;
                tokens = updated;
                output = call_remote_tool(
                    NOTION_URL,
                    &tokens.access_token,
                    &plan.tool,
                    &plan.arguments,
                    cancel,
                );
            }
        }
        let output = match output {
            Ok(output) => output,
            Err(error) => {
                self.cache.tools.clear();
                self.cache.ready_at = None;
                self.persist_cache()?;
                return Err(error.to_string());
            }
        };
        Ok(RemoteCallResult {
            server: "notion".into(),
            tool: plan.tool.clone(),
            ok: output.0,
            output: output.1,
        })
    }
    /// Accepts only a callback to the exact loopback URI and state generated for the pending flow.
    pub fn complete_pending_auth(&mut self, callback_url: &str) -> Result<(), String> {
        let p = self
            .pending
            .clone()
            .ok_or("no Notion authorization is pending")?;
        let u = Url::parse(callback_url).map_err(|_| "invalid OAuth callback URL")?;
        let expected = Url::parse(&p.redirect_uri).map_err(|_| "invalid stored redirect URI")?;
        if u.scheme() != "http"
            || u.host_str() != Some("127.0.0.1")
            || u.port() != expected.port()
            || u.path() != expected.path()
        {
            return Err("OAuth callback must use the pending 127.0.0.1 callback address".into());
        }
        if u.query_pairs().any(|(k, _)| k == "error") {
            return Err("Notion authorization was declined or failed".into());
        }
        let code = u
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.to_string())
            .ok_or("OAuth callback is missing code")?;
        let state = u
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.to_string())
            .ok_or("OAuth callback is missing state")?;
        if state != p.state {
            return Err("OAuth state did not match the pending request".into());
        }
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", p.redirect_uri.as_str()),
            ("client_id", p.client_id.as_str()),
            ("code_verifier", p.verifier.as_str()),
        ];
        let response = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .build()
            .post(&p.token_url)
            .send_form(&form)
            .map_err(|_| "Notion token exchange failed; response details were suppressed")?;
        let value: Value = serde_json::from_str(
            &read_response(response, 64 * 1024).map_err(|_| "Notion token response was invalid")?,
        )
        .map_err(|_| "Notion token response was invalid")?;
        let access = value["access_token"]
            .as_str()
            .ok_or("Notion token response did not include an access token")?
            .to_string();
        let refresh = value["refresh_token"].as_str().map(str::to_owned);
        let expires = value["expires_in"]
            .as_i64()
            .map(|s| Utc::now() + ChronoDuration::seconds(s));
        store_tokens(
            "notion",
            &Tokens {
                access_token: access,
                refresh_token: refresh,
                expires_at: expires,
                token_url: Some(p.token_url.clone()),
                client_id: Some(p.client_id.clone()),
            },
        )?;
        self.pending = None;
        self.callback = None;
        clear_pending_secure(&self.root)?;
        let _ = fs::remove_file(self.root.join("notion-auth-url"));
        self.cache.ready_at = None;
        self.persist_cache()
    }
    fn prepare_authorization(&mut self) -> Result<EnsureResult, String> {
        if self.pending.is_none() && self.root.join("notion-auth-url").exists() {
            if let Some(pending) = load_pending_secure(&self.root)? {
                if Utc::now() - pending.created_at < ChronoDuration::minutes(10) {
                    let port = Url::parse(&pending.redirect_uri)
                        .ok()
                        .and_then(|u| u.port());
                    if let Some(port) = port {
                        match start_callback_listener(Some(port), pending.state.clone()) {
                            Ok((redirect, callback)) if redirect == pending.redirect_uri => {
                                self.pending = Some(pending);
                                self.callback = Some(Mutex::new(callback));
                                let url = read_auth_url(&self.root)?;
                                return Ok(EnsureResult::WaitingForAccess { auth_url: url, specific_step: "Continue the open Notion authorization in your browser; HII restored its localhost callback.".into() });
                            }
                            _ => {}
                        }
                    }
                }
                clear_pending_secure(&self.root)?;
            }
        }
        if let Some(p) = &self.pending {
            if Utc::now() - p.created_at < ChronoDuration::minutes(10) {
                let url = read_auth_url(&self.root)?;
                return Ok(EnsureResult::WaitingForAccess{auth_url:url,specific_step:"Open the Notion authorization link and finish access in your browser. HII will resume after the localhost callback is received.".into()});
            }
        }
        let protected = fetch_protected_resource_metadata()?;
        let metadata = protected["authorization_servers"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .ok_or("Notion protected-resource metadata omitted authorization_servers")?;
        let issuer = metadata.trim_end_matches('/');
        let auth_meta = fetch_json(&format!("{issuer}/.well-known/oauth-authorization-server"))?;
        let reg = auth_meta["registration_endpoint"]
            .as_str()
            .ok_or("Notion authorization server does not support dynamic client registration")?;
        validate_notion_url(reg)?;
        let state: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        let (redirect, callback) = start_callback_listener(None, state.clone())?;
        let registration_response = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build().post(reg).send_json(json!({"client_name":"HII","redirect_uris":[redirect],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"})).map_err(|_|"Notion client registration failed; response details were suppressed")?;
        let registration: Value = serde_json::from_str(
            &read_response(registration_response, MAX_OAUTH_METADATA_BYTES)
                .map_err(|_| "Invalid Notion client registration response")?,
        )
        .map_err(|_| "Invalid Notion client registration response")?;
        let client = registration["client_id"]
            .as_str()
            .ok_or("Notion registration did not return client_id")?;
        let auth_endpoint = auth_meta["authorization_endpoint"]
            .as_str()
            .ok_or("Notion metadata omitted authorization_endpoint")?;
        let token = auth_meta["token_endpoint"]
            .as_str()
            .ok_or("Notion metadata omitted token_endpoint")?;
        validate_notion_url(auth_endpoint)?;
        validate_notion_url(token)?;
        let verifier: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(64)
            .map(char::from)
            .collect();
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(digest(&SHA256, verifier.as_bytes()).as_ref());
        let p = Pending {
            state: state.clone(),
            verifier,
            redirect_uri: redirect.clone(),
            token_url: token.into(),
            client_id: client.into(),
            created_at: Utc::now(),
        };
        let mut url =
            Url::parse(auth_endpoint).map_err(|_| "Invalid Notion authorization endpoint")?;
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(scope) = auth_meta["scopes_supported"].as_array().and_then(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .find(|scope| scope.to_ascii_lowercase().contains("read"))
        }) {
            query.append_pair("scope", scope);
        }
        drop(query);
        store_pending_secure(&self.root, &p)?;
        if let Err(error) = write_private_text(&self.root.join("notion-auth-url"), url.as_str()) {
            let _ = clear_pending_secure(&self.root);
            return Err(error);
        }
        self.pending = Some(p);
        self.callback = Some(Mutex::new(callback));
        Ok(EnsureResult::WaitingForAccess{auth_url:url.to_string(),specific_step:"Open the Notion authorization link and finish access in your browser. Keep this runtime open until the browser callback returns.".into()})
    }
    fn authorization_or_unavailable(&mut self) -> Result<EnsureResult, String> {
        match self.prepare_authorization() {
            Ok(result) => Ok(result),
            Err(reason) => Ok(EnsureResult::Unavailable { reason }),
        }
    }
    fn persist_cache(&self) -> Result<(), String> {
        persist_private(&self.root.join("notion-cache.json"), &self.cache)
    }
}

#[derive(Debug)]
enum RemoteError {
    Unauthorized,
    Other(String),
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => write!(f, "Notion authorization expired; reconnect access"),
            Self::Other(s) => write!(f, "{s}"),
        }
    }
}
fn list_tools(endpoint: &str, token: &str) -> Result<Vec<RemoteTool>, RemoteError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(15))
        .build();
    let (session, protocol) = initialize_remote(&agent, endpoint, token, None)?;
    let mut req = agent
        .post(endpoint)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", &protocol);
    if let Some(id) = session {
        req = req.set("Mcp-Session-Id", &id)
    }
    let response = req
        .send_json(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}))
        .map_err(map_http)?;
    let text = read_response(response, MAX_REMOTE_RESPONSE_BYTES)
        .map_err(|_| RemoteError::Other("Notion returned an unreadable tool list".into()))?;
    let value = parse_json_or_sse_id(&text, 2).map_err(RemoteError::Other)?;
    let arr = value["result"]["tools"]
        .as_array()
        .ok_or_else(|| RemoteError::Other("Notion tools/list omitted tools".into()))?;
    if arr.len() > 128 {
        return Err(RemoteError::Other(
            "Notion MCP returned too many tools (maximum 128)".into(),
        ));
    }
    Ok(arr
        .iter()
        .filter_map(|x| {
            let name = x["name"].as_str()?;
            if !crate::mcp_client::valid_tool_name(name) {
                return None;
            }
            Some(RemoteTool {
                name: name.to_string(),
                description: crate::text::clip_bytes(
                    &crate::receipt::redact_text(
                        x["description"].as_str().unwrap_or("No description"),
                    ),
                    2048,
                ),
                input_schema: x["inputSchema"]
                    .as_object()?
                    .into_iter()
                    .fold(serde_json::Map::new(), |mut m, (k, v)| {
                        m.insert(k.clone(), v.clone());
                        m
                    })
                    .into(),
                read_only: x["annotations"]["readOnlyHint"].as_bool().unwrap_or(false),
                destructive: x["annotations"]["destructiveHint"]
                    .as_bool()
                    .unwrap_or(false),
                open_world: x["annotations"]["openWorldHint"].as_bool().unwrap_or(true),
            })
        })
        .collect())
}
fn probe_ready(endpoint: &str, token: &str) -> Result<(), RemoteError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    initialize_remote(&agent, endpoint, token, None).map(|_| ())
}
fn initialize_remote(
    agent: &ureq::Agent,
    endpoint: &str,
    token: &str,
    cancel: Option<&crate::budget::Cancel>,
) -> Result<(Option<String>, String), RemoteError> {
    if cancel.is_some_and(crate::budget::Cancel::is_cancelled) {
        return Err(RemoteError::Other("MCP request canceled".into()));
    }
    let response = agent.post(endpoint)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send_json(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":MCP_PROTOCOL,"capabilities":{},"clientInfo":{"name":"hii","version":env!("CARGO_PKG_VERSION")}}}))
        .map_err(map_http)?;
    if cancel.is_some_and(crate::budget::Cancel::is_cancelled) {
        return Err(RemoteError::Other(
            "MCP initialize completed during cancellation".into(),
        ));
    }
    let session = response.header("Mcp-Session-Id").map(str::to_string);
    let body = read_response(response, MAX_REMOTE_RESPONSE_BYTES)
        .map_err(|_| RemoteError::Other("Notion MCP initialize response was unreadable".into()))?;
    let value = parse_json_or_sse_id(&body, 1).map_err(RemoteError::Other)?;
    let protocol = value["result"]["protocolVersion"].as_str().ok_or_else(|| {
        RemoteError::Other("Notion MCP initialize omitted protocolVersion".into())
    })?;
    if protocol != MCP_PROTOCOL {
        return Err(RemoteError::Other(format!(
            "Notion MCP selected unsupported protocol version {protocol}"
        )));
    }
    let mut notification = agent
        .post(endpoint)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", protocol);
    if let Some(id) = &session {
        notification = notification.set("Mcp-Session-Id", id);
    }
    if cancel.is_some_and(crate::budget::Cancel::is_cancelled) {
        return Err(RemoteError::Other(
            "MCP request canceled before initialized notification".into(),
        ));
    }
    let _ = notification
        .send_json(json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}))
        .map_err(map_http)?;
    if cancel.is_some_and(crate::budget::Cancel::is_cancelled) {
        return Err(RemoteError::Other(
            "MCP notification completed during cancellation".into(),
        ));
    }
    Ok((session, protocol.to_string()))
}
fn map_http(e: ureq::Error) -> RemoteError {
    match e {
        ureq::Error::Status(401, _) => RemoteError::Unauthorized,
        ureq::Error::Status(s, _) => RemoteError::Other(format!("Notion MCP returned HTTP {s}")),
        _ => RemoteError::Other("Notion MCP connection failed".into()),
    }
}
fn call_remote_tool(
    endpoint: &str,
    token: &str,
    tool: &str,
    arguments: &Value,
    cancel: &crate::budget::Cancel,
) -> Result<(bool, String), RemoteError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build();
    let (session, protocol) = initialize_remote(&agent, endpoint, token, Some(cancel))?;
    let mut request = agent
        .post(endpoint)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", &protocol);
    if let Some(session) = session {
        request = request.set("Mcp-Session-Id", &session);
    }
    if cancel.is_cancelled() {
        return Err(RemoteError::Other(
            "MCP request canceled before tools/call".into(),
        ));
    }
    let response = request.send_json(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":arguments}}))
        .map_err(map_http)?;
    if cancel.is_cancelled() {
        return Err(RemoteError::Other(
            "MCP tools/call completed during cancellation; remote effect may have applied".into(),
        ));
    }
    let body = read_response(response, MAX_REMOTE_RESPONSE_BYTES)
        .map_err(|_| RemoteError::Other("Notion MCP returned an unreadable tool result".into()))?;
    let value = parse_json_or_sse_id(&body, 2).map_err(RemoteError::Other)?;
    if !value["error"].is_null() {
        return Err(RemoteError::Other("Notion MCP tool call failed".into()));
    }
    let result = &value["result"];
    let mut output = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| match item["type"].as_str() {
            Some("text") => crate::receipt::redact_text(item["text"].as_str().unwrap_or_default()),
            Some(kind) => format!("[{kind} MCP content omitted from text context]"),
            None => "[untyped MCP content omitted]".into(),
        })
        .collect::<Vec<_>>()
        .join("\n");
    if output.len() > 96 * 1024 {
        output = crate::text::clip_bytes(&output, 96 * 1024);
        output.push_str("\n… MCP output truncated");
    }
    Ok((!result["isError"].as_bool().unwrap_or(false), output))
}
fn parse_json_or_sse_id(text: &str, expected_id: u64) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if v["id"].as_u64() != Some(expected_id) {
            return Err("Notion MCP response id did not match request".into());
        }
        if !v["error"].is_null() {
            return Err("Notion MCP returned a JSON-RPC error".into());
        }
        return Ok(v);
    }
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data:").map(str::trim) {
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if v["id"].as_u64() == Some(expected_id) {
                    if !v["error"].is_null() {
                        return Err("Notion MCP returned a JSON-RPC error".into());
                    }
                    return Ok(v);
                }
            }
        }
    }
    Err("Notion MCP returned no matching JSON/SSE response".into())
}
fn read_response(response: ureq::Response, max_bytes: u64) -> Result<String, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "HTTP response body could not be read".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("HTTP response body exceeded size limit".into());
    }
    String::from_utf8(bytes).map_err(|_| "HTTP response was not valid UTF-8".into())
}
fn fetch_json(url: &str) -> Result<Value, String> {
    validate_notion_url(url)?;
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
        .get(url)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(status, _) => format!("Notion OAuth metadata endpoint {url} returned HTTP {status}; this is a metadata-access blocker, not missing account authorization"),
            _ => format!("Notion OAuth metadata endpoint {url} could not be reached; check network access or policy"),
        })?;
    let bytes = response
        .into_reader()
        .take(MAX_OAUTH_METADATA_BYTES + 1)
        .bytes()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Notion OAuth metadata was unreadable")?;
    if bytes.len() as u64 > MAX_OAUTH_METADATA_BYTES {
        return Err("Notion OAuth metadata exceeded size limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Notion OAuth metadata was invalid".into())
}
fn fetch_protected_resource_metadata() -> Result<Value, String> {
    // RFC 9728 servers can advertise the exact metadata URL in the bearer challenge.
    // Prefer it, and otherwise use the resource-specific well-known path.
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
        .get(NOTION_URL)
        .call();
    let advertised = match response {
        Err(ureq::Error::Status(401, response)) => response
            .header("WWW-Authenticate")
            .and_then(resource_metadata_from_challenge),
        _ => None,
    };
    let url = advertised.unwrap_or_else(|| {
        "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp".to_string()
    });
    validate_notion_url(&url)?;
    fetch_json(&url)
}
fn resource_metadata_from_challenge(header: &str) -> Option<String> {
    let marker = "resource_metadata=\"";
    let start = header.find(marker)? + marker.len();
    let end = header[start..].find('"')? + start;
    Some(header[start..end].to_string())
}
fn validate_notion_url(value: &str) -> Result<(), String> {
    let parsed = Url::parse(value).map_err(|_| "Notion OAuth metadata contained an invalid URL")?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    #[cfg(test)]
    if host == "127.0.0.1"
        && parsed.scheme() == "http"
        && parsed.username() == ""
        && parsed.password().is_none()
    {
        return Ok(());
    }
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || !(host == "notion.com" || host.ends_with(".notion.com"))
    {
        return Err("Notion MCP metadata referenced an unsupported endpoint; HTTPS Notion domains are required".into());
    }
    Ok(())
}
fn refresh_tokens(current: &Tokens) -> Result<Option<Tokens>, String> {
    let Some(refresh) = current.refresh_token.as_deref() else {
        return Ok(None);
    };
    let (Some(endpoint), Some(client_id)) =
        (current.token_url.as_deref(), current.client_id.as_deref())
    else {
        return Ok(None);
    };
    validate_notion_url(endpoint)?;
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build()
        .post(endpoint)
        .send_form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", client_id),
        ])
        .map_err(|error| match error {
            ureq::Error::Status(status, _) => {
                format!("Notion token refresh returned HTTP {status}")
            }
            ureq::Error::Transport(_) => {
                "Notion token refresh failed due to a transport error".to_string()
            }
        })?;
    let value: Value = serde_json::from_str(
        &read_response(response, 64 * 1024)
            .map_err(|_| "Notion token refresh response was invalid")?,
    )
    .map_err(|_| "Notion token refresh response was invalid")?;
    let Some(access) = value["access_token"].as_str() else {
        return Ok(None);
    };
    Ok(Some(Tokens {
        access_token: access.to_string(),
        refresh_token: value["refresh_token"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| current.refresh_token.clone()),
        expires_at: value["expires_in"]
            .as_i64()
            .map(|s| Utc::now() + ChronoDuration::seconds(s)),
        token_url: Some(endpoint.to_string()),
        client_id: Some(client_id.to_string()),
    }))
}
fn start_callback_listener(
    port: Option<u16>,
    expected_state: String,
) -> Result<(String, Receiver<String>), String> {
    let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(0)))
        .map_err(|_| "could not start the Notion loopback callback listener".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "could not configure the Notion callback listener".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "callback listener address unavailable")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        let mut rejected = 0u8;
        while std::time::Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // Accepted sockets can inherit the listener's nonblocking mode
                    // (notably on macOS). Wait for the bounded request read rather
                    // than treating a connect-before-write race as a dead listener.
                    if stream.set_nonblocking(false).is_err() {
                        continue;
                    }
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut request = [0u8; 8192];
                    let n = match stream.read(&mut request) {
                        Ok(n) => n,
                        Err(_) => return,
                    };
                    let line = String::from_utf8_lossy(&request[..n]);
                    let path = line
                        .lines()
                        .next()
                        .and_then(|s| s.split_whitespace().nth(1));
                    if let Some(path) = path.filter(|p| p.starts_with("/oauth/callback?")) {
                        let callback = format!("http://127.0.0.1:{port}{path}");
                        let callback_state = Url::parse(&callback).ok().and_then(|u| {
                            u.query_pairs()
                                .find(|(k, _)| k == "state")
                                .map(|(_, v)| v.to_string())
                        });
                        if callback_state.as_deref() != Some(expected_state.as_str()) {
                            rejected = rejected.saturating_add(1);
                            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            if rejected >= 8 {
                                return;
                            }
                            continue;
                        }
                        let body = "Notion authorization received. You can return to HII.";
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                        let _ = stream.write_all(response.as_bytes());
                        let _ = tx.send(callback);
                        return;
                    }
                    let _ = stream.write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100))
                }
                Err(_) => return,
            }
        }
    });
    Ok((redirect, rx))
}
fn signature(endpoint: &str) -> String {
    format!(
        "{}-v{CACHE_VERSION}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(digest(&SHA256, endpoint.as_bytes()).as_ref())
    )
}
fn persist_private<T: Serialize>(p: &Path, v: &T) -> Result<(), String> {
    let b = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    fs::write(p, b).map_err(|e| format!("cannot persist MCP metadata: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot protect MCP metadata: {e}"))?;
    }
    Ok(())
}
fn write_private_text(path: &Path, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("cannot store pending OAuth URL: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot protect pending OAuth URL: {e}"))?;
    }
    Ok(())
}
fn private_read(p: &Path, max: u64) -> Result<Vec<u8>, String> {
    let m = fs::metadata(p).map_err(|e| e.to_string())?;
    if m.len() > max {
        return Err("MCP metadata cache exceeds size limit".into());
    }
    fs::read(p).map_err(|e| e.to_string())
}
fn read_auth_url(root: &Path) -> Result<String, String> {
    fs::read_to_string(root.join("notion-auth-url"))
        .map_err(|_| "pending Notion authorization URL is unavailable".into())
}
// Keychain API is invoked through a tiny Swift bridge. Secret JSON travels only on stdin;
// neither arguments nor diagnostics contain credential values.
#[cfg(target_os = "macos")]
const KEYCHAIN_SWIFT: &str = r#"
import Foundation
import Security
let a = CommandLine.arguments
if a.count < 4 { exit(2) }
let operation = a[1]
let service = a[2]
let account = a[3]
let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                           kSecAttrService as String: service,
                           kSecAttrAccount as String: account]
if operation == "delete" {
  let status = SecItemDelete(base as CFDictionary)
  if status != errSecSuccess && status != errSecItemNotFound { exit(7) }
} else if operation == "put" {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  SecItemDelete(base as CFDictionary)
  var query = base
  query[kSecValueData as String] = data
  let status = SecItemAdd(query as CFDictionary, nil)
  if status != errSecSuccess { exit(3) }
} else {
  var query = base
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { exit(4) }
  if status != errSecSuccess { exit(5) }
  guard let data = result as? Data else { exit(6) }
  if data.count > 131072 { exit(8) }
  FileHandle.standardOutput.write(data)
}
"#;
#[cfg(target_os = "macos")]
fn keychain(operation: &str, service: &str, input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use std::process::Stdio;
    let mut child = Command::new("swift")
        .args([
            "-e",
            KEYCHAIN_SWIFT,
            operation,
            "com.hii.mcp.notionsession",
            service,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "macOS Keychain bridge is unavailable".to_string())?;
    if let Some(data) = input {
        child
            .stdin
            .take()
            .ok_or("Keychain bridge input unavailable")?
            .write_all(data)
            .map_err(|_| "Keychain bridge input failed")?;
    } else {
        drop(child.stdin.take());
    }
    let started = std::time::Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|_| "macOS Keychain bridge failed")?
        {
            Some(_) => break,
            None if started.elapsed() >= Duration::from_secs(60) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("macOS Keychain operation timed out".into());
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|_| "Keychain bridge failed")?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    if operation == "get" && out.status.code() == Some(4) {
        return Err("not found".into());
    }
    Err("macOS Keychain operation failed".into())
}
fn load_tokens(service: &str) -> Result<Option<Tokens>, String> {
    #[cfg(target_os = "macos")]
    {
        let bytes = match keychain("get", service, None) {
            Ok(bytes) => bytes,
            Err(error) if error == "not found" => return Ok(None),
            Err(error) => return Err(error),
        };
        return serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Notion Keychain entry is invalid".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = service;
        Err("Secure OAuth token storage is unsupported on this operating system; connect Notion from macOS with Keychain enabled.".into())
    }
}
fn pending_service(root: &Path) -> String {
    format!(
        "notion-pending-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(digest(&SHA256, root.to_string_lossy().as_bytes()).as_ref())
    )
}
fn load_pending_secure(root: &Path) -> Result<Option<Pending>, String> {
    #[cfg(target_os = "macos")]
    {
        let bytes = match keychain("get", &pending_service(root), None) {
            Ok(bytes) => bytes,
            Err(error) if error == "not found" => return Ok(None),
            Err(error) => return Err(error),
        };
        return serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Notion pending authorization record is invalid".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}
fn store_pending_secure(root: &Path, pending: &Pending) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bytes = serde_json::to_vec(pending)
            .map_err(|_| "cannot encode pending authorization".to_string())?;
        keychain("put", &pending_service(root), Some(&bytes)).map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pending;
        Err("Secure OAuth continuation storage is unsupported on this operating system.".into())
    }
}
fn clear_pending_secure(root: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match keychain("delete", &pending_service(root), None) {
            Ok(_) => Ok(()),
            Err(error) if error == "not found" => Ok(()),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}
fn store_tokens(service: &str, tokens: &Tokens) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bytes =
            serde_json::to_vec(tokens).map_err(|_| "cannot encode OAuth token".to_string())?;
        keychain("put", service, Some(&bytes))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (service, tokens);
        Err("Secure OAuth token storage is unsupported on this operating system; connect Notion from macOS with Keychain enabled.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_json_and_sse() {
        assert_eq!(
            parse_json_or_sse_id(r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#, 2).unwrap()
                ["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            parse_json_or_sse_id("event: progress\ndata: {\"id\":99,\"result\":{}}\nevent: message\ndata: {\"id\":2,\"result\":{}}\n\n", 2).unwrap()["id"], 2);
        assert!(parse_json_or_sse_id(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#, 2).is_err());
    }
    #[test]
    fn prefers_resource_metadata_advertised_by_bearer_challenge() {
        assert_eq!(
            resource_metadata_from_challenge(
                "Bearer realm=\"Notion\", resource_metadata=\"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp\""
            )
            .as_deref(),
            Some("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp")
        );
        assert_eq!(
            resource_metadata_from_challenge("Bearer realm=\"Notion\""),
            None
        );
    }
    #[test]
    fn notion_is_only_relevant_for_notion_intents() {
        let mut c = ConnectionManager {
            root: PathBuf::from("/tmp"),
            cache: RemoteCache::default(),
            pending: None,
            callback: None,
        };
        assert!(matches!(
            c.ensure_for_intent("Find a local file").unwrap(),
            EnsureResult::Unavailable { .. }
        ));
    }
    #[test]
    fn callback_listener_is_loopback_and_delivers_automatically() {
        use std::net::TcpStream;
        let (redirect, receiver) = start_callback_listener(None, "fixture".into()).unwrap();
        let parsed = Url::parse(&redirect).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        let mut wrong = TcpStream::connect(("127.0.0.1", parsed.port().unwrap())).unwrap();
        wrong.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        // Exercise accept-before-request deterministically, as happens under a
        // busy scheduled full-suite run. The listener must not disconnect.
        thread::sleep(Duration::from_millis(200));
        wrong
            .write_all(
                b"GET /oauth/callback?code=bad&state=wrong HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .unwrap();
        let mut wrong_response = [0u8; 128];
        let received = wrong.read(&mut wrong_response).unwrap();
        assert!(String::from_utf8_lossy(&wrong_response[..received]).starts_with("HTTP/1.1 400"));
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
        let mut stream = TcpStream::connect(("127.0.0.1", parsed.port().unwrap())).unwrap();
        stream.write_all(b"GET /oauth/callback?code=fixture&state=fixture HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let callback = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(callback.starts_with(&redirect));
        assert!(callback.contains("code=fixture"));
    }
    #[test]
    fn normal_allows_non_destructive_remote_writes_but_prompts_for_destructive_tools() {
        let mut manager = ConnectionManager::disabled(Path::new("/tmp"));
        manager.cache.tools = vec![
            RemoteTool {
                name: "read_page".into(),
                description: "read".into(),
                input_schema: json!({"type":"object"}),
                read_only: true,
                destructive: false,
                open_world: true,
            },
            RemoteTool {
                name: "update_page".into(),
                description: "write".into(),
                input_schema: json!({"type":"object"}),
                read_only: false,
                destructive: false,
                open_world: false,
            },
            RemoteTool {
                name: "delete_page".into(),
                description: "delete".into(),
                input_schema: json!({"type":"object"}),
                read_only: false,
                destructive: true,
                open_world: false,
            },
        ];
        let read = manager
            .plan_remote_call("read_page", json!({}), crate::contract::Authority::Owner)
            .unwrap();
        let write = manager
            .plan_remote_call("update_page", json!({}), crate::contract::Authority::Owner)
            .unwrap();
        assert_eq!(read.decision, crate::contract::Decision::Allow);
        let delete = manager
            .plan_remote_call("delete_page", json!({}), crate::contract::Authority::Owner)
            .unwrap();
        assert_eq!(write.decision, crate::contract::Decision::Allow);
        assert_eq!(delete.decision, crate::contract::Decision::Prompt);
        let read_only_delete = manager
            .plan_remote_call("delete_page", json!({}), crate::contract::Authority::ReadOnly)
            .unwrap();
        assert_eq!(read_only_delete.decision, crate::contract::Decision::Deny);
    }
    #[test]
    fn refresh_uses_fixture_endpoint_and_rotates_secure_token_payload() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            let header_end = loop {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "fixture request closed before headers completed");
                request.extend_from_slice(&chunk[..n]);
                assert!(request.len() <= 16 * 1024, "fixture request exceeded limit");
                if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .expect("fixture POST should include Content-Length");
            let expected_len = header_end + content_length;
            assert!(expected_len <= 16 * 1024, "fixture request exceeded limit");
            while request.len() < expected_len {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "fixture request closed before body completed");
                request.extend_from_slice(&chunk[..n]);
            }
            let text = String::from_utf8_lossy(&request[..header_end]);
            assert!(text.contains("POST /token HTTP/1.1"));
            let body = r#"{"access_token":"fixture-new-access","refresh_token":"fixture-new-refresh","expires_in":3600}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let current = Tokens {
            access_token: "fixture-old-access".into(),
            refresh_token: Some("fixture-refresh".into()),
            expires_at: Some(Utc::now() - ChronoDuration::seconds(1)),
            token_url: Some(endpoint),
            client_id: Some("fixture-client".into()),
        };
        let refreshed = refresh_tokens(&current).unwrap().unwrap();
        assert_eq!(refreshed.access_token, "fixture-new-access");
        assert_eq!(
            refreshed.refresh_token.as_deref(),
            Some("fixture-new-refresh")
        );
        server.join().unwrap();
    }
    #[test]
    fn unauthorized_fixture_maps_to_refreshable_authorization_error() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = stream.read(&mut req);
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let error = ureq::post(&endpoint).call().unwrap_err();
        assert!(matches!(map_http(error), RemoteError::Unauthorized));
        server.join().unwrap();
    }
    #[test]
    fn streamable_http_initializes_notifies_and_preserves_session_and_version() {
        use std::net::TcpListener;
        fn request(stream: &mut std::net::TcpStream) -> String {
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 1024];
            let header_end;
            loop {
                let n = stream.read(&mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos + 4;
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&bytes[..header_end]).to_ascii_lowercase();
            let content_len = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < header_end + content_len {
                let n = stream.read(&mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..n]);
            }
            String::from_utf8_lossy(&bytes[..header_end + content_len]).into_owned()
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let fixture = thread::spawn(move || {
            let mut seen = Vec::new();
            for i in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                seen.push(request(&mut stream));
                let (status, headers, body) = match i {
                    0 => (
                        "200 OK",
                        "Content-Type: application/json\r\nMcp-Session-Id: session-fixture\r\n",
                        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}"#,
                    ),
                    1 => ("202 Accepted", "", ""),
                    _ => (
                        "200 OK",
                        "Content-Type: application/json\r\n",
                        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read_page","description":"Read a page","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}"#,
                    ),
                };
                write!(stream, "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            seen
        });
        let tools = list_tools(&endpoint, "fixture-access").unwrap();
        assert_eq!(tools.len(), 1);
        let seen = fixture.join().unwrap();
        assert!(seen[0].contains("\"method\":\"initialize\""));
        assert!(seen[1].contains("\"method\":\"notifications/initialized\""));
        assert!(seen[1]
            .to_ascii_lowercase()
            .contains("mcp-protocol-version: 2025-03-26"));
        assert!(seen[1]
            .to_ascii_lowercase()
            .contains("mcp-session-id: session-fixture"));
        assert!(seen[2].contains("\"method\":\"tools/list\""));
    }
    #[test]
    fn schema_ceiling_and_readiness_are_bounded() {
        let t = Utc::now();
        let c = RemoteCache {
            version: CACHE_VERSION,
            signature: signature(NOTION_URL),
            refreshed_at: Some(t - ChronoDuration::hours(25)),
            ready_at: Some(t - ChronoDuration::minutes(6)),
            tools: vec![],
        };
        assert!(!c
            .ready_at
            .is_some_and(|x| t - x < ChronoDuration::minutes(READY_TTL_MINUTES)));
        assert!(
            c.refreshed_at
                .is_some_and(|x| t - x < ChronoDuration::hours(SCHEMA_TTL_HOURS))
                == false
        )
    }
}
