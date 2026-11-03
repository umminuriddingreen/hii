//! Per-device locations for HII's fast runtime and portable static library.
//!
//! The runtime remains under the local HII runtime directory. A user may point
//! the static library at a mounted external volume; each device stores its own
//! mount path so Mac and Windows share the same CLI contract without sharing
//! incompatible absolute paths.

use crate::config::AppPaths;
use clap::{Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const CONFIG_FILE: &str = "config/storage.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LibraryArea {
    Skills,
    Software,
    Tools,
}

impl LibraryArea {
    fn name(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Software => "software",
            Self::Tools => "tools",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum StorageCommand {
    #[command(about = "Show local runtime and portable library locations")]
    Status {
        #[arg(long, help = "Emit machine-readable JSON")]
        json: bool,
    },
    #[command(
        name = "set-root",
        about = "Use a mounted external drive for static HII files"
    )]
    SetRoot {
        #[arg(
            value_name = "PATH",
            help = "Existing mounted drive folder for the HII library"
        )]
        path: PathBuf,
        #[arg(long, help = "Emit machine-readable JSON")]
        json: bool,
    },
    #[command(
        name = "clear-root",
        about = "Return static HII files to the local runtime directory"
    )]
    ClearRoot {
        #[arg(long, help = "Emit machine-readable JSON")]
        json: bool,
    },
    #[command(about = "Print the configured path for one static library area")]
    Path {
        #[arg(value_enum)]
        area: LibraryArea,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    #[serde(default = "schema_version")]
    schema_version: u8,
    #[serde(default)]
    library_root: Option<PathBuf>,
}

fn schema_version() -> u8 {
    1
}

fn config_path(runtime: &Path) -> PathBuf {
    runtime.join(CONFIG_FILE)
}

fn load(runtime: &Path) -> StorageConfig {
    fs::read(config_path(runtime))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn configured_library_root(runtime: &Path) -> Option<PathBuf> {
    load(runtime).library_root
}

/// Resolve one static area. Before an external library is selected this keeps
/// the historic `~/.hii/<area>` location, so existing installs keep working.
pub fn area_path(runtime: &Path, area: LibraryArea) -> PathBuf {
    configured_library_root(runtime)
        .unwrap_or_else(|| runtime.to_path_buf())
        .join(area.name())
}

pub fn skills_root(runtime: &Path) -> PathBuf {
    area_path(runtime, LibraryArea::Skills)
}

pub fn execute(paths: &AppPaths, action: StorageCommand) -> Result<(), String> {
    match action {
        StorageCommand::Status { json: as_json } => {
            let report = status(paths);
            if as_json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("runtime   {}", paths.runtime.display());
                println!("models    {}", paths.runtime.join("models").display());
                println!(
                    "library   {}",
                    report["libraryRoot"].as_str().unwrap_or("unconfigured")
                );
                println!(
                    "available {}",
                    report["available"].as_bool().unwrap_or(false)
                );
                println!(
                    "skills    {}",
                    area_path(&paths.runtime, LibraryArea::Skills).display()
                );
                println!(
                    "software  {}",
                    area_path(&paths.runtime, LibraryArea::Software).display()
                );
                println!(
                    "tools     {}",
                    area_path(&paths.runtime, LibraryArea::Tools).display()
                );
                if report["configured"].as_bool() == Some(false) {
                    println!("Select a mounted external folder with: hii storage set-root <PATH>");
                }
            }
        }
        StorageCommand::SetRoot {
            path,
            json: as_json,
        } => {
            let root = validate_root(&paths.runtime, &path)?;
            let current = active_library_root(&paths.runtime)?;
            copy_static_areas(&paths.runtime, &current, &root)?;
            let config = StorageConfig {
                schema_version: schema_version(),
                library_root: Some(root.clone()),
            };
            crate::store::write_json_atomic(&config_path(&paths.runtime), &config)?;
            let leftovers = remove_moved_sources(&paths.runtime, &current, &root);
            let mut report = status(paths);
            report["migration"] = json!({
                "from": current,
                "to": root,
                "areas": ["skills", "software", "tools"],
                "localLifecycleMetadataKept": true,
                "sourceCleanupWarnings": leftovers,
            });
            if as_json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!("HII static library set to {}", root.display());
                println!(
                    "Static skills, software, and tools were moved from {}. Model files and runtime state stay under {}.",
                    current.display(),
                    paths.runtime.display()
                );
                if !report["migration"]["sourceCleanupWarnings"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                {
                    println!("Some old files could not be removed; see `hii storage status --json` and clean them up after review.");
                }
            }
        }
        StorageCommand::ClearRoot { json: as_json } => {
            let current = configured_library_root(&paths.runtime)
                .map(|_| active_library_root(&paths.runtime))
                .transpose()?;
            if let Some(root) = current.as_ref() {
                copy_static_areas(&paths.runtime, root, &paths.runtime)?;
            }
            let path = config_path(&paths.runtime);
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|error| format!("cannot clear {}: {error}", path.display()))?;
            }
            let leftovers = current.as_ref().map_or_else(Vec::new, |root| {
                remove_moved_sources(&paths.runtime, root, &paths.runtime)
            });
            let mut report = status(paths);
            report["migration"] = json!({
                "from": current,
                "to": paths.runtime,
                "areas": ["skills", "software", "tools"],
                "localLifecycleMetadataKept": true,
                "sourceCleanupWarnings": leftovers,
            });
            if as_json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
                );
            } else {
                println!(
                    "HII static library files returned to {}",
                    paths.runtime.display(),
                );
                println!("Model files and runtime state remain under the local runtime.");
            }
        }
        StorageCommand::Path { area } => {
            println!("{}", area_path(&paths.runtime, area).display());
        }
    }
    Ok(())
}

fn status(paths: &AppPaths) -> serde_json::Value {
    let root = configured_library_root(&paths.runtime);
    let available = root.as_ref().is_some_and(|path| path.is_dir());
    json!({
        "schemaVersion": 1,
        "kind": "hii.storage.status",
        "scope": "per-device",
        "runtimeRoot": paths.runtime,
        "modelRuntimeRoot": paths.runtime.join("models"),
        "libraryRoot": root,
        "configured": root.is_some(),
        "available": available,
        "areas": {
            "skills": area_path(&paths.runtime, LibraryArea::Skills),
            "software": area_path(&paths.runtime, LibraryArea::Software),
            "tools": area_path(&paths.runtime, LibraryArea::Tools)
        }
    })
}

fn areas() -> [LibraryArea; 3] {
    [
        LibraryArea::Skills,
        LibraryArea::Software,
        LibraryArea::Tools,
    ]
}

fn active_library_root(runtime: &Path) -> Result<PathBuf, String> {
    let root = configured_library_root(runtime).unwrap_or_else(|| runtime.to_path_buf());
    let canonical = normalize_windows_path(root.canonicalize().map_err(|error| {
        format!(
            "current static library is unavailable at {}; mount that drive before changing storage: {error}",
            root.display()
        )
    })?);
    if !canonical.is_dir() {
        return Err(format!(
            "current static library is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn same_path(left: &Path, right: &Path) -> bool {
    left == right
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(left, right)| left == right)
}

fn normalize_windows_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!("\\\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

/// Copy and byte-verify all portable files before changing the active root.
/// Existing target files are accepted only when their bytes already match.
fn copy_static_areas(runtime: &Path, source_root: &Path, target_root: &Path) -> Result<(), String> {
    if same_path(source_root, target_root) {
        return Ok(());
    }
    let local_runtime = runtime
        .canonicalize()
        .unwrap_or_else(|_| runtime.to_path_buf());
    for area in areas() {
        let source = source_root.join(area.name());
        let target = target_root.join(area.name());
        let Some(source_metadata) = optional_metadata(&source)? else {
            continue;
        };
        if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
            return Err(format!(
                "static library area must be a real directory: {}",
                source.display()
            ));
        }
        if let Some(metadata) = optional_metadata(&target)? {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "external library path conflicts with directory {}",
                    target.display()
                ));
            }
        } else {
            fs::create_dir_all(&target)
                .map_err(|error| format!("cannot prepare {}: {error}", target.display()))?;
        }
        let preserve_lifecycle = area == LibraryArea::Skills
            && (same_path(source_root, &local_runtime) || same_path(target_root, &local_runtime));
        copy_tree_verified(&source, &target, Path::new(""), preserve_lifecycle)?;
    }
    Ok(())
}

fn copy_tree_verified(
    source: &Path,
    target: &Path,
    relative: &Path,
    preserve_lifecycle: bool,
) -> Result<(), String> {
    if preserve_lifecycle && relative == Path::new("lifecycle.json") {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("cannot inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "refusing to move symlinked static content: {}",
            source.display()
        ));
    }
    if metadata.is_dir() {
        if let Some(target_metadata) = optional_metadata(target)? {
            if target_metadata.file_type().is_symlink() || !target_metadata.is_dir() {
                return Err(format!(
                    "external library path conflicts with directory {}",
                    target.display()
                ));
            }
        } else {
            fs::create_dir_all(target)
                .map_err(|error| format!("cannot create {}: {error}", target.display()))?;
        }
        for entry in fs::read_dir(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let child_relative = relative.join(entry.file_name());
            copy_tree_verified(
                &entry.path(),
                &target.join(entry.file_name()),
                &child_relative,
                preserve_lifecycle,
            )?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(format!(
            "unsupported static library entry: {}",
            source.display()
        ));
    }
    if let Some(target_metadata) = optional_metadata(target)? {
        if target_metadata.file_type().is_symlink() || !target_metadata.is_file() {
            return Err(format!(
                "external library path conflicts with file {}",
                target.display()
            ));
        }
        if !files_equal(source, target)? {
            return Err(format!(
                "external library contains different content at {}; local files were left in place",
                target.display()
            ));
        }
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| format!("invalid library target {}", target.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    fs::copy(source, target).map_err(|error| {
        format!(
            "cannot copy {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    if !files_equal(source, target)? {
        let _ = fs::remove_file(target);
        return Err(format!("copied file did not verify: {}", target.display()));
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let mut left = fs::File::open(left).map_err(|error| error.to_string())?;
    let mut right = fs::File::open(right).map_err(|error| error.to_string())?;
    let mut left_chunk = [0u8; 64 * 1024];
    let mut right_chunk = [0u8; 64 * 1024];
    loop {
        let left_len = left
            .read(&mut left_chunk)
            .map_err(|error| error.to_string())?;
        let right_len = right
            .read(&mut right_chunk)
            .map_err(|error| error.to_string())?;
        if left_len != right_len || left_chunk[..left_len] != right_chunk[..right_len] {
            return Ok(false);
        }
        if left_len == 0 {
            return Ok(true);
        }
    }
}

fn optional_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
    }
}

/// Remove moved files only after the new root is active. Preserve HII's local
/// skill lifecycle ledger, which tracks runtime state rather than skill files.
fn remove_moved_sources(runtime: &Path, source_root: &Path, target_root: &Path) -> Vec<String> {
    if same_path(source_root, target_root) {
        return Vec::new();
    }
    let local_runtime = runtime
        .canonicalize()
        .unwrap_or_else(|_| runtime.to_path_buf());
    let mut warnings = Vec::new();
    for area in areas() {
        let source = source_root.join(area.name());
        let source_exists = match optional_metadata(&source) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        if !source_exists {
            continue;
        }
        let preserve_lifecycle =
            area == LibraryArea::Skills && same_path(source_root, &local_runtime);
        if let Err(error) = remove_tree_contents(&source, Path::new(""), preserve_lifecycle) {
            warnings.push(error);
        }
    }
    warnings
}

fn remove_tree_contents(
    root: &Path,
    relative: &Path,
    preserve_lifecycle: bool,
) -> Result<(), String> {
    for entry in
        fs::read_dir(root).map_err(|error| format!("cannot clean {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let child_relative = relative.join(entry.file_name());
        if preserve_lifecycle && child_relative == Path::new("lifecycle.json") {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "left symlinked source content in place: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            remove_tree_contents(&path, &child_relative, preserve_lifecycle)?;
            if fs::read_dir(&path)
                .map_err(|error| error.to_string())?
                .next()
                .is_none()
            {
                fs::remove_dir(&path)
                    .map_err(|error| format!("cannot remove {}: {error}", path.display()))?;
            }
        } else if metadata.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("cannot remove {}: {error}", path.display()))?;
        } else {
            return Err(format!(
                "left unsupported source content in place: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn validate_root(runtime: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("external library path must be absolute".into());
    }
    let metadata = fs::metadata(path).map_err(|error| {
        format!("external library folder must already be mounted and accessible: {error}")
    })?;
    if !metadata.is_dir() {
        return Err("external library path must be a directory".into());
    }
    let root = normalize_windows_path(
        path.canonicalize()
            .map_err(|error| format!("cannot resolve external library path: {error}"))?,
    );
    let runtime_root = normalize_windows_path(
        runtime
            .canonicalize()
            .map_err(|error| format!("cannot resolve local runtime path: {error}"))?,
    );
    if root.starts_with(&runtime_root) || runtime_root.starts_with(&root) {
        return Err("external library and local runtime paths must not overlap".into());
    }
    if let Some(previous) = configured_library_root(runtime).filter(|previous| previous.exists()) {
        let previous = normalize_windows_path(
            previous
                .canonicalize()
                .map_err(|error| format!("cannot resolve current library path: {error}"))?,
        );
        if previous != root && (root.starts_with(&previous) || previous.starts_with(&root)) {
            return Err("new and current external library paths must not overlap".into());
        }
    }

    let probe = root.join(format!(".hii-write-check-{}", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("external library folder is not writable: {error}"))?;
    file.write_all(b"HII storage check\n")
        .map_err(|error| format!("external library folder write failed: {error}"))?;
    drop(file);
    fs::remove_file(&probe)
        .map_err(|error| format!("cannot remove storage check file: {error}"))?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn paths(runtime: &Path) -> AppPaths {
        AppPaths {
            repo: runtime.to_path_buf(),
            runtime: runtime.to_path_buf(),
        }
    }

    #[test]
    fn unset_library_keeps_legacy_local_static_paths_and_fast_model_path() {
        let runtime = TempDir::new().unwrap();
        assert_eq!(skills_root(runtime.path()), runtime.path().join("skills"));
        assert_eq!(
            area_path(runtime.path(), LibraryArea::Tools),
            runtime.path().join("tools")
        );
        assert_eq!(
            runtime.path().join("models"),
            paths(runtime.path()).runtime.join("models")
        );
    }

    #[test]
    fn configured_external_root_routes_static_areas_and_leaves_runtime_local() {
        let runtime = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        fs::create_dir_all(config_path(runtime.path()).parent().unwrap()).unwrap();
        crate::store::write_json_atomic(
            &config_path(runtime.path()),
            &StorageConfig {
                schema_version: 1,
                library_root: Some(external.path().to_path_buf()),
            },
        )
        .unwrap();

        assert_eq!(skills_root(runtime.path()), external.path().join("skills"));
        assert_eq!(
            area_path(runtime.path(), LibraryArea::Software),
            external.path().join("software")
        );
        assert_eq!(
            area_path(runtime.path(), LibraryArea::Tools),
            external.path().join("tools")
        );
        assert_eq!(
            paths(runtime.path()).runtime.join("models"),
            runtime.path().join("models")
        );
    }

    #[test]
    fn selecting_a_root_requires_a_mounted_writable_non_overlapping_folder() {
        let runtime = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        assert_eq!(
            validate_root(runtime.path(), external.path()).unwrap(),
            normalize_windows_path(external.path().canonicalize().unwrap())
        );
        assert!(validate_root(runtime.path(), Path::new("relative-drive")).is_err());
        assert!(validate_root(runtime.path(), runtime.path()).is_err());
        assert!(validate_root(runtime.path(), &runtime.path().join("missing")).is_err());
    }

    #[test]
    fn static_library_move_verifies_files_and_keeps_local_lifecycle_state() {
        let runtime = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        let installed = runtime.path().join("skills/installed/example/SKILL.md");
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::write(&installed, "portable skill\n").unwrap();
        let lifecycle = runtime.path().join("skills/lifecycle.json");
        fs::write(&lifecycle, "{\"skills\":{}}\n").unwrap();
        let tool = runtime.path().join("tools/bin/example");
        fs::create_dir_all(tool.parent().unwrap()).unwrap();
        fs::write(&tool, "portable tool\n").unwrap();

        copy_static_areas(runtime.path(), runtime.path(), external.path()).unwrap();
        assert_eq!(
            fs::read_to_string(external.path().join("skills/installed/example/SKILL.md")).unwrap(),
            "portable skill\n"
        );
        assert_eq!(
            fs::read_to_string(external.path().join("tools/bin/example")).unwrap(),
            "portable tool\n"
        );
        remove_moved_sources(runtime.path(), runtime.path(), external.path());
        assert!(!installed.exists());
        assert!(!tool.exists());
        assert!(lifecycle.exists());
    }

    #[test]
    fn conflicting_external_file_aborts_move_without_removing_local_source() {
        let runtime = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        fs::create_dir_all(runtime.path().join("software")).unwrap();
        fs::create_dir_all(external.path().join("software")).unwrap();
        fs::write(runtime.path().join("software/app.bin"), "local").unwrap();
        fs::write(external.path().join("software/app.bin"), "different").unwrap();

        let error = copy_static_areas(runtime.path(), runtime.path(), external.path()).unwrap_err();
        assert!(error.contains("different content"));
        assert_eq!(
            fs::read_to_string(runtime.path().join("software/app.bin")).unwrap(),
            "local"
        );
    }
}
