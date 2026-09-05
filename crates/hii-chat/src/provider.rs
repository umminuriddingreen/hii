// SPDX-License-Identifier: LicenseRef-BSL-1.1
use crate::model::{Message, MessagePart, Settings};
use anyhow::{anyhow, ensure, Context, Result};
use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{net::IpAddr, pin::Pin, time::Duration};

pub type InferenceStream = Pin<Box<dyn Stream<Item = Result<InferenceEvent>> + Send>>;

#[derive(Clone, Debug)]
pub enum InferenceEvent {
    Part(MessagePart),
    Completed { reason: Option<String> },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
}

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
}

#[async_trait]
pub trait InferenceProvider: Send + Sync {
    async fn models(&self) -> Result<Vec<ModelInfo>>;
    async fn chat(&self, request: ChatRequest) -> Result<InferenceStream>;
    async fn health(&self) -> Result<()> {
        self.models().await.map(|_| ())
    }
}

pub fn local_endpoint(value: &str) -> Result<Url> {
    let mut url = Url::parse(value).context("Invalid provider endpoint")?;
    ensure!(
        url.scheme() == "http",
        "Only local HTTP providers are supported"
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Endpoint must not contain credentials, query parameters or fragments"
    );
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']');
    ensure!(
        host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        "Provider must be on loopback (localhost, 127.0.0.1 or ::1)"
    );
    if host == "localhost" {
        url.set_host(Some("127.0.0.1"))?;
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

pub fn validate_settings(settings: &Settings) -> Result<()> {
    local_endpoint(&settings.endpoint)?;
    ensure!(
        (1..=32768).contains(&settings.max_tokens),
        "Max output must be 1 to 32768 tokens"
    );
    ensure!(
        (512..=131072).contains(&settings.context_size),
        "Context must be 512 to 131072 tokens"
    );
    ensure!(
        settings.max_tokens < settings.context_size,
        "Output budget must be smaller than context"
    );
    ensure!(settings.model.len() <= 512, "Model identifier is too long");
    Ok(())
}

pub struct OpenAiCompatible {
    client: Client,
    base: Url,
}

impl OpenAiCompatible {
    pub fn new(endpoint: &str) -> Result<Self> {
        Ok(Self {
            base: local_endpoint(endpoint)?,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .build()?,
        })
    }
}

#[async_trait]
impl InferenceProvider for OpenAiCompatible {
    async fn models(&self) -> Result<Vec<ModelInfo>> {
        #[derive(Deserialize)]
        struct Models {
            data: Vec<ModelInfo>,
        }
        let response = self
            .client
            .get(self.base.join("models")?)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .context("Cannot reach local runtime")?;
        ensure!(
            response.status().is_success(),
            "Runtime model discovery returned HTTP {}",
            response.status()
        );
        Ok(response.json::<Models>().await?.data)
    }

    async fn chat(&self, request: ChatRequest) -> Result<InferenceStream> {
        let messages: Vec<Value> = request
            .messages
            .iter()
            .map(|message| {
                let content: String = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        MessagePart::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                json!({"role": message.role, "content": content})
            })
            .collect();
        let response = self
            .client
            .post(self.base.join("chat/completions")?)
            .json(
                &json!({ "model": request.model, "messages": messages, "stream": true,
                "max_tokens": request.max_tokens }),
            )
            .send()
            .await
            .context("Local inference connection failed")?;
        ensure!(
            response.status().is_success(),
            "Local inference returned HTTP {} (check model and context budget)",
            response.status()
        );
        ensure!(
            response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.starts_with("text/event-stream")),
            "Provider did not return an SSE stream"
        );
        let mut events = response.bytes_stream().eventsource();
        Ok(Box::pin(async_stream::try_stream! {
            let mut reason = None;
            let mut done = false;
            while let Some(event) = events.next().await {
                let event = event.context("Malformed or interrupted SSE stream")?;
                if event.data.trim() == "[DONE]" {
                    done = true;
                    yield InferenceEvent::Completed { reason };
                    break;
                }
                if event.data.trim().is_empty() { continue; }
                let value: Value = serde_json::from_str(&event.data).context("Invalid JSON in provider stream")?;
                if value.get("error").is_some() || event.event == "error" { Err(anyhow!("Provider reported an inference error"))?; }
                if let Some(choice) = value["choices"].as_array().and_then(|c| c.first()) {
                    let delta = &choice["delta"];
                    if delta.get("tool_calls").is_some() || delta.get("function_call").is_some() { Err(anyhow!("Tool calls are not supported in this slice"))?; }
                    if let Some(text) = ["reasoning_content", "reasoning", "thinking"].iter()
                        .find_map(|key| delta[*key].as_str().filter(|s| !s.is_empty())) {
                        yield InferenceEvent::Part(MessagePart::Reasoning { text: text.into() });
                    }
                    if let Some(text) = delta["content"].as_str().filter(|s| !s.is_empty()) {
                        yield InferenceEvent::Part(MessagePart::Text { text: text.into() });
                    }
                    if let Some(value) = choice["finish_reason"].as_str() { reason = Some(value.into()); }
                }
            }
            if !done { Err(anyhow!("Provider disconnected before [DONE]; partial response was retained"))?; }
        }))
    }
}
