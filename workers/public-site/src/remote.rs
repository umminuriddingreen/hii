//! Paired-host relay.
//!
//! A host agent running on a paired machine opens an outbound WebSocket to
//! `/api/remote/host` with a bearer token; a signed-in browser opens
//! `/api/remote/chat`, `/api/remote/terminal`, or `/api/remote/browser`. All land in the same
//! Durable Object, which relays typed control messages between them. No
//! inbound port is opened on the host machine and nothing relayed is
//! persisted.
//!
//! Browser frames belong only to a separately granted browser channel. There
//! is no machine screen or general remote input channel.

use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{
    Env, Method, Request, Response, Result, State, WebSocket, WebSocketIncomingMessage,
    WebSocketPair, durable_object,
};

use crate::{SessionRow, api_error, hash_token, json_response, now_ms, random_token};

/// Control messages are small JSON objects; anything larger is a protocol error.
const MAX_CONTROL_BYTES: usize = 16 * 1024;
const MAX_BROWSER_FRAME_BYTES: usize = 512 * 1024;
const MAX_HOSTS_PER_ACCOUNT: i64 = 16;
const MAX_TERMINAL_GRANT_TTL_MS: i64 = 10 * 60 * 1000;

pub fn is_remote_api_path(path: &str) -> bool {
    path == "/api/remote/hosts"
        || path.starts_with("/api/remote/hosts/")
        || path == "/api/remote/chat"
        || path == "/api/remote/terminal"
        || path == "/api/remote/browser"
}

/// True for the host socket, which authenticates with a bearer token rather
/// than a session cookie and therefore bypasses the cookie gate in `lib.rs`.
pub fn is_remote_host_socket(path: &str) -> bool {
    path == "/api/remote/host"
}

#[derive(Deserialize)]
struct HostRow {
    id: String,
    account_id: String,
    name: String,
    created_at: i64,
    last_seen_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostView {
    id: String,
    name: String,
    created_at: i64,
    last_seen_at: Option<i64>,
    online: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateHost {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateTerminalGrant {
    cwd: String,
    ttl_seconds: Option<i64>,
}

#[derive(Deserialize)]
struct TerminalGrantRow {
    host_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBrowserGrant {
    ttl_seconds: Option<i64>,
}

fn browser_grant_host(path: &str) -> Option<&str> {
    path.strip_prefix("/api/remote/hosts/")?
        .strip_suffix("/browser-grants")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

fn browser_viewer_message_allowed(tag: &str, text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let grant = tag.trim_start_matches("browser:");
    let kind = value.get("t").and_then(|v| v.as_str()).unwrap_or_default();
    let claimed = value
        .get("grantId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if claimed != grant {
        return false;
    }
    match kind {
        "browser.open" | "browser.navigate" => value
            .get("url")
            .and_then(|v| v.as_str())
            .is_some_and(|url| {
                url.len() <= 4096 && (url.starts_with("https://") || url.starts_with("http://"))
            }),
        "browser.close" | "browser.ack" => true,
        "browser.input" => matches!(
            value.get("event").and_then(|v| v.as_str()),
            Some(
                "mousePressed"
                    | "mouseReleased"
                    | "mouseMoved"
                    | "mouseWheel"
                    | "keyDown"
                    | "keyUp"
                    | "char"
            )
        ),
        _ => false,
    }
}

fn terminal_grant_host(path: &str) -> Option<&str> {
    path.strip_prefix("/api/remote/hosts/")?
        .strip_suffix("/terminal-grants")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

fn terminal_viewer_message_allowed(tag: &str, text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let grant = tag.trim_start_matches("terminal:");
    let kind = value.get("t").and_then(|v| v.as_str()).unwrap_or_default();
    let claimed = value
        .get("grantId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    claimed == grant
        && matches!(
            kind,
            "terminal.open" | "terminal.input" | "terminal.resize" | "terminal.close"
        )
}

fn chat_viewer_message_allowed(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let kind = value.get("t").and_then(|v| v.as_str()).unwrap_or_default();
    let request_id = value
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    !request_id.is_empty() && request_id.len() <= 128 && matches!(kind, "chat.run" | "chat.cancel")
}

fn room_name(account_id: &str, host_id: &str) -> String {
    format!("remote:{account_id}:{host_id}")
}

async fn room(env: &Env, account_id: &str, host_id: &str) -> Result<worker::durable::Stub> {
    env.durable_object("REMOTE_ROOM")?
        .id_from_name(&room_name(account_id, host_id))?
        .get_stub()
}

async fn room_online(env: &Env, account_id: &str, host_id: &str) -> bool {
    let Ok(stub) = room(env, account_id, host_id).await else {
        return false;
    };
    let Ok(mut response) = stub.fetch_with_str("https://remote.invalid/status").await else {
        return false;
    };
    response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|value| value.get("online").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// Routes the cookie-authenticated half of the API.
pub async fn handle_remote_api(
    request: &mut Request,
    env: &Env,
    session: &SessionRow,
) -> Result<Response> {
    let url = request.url()?;
    let path = url.path().to_owned();
    let db = env.d1("IDENTITY")?;

    if path == "/api/remote/chat" {
        let Some(host_id) = url
            .query_pairs()
            .find(|(key, _)| key == "host")
            .map(|(_, value)| value.into_owned())
        else {
            return api_error(400, "host_required");
        };
        let owned = db
            .prepare("SELECT id FROM remote_hosts WHERE id = ?1 AND account_id = ?2")
            .bind(&[host_id.as_str().into(), session.account_id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if owned.is_none() {
            return api_error(404, "not_found");
        }
        if request.headers().get("Upgrade")?.as_deref() != Some("websocket") {
            return api_error(426, "upgrade_required");
        }
        let stub = room(env, &session.account_id, &host_id).await?;
        return stub.fetch_with_request(request.clone()?).await;
    }

    if path == "/api/remote/terminal" || path == "/api/remote/browser" {
        let Some(grant_id) = url
            .query_pairs()
            .find(|(key, _)| key == "grant")
            .map(|(_, value)| value.into_owned())
        else {
            return api_error(400, "grant_required");
        };
        let grant = db
            .prepare(
                if path == "/api/remote/browser" {
                    "SELECT host_id FROM browser_grants WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL AND expires_at > ?3"
                } else { "SELECT host_id FROM terminal_grants
                 WHERE id = ?1 AND account_id = ?2 AND revoked_at IS NULL AND expires_at > ?3"
                }
            )
            .bind(&[
                grant_id.as_str().into(),
                session.account_id.as_str().into(),
                JsValue::from_f64(now_ms() as f64),
            ])?
            .first::<TerminalGrantRow>(None)
            .await?;
        let Some(grant) = grant else {
            return api_error(404, "grant_unavailable");
        };
        if request.headers().get("Upgrade")?.as_deref() != Some("websocket") {
            return api_error(426, "upgrade_required");
        }
        let stub = room(env, &session.account_id, &grant.host_id).await?;
        return stub.fetch_with_request(request.clone()?).await;
    }

    if matches!(request.method(), Method::Post | Method::Delete)
        && request.headers().get("X-HII-CSRF")?.as_deref() != Some(session.csrf_token.as_str())
    {
        return api_error(403, "csrf_mismatch");
    }

    match (request.method(), path.as_str()) {
        (Method::Get, "/api/remote/hosts") => {
            let rows = db
                .prepare(
                    "SELECT id, account_id, name, created_at, last_seen_at
                     FROM remote_hosts WHERE account_id = ?1 ORDER BY created_at DESC",
                )
                .bind(&[session.account_id.as_str().into()])?
                .all()
                .await?
                .results::<HostRow>()?;
            let mut hosts = Vec::with_capacity(rows.len());
            for row in rows {
                let online = room_online(env, &row.account_id, &row.id).await;
                hosts.push(HostView {
                    id: row.id,
                    name: row.name,
                    created_at: row.created_at,
                    last_seen_at: row.last_seen_at,
                    online,
                });
            }
            json_response(200, json!({ "hosts": hosts }))
        }
        (Method::Post, "/api/remote/hosts") => {
            let input: CreateHost = crate::read_json(request).await?;
            let name = input.name.trim();
            if name.is_empty() || name.chars().count() > 64 {
                return api_error(400, "invalid_name");
            }
            let count = db
                .prepare("SELECT COUNT(*) AS count FROM remote_hosts WHERE account_id = ?1")
                .bind(&[session.account_id.as_str().into()])?
                .first::<serde_json::Value>(None)
                .await?
                .and_then(|value| value.get("count").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            if count >= MAX_HOSTS_PER_ACCOUNT {
                return api_error(409, "too_many_hosts");
            }
            let id = random_token()?;
            let token = format!("{id}.{}", random_token()?);
            db.prepare(
                "INSERT INTO remote_hosts (id, account_id, name, token_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .bind(&[
                id.as_str().into(),
                session.account_id.as_str().into(),
                name.into(),
                hash_token(&token).as_str().into(),
                JsValue::from_f64(now_ms() as f64),
            ])?
            .run()
            .await?;
            // The token is returned exactly once; only its hash is stored.
            json_response(201, json!({ "hostId": id, "token": token, "name": name }))
        }
        (Method::Post, path) if terminal_grant_host(path).is_some() => {
            let host_id = terminal_grant_host(path).unwrap_or_default();
            let input: CreateTerminalGrant = crate::read_json(request).await?;
            let cwd = input.cwd.trim();
            if cwd.is_empty() || cwd.len() > 4096 || cwd.as_bytes().contains(&0) {
                return api_error(400, "invalid_terminal_cwd");
            }
            let owned = db
                .prepare("SELECT id FROM remote_hosts WHERE id = ?1 AND account_id = ?2")
                .bind(&[host_id.into(), session.account_id.as_str().into()])?
                .first::<serde_json::Value>(None)
                .await?;
            if owned.is_none() {
                return api_error(404, "not_found");
            }
            let ttl_ms = input
                .ttl_seconds
                .unwrap_or(300)
                .clamp(30, MAX_TERMINAL_GRANT_TTL_MS / 1000)
                * 1000;
            let id = random_token()?;
            let created_at = now_ms();
            let expires_at = created_at + ttl_ms;
            db.prepare(
                "INSERT INTO terminal_grants (id, account_id, host_id, cwd, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .bind(&[
                id.as_str().into(),
                session.account_id.as_str().into(),
                host_id.into(),
                cwd.into(),
                JsValue::from_f64(created_at as f64),
                JsValue::from_f64(expires_at as f64),
            ])?
            .run()
            .await?;
            json_response(
                201,
                json!({
                    "grantId": id,
                    "hostId": host_id,
                    "cwd": cwd,
                    "expiresAt": expires_at,
                    "authority": "open_terminal"
                }),
            )
        }
        (Method::Post, path) if browser_grant_host(path).is_some() => {
            let host_id = browser_grant_host(path).unwrap_or_default();
            let input: CreateBrowserGrant = crate::read_json(request).await?;
            let owned = db
                .prepare("SELECT id FROM remote_hosts WHERE id = ?1 AND account_id = ?2")
                .bind(&[host_id.into(), session.account_id.as_str().into()])?
                .first::<serde_json::Value>(None)
                .await?;
            if owned.is_none() {
                return api_error(404, "not_found");
            }
            let ttl_ms = input.ttl_seconds.unwrap_or(300).clamp(30, 600) * 1000;
            let id = random_token()?;
            let created_at = now_ms();
            let expires_at = created_at + ttl_ms;
            db.prepare("INSERT INTO browser_grants (id, account_id, host_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
                .bind(&[id.as_str().into(), session.account_id.as_str().into(), host_id.into(),
                    JsValue::from_f64(created_at as f64), JsValue::from_f64(expires_at as f64)])?
                .run().await?;
            json_response(
                201,
                json!({ "grantId": id, "hostId": host_id, "expiresAt": expires_at, "authority": "browse_isolated_profile" }),
            )
        }
        (Method::Delete, path) if path.starts_with("/api/remote/browser-grants/") => {
            let grant_id = path.trim_start_matches("/api/remote/browser-grants/");
            let grant = db
                .prepare("SELECT host_id FROM browser_grants WHERE id = ?1 AND account_id = ?2")
                .bind(&[grant_id.into(), session.account_id.as_str().into()])?
                .first::<TerminalGrantRow>(None)
                .await?;
            db.prepare("UPDATE browser_grants SET revoked_at = ?1 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL")
                .bind(&[JsValue::from_f64(now_ms() as f64), grant_id.into(), session.account_id.as_str().into()])?
                .run().await?;
            if let Some(grant) = grant
                && let Ok(stub) = room(env, &session.account_id, &grant.host_id).await
            {
                let _ = stub
                    .fetch_with_str(&format!(
                        "https://remote.invalid/revoke-browser?grant={grant_id}"
                    ))
                    .await;
            }
            json_response(200, json!({ "revoked": true }))
        }
        (Method::Delete, path) if path.starts_with("/api/remote/terminal-grants/") => {
            let grant_id = path.trim_start_matches("/api/remote/terminal-grants/");
            let grant = db
                .prepare("SELECT host_id FROM terminal_grants WHERE id = ?1 AND account_id = ?2")
                .bind(&[grant_id.into(), session.account_id.as_str().into()])?
                .first::<TerminalGrantRow>(None)
                .await?;
            db.prepare(
                "UPDATE terminal_grants SET revoked_at = ?1
                 WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
            )
            .bind(&[
                JsValue::from_f64(now_ms() as f64),
                grant_id.into(),
                session.account_id.as_str().into(),
            ])?
            .run()
            .await?;
            if let Some(grant) = grant
                && let Ok(stub) = room(env, &session.account_id, &grant.host_id).await
            {
                let _ = stub
                    .fetch_with_str(&format!(
                        "https://remote.invalid/revoke-terminal?grant={grant_id}"
                    ))
                    .await;
            }
            json_response(200, json!({ "revoked": true }))
        }
        (Method::Delete, path) => {
            let Some(host_id) = path.strip_prefix("/api/remote/hosts/") else {
                return api_error(404, "not_found");
            };
            db.prepare("DELETE FROM remote_hosts WHERE id = ?1 AND account_id = ?2")
                .bind(&[host_id.into(), session.account_id.as_str().into()])?
                .run()
                .await?;
            if let Ok(stub) = room(env, &session.account_id, host_id).await {
                let _ = stub.fetch_with_str("https://remote.invalid/evict").await;
            }
            json_response(200, json!({ "revoked": true }))
        }
        _ => api_error(404, "not_found"),
    }
}

/// The host socket: bearer-token authenticated, no cookie, no CSRF.
pub async fn handle_host_socket(request: &Request, env: &Env) -> Result<Response> {
    if request.headers().get("Upgrade")?.as_deref() != Some("websocket") {
        return api_error(426, "upgrade_required");
    }
    let url = request.url()?;
    let Some(token) = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
    else {
        return api_error(401, "authentication_required");
    };
    let db = env.d1("IDENTITY")?;
    let Some(row) = db
        .prepare(
            "SELECT id, account_id, name, created_at, last_seen_at
             FROM remote_hosts WHERE token_hash = ?1",
        )
        .bind(&[hash_token(&token).as_str().into()])?
        .first::<HostRow>(None)
        .await?
    else {
        return api_error(401, "authentication_required");
    };
    db.prepare("UPDATE remote_hosts SET last_seen_at = ?1 WHERE id = ?2")
        .bind(&[JsValue::from_f64(now_ms() as f64), row.id.as_str().into()])?
        .run()
        .await?;
    let stub = room(env, &row.account_id, &row.id).await?;
    // The original request is forwarded verbatim: workerd only completes a
    // WebSocket upgrade when the untouched Upgrade request reaches the object.
    stub.fetch_with_request(request.clone()?).await
}

#[durable_object]
pub struct RemoteRoom {
    state: State,
    env: Env,
}

impl worker::DurableObject for RemoteRoom {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        let url = request.url()?;
        let path = url.path().to_owned();
        match path.as_str() {
            "/status" => {
                let online = !self.state.get_websockets_with_tag("host").is_empty();
                let viewers = self.state.get_websockets_with_tag("chat").len();
                Response::from_json(&json!({ "online": online, "viewers": viewers }))
            }
            "/evict" => {
                for socket in self.state.get_websockets() {
                    let _ = socket.close(Some(4003), Some("revoked"));
                }
                Response::from_json(&json!({ "evicted": true }))
            }
            "/revoke-terminal" => {
                if let Some(grant) = url
                    .query_pairs()
                    .find(|(key, _)| key == "grant")
                    .map(|(_, value)| value.into_owned())
                {
                    for socket in self
                        .state
                        .get_websockets_with_tag(&format!("terminal:{grant}"))
                    {
                        let _ = socket.close(Some(4003), Some("terminal grant revoked"));
                    }
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(
                            json!({ "t": "terminal.revoked", "grantId": grant }).to_string(),
                        );
                    }
                }
                Response::from_json(&json!({ "revoked": true }))
            }
            "/revoke-browser" => {
                if let Some(grant) = url
                    .query_pairs()
                    .find(|(key, _)| key == "grant")
                    .map(|(_, value)| value.into_owned())
                {
                    for socket in self
                        .state
                        .get_websockets_with_tag(&format!("browser:{grant}"))
                    {
                        let _ = socket.close(Some(4003), Some("browser grant revoked"));
                    }
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(
                            json!({ "t": "browser.revoked", "grantId": grant }).to_string(),
                        );
                    }
                }
                Response::from_json(&json!({ "revoked": true }))
            }
            "/api/remote/host"
            | "/api/remote/chat"
            | "/api/remote/terminal"
            | "/api/remote/browser" => {
                let grant = url
                    .query_pairs()
                    .find(|(key, _)| key == "grant")
                    .map(|(_, value)| value.into_owned());
                let role = if path == "/api/remote/host" {
                    "host"
                } else if path == "/api/remote/terminal" {
                    // The API already checked account ownership and grant lifetime.
                    "terminal"
                } else if path == "/api/remote/browser" {
                    "browser"
                } else {
                    "chat"
                };
                let tag = match role {
                    "terminal" | "browser" => {
                        format!("{role}:{}", grant.as_deref().unwrap_or("invalid"))
                    }
                    _ => role.to_owned(),
                };
                let browser_expires = if role == "browser" {
                    let grant_id = grant.as_deref().unwrap_or_default();
                    let row = self.env.d1("IDENTITY")?
                        .prepare("SELECT expires_at FROM browser_grants WHERE id = ?1 AND revoked_at IS NULL AND expires_at > ?2")
                        .bind(&[grant_id.into(), JsValue::from_f64(now_ms() as f64)])?
                        .first::<serde_json::Value>(None).await?;
                    let Some(expires_at) =
                        row.and_then(|value| value.get("expires_at").and_then(|v| v.as_i64()))
                    else {
                        return Response::error("browser_grant_unavailable", 404);
                    };
                    Some(format!("expires:{expires_at}"))
                } else {
                    None
                };
                if role == "host" {
                    // One host per room: a reconnecting agent replaces the stale socket.
                    for stale in self.state.get_websockets_with_tag("host") {
                        let _ = stale.close(Some(4000), Some("replaced"));
                    }
                }
                let pair = WebSocketPair::new()?;
                if let Some(expires) = browser_expires.as_deref() {
                    self.state
                        .accept_websocket_with_tags(&pair.server, &[&tag, expires]);
                } else {
                    self.state.accept_websocket_with_tags(&pair.server, &[&tag]);
                }
                if role == "chat" {
                    // Nudge the host to re-announce itself to a joining viewer.
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(r#"{"t":"viewer-joined"}"#);
                    }
                    let online = !self.state.get_websockets_with_tag("host").is_empty();
                    let _ = pair.server.send_with_str(
                        json!({ "t": "chat.room", "hostOnline": online }).to_string(),
                    );
                } else if role == "host" {
                    for chat in self.state.get_websockets_with_tag("chat") {
                        let _ = chat.send_with_str(r#"{"t":"chat.host-online"}"#);
                    }
                } else if role == "browser" {
                    let online = !self.state.get_websockets_with_tag("host").is_empty();
                    let _ = pair.server.send_with_str(
                        json!({ "t": "browser.room", "hostOnline": online }).to_string(),
                    );
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(
                            json!({ "t": "browser.viewer_joined", "grantId": grant }).to_string(),
                        );
                    }
                } else {
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(
                            json!({ "t": "terminal.viewer_joined", "grantId": grant }).to_string(),
                        );
                    }
                }
                Response::from_websocket(pair.client)
            }
            _ => Response::error("not_found", 404),
        }
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let from_host = self.state.get_tags(&ws).iter().any(|tag| tag == "host");
        let terminal_tag = self
            .state
            .get_tags(&ws)
            .into_iter()
            .find(|tag| tag.starts_with("terminal:"));
        let browser_tag = self
            .state
            .get_tags(&ws)
            .into_iter()
            .find(|tag| tag.starts_with("browser:"));
        let from_chat = self.state.get_tags(&ws).iter().any(|tag| tag == "chat");
        match message {
            // The relay is text-only; binary frames belong to no channel.
            WebSocketIncomingMessage::Binary(_) => {}
            WebSocketIncomingMessage::String(text) => {
                if text.len() > MAX_BROWSER_FRAME_BYTES {
                    return Ok(());
                }
                if let Some(tag) = browser_tag {
                    let active = self.state.get_tags(&ws).iter().any(|tag| {
                        tag.strip_prefix("expires:")
                            .and_then(|value| value.parse::<i64>().ok())
                            .is_some_and(|expiry| expiry > now_ms())
                    });
                    if !active {
                        let _ = ws.close(Some(4003), Some("browser grant expired"));
                        return Ok(());
                    }
                    if text.len() > MAX_CONTROL_BYTES
                        || !browser_viewer_message_allowed(&tag, &text)
                    {
                        return Ok(());
                    }
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(&text);
                    }
                } else if text.len() > MAX_CONTROL_BYTES && !from_host {
                    return Ok(());
                } else if let Some(tag) = terminal_tag {
                    if !terminal_viewer_message_allowed(&tag, &text) {
                        return Ok(());
                    }
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(&text);
                    }
                } else if from_chat {
                    if !chat_viewer_message_allowed(&text) {
                        return Ok(());
                    }
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(&text);
                    }
                } else if from_host {
                    let value = serde_json::from_str::<serde_json::Value>(&text).ok();
                    let kind = value
                        .as_ref()
                        .and_then(|item| item.get("t"))
                        .and_then(|item| item.as_str())
                        .unwrap_or_default();
                    let grant = value
                        .as_ref()
                        .and_then(|item| item.get("grantId"))
                        .and_then(|item| item.as_str());
                    if kind.starts_with("chat.") && text.len() <= MAX_CONTROL_BYTES {
                        for viewer in self.state.get_websockets_with_tag("chat") {
                            let _ = viewer.send_with_str(&text);
                        }
                    } else if kind.starts_with("browser.")
                        && kind != "browser.input"
                        && kind != "browser.navigate"
                    {
                        if let Some(grant) = grant {
                            for viewer in self
                                .state
                                .get_websockets_with_tag(&format!("browser:{grant}"))
                            {
                                let active = self.state.get_tags(&viewer).iter().any(|tag| {
                                    tag.strip_prefix("expires:")
                                        .and_then(|value| value.parse::<i64>().ok())
                                        .is_some_and(|expiry| expiry > now_ms())
                                });
                                if active {
                                    let _ = viewer.send_with_str(&text);
                                } else {
                                    let _ = viewer.close(Some(4003), Some("browser grant expired"));
                                }
                            }
                        }
                    } else if let Some(grant) = grant {
                        for viewer in self
                            .state
                            .get_websockets_with_tag(&format!("terminal:{grant}"))
                        {
                            let _ = viewer.send_with_str(&text);
                        }
                    }
                } else {
                    for host in self.state.get_websockets_with_tag("host") {
                        let _ = host.send_with_str(&text);
                    }
                }
            }
        }
        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        if self.state.get_tags(&ws).iter().any(|tag| tag == "host")
            && self.state.get_websockets_with_tag("host").len() <= 1
        {
            for chat in self.state.get_websockets_with_tag("chat") {
                let _ = chat.send_with_str(r#"{"t":"chat.host-offline"}"#);
            }
            for browser in self.state.get_websockets() {
                if self
                    .state
                    .get_tags(&browser)
                    .iter()
                    .any(|tag| tag.starts_with("browser:"))
                {
                    let _ = browser.send_with_str(r#"{"t":"browser.host-offline"}"#);
                }
            }
        } else if let Some(grant) = self
            .state
            .get_tags(&ws)
            .into_iter()
            .find(|tag| tag.starts_with("browser:"))
        {
            for host in self.state.get_websockets_with_tag("host") {
                let _ = host.send_with_str(json!({ "t": "browser.close", "grantId": grant.trim_start_matches("browser:") }).to_string());
            }
        }
        Ok(())
    }

    async fn websocket_error(&self, _ws: WebSocket, _error: worker::Error) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        browser_grant_host, browser_viewer_message_allowed, chat_viewer_message_allowed,
        terminal_grant_host, terminal_viewer_message_allowed,
    };

    #[test]
    fn terminal_grant_path_names_exactly_one_host() {
        assert_eq!(
            terminal_grant_host("/api/remote/hosts/host-1/terminal-grants"),
            Some("host-1")
        );
        assert_eq!(
            terminal_grant_host("/api/remote/hosts/host-1/other/terminal-grants"),
            None
        );
        assert_eq!(
            terminal_grant_host("/api/remote/hosts//terminal-grants"),
            None
        );
    }

    #[test]
    fn terminal_viewer_is_bound_to_its_grant_and_typed_messages() {
        assert!(terminal_viewer_message_allowed(
            "terminal:grant-1",
            r#"{"t":"terminal.input","grantId":"grant-1","data":"aA=="}"#
        ));
        assert!(!terminal_viewer_message_allowed(
            "terminal:grant-1",
            r#"{"t":"terminal.input","grantId":"grant-2","data":"aA=="}"#
        ));
        assert!(!terminal_viewer_message_allowed(
            "terminal:grant-1",
            r#"{"t":"move","grantId":"grant-1","x":0,"y":0}"#
        ));
        assert!(!terminal_viewer_message_allowed(
            "terminal:grant-1",
            "not-json"
        ));
    }

    #[test]
    fn chat_viewer_can_only_request_or_cancel_a_bounded_chat_turn() {
        assert!(chat_viewer_message_allowed(
            r#"{"t":"chat.run","requestId":"turn-1","prompt":"hi"}"#
        ));
        assert!(chat_viewer_message_allowed(
            r#"{"t":"chat.cancel","requestId":"turn-1"}"#
        ));
        assert!(!chat_viewer_message_allowed(
            r#"{"t":"terminal.open","requestId":"turn-1"}"#
        ));
        assert!(!chat_viewer_message_allowed(
            r#"{"t":"chat.run","requestId":""}"#
        ));
    }

    #[test]
    fn browser_grant_and_inputs_are_browser_only() {
        assert_eq!(
            browser_grant_host("/api/remote/hosts/host-1/browser-grants"),
            Some("host-1")
        );
        assert_eq!(
            browser_grant_host("/api/remote/hosts/host-1/other/browser-grants"),
            None
        );
        assert!(browser_viewer_message_allowed(
            "browser:grant-1",
            r#"{"t":"browser.navigate","grantId":"grant-1","url":"https://example.com"}"#
        ));
        assert!(browser_viewer_message_allowed(
            "browser:grant-1",
            r#"{"t":"browser.input","grantId":"grant-1","event":"mousePressed","x":1,"y":2}"#
        ));
        assert!(!browser_viewer_message_allowed(
            "browser:grant-1",
            r#"{"t":"browser.navigate","grantId":"grant-2","url":"https://example.com"}"#
        ));
        assert!(!browser_viewer_message_allowed(
            "browser:grant-1",
            r#"{"t":"browser.open","grantId":"grant-1","url":"file:///etc/passwd"}"#
        ));
        assert!(!browser_viewer_message_allowed(
            "browser:grant-1",
            r#"{"t":"terminal.open","grantId":"grant-1"}"#
        ));
    }
}
