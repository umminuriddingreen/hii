// SPDX-License-Identifier: Apache-2.0
//! Private, source-linked location records and compact agent context.

use crate::{
    clock,
    config::AppPaths,
    receipt::{Receipt, RunStore},
    store,
};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const LIBRARY_VERSION: u8 = 1;
const MAX_LIMIT: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapRecord {
    id: String,
    title: String,
    summary: String,
    url: String,
    place: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    precision: String,
    visibility: String,
    kind: String,
    created_at: String,
    source: MapSource,
    reasoning: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct MapSource {
    url: String,
    #[serde(rename = "retrievedAt")]
    retrieved_at: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    schema_version: u8,
    records: Vec<MapRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicFeed {
    schema_version: u8,
    posts: Vec<PublicPost>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPost {
    id: String,
    title: String,
    summary: String,
    url: String,
    place: Option<String>,
    location: PublicLocation,
    visibility: String,
    kind: String,
    created_at: String,
    source: MapSource,
    reasoning: String,
}

#[derive(Serialize)]
struct PublicLocation {
    latitude: f64,
    longitude: f64,
    precision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplicitLocation {
    place: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

pub fn resolve_location(
    place: Option<String>,
    location_json: Option<&str>,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(Option<String>, Option<f64>, Option<f64>), String> {
    let Some(raw) = location_json else {
        validate_coordinates(latitude, longitude)?;
        return Ok((place, latitude, longitude));
    };
    if place.is_some() || latitude.is_some() || longitude.is_some() {
        return Err("use either --location JSON or --place/--latitude/--longitude".into());
    }
    let location: ExplicitLocation =
        serde_json::from_str(raw).map_err(|error| format!("invalid --location JSON: {error}"))?;
    validate_coordinates(location.latitude, location.longitude)?;
    if location
        .place
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        && location.latitude.is_none()
    {
        return Err("--location JSON needs a place or coordinate pair".into());
    }
    Ok((location.place, location.latitude, location.longitude))
}

fn library_path(runtime: &Path) -> PathBuf {
    runtime.join("map/library.json")
}

fn lock_library(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "map library path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create map library directory: {error}"))?;
    store::set_directory_mode(parent)?;
    let lock_path = path.with_extension("json.lock");
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let lock = options
        .open(lock_path)
        .map_err(|error| format!("open map library lock: {error}"))?;
    if !lock
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("map library lock is not a regular file".into());
    }
    FileExt::lock_exclusive(&lock).map_err(|error| format!("lock map library: {error}"))?;
    Ok(lock)
}

fn read_library(path: &Path) -> Result<Library, String> {
    let mut library = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Library>(&bytes)
            .map_err(|error| format!("invalid map library {}: {error}", path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Library::default(),
        Err(error) => {
            return Err(format!(
                "cannot read map library {}: {error}",
                path.display()
            ))
        }
    };
    if library.schema_version == 0 {
        library.schema_version = LIBRARY_VERSION;
    }
    if library.schema_version != LIBRARY_VERSION {
        return Err(format!(
            "unsupported map library schema version {}",
            library.schema_version
        ));
    }
    Ok(library)
}

fn validate_url(raw: &str) -> Result<String, String> {
    let parsed =
        url::Url::parse(raw.trim()).map_err(|error| format!("invalid source URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("source URL must be an absolute HTTP(S) URL".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("source URL must not contain credentials".into());
    }
    Ok(parsed.to_string())
}

fn validate_coordinates(latitude: Option<f64>, longitude: Option<f64>) -> Result<(), String> {
    match (latitude, longitude) {
        (None, None) => Ok(()),
        (Some(lat), Some(lon))
            if lat.is_finite()
                && (-90.0..=90.0).contains(&lat)
                && lon.is_finite()
                && (-180.0..=180.0).contains(&lon) =>
        {
            Ok(())
        }
        (Some(_), None) | (None, Some(_)) => {
            Err("latitude and longitude must be provided together".into())
        }
        _ => Err(
            "coordinates must be finite, with latitude in [-90, 90] and longitude in [-180, 180]"
                .into(),
        ),
    }
}

fn build_record(
    title: String,
    raw_url: String,
    summary: String,
    reasoning: String,
    retrieved_at: Option<String>,
    place: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    precision: String,
    public: bool,
) -> Result<MapRecord, String> {
    validate_coordinates(latitude, longitude)?;
    let title = nonempty("title", title)?;
    let summary = nonempty("summary", summary)?;
    let reasoning = nonempty("reasoning/evidence", reasoning)?;
    let precision = nonempty("location precision", precision)?;
    let url = validate_url(&raw_url)?;
    let place = place
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let retrieved_at = match retrieved_at {
        Some(value) => {
            let timestamp = DateTime::parse_from_rfc3339(value.trim())
                .map_err(|error| format!("invalid --retrieved-at timestamp: {error}"))?
                .with_timezone(&Utc);
            if timestamp > Utc::now() + chrono::Duration::minutes(5) {
                return Err("--retrieved-at cannot be more than five minutes in the future".into());
            }
            timestamp.to_rfc3339()
        }
        None => Utc::now().to_rfc3339(),
    };
    let created_at = Utc::now().to_rfc3339();
    let record = MapRecord {
        id: Uuid::new_v4().to_string(),
        title,
        summary,
        url: url.clone(),
        place,
        latitude,
        longitude,
        precision,
        visibility: if public { "public" } else { "private" }.into(),
        kind: "link".into(),
        created_at,
        source: MapSource { url, retrieved_at },
        reasoning,
    };
    Ok(record)
}

fn store_record(path: &Path, record: &MapRecord) -> Result<(), String> {
    let _lock = lock_library(path)?;
    let mut library = read_library(path)?;
    library.records.push(record.clone());
    store::write_json_private_atomic(path, &library)?;
    Ok(())
}

fn nonempty(name: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{name} cannot be empty"))
    } else {
        Ok(value.to_string())
    }
}

fn create_receipt(paths: &AppPaths, run: RunStore, record: &MapRecord) -> Result<PathBuf, String> {
    let library = library_path(&paths.runtime);
    run.event(
        "map.record.added",
        json!({
            "recordId": record.id,
            "visibility": record.visibility,
            "sourceUrl": record.source.url,
            "retrievedAt": record.source.retrieved_at,
            "library": library.display().to_string(),
        }),
    )?;
    let now = clock::unix_ms();
    let verification = serde_json::to_string(
        &json!({"id":record.id,"visibility":record.visibility,"source":record.source}),
    )
    .map_err(|error| error.to_string())?;
    let value = json!({
        "schema_version": 9,
        "id": run.id,
        "created_at_unix_ms": run.started_at_unix_ms,
        "finished_at_unix_ms": now,
        "status": "completed",
        "goal": "hii map add",
        "workspace": paths.repo.display().to_string(),
        "model": "deterministic",
        "steps": 1,
        "summary": format!("Saved {} map source {}", record.visibility, record.title),
        "verification": [{"command":"validate source and location; atomically write map library","ok":true,"output":verification}],
        "git_status": "",
        "risk": "bounded personal-local source library mutation",
        "authority": "personal-local",
        "artifacts": [library.display().to_string()],
        "outcome": "completed",
        "exit_code": 0,
        "context_sources": [record.source.url],
    });
    let receipt: Receipt = serde_json::from_value(value)
        .map_err(|error| format!("cannot construct map receipt: {error}"))?;
    run.finish(&paths.runtime, &receipt)
}

pub fn add(
    paths: &AppPaths,
    title: String,
    url: String,
    summary: String,
    reasoning: String,
    retrieved_at: Option<String>,
    place: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    precision: String,
    public: bool,
    allow_write: bool,
) -> Result<(), String> {
    let path = library_path(&paths.runtime);
    if !allow_write {
        return Err("map add writes local state; pass --allow-write to authorize it".into());
    }
    let record = build_record(
        title,
        url,
        summary,
        reasoning,
        retrieved_at,
        place,
        latitude,
        longitude,
        precision,
        public,
    )?;
    let mut run = RunStore::create(&paths.runtime)?;
    run.set_authority("personal-local")?;
    run.event(
        "map.record.add.started",
        json!({"recordId":record.id,"visibility":record.visibility,"sourceUrl":record.source.url}),
    )?;
    store_record(&path, &record)?;
    let receipt = create_receipt(paths, run, &record)?;
    println!(
        "{}",
        json!({"ok":true,"record":record,"receipt":receipt.display().to_string()})
    );
    Ok(())
}

fn matches_query(record: &MapRecord, query: Option<&str>) -> bool {
    let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) else {
        return true;
    };
    let query = query.to_lowercase();
    [
        record.title.as_str(),
        record.summary.as_str(),
        record.url.as_str(),
        record.reasoning.as_str(),
        record.place.as_deref().unwrap_or(""),
    ]
    .iter()
    .any(|field| field.to_lowercase().contains(&query))
}

fn freshness(retrieved_at: &str) -> String {
    let parsed = DateTime::parse_from_rfc3339(retrieved_at).ok();
    match parsed.map(|date| (Utc::now() - date.with_timezone(&Utc)).num_days()) {
        Some(days) if days < 0 => "future timestamp (clock skew)".into(),
        Some(days) if days <= 7 => format!("fresh ({}d)", days),
        Some(days) => format!("dated ({}d)", days),
        None => "unknown".into(),
    }
}

pub fn context(
    paths: &AppPaths,
    place: Option<&str>,
    query: Option<&str>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    limit: usize,
    json_output: bool,
) -> Result<(), String> {
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(format!("--limit must be 1..={MAX_LIMIT}"));
    }
    validate_coordinates(latitude, longitude)?;
    let library = read_library(&library_path(&paths.runtime))?;
    let mut records: Vec<_> = library
        .records
        .into_iter()
        .filter(|record| matches_query(record, query))
        .collect();
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    records.truncate(limit);
    let current_place = place.map(str::trim).filter(|value| !value.is_empty());
    let refs: Vec<Value> = records.iter().map(|record| json!({
        "id":record.id,"title":record.title,"summary":record.summary,"url":record.url,
        "place":record.place,"latitude":record.latitude,"longitude":record.longitude,
        "precision":record.precision,"visibility":record.visibility,
        "retrievedAt":record.source.retrieved_at,"freshness":freshness(&record.source.retrieved_at),
        "reasoning":record.reasoning,
    })).collect();
    let brief = format!(
        "HII Map local context. Current place: {}. Coordinates: {}. Query: {}. Local references: {}. Use existing web_search to find current authoritative sources and web_fetch to inspect them; compare claims, retain URLs and retrieved times, state uncertainty, then save a supported result with hii map add --title ... --url ... --summary ... --reasoning ... --place ... --allow-write. Never infer the user's location from IP or browser state and never publish private records.",
        current_place.unwrap_or("not supplied"),
        match (latitude,longitude) { (Some(lat),Some(lon)) => format!("explicitly supplied {lat}, {lon}"), _ => "not supplied".into() },
        query.unwrap_or("none"), refs.len()
    );
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"brief":brief,"place":current_place,"query":query,"references":refs})
            )
            .map_err(|error| error.to_string())?
        );
    } else {
        println!("{brief}");
        for reference in &refs {
            println!(
                "- {} — {} [{}] · {}",
                reference["title"].as_str().unwrap_or(""),
                reference["url"].as_str().unwrap_or(""),
                reference["visibility"].as_str().unwrap_or(""),
                reference["freshness"].as_str().unwrap_or("")
            );
        }
    }
    Ok(())
}

pub fn list(paths: &AppPaths, json_output: bool) -> Result<(), String> {
    let library = read_library(&library_path(&paths.runtime))?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&library).map_err(|error| error.to_string())?
        );
    } else {
        for record in library.records.iter().rev() {
            println!(
                "{} [{}] {} — {} ({})",
                record.id,
                record.visibility,
                record.title,
                record.place.as_deref().unwrap_or("unlocated"),
                record.url
            );
        }
        if library.records.is_empty() {
            println!("No map sources saved.");
        }
    }
    Ok(())
}

pub fn export(
    paths: &AppPaths,
    output: &Path,
    public: bool,
    allow_write: bool,
) -> Result<(), String> {
    let mut run = RunStore::create(&paths.runtime)?;
    run.set_authority(if allow_write {
        "personal-local"
    } else {
        "read-only"
    })?;
    run.event(
        "map.export.started",
        json!({"output":output.display().to_string(),"public":public,"allowWrite":allow_write}),
    )?;
    let result = export_feed(&paths.runtime, output, public, allow_write);
    let (ok, detail) = match &result {
        Ok((exported, skipped)) => (
            true,
            json!({"exported":exported,"skippedWithoutCoordinates":skipped}),
        ),
        Err(error) => (false, json!({"error":error})),
    };
    run.event(
        if ok {
            "map.export.completed"
        } else {
            "map.export.failed"
        },
        json!({"output":output.display().to_string(),"result":detail.clone()}),
    )?;
    let receipt_value = json!({
        "schema_version":9,"id":run.id,"created_at_unix_ms":run.started_at_unix_ms,
        "finished_at_unix_ms":clock::unix_ms(),"status":if ok {"completed"} else {"incomplete"},
        "goal":"hii map export","workspace":paths.repo.display().to_string(),"model":"deterministic",
        "steps":1,"summary":if ok {"Exported public HII Map feed"} else {"HII Map export failed"},
        "verification":[{"command":"write explicit public-only Map feed","ok":ok,"output":detail.to_string()}],
        "git_status":"","risk":if allow_write {"bounded local export to explicit path"} else {"export denied because --allow-write was omitted"},
        "authority":if allow_write {"personal-local"} else {"read-only"},
        "artifacts":if ok {vec![output.display().to_string()]} else {Vec::<String>::new()},
        "outcome":if ok {"completed"} else {"infra-error"},"exit_code":if ok {0} else {1}
    });
    let receipt: Receipt = serde_json::from_value(receipt_value)
        .map_err(|error| format!("cannot construct map export receipt: {error}"))?;
    let receipt_path = run.finish(&paths.runtime, &receipt)?;
    match result {
        Ok((exported, skipped)) => {
            println!(
                "{}",
                json!({"ok":true,"output":output.display().to_string(),"exported":exported,"skippedWithoutCoordinates":skipped,"receipt":receipt_path.display().to_string()})
            );
            Ok(())
        }
        Err(error) => Err(format!("{error}; receipt: {}", receipt_path.display())),
    }
}

fn export_feed(
    runtime: &Path,
    output: &Path,
    public: bool,
    allow_write: bool,
) -> Result<(usize, usize), String> {
    if !public {
        return Err("map export requires explicit --public".into());
    }
    if !allow_write {
        return Err(
            "map export writes the selected path; pass --allow-write to authorize it".into(),
        );
    }
    let library = read_library(&library_path(runtime))?;
    let (feed, skipped) = public_feed(library);
    let exported = feed.posts.len();
    store::write_json_atomic(output, &feed)?;
    Ok((exported, skipped))
}

fn public_feed(library: Library) -> (PublicFeed, usize) {
    let mut posts = Vec::new();
    let mut skipped = 0;
    for record in library
        .records
        .into_iter()
        .filter(|record| record.visibility == "public")
    {
        match (record.latitude, record.longitude) {
            (Some(latitude), Some(longitude)) => posts.push(PublicPost {
                id: record.id,
                title: record.title,
                summary: record.summary,
                url: record.url,
                place: record.place,
                location: PublicLocation {
                    latitude,
                    longitude,
                    precision: record.precision,
                },
                visibility: record.visibility,
                kind: record.kind,
                created_at: record.created_at,
                source: record.source,
                reasoning: record.reasoning,
            }),
            _ => skipped += 1,
        }
    }
    (
        PublicFeed {
            schema_version: 1,
            posts,
        },
        skipped,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use tempfile::tempdir;

    #[test]
    fn stores_private_records_atomically_with_source_timestamp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("map/library.json");
        let record = build_record(
            "A place".into(),
            "https://example.com/source".into(),
            "A grounded summary".into(),
            "Evidence from source".into(),
            None,
            Some("Example City".into()),
            None,
            None,
            "city".into(),
            false,
        )
        .unwrap();
        store_record(&path, &record).unwrap();
        assert_eq!(record.source.url, record.url);
        assert!(!record.source.retrieved_at.is_empty());
        assert_eq!(
            read_library(&path).unwrap().records[0].visibility,
            "private"
        );
        let mode = fs::metadata(path).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(mode.mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn concurrent_adds_keep_every_record() {
        let dir = tempdir().unwrap();
        let path = Arc::new(dir.path().join("map/library.json"));
        let barrier = Arc::new(Barrier::new(12));
        let workers: Vec<_> = (0..12)
            .map(|index| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let record = build_record(
                        format!("Place {index}"),
                        format!("https://example.com/{index}"),
                        "summary".into(),
                        "evidence".into(),
                        None,
                        None,
                        None,
                        None,
                        "unspecified".into(),
                        false,
                    )
                    .unwrap();
                    barrier.wait();
                    store_record(&path, &record).unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let records = read_library(&path).unwrap().records;
        assert_eq!(records.len(), 12);
        assert_eq!(
            records
                .iter()
                .map(|record| &record.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            12
        );
    }

    #[test]
    fn export_finishes_success_and_failure_receipts() {
        let dir = tempdir().unwrap();
        let paths = AppPaths {
            repo: dir.path().join("repo"),
            runtime: dir.path().join("runtime"),
        };
        fs::create_dir_all(&paths.repo).unwrap();
        let library = library_path(&paths.runtime);
        let record = build_record(
            "Public".into(),
            "https://example.com/map".into(),
            "summary".into(),
            "evidence".into(),
            None,
            Some("Somewhere".into()),
            Some(10.0),
            Some(20.0),
            "city".into(),
            true,
        )
        .unwrap();
        store_record(&library, &record).unwrap();
        let output = dir.path().join("feed.json");
        export(&paths, &output, true, true).unwrap();
        let receipt_path = crate::receipt::find_receipt(&paths.runtime, None, &paths.repo).unwrap();
        let receipt: Receipt = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
        assert_eq!(receipt.status, "completed");
        assert_eq!(receipt.artifacts, vec![output.display().to_string()]);

        let error = export(&paths, dir.path(), true, true).unwrap_err();
        assert!(error.contains("receipt:"));
        let receipt_path = crate::receipt::find_receipt(&paths.runtime, None, &paths.repo).unwrap();
        let receipt: Receipt = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
        assert_eq!(receipt.status, "incomplete");
        assert_eq!(receipt.outcome, "infra-error");
        assert!(!receipt.verification[0].ok);
    }

    #[test]
    fn rejects_credentials_bad_urls_and_partial_or_out_of_range_coordinates() {
        assert!(validate_url("https://u:p@x/").is_err() && validate_url("file:///tmp/x").is_err());
        assert!(validate_coordinates(Some(12.0), None).is_err());
        assert!(validate_coordinates(Some(91.0), Some(0.0)).is_err());
        let (place, lat, lon) = resolve_location(
            None,
            Some("{\"place\":\"Here\",\"latitude\":12,\"longitude\":13}"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(place.as_deref(), Some("Here"));
        assert_eq!((lat, lon), (Some(12.0), Some(13.0)));
    }

    #[test]
    fn export_contains_only_public_located_records() {
        let private = build_record(
            "Private".into(),
            "https://example.com/p".into(),
            "private".into(),
            "source evidence".into(),
            None,
            Some("Somewhere".into()),
            None,
            None,
            "place".into(),
            false,
        )
        .unwrap();
        let public = build_record(
            "Public".into(),
            "https://example.com/pub".into(),
            "public".into(),
            "source evidence".into(),
            None,
            Some("Somewhere".into()),
            Some(40.0),
            Some(-74.0),
            "city".into(),
            true,
        )
        .unwrap();
        let (feed, skipped) = public_feed(Library {
            schema_version: LIBRARY_VERSION,
            records: vec![private, public],
        });
        let value = serde_json::to_value(feed).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["posts"].as_array().unwrap().len(), 1);
        assert_eq!(value["posts"][0]["location"]["latitude"], 40.0);
        assert_eq!(skipped, 0);
    }
}
