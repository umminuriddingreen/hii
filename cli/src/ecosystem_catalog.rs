use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_RESOURCES: usize = 128;
const MAX_SYSTEMS: usize = 64;
const MAX_JSONL_LINES: usize = 256;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_LINE_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcosystemCatalog {
    schema_version: u8,
    kind: &'static str,
    authority: &'static str,
    resources: Vec<EcosystemResource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EcosystemResource {
    id: String,
    kind: ResourceKind,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    status: ResourceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    source_ref: String,
    object_ref: ObjectRef,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResourceKind {
    Device,
    Capability,
    Job,
    Artifact,
    Receipt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResourceStatus {
    Ready,
    Running,
    Blocked,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectRef {
    authority: &'static str,
    id: String,
    kind: ResourceKind,
}

#[derive(Deserialize)]
struct SystemsFile {
    #[serde(default)]
    systems: Vec<Value>,
}

pub fn build(runtime: &Path) -> EcosystemCatalog {
    let mut resources = BTreeMap::<(ResourceKind, String), EcosystemResource>::new();
    project_systems(runtime, &mut resources);
    project_captures(runtime, &mut resources);
    project_workflows(runtime, &mut resources);
    project_events(runtime, &mut resources);

    EcosystemCatalog {
        schema_version: 1,
        kind: "hii.ecosystem.catalog",
        authority: "hii-runtime",
        resources: resources.into_values().take(MAX_RESOURCES).collect(),
    }
}

pub fn render_json(runtime: &Path) -> Result<String, String> {
    serde_json::to_string_pretty(&build(runtime)).map_err(|error| error.to_string())
}

fn project_systems(
    runtime: &Path,
    resources: &mut BTreeMap<(ResourceKind, String), EcosystemResource>,
) {
    let Some(raw) = read_bounded(runtime.join("systems.json")) else {
        return;
    };
    let Ok(registry) = serde_json::from_slice::<SystemsFile>(&raw) else {
        return;
    };
    for value in registry.systems.into_iter().take(MAX_SYSTEMS) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(id) = clean_id(object.get("id")) else {
            continue;
        };
        let os = clean_text(object.get("os"), 40);
        let detail = os
            .filter(|value| value != "unknown")
            .map(|value| format!("{value} · enrolled"))
            .or_else(|| Some("Enrolled device".to_string()));
        // Enrollment proves identity, not liveness or executor readiness.
        insert(
            resources,
            resource(ResourceSpec {
                id: id.clone(),
                kind: ResourceKind::Device,
                name: id.clone(),
                detail,
                status: ResourceStatus::Unknown,
                node_id: Some(id.clone()),
                updated_at: None,
                source_ref: format!("hii-runtime://systems/{id}"),
            }),
        );
    }
}

fn project_captures(
    runtime: &Path,
    resources: &mut BTreeMap<(ResourceKind, String), EcosystemResource>,
) {
    for value in read_jsonl(runtime.join("ecosystem/captures.jsonl")) {
        let Some(object) = value.as_object() else {
            continue;
        };
        if string(object.get("kind")) != Some("hii.capture") {
            continue;
        }
        let Some(id) = clean_id(object.get("id")) else {
            continue;
        };
        let Some(name) = clean_text(object.get("title"), 240) else {
            continue;
        };
        insert(
            resources,
            resource(ResourceSpec {
                id: id.clone(),
                kind: ResourceKind::Artifact,
                name,
                detail: Some("Captured browser artifact".to_string()),
                status: ResourceStatus::Ready,
                node_id: None,
                updated_at: clean_timestamp(object.get("createdAt")),
                source_ref: format!("hii-runtime://ecosystem/captures/{id}"),
            }),
        );
    }
}

fn project_workflows(
    runtime: &Path,
    resources: &mut BTreeMap<(ResourceKind, String), EcosystemResource>,
) {
    for value in read_jsonl(runtime.join("ecosystem/workflows.jsonl")) {
        let Some(object) = value.as_object() else {
            continue;
        };
        if string(object.get("kind")) != Some("hii.workflow") {
            continue;
        }
        let Some(id) = clean_id(object.get("id")) else {
            continue;
        };
        let Some(name) = clean_text(object.get("title"), 240) else {
            continue;
        };
        let revision = object.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let next = resource(ResourceSpec {
            id: id.clone(),
            kind: ResourceKind::Capability,
            name,
            detail: (revision > 0).then(|| format!("Saved workflow · revision {revision}")),
            status: ResourceStatus::Ready,
            node_id: None,
            updated_at: clean_timestamp(object.get("updatedAt")),
            source_ref: format!("hii-runtime://ecosystem/workflows/{id}"),
        });
        let key = (ResourceKind::Capability, id);
        let replace = resources
            .get(&key)
            .map(|current| next.updated_at > current.updated_at)
            .unwrap_or(true);
        if replace {
            resources.insert(key, next);
        }
    }
}

fn project_events(
    runtime: &Path,
    resources: &mut BTreeMap<(ResourceKind, String), EcosystemResource>,
) {
    for value in read_jsonl(runtime.join("ecosystem/events.jsonl")) {
        let Some(event) = value.as_object() else {
            continue;
        };
        if string(event.get("kind")) != Some("hii.ecosystem.event") {
            continue;
        }
        let Some(object) = event.get("object").and_then(Value::as_object) else {
            continue;
        };
        let Some(id) = clean_id(object.get("id")) else {
            continue;
        };
        let kind = match string(object.get("kind")) {
            Some("run") => ResourceKind::Job,
            Some("artifact") => ResourceKind::Artifact,
            Some("receipt") => ResourceKind::Receipt,
            _ => continue,
        };
        let status = match string(event.get("status")) {
            Some("completed") => ResourceStatus::Ready,
            Some("running") => ResourceStatus::Running,
            Some("queued" | "waiting_approval") => ResourceStatus::Partial,
            Some("failed" | "cancelled") => ResourceStatus::Blocked,
            _ => ResourceStatus::Unknown,
        };
        let summary = clean_text(event.get("summary"), 240)
            .unwrap_or_else(|| format!("{} {id}", kind_label(kind)));
        let next = resource(ResourceSpec {
            id: id.clone(),
            kind,
            name: summary,
            detail: Some("Durable ecosystem event reference".to_string()),
            status,
            node_id: None,
            updated_at: clean_timestamp(event.get("createdAt")),
            source_ref: format!("hii-runtime://ecosystem/{}/{id}", kind_label(kind)),
        });
        let key = (kind, id);
        let replace = resources
            .get(&key)
            .map(|current| next.updated_at > current.updated_at)
            .unwrap_or(true);
        if replace {
            resources.insert(key, next);
        }
    }
}

struct ResourceSpec {
    id: String,
    kind: ResourceKind,
    name: String,
    detail: Option<String>,
    status: ResourceStatus,
    node_id: Option<String>,
    updated_at: Option<String>,
    source_ref: String,
}

fn resource(spec: ResourceSpec) -> EcosystemResource {
    EcosystemResource {
        object_ref: ObjectRef {
            authority: "hii-runtime",
            id: spec.id.clone(),
            kind: spec.kind,
        },
        id: spec.id,
        kind: spec.kind,
        name: spec.name,
        detail: spec.detail,
        status: spec.status,
        node_id: spec.node_id,
        updated_at: spec.updated_at,
        source_ref: spec.source_ref,
    }
}

fn insert(
    resources: &mut BTreeMap<(ResourceKind, String), EcosystemResource>,
    value: EcosystemResource,
) {
    resources.insert((value.kind, value.id.clone()), value);
}

fn read_bounded(path: PathBuf) -> Option<Vec<u8>> {
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .ok()?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_FILE_BYTES).then_some(bytes)
}

fn read_jsonl(path: PathBuf) -> Vec<Value> {
    let Some(raw) = read_bounded(path) else {
        return Vec::new();
    };
    raw.split(|byte| *byte == b'\n')
        .take(MAX_JSONL_LINES)
        .filter(|line| !line.is_empty() && line.len() <= MAX_LINE_BYTES)
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect()
}

fn string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn clean_id(value: Option<&Value>) -> Option<String> {
    let value = string(value)?;
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(value.to_string())
}

fn clean_text(value: Option<&Value>, max: usize) -> Option<String> {
    let normalized = string(value)?
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let value: String = normalized.chars().take(max).collect();
    (!value.is_empty()).then_some(value)
}

fn clean_timestamp(value: Option<&Value>) -> Option<String> {
    let value = clean_text(value, 40)?;
    (value.len() >= 20 && value.ends_with('Z')).then_some(value)
}

fn kind_label(kind: ResourceKind) -> &'static str {
    match kind {
        ResourceKind::Device => "device",
        ResourceKind::Capability => "capability",
        ResourceKind::Job => "job",
        ResourceKind::Artifact => "artifact",
        ResourceKind::Receipt => "receipt",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TempRuntime(PathBuf);

    impl TempRuntime {
        fn new() -> Self {
            let nonce = uuid::Uuid::new_v4();
            let path = std::env::temp_dir().join(format!("hii-catalog-{nonce}"));
            fs::create_dir_all(path.join("ecosystem")).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, value: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, value).unwrap();
        }
    }

    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn empty_runtime_is_a_valid_empty_catalog() {
        let runtime = TempRuntime::new();
        assert!(build(&runtime.0).resources.is_empty());
    }

    #[test]
    fn malformed_and_unsupported_records_are_skipped() {
        let runtime = TempRuntime::new();
        runtime.write("systems.json", "not json");
        runtime.write(
            "ecosystem/events.jsonl",
            "not json\n{\"kind\":\"hii.ecosystem.event\",\"object\":{\"kind\":\"capture\",\"id\":\"ignored\"}}\n",
        );
        assert!(build(&runtime.0).resources.is_empty());
    }

    #[test]
    fn catalog_is_bounded_sorted_and_deterministic() {
        let runtime = TempRuntime::new();
        let systems = (0..200)
            .rev()
            .map(|index| format!(r#"{{"id":"node-{index}","os":"macos","status":"ready","capabilities":["shell"]}}"#))
            .collect::<Vec<_>>()
            .join(",");
        runtime.write("systems.json", &format!(r#"{{"systems":[{systems}]}}"#));
        let first = render_json(&runtime.0).unwrap();
        let second = render_json(&runtime.0).unwrap();
        assert_eq!(first, second);
        let catalog = build(&runtime.0);
        assert_eq!(catalog.resources.len(), MAX_SYSTEMS);
        assert!(catalog
            .resources
            .windows(2)
            .all(|pair| pair[0].id < pair[1].id));
        assert!(catalog
            .resources
            .iter()
            .all(|resource| resource.status == ResourceStatus::Unknown));
    }

    #[test]
    fn latest_safe_workflow_revision_and_event_are_projected_as_references() {
        let runtime = TempRuntime::new();
        runtime.write(
            "ecosystem/workflows.jsonl",
            "{\"kind\":\"hii.workflow\",\"id\":\"render\",\"title\":\"Render old\",\"revision\":1,\"updatedAt\":\"2026-08-20T00:00:00Z\"}\n{\"kind\":\"hii.workflow\",\"id\":\"render\",\"title\":\"Render current\",\"revision\":2,\"updatedAt\":\"2026-08-21T00:00:00Z\"}\n",
        );
        runtime.write(
            "ecosystem/events.jsonl",
            "{\"kind\":\"hii.ecosystem.event\",\"status\":\"running\",\"summary\":\"Build HII\",\"object\":{\"kind\":\"run\",\"id\":\"run-1\"},\"createdAt\":\"2026-08-21T00:00:00Z\"}\n",
        );
        let catalog = build(&runtime.0);
        assert_eq!(catalog.resources.len(), 2);
        assert!(catalog.resources.iter().any(|resource| {
            resource.id == "render"
                && resource.name == "Render current"
                && resource.source_ref == "hii-runtime://ecosystem/workflows/render"
        }));
        assert!(catalog.resources.iter().any(|resource| {
            resource.id == "run-1" && resource.status == ResourceStatus::Running
        }));
    }

    #[test]
    fn captured_url_credentials_are_not_projected() {
        let runtime = TempRuntime::new();
        runtime.write(
            "ecosystem/captures.jsonl",
            "{\"kind\":\"hii.capture\",\"id\":\"capture-1\",\"title\":\"Research\",\"url\":\"https://user:password@example.com/private?token=secret\",\"createdAt\":\"2026-08-21T00:00:00Z\"}\n",
        );
        let rendered = render_json(&runtime.0).unwrap();
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("token=secret"));
        assert!(rendered.contains("Captured browser artifact"));
    }
}
