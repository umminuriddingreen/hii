//! Owner-only transport for the existing CLI-backed personal workspace.
//! Bodies pass through live sockets; they are never written to cloud storage.
use crate::{api_error, now_ms};
use serde_json::{Value, json};
use worker::{
    Env, Request, Response, Result, State, WebSocket, WebSocketIncomingMessage, WebSocketPair,
    durable_object,
};

pub fn owner(env: &Env, account: &str) -> bool {
    env.secret("HII_PERSONAL_ACCOUNT_ID")
        .map(|id| !account.is_empty() && id.to_string() == account)
        .unwrap_or(false)
}
pub fn host_authorized(env: &Env, request: &Request) -> bool {
    let Ok(secret) = env.secret("HII_PERSONAL_HOST_KEY") else {
        return false;
    };
    let expected = format!("Bearer {}", secret);
    request
        .headers()
        .get("Authorization")
        .ok()
        .flatten()
        .is_some_and(|supplied| {
            supplied.len() == expected.len()
                && supplied
                    .bytes()
                    .zip(expected.bytes())
                    .fold(0u8, |a, (b, c)| a | (b ^ c))
                    == 0
        })
}
pub async fn socket(request: &Request, env: &Env) -> Result<Response> {
    let ns = env.durable_object("PERSONAL_ROOM")?;
    ns.id_from_name("owner")?
        .get_stub()?
        .fetch_with_request(request.clone()?)
        .await
}
#[durable_object]
pub struct PersonalRoom {
    state: State,
    env: Env,
}
impl worker::DurableObject for PersonalRoom {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }
    async fn fetch(&self, request: Request) -> Result<Response> {
        if request.headers().get("Upgrade")?.as_deref() != Some("websocket") {
            return api_error(426, "upgrade_required");
        }
        let host = request.path() == "/api/personal/host";
        let pair = WebSocketPair::new()?;
        if host {
            if !host_authorized(&self.env, &request) {
                return api_error(401, "authentication_required");
            }
            for old in self.state.get_websockets_with_tag("host") {
                let _ = old.close(Some(4000), Some("host replaced"));
            }
            self.state
                .accept_websocket_with_tags(&pair.server, &["host"]);
        } else {
            let Some(token) = crate::cookie(&request, crate::SESSION_COOKIE)? else {
                return api_error(401, "authentication_required");
            };
            let db = self.env.d1("IDENTITY")?;
            let Some(session) = crate::active_session(&db, &token).await? else {
                return api_error(401, "authentication_required");
            };
            if !owner(&self.env, &session.account_id) {
                return api_error(404, "not_found");
            }
            if self.state.get_websockets_with_tag("viewer").len() >= 16 {
                return api_error(429, "too_many_connections");
            }
            let tag = format!("client:{}", crate::random_token()?);
            let hash = format!("session:{}", crate::hash_token(&token));
            self.state
                .accept_websocket_with_tags(&pair.server, &["viewer", &tag, &hash]);
            pair.server.send_with_str(json!({"t":"ready","online":!self.state.get_websockets_with_tag("host").is_empty()}).to_string())?;
        }
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let WebSocketIncomingMessage::String(text) = message else {
            return Ok(());
        };
        if text.len() > 192 * 1024 {
            let _ = ws.close(Some(1009), Some("frame too large"));
            return Ok(());
        }
        let Ok(mut msg) = serde_json::from_str::<Value>(&text) else {
            return Ok(());
        };
        let tags = self.state.get_tags(&ws);
        if tags.iter().any(|t| t == "host") {
            if let Some(client) = msg["client"].as_str() {
                for viewer in self.state.get_websockets_with_tag(client) {
                    let _ = viewer.send_with_str(&text);
                }
            }
            return Ok(());
        }
        let Some(client) = tags.iter().find(|t| t.starts_with("client:")) else {
            return Ok(());
        };
        let hash = tags
            .iter()
            .find_map(|t| t.strip_prefix("session:"))
            .unwrap_or_default();
        // Recheck the live session on every request and upload frame: logout and
        // account revocation cannot leave a reusable remote-control socket.
        let db = self.env.d1("IDENTITY")?;
        let row = db
            .prepare("SELECT account_id FROM sessions WHERE token_hash=?1 AND expires_at>?2")
            .bind(&[hash.into(), (now_ms() as f64).into()])?
            .first::<Value>(None)
            .await?;
        if !row
            .as_ref()
            .and_then(|r| r["account_id"].as_str())
            .is_some_and(|a| owner(&self.env, a))
        {
            let _ = ws.close(Some(4003), Some("session expired"));
            return Ok(());
        }
        if !matches!(
            msg["t"].as_str(),
            Some("request" | "upload" | "end" | "cancel")
        ) {
            return Ok(());
        }
        let hosts = self.state.get_websockets_with_tag("host");
        if hosts.is_empty() {
            ws.send_with_str(json!({"t":"error","id":msg["id"],"message":"Your Mac is offline. Open HII on your Mac and retry."}).to_string())?;
            return Ok(());
        }
        msg["client"] = json!(client);
        for host in hosts {
            host.send_with_str(msg.to_string())?;
        }
        Ok(())
    }
    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        let tags = self.state.get_tags(&ws);
        if tags.iter().any(|t| t == "host") {
            for viewer in self.state.get_websockets_with_tag("viewer") {
                let _ = viewer.close(Some(1012), Some("Mac disconnected"));
            }
        } else if let Some(client) = tags.iter().find(|t| t.starts_with("client:")) {
            for host in self.state.get_websockets_with_tag("host") {
                let _ = host.send_with_str(json!({"t":"disconnect","client":client}).to_string());
            }
        }
        Ok(())
    }
    async fn websocket_error(&self, ws: WebSocket, _error: worker::Error) -> Result<()> {
        let _ = ws.close(Some(1011), Some("connection error"));
        Ok(())
    }
}
