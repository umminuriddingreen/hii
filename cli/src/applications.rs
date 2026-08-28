// SPDX-License-Identifier: LicenseRef-BSL-1.1

use crate::config::AppPaths;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSurface {
    pub surface: String,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSurface {
    pub bundle_identifier: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSurfaces {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canvas: Option<CanvasSurface>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<NativeSurface>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationManifest {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub version: String,
    pub developer: String,
    pub summary: String,
    pub icon: String,
    pub surfaces: ApplicationSurfaces,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub built_in: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    schema_version: u8,
    applications: Vec<ApplicationManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    scanned_roots: Vec<String>,
    discovered: usize,
    added: Vec<ApplicationManifest>,
    applications: Vec<ApplicationManifest>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub schema_version: u8,
    pub id: String,
    pub application_id: String,
    pub surface: String,
    pub source: String,
    pub status: String,
    pub requested_at: String,
    pub receipt_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Acknowledgement {
    schema_version: u8,
    request_id: String,
    handled_at: String,
    receipt_path: String,
}

fn directory(paths: &AppPaths) -> PathBuf {
    paths.runtime.join("applications")
}

fn registry_path(paths: &AppPaths) -> PathBuf {
    directory(paths).join("registry.json")
}

fn request_path(paths: &AppPaths) -> PathBuf {
    directory(paths).join("launch-requests.jsonl")
}

fn acknowledgement_path(paths: &AppPaths) -> PathBuf {
    directory(paths).join("launch-acknowledgements.jsonl")
}

fn built_ins() -> Vec<ApplicationManifest> {
    vec![
        ApplicationManifest {
            schema_version: SCHEMA_VERSION,
            id: "hii.canvas".into(),
            name: "HII Canvas".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            developer: "HII".into(),
            summary: "The spatial surface for HII objects, agents, applications, and proof.".into(),
            icon: "square.on.square.dashed".into(),
            surfaces: ApplicationSurfaces {
                canvas: Some(CanvasSurface {
                    surface: "canvas-root".into(),
                    width: 1440,
                    height: 960,
                    entry_url: None,
                }),
                native: Some(NativeSurface {
                    bundle_identifier: "com.ummi.hii".into(),
                }),
            },
            capabilities: vec!["hii.workspace.creative_canvas".into()],
            built_in: true,
        },
        ApplicationManifest {
            schema_version: SCHEMA_VERSION,
            id: "community.waymark.location-studio".into(),
            name: "Waymark".into(),
            version: "0.2.0-beta".into(),
            developer: "Waymark Labs".into(),
            summary: "Pick, save, and preview locations for governed device workflows.".into(),
            icon: "location.circle".into(),
            surfaces: ApplicationSurfaces {
                canvas: Some(CanvasSurface {
                    surface: "waymark-location".into(),
                    width: 1080,
                    height: 720,
                    entry_url: None,
                }),
                native: None,
            },
            capabilities: vec![
                "hii.location.preview".into(),
                "hii.device.location.propose".into(),
            ],
            built_in: true,
        },
        ApplicationManifest {
            schema_version: SCHEMA_VERSION,
            id: "hii.link".into(),
            name: "HII Link".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            developer: "HII".into(),
            summary: "Cross-platform native WireGuard device mesh, HII account binding, signed contact cards, and user-controlled communication handoff."
                .into(),
            icon: "person.2.wave.2".into(),
            surfaces: ApplicationSurfaces {
                canvas: Some(CanvasSurface {
                    surface: "hii-link".into(),
                    width: 920,
                    height: 640,
                    entry_url: None,
                }),
                native: None,
            },
            capabilities: vec![
                "hii.identity.contact-card".into(),
                "hii.fabric.vpn.status".into(),
                "hii.fabric.vpn.peer-management".into(),
                "hii.communication.handoff".into(),
            ],
            built_in: true,
        },
    ]
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 120
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        });
    if valid {
        Ok(())
    } else {
        Err(format!("invalid HII application {label} `{value}`"))
    }
}

fn validate_manifest(manifest: &ApplicationManifest) -> Result<(), String> {
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported HII application schema {}",
            manifest.schema_version
        ));
    }
    validate_identifier(&manifest.id, "id")?;
    if manifest.name.trim().is_empty() || manifest.name.len() > 100 {
        return Err("HII application name must contain 1 to 100 characters".into());
    }
    if manifest.surfaces.canvas.is_none() && manifest.surfaces.native.is_none() {
        return Err("HII application manifest must declare a canvas or native surface".into());
    }
    if let Some(canvas) = &manifest.surfaces.canvas {
        validate_identifier(&canvas.surface, "canvas surface")?;
        if !(240..=4096).contains(&canvas.width) || !(180..=4096).contains(&canvas.height) {
            return Err("HII canvas application size must be between 240x180 and 4096x4096".into());
        }
        if let Some(entry_url) = &canvas.entry_url {
            let parsed = url::Url::parse(entry_url)
                .map_err(|_| "HII canvas entryUrl must be an absolute URL".to_string())?;
            let allowed_local_http = parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
            if parsed.scheme() != "https" && !allowed_local_http {
                return Err("HII canvas entryUrl must use HTTPS or local HTTP".into());
            }
        }
    }
    if let Some(native) = &manifest.surfaces.native {
        validate_identifier(&native.bundle_identifier, "bundle identifier")?;
    }
    Ok(())
}

fn registered(paths: &AppPaths) -> Result<Vec<ApplicationManifest>, String> {
    let path = registry_path(paths);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let value: Registry =
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("invalid HII application registry: {error}"))?;
    if value.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported HII application registry schema {}",
            value.schema_version
        ));
    }
    for manifest in &value.applications {
        validate_manifest(manifest)?;
    }
    Ok(value.applications)
}

pub fn list(paths: &AppPaths) -> Result<Vec<ApplicationManifest>, String> {
    let mut combined = built_ins();
    for manifest in registered(paths)? {
        if !combined.iter().any(|entry| entry.id == manifest.id) {
            combined.push(manifest);
        }
    }
    Ok(combined)
}

fn application_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
}

fn manifest_from_bundle(bundle: &Path) -> Result<Option<ApplicationManifest>, String> {
    let info_path = bundle.join("Contents/Info.plist");
    if !info_path.is_file() {
        return Ok(None);
    }
    let value = plist::Value::from_file(&info_path)
        .map_err(|error| format!("could not read {}: {error}", info_path.display()))?;
    let Some(dictionary) = value.as_dictionary() else {
        return Ok(None);
    };
    let string = |key: &str| dictionary.get(key).and_then(plist::Value::as_string);
    let Some(bundle_identifier) = string("CFBundleIdentifier") else {
        return Ok(None);
    };
    if validate_identifier(bundle_identifier, "bundle identifier").is_err() {
        return Ok(None);
    }
    let fallback_name = bundle
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(bundle_identifier);
    let name = string("CFBundleDisplayName")
        .or_else(|| string("CFBundleName"))
        .unwrap_or(fallback_name)
        .trim();
    if name.is_empty() || name.len() > 100 {
        return Ok(None);
    }
    let version = string("CFBundleShortVersionString")
        .or_else(|| string("CFBundleVersion"))
        .unwrap_or("unknown");
    Ok(Some(ApplicationManifest {
        schema_version: SCHEMA_VERSION,
        id: bundle_identifier.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        developer: string("NSHumanReadableCopyright")
            .unwrap_or("Installed on this Mac")
            .to_string(),
        summary: format!(
            "Native macOS application discovered in {}",
            bundle.display()
        ),
        icon: "app.dashed".into(),
        surfaces: ApplicationSurfaces {
            canvas: None,
            native: Some(NativeSurface {
                bundle_identifier: bundle_identifier.to_string(),
            }),
        },
        capabilities: Vec::new(),
        built_in: false,
    }))
}

fn scan_roots(roots: &[PathBuf]) -> Result<Vec<ApplicationManifest>, String> {
    let mut discovered = Vec::new();
    for root in roots {
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("could not scan {}: {error}", root.display())),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("app") {
                continue;
            }
            if let Some(manifest) = manifest_from_bundle(&path)? {
                if !discovered
                    .iter()
                    .any(|item: &ApplicationManifest| item.id == manifest.id)
                {
                    discovered.push(manifest);
                }
            }
        }
    }
    discovered.sort_by_key(|application| application.name.to_lowercase());
    Ok(discovered)
}

fn refresh_from_roots(paths: &AppPaths, roots: &[PathBuf]) -> Result<RefreshResult, String> {
    let discovered = scan_roots(roots)?;
    let built_in_ids: BTreeSet<_> = built_ins().into_iter().map(|entry| entry.id).collect();
    let mut registered = registered(paths)?;
    let known_ids: BTreeSet<_> = registered
        .iter()
        .map(|entry| entry.id.clone())
        .chain(built_in_ids)
        .collect();
    let added: Vec<_> = discovered
        .iter()
        .filter(|entry| !known_ids.contains(&entry.id))
        .cloned()
        .collect();
    registered.extend(added.iter().cloned());
    registered.sort_by_key(|application| application.name.to_lowercase());
    crate::store::write_json_atomic(
        &registry_path(paths),
        &Registry {
            schema_version: SCHEMA_VERSION,
            applications: registered,
        },
    )?;
    Ok(RefreshResult {
        scanned_roots: roots
            .iter()
            .map(|root| root.display().to_string())
            .collect(),
        discovered: discovered.len(),
        added,
        applications: list(paths)?,
    })
}

pub fn register(paths: &AppPaths, manifest_path: &Path) -> Result<ApplicationManifest, String> {
    let mut manifest: ApplicationManifest = serde_json::from_slice(
        &fs::read(manifest_path)
            .map_err(|error| format!("could not read application manifest: {error}"))?,
    )
    .map_err(|error| format!("invalid HII application manifest: {error}"))?;
    manifest.built_in = false;
    validate_manifest(&manifest)?;
    if built_ins().iter().any(|entry| entry.id == manifest.id) {
        return Err(format!(
            "built-in HII application `{}` cannot be replaced",
            manifest.id
        ));
    }
    let mut applications = registered(paths)?;
    applications.retain(|entry| entry.id != manifest.id);
    applications.push(manifest.clone());
    applications.sort_by(|left, right| left.id.cmp(&right.id));
    crate::store::write_json_atomic(
        &registry_path(paths),
        &Registry {
            schema_version: SCHEMA_VERSION,
            applications,
        },
    )?;
    Ok(manifest)
}

fn append_json_line(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|error| error.to_string())
}

pub fn launch(
    paths: &AppPaths,
    application_id: &str,
    surface: &str,
    source: &str,
) -> Result<LaunchRequest, String> {
    validate_identifier(application_id, "id")?;
    if !matches!(surface, "canvas" | "native" | "bar") {
        return Err("HII application surface must be canvas, native, or bar".into());
    }
    let application = list(paths)?
        .into_iter()
        .find(|entry| entry.id == application_id)
        .ok_or_else(|| format!("unknown HII application `{application_id}`"))?;
    let supported = match surface {
        "canvas" => application.surfaces.canvas.is_some(),
        "native" => application.surfaces.native.is_some(),
        "bar" => true,
        _ => false,
    };
    if !supported {
        return Err(format!(
            "{} does not declare a {surface} surface",
            application.name
        ));
    }
    let id = Uuid::new_v4().to_string();
    let requested_at = Utc::now().to_rfc3339();
    let receipt = paths
        .runtime
        .join("receipts/applications")
        .join(format!("{id}.json"));
    let request = LaunchRequest {
        schema_version: SCHEMA_VERSION,
        id: id.clone(),
        application_id: application.id,
        surface: surface.into(),
        source: source.chars().take(80).collect(),
        status: "requested".into(),
        requested_at: requested_at.clone(),
        receipt_path: receipt.display().to_string(),
    };
    append_json_line(&request_path(paths), &request)?;
    crate::store::write_json_atomic(
        &receipt,
        &serde_json::json!({
            "schemaVersion": 1,
            "kind": "hii.application.launch.receipt",
            "id": id,
            "applicationId": request.application_id,
            "surface": surface,
            "source": request.source,
            "satisfied": true,
            "proofStrength": "observed",
            "summary": "HII recorded the application launch request; the target surface must acknowledge rendering or activation separately.",
            "createdAt": requested_at
        }),
    )?;
    Ok(request)
}

fn acknowledgements(paths: &AppPaths) -> Result<BTreeSet<String>, String> {
    let path = acknowledgement_path(paths);
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Acknowledgement>(line).ok())
        .map(|value| value.request_id)
        .collect())
}

pub fn pending_requests(paths: &AppPaths) -> Result<Vec<LaunchRequest>, String> {
    let path = request_path(paths);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let acknowledged = acknowledgements(paths)?;
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut requests: Vec<LaunchRequest> = raw
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .filter(|request: &LaunchRequest| !acknowledged.contains(&request.id))
        .collect();
    if requests.len() > 100 {
        requests = requests.split_off(requests.len() - 100);
    }
    Ok(requests)
}

fn acknowledge(paths: &AppPaths, request_id: &str) -> Result<Acknowledgement, String> {
    validate_identifier(request_id, "request id")?;
    let request = pending_requests(paths)?
        .into_iter()
        .find(|request| request.id == request_id)
        .ok_or_else(|| {
            format!("unknown or already handled HII application request `{request_id}`")
        })?;
    let handled_at = Utc::now().to_rfc3339();
    let receipt = paths
        .runtime
        .join("receipts/applications")
        .join(format!("{request_id}-handled.json"));
    let acknowledgement = Acknowledgement {
        schema_version: SCHEMA_VERSION,
        request_id: request_id.into(),
        handled_at: handled_at.clone(),
        receipt_path: receipt.display().to_string(),
    };
    append_json_line(&acknowledgement_path(paths), &acknowledgement)?;
    crate::store::write_json_atomic(
        &receipt,
        &serde_json::json!({
            "schemaVersion": 1,
            "kind": "hii.application.surface.receipt",
            "id": Uuid::new_v4().to_string(),
            "requestId": request.id,
            "applicationId": request.application_id,
            "surface": request.surface,
            "source": request.source,
            "satisfied": true,
            "proofStrength": "observed",
            "summary": "The target HII surface acknowledged that it handled this application launch request.",
            "createdAt": handled_at
        }),
    )?;
    Ok(acknowledgement)
}

pub fn render_list(paths: &AppPaths, json: bool) -> Result<(), String> {
    let applications = list(paths)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": SCHEMA_VERSION,
                "applications": applications
            }))
            .map_err(|error| error.to_string())?
        );
    } else {
        for application in applications {
            let surfaces = [
                application.surfaces.canvas.as_ref().map(|_| "canvas"),
                application.surfaces.native.as_ref().map(|_| "native"),
                Some("bar"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(",");
            println!(
                "{:<36} {:<18} {}",
                application.id, surfaces, application.name
            );
        }
    }
    Ok(())
}

pub fn render_refresh(paths: &AppPaths, json: bool) -> Result<(), String> {
    let result = refresh_from_roots(paths, &application_roots())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
        );
    } else if result.added.is_empty() {
        println!("Applications are up to date ({} found).", result.discovered);
    } else {
        println!("Added {} new application(s):", result.added.len());
        for application in result.added {
            println!("  {}  {}", application.id, application.name);
        }
    }
    Ok(())
}

pub fn render_register(paths: &AppPaths, manifest: &Path, json: bool) -> Result<(), String> {
    let application = register(paths, manifest)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&application).map_err(|error| error.to_string())?
        );
    } else {
        println!("Registered {} ({})", application.name, application.id);
    }
    Ok(())
}

pub fn render_launch(
    paths: &AppPaths,
    application: &str,
    surface: &str,
    source: &str,
    json: bool,
) -> Result<(), String> {
    let request = launch(paths, application, surface, source)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?
        );
    } else {
        println!(
            "Requested {} on {}\nrequest: {}\nreceipt: {}",
            application, surface, request.id, request.receipt_path
        );
    }
    Ok(())
}

pub fn render_requests(paths: &AppPaths, json: bool) -> Result<(), String> {
    let requests = pending_requests(paths)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": SCHEMA_VERSION,
                "requests": requests
            }))
            .map_err(|error| error.to_string())?
        );
    } else if requests.is_empty() {
        println!("No pending HII application launches.");
    } else {
        for request in requests {
            println!(
                "{}  {}  {}  {}",
                request.id, request.application_id, request.surface, request.source
            );
        }
    }
    Ok(())
}

pub fn render_acknowledge(paths: &AppPaths, request: &str, json: bool) -> Result<(), String> {
    let acknowledgement = acknowledge(paths, request)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&acknowledgement).map_err(|error| error.to_string())?
        );
    } else {
        println!("Acknowledged {}", acknowledgement.request_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> AppPaths {
        let root = std::env::temp_dir().join(format!("hii-applications-test-{}", Uuid::new_v4()));
        AppPaths {
            repo: root.join("repo"),
            runtime: root.join("runtime"),
        }
    }

    fn write_app(root: &Path, directory_name: &str, bundle_id: &str, name: &str) {
        let contents = root.join(directory_name).join("Contents");
        fs::create_dir_all(&contents).unwrap();
        let mut dictionary = plist::Dictionary::new();
        dictionary.insert(
            "CFBundleIdentifier".into(),
            plist::Value::String(bundle_id.into()),
        );
        dictionary.insert(
            "CFBundleDisplayName".into(),
            plist::Value::String(name.into()),
        );
        dictionary.insert(
            "CFBundleShortVersionString".into(),
            plist::Value::String("1.2.3".into()),
        );
        plist::Value::Dictionary(dictionary)
            .to_file_xml(contents.join("Info.plist"))
            .unwrap();
    }

    #[test]
    fn built_ins_share_a_typed_surface_contract() {
        let paths = paths();
        let applications = list(&paths).expect("list applications");
        assert!(applications
            .iter()
            .any(|entry| entry.id == "hii.canvas" && entry.surfaces.native.is_some()));
        assert!(applications
            .iter()
            .any(|entry| entry.id == "community.waymark.location-studio"
                && entry.surfaces.canvas.is_some()));
        assert!(applications.iter().any(|entry| {
            entry.id == "hii.link"
                && entry
                    .capabilities
                    .contains(&"hii.identity.contact-card".into())
        }));
    }

    #[test]
    fn canvas_launches_remain_pending_until_the_surface_acknowledges_them() {
        let paths = paths();
        let request =
            launch(&paths, "community.waymark.location-studio", "canvas", "bar").expect("launch");
        assert_eq!(pending_requests(&paths).expect("pending").len(), 1);
        acknowledge(&paths, &request.id).expect("acknowledge");
        assert!(pending_requests(&paths)
            .expect("pending after ack")
            .is_empty());
        assert!(paths
            .runtime
            .join("receipts/applications")
            .join(format!("{}-handled.json", request.id))
            .is_file());
        let _ = fs::remove_dir_all(paths.runtime.parent().expect("root"));
    }

    #[test]
    fn refresh_adds_only_new_applications_from_the_scanned_folders() {
        let paths = paths();
        let applications = paths.runtime.parent().unwrap().join("Applications");
        write_app(
            &applications,
            "Example.app",
            "com.example.native",
            "Example",
        );
        write_app(
            &applications,
            "Duplicate.app",
            "com.example.native",
            "Example duplicate",
        );
        fs::create_dir_all(applications.join("Not An App")).unwrap();

        let first = refresh_from_roots(&paths, std::slice::from_ref(&applications)).unwrap();
        assert_eq!(first.discovered, 1);
        assert_eq!(first.added.len(), 1);
        assert_eq!(first.added[0].id, "com.example.native");
        assert_eq!(
            first.added[0]
                .surfaces
                .native
                .as_ref()
                .unwrap()
                .bundle_identifier,
            "com.example.native"
        );

        let second = refresh_from_roots(&paths, std::slice::from_ref(&applications)).unwrap();
        assert!(second.added.is_empty());
        assert_eq!(
            second
                .applications
                .iter()
                .filter(|entry| entry.id == "com.example.native")
                .count(),
            1
        );
        let _ = fs::remove_dir_all(paths.runtime.parent().expect("root"));
    }
}
