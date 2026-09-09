// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Explicitly linked account-workspace synchronization for the native app.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const DEFAULT_API: &str = "https://humaninformationinterface.com/api/device";
static ACCOUNT_PROJECTION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceConfig {
    version: u8,
    api: String,
    device_id: String,
    token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSyncStatus {
    linked: bool,
    device_id: Option<String>,
    api: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvelope {
    status: u16,
    body: Value,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceSelection {
    device_id: String,
    workspace_id: Option<String>,
    configured: bool,
}

fn account_config_path(runtime: &Path, directory: Option<PathBuf>) -> PathBuf {
    directory
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| runtime.join("account"))
        .join("device.json")
}

fn config_path() -> Result<PathBuf, String> {
    Ok(account_config_path(
        &hii_core::runtime_root()?,
        env::var_os("HII_ACCOUNT_DIR").map(PathBuf::from),
    ))
}

fn valid_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn selection_database(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let db = Connection::open(path).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS hii_account_workspace_preferences (
             device_id TEXT PRIMARY KEY NOT NULL,
             workspace_id TEXT,
             updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
             CHECK(length(device_id)=43),
             CHECK(workspace_id IS NULL OR length(workspace_id)=43)
         );",
    )
    .map_err(|error| error.to_string())?;
    Ok(db)
}

fn selection_path() -> Result<PathBuf, String> {
    Ok(env::var_os("HII_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or(hii_core::runtime_root()?.join("hii.db")))
}

fn read_selection(db: &Connection, device_id: &str) -> Result<AccountWorkspaceSelection, String> {
    if !valid_id(device_id) {
        return Err("HII device ID is invalid.".into());
    }
    let saved: Option<Option<String>> = db
        .query_row(
            "SELECT workspace_id FROM hii_account_workspace_preferences WHERE device_id=?1",
            [device_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(AccountWorkspaceSelection {
        device_id: device_id.into(),
        configured: saved.is_some(),
        workspace_id: saved.flatten(),
    })
}

fn write_selection(
    db: &Connection,
    device_id: &str,
    workspace_id: Option<&str>,
) -> Result<AccountWorkspaceSelection, String> {
    if !valid_id(device_id) || workspace_id.is_some_and(|id| !valid_id(id)) {
        return Err("HII workspace selection is invalid.".into());
    }
    db.execute(
        "INSERT INTO hii_account_workspace_preferences (device_id,workspace_id) VALUES (?1,?2)
         ON CONFLICT(device_id) DO UPDATE SET workspace_id=excluded.workspace_id,updated_at=unixepoch()",
        params![device_id, workspace_id],
    ).map_err(|error| error.to_string())?;
    Ok(AccountWorkspaceSelection {
        device_id: device_id.into(),
        workspace_id: workspace_id.map(str::to_owned),
        configured: true,
    })
}

#[tauri::command]
pub fn account_workspace_selection_get() -> Result<AccountWorkspaceSelection, String> {
    let config = read_config()?;
    read_selection(&selection_database(&selection_path()?)?, &config.device_id)
}

/// The surface validates membership against the current account workspace list.
/// This stores only a preference; read/write endpoints still enforce remote access.
#[tauri::command]
pub fn account_workspace_selection_set(
    workspace_id: Option<String>,
) -> Result<AccountWorkspaceSelection, String> {
    let config = read_config()?;
    write_selection(
        &selection_database(&selection_path()?)?,
        &config.device_id,
        workspace_id.as_deref(),
    )
}

fn api_base() -> String {
    env::var("HII_ACCOUNT_API")
        .ok()
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| {
            value.starts_with("https://")
                || value.starts_with("http://127.0.0.1")
                || value.starts_with("http://localhost")
        })
        .unwrap_or_else(|| DEFAULT_API.to_string())
}

fn read_config() -> Result<DeviceConfig, String> {
    let path = config_path()?;
    let bytes = fs::read(&path).map_err(|_| {
        "This HII app is not linked to an account workspace. Create a device code on the HII website first."
            .to_string()
    })?;
    let config: DeviceConfig = serde_json::from_slice(&bytes)
        .map_err(|_| "HII account device configuration is invalid.".to_string())?;
    if config.version != 1 || config.token.len() < 32 || !valid_id(&config.device_id) {
        return Err("HII account device configuration is invalid.".into());
    }
    Ok(config)
}

fn write_config(config: &DeviceConfig) -> Result<(), String> {
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "HII account device path is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("HII could not create its private account directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("HII could not protect its account directory: {error}"))?;
    }
    let temporary = parent.join(format!(".device-{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(config)
        .map_err(|error| format!("HII could not encode its account link: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("HII could not store its account link: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("HII could not protect its account link: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("HII could not finalize its account link: {error}"))
}

fn response_envelope(response: ureq::Response) -> Result<ApiEnvelope, String> {
    let status = response.status();
    let body = response
        .into_json::<Value>()
        .map_err(|error| format!("HII account service returned invalid data: {error}"))?;
    Ok(ApiEnvelope { status, body })
}

fn call(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<ApiEnvelope, String> {
    let mut request = ureq::request(method, url).timeout(Duration::from_secs(30));
    if let Some(token) = token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let result = if let Some(body) = body {
        request
            .set("Content-Type", "application/json")
            .send_json(body)
    } else {
        request.call()
    };
    match result {
        Ok(response) => response_envelope(response),
        Err(ureq::Error::Status(_, response)) => response_envelope(response),
        Err(error) => Err(format!("HII could not reach the account service: {error}")),
    }
}

#[tauri::command]
pub fn account_sync_status() -> Result<AccountSyncStatus, String> {
    let api = api_base();
    match read_config() {
        Ok(config) => Ok(AccountSyncStatus {
            linked: true,
            device_id: Some(config.device_id),
            api: config.api,
        }),
        Err(_) => Ok(AccountSyncStatus {
            linked: false,
            device_id: None,
            api,
        }),
    }
}

#[tauri::command]
pub fn account_sync_link(code: String, device_name: String) -> Result<Value, String> {
    let api = api_base();
    let envelope = call(
        "POST",
        &format!("{api}/link"),
        None,
        Some(json!({ "code": code.trim(), "deviceName": device_name.trim() })),
    )?;
    if envelope.status != 201 {
        return Err(envelope
            .body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("HII could not link this app.")
            .to_string());
    }
    let device_id = envelope
        .body
        .get("deviceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "HII account link omitted the device ID.".to_string())?;
    let token = envelope
        .body
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| "HII account link omitted the device token.".to_string())?;
    write_config(&DeviceConfig {
        version: 1,
        api,
        device_id: device_id.to_string(),
        token: token.to_string(),
    })?;
    Ok(json!({ "linked": true, "deviceId": device_id }))
}

#[tauri::command]
pub fn account_workspace_list() -> Result<ApiEnvelope, String> {
    let config = read_config()?;
    call(
        "GET",
        &format!("{}/workspaces", config.api),
        Some(&config.token),
        None,
    )
}

#[tauri::command]
pub fn account_workspace_read(workspace_id: String) -> Result<ApiEnvelope, String> {
    if !valid_id(&workspace_id) {
        return Err("HII workspace ID is invalid.".into());
    }
    let config = read_config()?;
    let _lock = ACCOUNT_PROJECTION_LOCK
        .lock()
        .map_err(|_| "account sync lock poisoned")?;
    let remote = call(
        "GET",
        &format!("{}/workspaces/{workspace_id}", config.api),
        Some(&config.token),
        None,
    )?;
    sync_projection(
        &hii_core::runtime_root()?,
        &config.api,
        &workspace_id,
        remote,
        None,
        |document, revision| upload_workspace(&config, &workspace_id, document, revision),
    )
}

#[tauri::command]
pub fn account_workspace_write(
    workspace_id: String,
    expected_revision: i64,
    document: Value,
) -> Result<ApiEnvelope, String> {
    if !valid_id(&workspace_id) || expected_revision < 0 {
        return Err("HII workspace write is invalid.".into());
    }
    let config = read_config()?;
    let _lock = ACCOUNT_PROJECTION_LOCK
        .lock()
        .map_err(|_| "account sync lock poisoned")?;
    let runtime = hii_core::runtime_root()?;
    let db = projection_database(&runtime)?;
    let (bound_api, revision): (String, u64) = db
        .query_row(
            "SELECT api,remote_revision FROM hii_account_workspace_sync WHERE workspace_id=?1",
            [&workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "load the authenticated account projection before saving")?;
    if bound_api != config.api {
        return Err("account projection belongs to another source".into());
    }
    let current = hii_core::runtime::read_space(&runtime, &workspace_id)?
        .ok_or("account projection is missing")?;
    if expected_revision as u64 != current.sequence {
        return Ok(ApiEnvelope {
            status: 409,
            body: json!({"workspace":{
                "id":workspace_id,"revision":revision,"remoteRevision":revision,"document":current.document
            }}),
        });
    }
    // Save the user's edit before network access. Offline errors keep the local
    // version in Runtime rather than only in a browser component's memory.
    apply_projection(&runtime, &workspace_id, document, current.sequence)?;
    let remote = call(
        "GET",
        &format!("{}/workspaces/{workspace_id}", config.api),
        Some(&config.token),
        None,
    )?;
    sync_projection(
        &runtime,
        &config.api,
        &workspace_id,
        remote,
        None,
        |document, revision| upload_workspace(&config, &workspace_id, document, revision),
    )
}

fn upload_workspace(
    config: &DeviceConfig,
    workspace_id: &str,
    document: Value,
    revision: u64,
) -> Result<ApiEnvelope, String> {
    call(
        "POST",
        &format!("{}/workspaces/{workspace_id}/document", config.api),
        Some(&config.token),
        Some(json!({ "expectedRevision": revision, "document": document })),
    )
}

fn projection_database(runtime: &Path) -> Result<Connection, String> {
    let path = env::var_os("HII_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime.join("hii.db"));
    let db = selection_database(&path)?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS hii_account_workspace_sync (
        workspace_id TEXT PRIMARY KEY, api TEXT NOT NULL, owner_account_id TEXT NOT NULL,
        remote_revision INTEGER NOT NULL, remote_document_json TEXT NOT NULL
    );",
    )
    .map_err(|error| error.to_string())?;
    Ok(db)
}

fn remote_document(
    remote: &ApiEnvelope,
    workspace_id: &str,
) -> Result<(String, u64, Value), String> {
    let workspace = &remote.body["workspace"];
    if workspace["id"].as_str() != Some(workspace_id) {
        return Err("account service returned a different workspace".into());
    }
    let owner = workspace["ownerAccountId"]
        .as_str()
        .ok_or("account workspace omitted its owner")?
        .to_string();
    let revision = workspace["revision"]
        .as_u64()
        .ok_or("account workspace omitted its revision")?;
    let mut document = workspace["document"].clone();
    document["revision"] = json!(revision);
    hii_core::runtime::canonical_space_document(&document)?;
    Ok((owner, revision, document))
}

fn remember_remote(
    db: &Connection,
    api: &str,
    workspace_id: &str,
    owner: &str,
    revision: u64,
    document: &Value,
) -> Result<(), String> {
    let changed = db.execute("INSERT INTO hii_account_workspace_sync
        (workspace_id,api,owner_account_id,remote_revision,remote_document_json) VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(workspace_id) DO UPDATE SET remote_revision=excluded.remote_revision,
        remote_document_json=excluded.remote_document_json
        WHERE remote_revision<=excluded.remote_revision AND api=excluded.api AND owner_account_id=excluded.owner_account_id",
        params![workspace_id, api, owner, revision, document.to_string()]).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("account sync base advanced concurrently; local work preserved".into());
    }
    Ok(())
}

fn apply_projection(
    runtime: &Path,
    workspace_id: &str,
    mut document: Value,
    sequence: u64,
) -> Result<hii_core::runtime::RuntimeSpaceSnapshotV1, String> {
    use sha2::{Digest, Sha256};
    document["revision"] = json!(sequence);
    let hash = Sha256::digest(document.to_string().as_bytes());
    hii_core::runtime::apply_space(
        runtime,
        workspace_id,
        &hii_core::runtime::RuntimeSpaceApplyV1 {
            version: 1,
            space_id: Some(workspace_id.into()),
            expected_sequence: sequence,
            actor: hii_core::runtime::IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            authority_grant_id: None,
            run_id: None,
            idempotency_key: format!("account-sync:{sequence}:{hash:x}"),
            document,
        },
    )
}

fn projected_envelope(
    mut remote: ApiEnvelope,
    snapshot: &hii_core::runtime::RuntimeSpaceSnapshotV1,
) -> ApiEnvelope {
    remote.body["workspace"]["remoteRevision"] = remote.body["workspace"]["revision"].clone();
    remote.body["workspace"]["document"] = snapshot.document.clone();
    remote.body["workspace"]["runtimeSpaceId"] = json!(snapshot.space_id);
    remote
}

/// Account data is authenticated before entering this function. Runtime and
/// remote revisions are independent. Work is saved locally before any upload;
/// a conflict/offline error leaves it there for review or the next retry.
fn sync_projection(
    runtime: &Path,
    api: &str,
    workspace_id: &str,
    mut remote: ApiEnvelope,
    pending: Option<(u64, Value)>,
    mut upload: impl FnMut(Value, u64) -> Result<ApiEnvelope, String>,
) -> Result<ApiEnvelope, String> {
    if remote.status != 200 {
        return Ok(remote);
    }
    let (owner, remote_revision, raw_remote) = remote_document(&remote, workspace_id)?;
    let db = projection_database(runtime)?;
    let binding: Option<(String, String, String, u64)> = db.query_row(
        "SELECT api, owner_account_id, remote_document_json, remote_revision FROM hii_account_workspace_sync WHERE workspace_id=?1",
        [workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(|error| error.to_string())?;
    if let Some((bound_api, bound_owner, _, stored_revision)) = &binding {
        if bound_api != api || bound_owner != &owner {
            return Err("account projection belongs to another account source".into());
        }
        if remote_revision < *stored_revision {
            return Err(
                "account response is older than the local sync base; local work preserved".into(),
            );
        }
    }
    let mut current = hii_core::runtime::read_space(runtime, workspace_id)?;
    let mut base = if let Some((_, _, raw, _)) = binding {
        serde_json::from_str(&raw)
            .map_err(|_| "account sync base is unreadable; local work preserved")?
    } else {
        if current
            .as_ref()
            .is_some_and(|snapshot| snapshot.sequence != 0 || !snapshot.objects.is_empty())
        {
            return Err(
                "account Space ID already contains unbound local work; refusing to overwrite it"
                    .into(),
            );
        }
        let mut initial = hii_core::runtime::canonical_space_document(&raw_remote)?;
        initial["revision"] = json!(0);
        current = Some(match current {
            Some(snapshot) => apply_projection(runtime, workspace_id, initial, snapshot.sequence)?,
            None => hii_core::runtime::initialize_space(runtime, workspace_id, &initial)?,
        });
        remember_remote(&db, api, workspace_id, &owner, remote_revision, &raw_remote)?;
        raw_remote.clone()
    };
    let mut current = current.ok_or("account projection is missing; local sync base retained")?;
    if let Some((expected, document)) = pending {
        if expected != current.sequence {
            remote.status = 409;
            return Ok(projected_envelope(remote, &current));
        }
        current = apply_projection(runtime, workspace_id, document, expected)?;
    }
    for _ in 0..3 {
        let (next_owner, revision, raw) = remote_document(&remote, workspace_id)?;
        if next_owner != owner {
            return Err("account workspace owner changed during synchronization".into());
        }
        let canonical_remote = hii_core::runtime::canonical_space_document(&raw)?;
        let canonical_base = hii_core::runtime::canonical_space_document(&base)?;
        let merged = merge_documents(&canonical_base, &current.document, &canonical_remote)?;
        current = apply_projection(runtime, workspace_id, merged, current.sequence)?;
        remember_remote(&db, api, workspace_id, &owner, revision, &raw)?;
        let pending_sync = !same_document(&current.document, &canonical_remote);
        let provenance = json!({"source":"authenticated account workspace", "api":api,
            "workspaceId":workspace_id,"ownerAccountId":owner,"remoteRevision":revision,"pendingSync":pending_sync}).to_string();
        for object in &current.objects {
            db.execute("UPDATE operational_objects SET provenance_json=?2 WHERE id=?1 AND properties_json=?3",
                params![object.id, provenance, object.payload.to_string()]
            ).map_err(|error| error.to_string())?;
        }
        if !pending_sync {
            return Ok(projected_envelope(remote, &current));
        }
        // Replay only local changes over the original remote document, retaining
        // hosted fields which are not represented in the local projection.
        let mut outgoing = merge_documents(&canonical_remote, &current.document, &raw)?;
        // Camera state belongs to this device. Object geometry still syncs.
        outgoing["viewport"] = raw["viewport"].clone();
        let submitted = current.document.clone();
        remote = upload(outgoing, revision)?;
        if remote.status == 200 {
            // A subsequent local edit is based on our submitted document, not
            // the earlier remote base. Keep it when the server acknowledges.
            base = submitted;
        } else if remote.status == 409 {
            base = raw;
        } else {
            return Err(format!(
                "account upload refused ({}); local work preserved",
                remote.status
            ));
        }
        current = hii_core::runtime::read_space(runtime, workspace_id)?
            .ok_or("account projection disappeared")?;
    }
    Err("account synchronization kept changing; local work preserved, retry required".into())
}

fn same_document(left: &Value, right: &Value) -> bool {
    // Collection order is a projection detail, not an authored change.
    fn index<'a>(doc: &'a Value, key: &str) -> BTreeMap<&'a str, &'a Value> {
        doc[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| (item["id"].as_str().unwrap(), item))
            .collect::<BTreeMap<_, _>>()
    }
    left["nextZ"] == right["nextZ"]
        && ["nodes", "links"]
            .iter()
            .all(|key| index(left, key) == index(right, key))
}

/// A conflict in the same field is actionable, not permission to silently choose
/// the latest timestamp. Independent object/field changes merge deterministically.
fn merge_documents(base: &Value, local: &Value, remote: &Value) -> Result<Value, String> {
    let mut result = remote.clone();
    for field in ["nodes", "links"] {
        let index = |doc: &Value| -> Result<BTreeMap<String, Value>, String> {
            let mut map = BTreeMap::new();
            for item in doc[field]
                .as_array()
                .ok_or("account projection collection is invalid")?
            {
                let id = item["id"].as_str().ok_or("account object omitted its ID")?;
                if map.insert(id.to_string(), item.clone()).is_some() {
                    return Err("account object IDs are duplicated".into());
                }
            }
            Ok(map)
        };
        let (base, local, remote) = (index(base)?, index(local)?, index(remote)?);
        let ids = base
            .keys()
            .chain(local.keys())
            .chain(remote.keys())
            .collect::<BTreeSet<_>>();
        let mut items = Vec::new();
        for id in ids {
            if let Some(item) = merge_value(
                base.get(id),
                local.get(id),
                remote.get(id),
                &format!("{field}/{id}"),
            )? {
                items.push(item);
            }
        }
        result[field] = json!(items);
    }
    result["viewport"] = local["viewport"].clone();
    result["nextZ"] = json!(local["nextZ"]
        .as_u64()
        .unwrap_or(1)
        .max(remote["nextZ"].as_u64().unwrap_or(1)));
    result["updatedAt"] = local["updatedAt"].clone();
    Ok(result)
}

fn merge_value(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    path: &str,
) -> Result<Option<Value>, String> {
    if local == base {
        return Ok(remote.cloned());
    }
    if remote == base || local == remote {
        return Ok(local.cloned());
    }
    if path.ends_with("/updatedAt") {
        return Ok(local.cloned());
    }
    if let (Some(Value::Object(base)), Some(Value::Object(local)), Some(Value::Object(remote))) =
        (base, local, remote)
    {
        let keys = base
            .keys()
            .chain(local.keys())
            .chain(remote.keys())
            .collect::<BTreeSet<_>>();
        let mut result = serde_json::Map::new();
        for key in keys {
            if let Some(value) = merge_value(
                base.get(key),
                local.get(key),
                remote.get(key),
                &format!("{path}/{key}"),
            )? {
                result.insert(key.clone(), value);
            }
        }
        return Ok(Some(Value::Object(result)));
    }
    Err(format!(
        "account synchronization conflict at {path}; local and remote work preserved"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_document(content: &str, x: i64) -> Value {
        json!({"version":1,"revision":0,"updatedAt":"2026-09-08T00:00:00Z",
            "viewport":{"x":0,"y":0,"zoom":1},"nextZ":2,"links":[],
            "nodes":[{"id":"one","type":"note","handle":"scheme-a","x":x,"y":0,"w":200,"h":100,"z":1,
                "createdAt":"2026-09-08T00:00:00Z","updatedAt":"2026-09-08T00:00:00Z","payload":{"content":content}}]})
    }

    fn fixture_remote(id: &str, revision: u64, mut document: Value) -> ApiEnvelope {
        document["revision"] = json!(revision);
        ApiEnvelope {
            status: 200,
            body: json!({"workspace":{
                "id":id,"ownerAccountId":"owner","revision":revision,"role":"owner","document":document
            }}),
        }
    }

    #[test]
    fn account_links_normalize_defaults_without_uploading_projection_details() {
        let directory = tempfile::tempdir().unwrap();
        let id = "l".repeat(43);
        let mut document = fixture_document("linked", 0);
        let mut second = document["nodes"][0].clone();
        second["id"] = json!("two");
        second["handle"] = json!("scheme-b");
        document["nodes"].as_array_mut().unwrap().push(second);
        document["links"] = json!([
            {"id":"z","fromId":"one","toId":"two","futureField":"preserved remotely"},
            {"id":"a","fromId":"two","toId":"one"}
        ]);
        for _ in 0..2 {
            let response = sync_projection(
                directory.path(),
                DEFAULT_API,
                &id,
                fixture_remote(&id, 4, document.clone()),
                None,
                |_, _| panic!("normalization is not a remote edit"),
            )
            .unwrap();
            assert_eq!(
                response.body["workspace"]["document"]["links"][0]["arrow"],
                "end"
            );
        }
    }

    #[test]
    fn account_projection_is_local_context_with_independent_revisions_and_no_other_board() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let id = "w".repeat(43);
        hii_core::runtime::initialize_space(
            root,
            "default",
            &fixture_document("private local board", 0),
        )
        .unwrap();
        let response = sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 17, fixture_document("account object", 0)),
            None,
            |_, _| panic!("initial read must not upload"),
        )
        .unwrap();
        assert_eq!(response.body["workspace"]["remoteRevision"], 17);
        assert_eq!(response.body["workspace"]["document"]["revision"], 0);
        let projected = hii_core::runtime::read_space(root, &id).unwrap().unwrap();
        assert_eq!(
            projected.document["nodes"][0]["payload"]["content"],
            "account object"
        );
        assert_eq!(
            projected.objects[0].provenance["source"],
            "authenticated account workspace"
        );
        assert_eq!(
            hii_core::runtime::resolve_space_object_id(&projected, "@scheme-a").unwrap(),
            "one"
        );
        let pack = hii_core::context_pack::compile(
            root,
            &hii_core::context_pack::ContextCompileRequestV1 {
                version: 1,
                space_id: Some(id.clone()),
                workspace_root: Some(root.display().to_string()),
                intent: "inspect the selected account object".into(),
                selected_object_ids: vec!["one".into()],
                excluded_object_ids: Vec::new(),
                actor: hii_core::runtime::IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
                authority: "read-only".into(),
                mode: "plan".into(),
                budget_tokens: None,
                previous_fingerprint: None,
            },
        )
        .unwrap();
        assert_ne!(
            pack.status,
            hii_core::context_pack::ContextPackStatusV1::Blocked
        );
        assert!(pack
            .items
            .iter()
            .any(|item| item.context_ref.id == format!("workspace:{id}:object:one")));
        assert!(pack
            .items
            .iter()
            .all(|item| !item.summary.contains("private local board")));
        assert_eq!(
            hii_core::runtime::read_space(root, "default")
                .unwrap()
                .unwrap()
                .document["nodes"][0]["payload"]["content"],
            "private local board"
        );
    }

    #[test]
    fn cli_changes_merge_with_web_changes_and_retry_remote_cas() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let id = "w".repeat(43);
        let original = fixture_document("original", 0);
        sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 7, original.clone()),
            None,
            |_, _| unreachable!(),
        )
        .unwrap();
        let mut local = hii_core::runtime::read_space(root, &id)
            .unwrap()
            .unwrap()
            .document;
        local["nodes"][0]["payload"]["content"] = json!("CLI edit");
        apply_projection(root, &id, local, 0).unwrap();
        let mut calls = 0;
        let response = sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 7, original),
            None,
            |document, expected| {
                calls += 1;
                if calls == 1 {
                    assert_eq!(expected, 7);
                    let mut conflict = fixture_remote(&id, 8, fixture_document("original", 420));
                    conflict.status = 409;
                    Ok(conflict)
                } else {
                    assert_eq!(expected, 8);
                    assert_eq!(document["nodes"][0]["payload"]["content"], "CLI edit");
                    assert_eq!(document["nodes"][0]["x"], 420);
                    Ok(fixture_remote(&id, 9, document))
                }
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(response.body["workspace"]["remoteRevision"], 9);
        assert_eq!(response.body["workspace"]["document"]["revision"], 2);
        // Reopening sees the same Runtime state and needs no write-back.
        sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 9, response.body["workspace"]["document"].clone()),
            None,
            |_, _| panic!("acknowledged work must not upload twice"),
        )
        .unwrap();
    }

    #[test]
    fn local_edits_during_upload_survive_the_remote_acknowledgment() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let id = "w".repeat(43);
        sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 1, fixture_document("base", 0)),
            None,
            |_, _| unreachable!(),
        )
        .unwrap();
        let mut local = hii_core::runtime::read_space(root, &id)
            .unwrap()
            .unwrap()
            .document;
        local["nodes"][0]["payload"]["content"] = json!("first local edit");
        apply_projection(root, &id, local, 0).unwrap();
        let mut calls = 0;
        let response = sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 1, fixture_document("base", 0)),
            None,
            |document, revision| {
                calls += 1;
                if calls == 1 {
                    let mut concurrent = hii_core::runtime::read_space(root, &id).unwrap().unwrap();
                    concurrent.document["nodes"][0]["payload"]["content"] =
                        json!("newer local edit");
                    apply_projection(root, &id, concurrent.document, concurrent.sequence).unwrap();
                }
                Ok(fixture_remote(&id, revision + 1, document))
            },
        )
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(
            response.body["workspace"]["document"]["nodes"][0]["payload"]["content"],
            "newer local edit"
        );
    }

    #[test]
    fn same_field_conflicts_and_offline_uploads_preserve_local_work() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let id = "w".repeat(43);
        sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 1, fixture_document("base", 0)),
            None,
            |_, _| unreachable!(),
        )
        .unwrap();
        let mut local = hii_core::runtime::read_space(root, &id)
            .unwrap()
            .unwrap()
            .document;
        local["nodes"][0]["payload"]["content"] = json!("local work");
        apply_projection(root, &id, local, 0).unwrap();
        let error = sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 2, fixture_document("competing web work", 0)),
            None,
            |_, _| panic!("conflicting text must not upload"),
        )
        .err()
        .unwrap();
        assert!(error.contains("conflict at nodes/one/payload/content"));
        let error = sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 1, fixture_document("base", 0)),
            None,
            |_, _| Err("offline".into()),
        )
        .err()
        .unwrap();
        assert_eq!(error, "offline");
        assert_eq!(
            hii_core::runtime::read_space(root, &id)
                .unwrap()
                .unwrap()
                .document["nodes"][0]["payload"]["content"],
            "local work"
        );
    }

    #[test]
    fn account_projection_refuses_unbound_content_and_changed_sources() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let id = "w".repeat(43);
        hii_core::runtime::initialize_space(root, &id, &fixture_document("existing local", 0))
            .unwrap();
        assert!(sync_projection(
            root,
            DEFAULT_API,
            &id,
            fixture_remote(&id, 1, fixture_document("remote", 0)),
            None,
            |_, _| unreachable!()
        )
        .is_err());
        let other = "x".repeat(43);
        sync_projection(
            root,
            DEFAULT_API,
            &other,
            fixture_remote(&other, 3, fixture_document("remote", 0)),
            None,
            |_, _| unreachable!(),
        )
        .unwrap();
        assert!(sync_projection(
            root,
            "https://other.example/api",
            &other,
            fixture_remote(&other, 3, fixture_document("remote", 0)),
            None,
            |_, _| unreachable!()
        )
        .is_err());
        assert!(sync_projection(
            root,
            DEFAULT_API,
            &other,
            fixture_remote(&other, 2, fixture_document("old", 0)),
            None,
            |_, _| unreachable!()
        )
        .is_err());
    }

    #[test]
    fn account_path_uses_explicit_account_directory_or_runtime() {
        let runtime = Path::new("isolated-runtime");
        assert_eq!(
            account_config_path(runtime, None),
            runtime.join("account/device.json")
        );
        assert_eq!(
            account_config_path(runtime, Some(PathBuf::new())),
            runtime.join("account/device.json")
        );
        assert_eq!(
            account_config_path(runtime, Some(PathBuf::from("selected-account"))),
            Path::new("selected-account/device.json")
        );
    }

    #[test]
    fn workspace_selection_survives_restart_and_is_scoped_to_device(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hii.db");
        let first = "a".repeat(43);
        let second = "b".repeat(43);
        let workspace = "w".repeat(43);
        {
            let db = selection_database(&path)?;
            let empty = read_selection(&db, &first)?;
            assert!(!empty.configured);
            assert_eq!(empty.workspace_id, None);
            write_selection(&db, &first, Some(&workspace))?;
            write_selection(&db, &second, None)?;
        }
        let db = selection_database(&path)?;
        assert_eq!(
            read_selection(&db, &first)?,
            AccountWorkspaceSelection {
                device_id: first.clone(),
                workspace_id: Some(workspace),
                configured: true,
            }
        );
        assert_eq!(
            read_selection(&db, &second)?,
            AccountWorkspaceSelection {
                device_id: second,
                workspace_id: None,
                configured: true,
            }
        );
        assert!(!read_selection(&db, &"c".repeat(43))?.configured);
        write_selection(&db, &first, None)?;
        assert_eq!(read_selection(&db, &first)?.workspace_id, None);
        assert!(read_selection(&db, &first)?.configured);
        drop(db);
        Ok(())
    }

    #[test]
    fn preferences_preserve_existing_database_and_reject_invalid_ids(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("hii.db");
        let device = "d".repeat(43);
        {
            let db = Connection::open(&path)?;
            db.execute_batch("PRAGMA user_version=42; CREATE TABLE existing_hii_data (content TEXT); INSERT INTO existing_hii_data VALUES ('preserved');")?;
        }
        let db = selection_database(&path)?;
        for invalid in [
            "short".to_owned(),
            "/".repeat(43),
            "a".repeat(42),
            "a".repeat(44),
        ] {
            assert!(write_selection(&db, &device, Some(&invalid)).is_err());
            assert!(write_selection(&db, &invalid, None).is_err());
        }
        assert!(!read_selection(&db, &device)?.configured);
        write_selection(&db, &device, Some(&format!("{}_-", "w".repeat(41))))?;
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?,
            42
        );
        assert_eq!(
            db.query_row("SELECT content FROM existing_hii_data", [], |row| row
                .get::<_, String>(0))?,
            "preserved"
        );
        drop(db);
        Ok(())
    }

    #[test]
    fn production_account_api_is_https() {
        assert!(DEFAULT_API.starts_with("https://"));
        if std::env::var("HII_ACCOUNT_API").is_err() {
            assert_eq!(api_base(), DEFAULT_API);
        }
    }
}
