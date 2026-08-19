// SPDX-License-Identifier: LicenseRef-BSL-1.1
use crate::config::AppPaths;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    route: String,
    status: String,
    detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    schema_version: u8,
    kind: String,
    id: String,
    source: String,
    title: String,
    body: String,
    severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    coordinate: Option<String>,
    proof_refs: Vec<String>,
    deliveries: Vec<Delivery>,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_at: Option<String>,
}

fn now() -> Result<(u128, String), String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok((millis, millis.to_string()))
}
fn file(paths: &AppPaths) -> std::path::PathBuf {
    paths.runtime.join("notifications/events.jsonl")
}
fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}
fn append(paths: &AppPaths, event: &Notification) -> Result<(), String> {
    let path = file(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(
        handle,
        "{}",
        serde_json::to_string(event).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())
}
fn list_all(paths: &AppPaths) -> Result<Vec<Notification>, String> {
    let raw = match fs::read_to_string(file(paths)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut latest = BTreeMap::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let event: Notification = serde_json::from_str(line)
            .map_err(|error| format!("invalid notification ledger entry: {error}"))?;
        latest.insert(event.id.clone(), event);
    }
    let mut values: Vec<_> = latest.into_values().collect();
    values.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(values)
}

#[allow(clippy::too_many_arguments)]
pub fn send(
    paths: &AppPaths,
    title: &str,
    body: &str,
    source: &str,
    severity: &str,
    coordinate: Option<&str>,
    routes: &[String],
    proof_refs: &[String],
    json: bool,
) -> Result<(), String> {
    let title = clean(title, 160);
    let body = clean(body, 2000);
    if title.is_empty() || body.is_empty() {
        return Err("notification title and body are required".into());
    }
    if !["info", "success", "attention", "urgent"].contains(&severity) {
        return Err("severity must be info, success, attention, or urgent".into());
    }
    let mut selected = if routes.is_empty() {
        vec!["canvas".to_string()]
    } else {
        routes.to_vec()
    };
    if selected
        .iter()
        .any(|route| !["canvas", "text", "device"].contains(&route.as_str()))
    {
        return Err("route must be canvas, text, or device".into());
    }
    if !selected.iter().any(|route| route == "canvas") {
        selected.insert(0, "canvas".into());
    }
    selected.sort();
    selected.dedup();
    let (millis, created_at) = now()?;
    let event = Notification {
        schema_version: 1,
        kind: "hii.notification".into(),
        id: format!("n-{millis}-{}", std::process::id()),
        source: clean(source, 120),
        title,
        body,
        severity: severity.into(),
        coordinate: coordinate
            .map(|value| clean(value, 1000))
            .filter(|value| !value.is_empty()),
        proof_refs: proof_refs
            .iter()
            .map(|value| clean(value, 1000))
            .filter(|value| !value.is_empty())
            .take(20)
            .collect(),
        deliveries: selected
            .into_iter()
            .map(|route| {
                if route == "canvas" {
                    Delivery {
                        route,
                        status: "delivered".into(),
                        detail: "HII canvas inbox".into(),
                    }
                } else if route == "text" {
                    Delivery {
                        route,
                        status: "not_configured".into(),
                        detail: "Enroll an owned Messages recipient before external delivery."
                            .into(),
                    }
                } else {
                    Delivery {
                        route,
                        status: "not_configured".into(),
                        detail: "Enroll an owned device transport before nearby delivery.".into(),
                    }
                }
            })
            .collect(),
        created_at,
        read_at: None,
    };
    append(paths, &event)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&event).map_err(|error| error.to_string())?
        );
    } else {
        println!(
            "notified  {}\nsource    {}\ndelivery  {}",
            event.title,
            event.source,
            event
                .deliveries
                .iter()
                .map(|item| format!("{}:{}", item.route, item.status))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}
pub fn list(paths: &AppPaths, unread: bool, limit: usize, json: bool) -> Result<(), String> {
    let values: Vec<_> = list_all(paths)?
        .into_iter()
        .filter(|item| !unread || item.read_at.is_none())
        .take(limit.min(200))
        .collect();
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&values).map_err(|error| error.to_string())?
        );
    } else if values.is_empty() {
        println!("No notifications.");
    } else {
        for item in values {
            println!(
                "{}  {:<9}  {} · {}",
                if item.read_at.is_some() { " " } else { "•" },
                item.severity,
                item.source,
                item.title
            );
        }
    }
    Ok(())
}
pub fn read(paths: &AppPaths, id: &str, json: bool) -> Result<(), String> {
    let mut event = list_all(paths)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("notification not found: {id}"))?;
    event.read_at = Some(now()?.1);
    append(paths, &event)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&event).map_err(|error| error.to_string())?
        );
    } else {
        println!("read  {}", event.title);
    }
    Ok(())
}
