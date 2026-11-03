//! Planning capability installation and creating local capability drafts.
//!
//! Installation is delegated to the reviewed Node helper as an argv vector. This
//! module never builds a shell command and never executes downloaded code.

use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const MAX_SKILL_BYTES: usize = 64 * 1024;
const MAX_TOOL_BYTES: usize = 256 * 1024;
pub const CONTEXT_PREFIX: &str = "HII CAPABILITY CONTEXT:";

/// Expose only the native schemas relevant to this request; no connector scan.
pub fn context_for_request(input: &str) -> Option<String> {
    let input = input.to_ascii_lowercase();
    let mut names = Vec::new();
    if (input.contains("skill") || input.contains("tool"))
        && ["create", "build", "make", "save"]
            .iter()
            .any(|verb| input.contains(verb))
    {
        names.push("capability_create");
    }
    if input.contains("install") || input.contains("download") {
        names.push("capability_install");
    }
    if input.contains("model") || input.contains("hugging") || input.contains("hardware") {
        names.push("model_catalog");
    }
    if names.is_empty() {
        return None;
    }
    let schemas = names
        .into_iter()
        .map(|name| json!({"type":name,"inputs":crate::acp::input_schema(name)}))
        .collect::<Vec<_>>();
    Some(format!("{CONTEXT_PREFIX}\nAvailable native actions: {}\nUse capability_create for NEW reusable skill/tool drafts; skill_search only finds existing skills. Verify created files before claiming success. Installation requires an explicit target; model_catalog reports hardware fit estimates, not proven optimal speed.", Value::Array(schemas)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    Model,
    Skill,
    Tool,
}

impl InstallKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Skill => "skill",
            Self::Tool => "tool",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRequest {
    pub kind: InstallKind,
    pub source: String,
    /// Optional model file or skill subdirectory to install.
    pub file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub program: String,
    /// Each value is passed as one process argument. Spaces are preserved.
    pub args: Vec<String>,
    pub timeout_secs: u64,
}

/// Resolve shipped resources independently of the user's active work folder.
pub fn resource(repo: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut roots = vec![repo.to_path_buf()];
    if let Some(root) = std::env::var_os("HII_ROOT") {
        roots.push(root.into());
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.join("resources"));
        }
    }
    roots
        .into_iter()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "This HII installation is missing {relative}; reinstall the complete CLI release."
            )
        })
}

/// Short help shown for `/install` with no arguments.
pub fn help() -> String {
    "Install a capability:\n  /install owner/repo\n  /install model owner/repo [filename]\n  /install skill PATH_OR_REPO [subdir]\n  /install tool FORMULA\n\nA bare owner/repo installs a Hugging Face model. Quote paths that contain spaces.".to_string()
}

/// Public parsing facade for slash-command callers. A bare command yields
/// `None`, allowing the caller to print [`help`].
pub fn parse(input: &str) -> Result<Option<Value>, String> {
    Ok(parse_slash(input)?.map(|request| {
        json!({
            "kind": request.kind.as_str(),
            "source": request.source,
            "file": request.file,
        })
    }))
}

/// Parse the slash-command form. `Ok(None)` means the command was bare and the
/// caller should display [`help`]. Quoted paths stay single argv values.
pub fn parse_slash(input: &str) -> Result<Option<InstallRequest>, String> {
    let words = tokenize(input)?;
    let words = if words.first().is_some_and(|word| *word == "/install") {
        &words[1..]
    } else {
        &words[..]
    };
    if words.is_empty() {
        return Ok(None);
    }
    if words.len() == 1 {
        return Ok(Some(InstallRequest {
            kind: InstallKind::Model,
            source: words[0].clone(),
            file: None,
        }));
    }
    let kind = match words[0].as_str() {
        "model" => InstallKind::Model,
        "skill" => InstallKind::Skill,
        "tool" => InstallKind::Tool,
        _ => return Err("expected install kind: model, skill, or tool".into()),
    };
    let max_words = if kind == InstallKind::Tool { 2 } else { 3 };
    if words.len() < 2 || words.len() > max_words {
        return Err(format!(
            "invalid /install {} arguments; see /install",
            kind.as_str()
        ));
    }
    Ok(Some(InstallRequest {
        kind,
        source: words[1].clone(),
        file: words.get(2).cloned(),
    }))
}

/// Split words with simple quoting and escaping. This intentionally does not
/// expand variables, globs, substitutions, or any other shell syntax.
fn tokenize(input: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut started = false;
    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            started = true;
            continue;
        }
        match (quote, character) {
            (Some('\''), '\'') => quote = None,
            (Some('"'), '"') => quote = None,
            (Some('\''), _) => current.push(character),
            (Some('"'), '\\') => escaped = true,
            (Some(_), _) => current.push(character),
            (None, '\'' | '"') => {
                quote = Some(character);
                started = true;
            }
            (None, '\\') => {
                escaped = true;
                started = true;
            }
            (None, ch) if ch.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, ch) => {
                current.push(ch);
                started = true;
            }
        }
    }
    if escaped {
        return Err("install arguments end with an incomplete escape".into());
    }
    if quote.is_some() {
        return Err("install arguments contain an unmatched quote".into());
    }
    if started {
        words.push(current);
    }
    Ok(words)
}

/// Plan an invocation of `scripts/hii-capability-install.mjs`.
///
/// `args` accepts either `{kind, source, file?}` or `{input: "/install ..."}`.
/// Paths and other values are kept as individual argv elements, never shell text.
pub fn plan(
    repo: &Path,
    runtime: &Path,
    workspace: &Path,
    args: &Value,
) -> Result<InstallPlan, String> {
    let mut request = request_from_value(args)?;
    match request.kind {
        InstallKind::Model => {
            request.source = request
                .source
                .strip_prefix("https://huggingface.co/")
                .unwrap_or(&request.source)
                .trim_end_matches('/')
                .to_string();
        }
        InstallKind::Skill => {
            let local = workspace.join(&request.source);
            if local.exists() {
                request.source = local.display().to_string();
            } else {
                request.source = request
                    .source
                    .strip_prefix("https://github.com/")
                    .unwrap_or(&request.source)
                    .trim_end_matches('/')
                    .trim_end_matches(".git")
                    .to_string();
            }
        }
        InstallKind::Tool => {}
    }
    validate_request(&request)?;
    if runtime.as_os_str().is_empty() || workspace.as_os_str().is_empty() {
        return Err("runtime and workspace paths must be non-empty".into());
    }
    let mut argv = vec![
        "--runtime".to_string(),
        runtime.to_string_lossy().into_owned(),
        "--workspace".to_string(),
        workspace.to_string_lossy().into_owned(),
    ];
    if request.kind == InstallKind::Skill {
        argv.push("--skills".into());
        argv.push(
            crate::storage::skills_root(runtime)
                .to_string_lossy()
                .into_owned(),
        );
    }
    argv.push(request.kind.as_str().to_string());
    argv.push(request.source);
    if let Some(file) = request.file {
        argv.push(file);
    }
    Ok(InstallPlan {
        program: "node".to_string(),
        args: {
            let mut with_script = vec![resource(repo, "scripts/hii-capability-install.mjs")?
                .to_string_lossy()
                .into_owned()];
            with_script.extend(argv);
            with_script
        },
        timeout_secs: 3600,
    })
}

/// Installation through the helper always starts Node with separate argv items.
pub fn explicit_install_intent(intent: &str, args: &Value) -> bool {
    let source_and_file = if let Some(input) = args.get("input").and_then(Value::as_str) {
        match parse_slash(input) {
            Ok(Some(request)) => (request.source, request.file),
            _ => return false,
        }
    } else if let Some(source) = args
        .get("source")
        .or_else(|| args.get("repo"))
        .or_else(|| args.get("formula"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|source| !source.is_empty())
    {
        let file = args
            .get("file")
            .or_else(|| args.get("subdir"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|file| !file.is_empty())
            .map(str::to_string);
        (source.to_string(), file)
    } else {
        return false;
    };
    let words = intent_words(intent);
    let verb_positions = words
        .iter()
        .enumerate()
        .filter_map(|(index, word)| {
            matches!(word.as_str(), "install" | "download").then_some(index)
        })
        .collect::<Vec<_>>();
    if verb_positions.is_empty()
        || verb_positions.iter().any(|index| {
            let start = index.saturating_sub(5);
            words[start..*index].iter().any(|word| {
                matches!(
                    word.as_str(),
                    "not"
                        | "never"
                        | "avoid"
                        | "without"
                        | "no"
                        | "cannot"
                        | "can't"
                        | "dont"
                        | "don't"
                )
            })
        })
    {
        return false;
    }
    contains_identifier_phrase(intent, &source_and_file.0)
        && source_and_file
            .1
            .as_deref()
            .map_or(true, |file| contains_identifier_phrase(intent, file))
}

fn intent_words(intent: &str) -> Vec<String> {
    intent
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric() && character != '\'')
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn contains_identifier_phrase(haystack: &str, needle: &str) -> bool {
    let haystack_lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    haystack_lower
        .match_indices(&needle_lower)
        .any(|(index, _)| {
            let before = haystack_lower[..index].chars().next_back();
            let after = haystack_lower[index + needle_lower.len()..].chars().next();
            let is_identifier = |character: char| {
                character.is_alphanumeric() || matches!(character, '_' | '-' | '.')
            };
            !before.is_some_and(is_identifier) && !after.is_some_and(is_identifier)
        })
}

/// JSON tool-argument facade for creating a workspace capability draft.
pub fn create(workspace: &Path, args: &Value) -> Result<String, String> {
    let kind = required_string(args, "kind")?;
    let name = required_string(args, "name")?;
    let content = required_string(args, "content")?;
    let description = required_string(args, "description")?;
    capability_create(workspace, kind, name, content, description).map(|directory| {
        let file = directory.join(if kind == "skill" { "SKILL.md".into() } else { format!("{name}.py") });
        json!({"kind":kind,"name":name,"path":file,"status":"draft","executed":false,
            "verification": "saved content and metadata checked; behavior not executed",
            "next":if kind == "skill" { "Skill draft saved and checked. It grants no additional authority." } else { "Use python3 to verify the generated tool when execution is requested." }}).to_string()
    })
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("create requires a string {key}"))
}

fn request_from_value(args: &Value) -> Result<InstallRequest, String> {
    if let Some(input) = args.get("input").and_then(Value::as_str) {
        return parse_slash(input)?.ok_or_else(|| "provide install arguments; see /install".into());
    }
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "install requires a kind (model, skill, or tool)".to_string())?;
    let kind = match kind {
        "model" => InstallKind::Model,
        "skill" => InstallKind::Skill,
        "tool" => InstallKind::Tool,
        _ => return Err("install kind must be model, skill, or tool".into()),
    };
    let source = args
        .get("source")
        .or_else(|| args.get("repo"))
        .or_else(|| args.get("formula"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "install requires a non-empty source".to_string())?
        .to_string();
    let file = args
        .get("file")
        .or_else(|| args.get("subdir"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    Ok(InstallRequest { kind, source, file })
}

fn validate_request(request: &InstallRequest) -> Result<(), String> {
    if request.source.trim() != request.source || request.source.is_empty() {
        return Err("install source must be non-empty and have no surrounding whitespace".into());
    }
    match request.kind {
        InstallKind::Model => {
            if !is_repo_reference(&request.source, "huggingface.co") {
                return Err("model source must be a Hugging Face owner/repo".into());
            }
            if request
                .file
                .as_deref()
                .is_some_and(|file| !safe_relative_file(file))
            {
                return Err("model filename must be a safe relative path".into());
            }
        }
        InstallKind::Skill => {
            if is_github_reference(&request.source) {
                if let Some(subdir) = &request.file {
                    if !safe_relative_file(subdir) {
                        return Err("skill subdirectory must be a safe relative path".into());
                    }
                }
            } else {
                let path = Path::new(&request.source);
                let metadata = fs::symlink_metadata(path).map_err(|error| {
                    format!(
                        "skill source path is unavailable ({}): {error}",
                        path.display()
                    )
                })?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err("local skill source must be a real directory".into());
                }
                if request
                    .file
                    .as_deref()
                    .is_some_and(|file| !safe_relative_file(file))
                {
                    return Err("skill subdirectory must be a safe relative path".into());
                }
            }
        }
        InstallKind::Tool => {
            if request.file.is_some() || !valid_formula(&request.source) {
                return Err("tool source must be one Homebrew formula name".into());
            }
        }
    }
    Ok(())
}

fn is_repo_reference(source: &str, host: &str) -> bool {
    let normalized = source
        .strip_prefix(&format!("https://{host}/"))
        .or_else(|| source.strip_prefix(&format!("http://{host}/")))
        .unwrap_or(source)
        .trim_end_matches('/')
        .trim_end_matches(".git");
    safe_owner_repo(normalized)
}

fn is_github_reference(source: &str) -> bool {
    let normalized = source
        .strip_prefix("https://github.com/")
        .or_else(|| source.strip_prefix("http://github.com/"))
        .unwrap_or(source)
        .trim_end_matches('/')
        .trim_end_matches(".git");
    safe_owner_repo(normalized)
}

fn safe_owner_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    let Some(owner) = parts.next() else {
        return false;
    };
    let Some(repo) = parts.next() else {
        return false;
    };
    parts.next().is_none() && safe_component(owner) && safe_component(repo)
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn safe_relative_file(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(
            |component| matches!(component, std::path::Component::Normal(part) if !part.is_empty()),
        )
}

fn valid_formula(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'+' | b'.' | b'_' | b'-')
        })
}

/// Create a skill or tool draft inside the current workspace.
/// New directories are created exclusively; files are created with `create_new`
/// and any partial target is removed on failure. Nothing is executed or approved.
pub fn capability_create(
    workspace: &Path,
    kind: &str,
    name: &str,
    content: &str,
    description: &str,
) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("name must start with a letter or digit and contain only letters, digits, '.', '_' or '-'".into());
    }
    if description.trim().is_empty()
        || description.len() > 2048
        || description.chars().any(char::is_control)
    {
        return Err("description must be 1 to 2048 printable characters".into());
    }
    let (category, filename, max_bytes) = match kind {
        "skill" => ("skills", "SKILL.md".to_string(), MAX_SKILL_BYTES),
        "tool" => ("tools", format!("{name}.py"), MAX_TOOL_BYTES),
        _ => return Err("creation kind must be skill or tool".into()),
    };
    if content.trim().is_empty() || content.len() > max_bytes {
        return Err(format!(
            "{kind} content must be non-empty and at most {max_bytes} bytes"
        ));
    }

    let workspace_meta = fs::symlink_metadata(workspace)
        .map_err(|error| format!("workspace is unavailable: {error}"))?;
    if !workspace_meta.is_dir() || workspace_meta.file_type().is_symlink() {
        return Err("workspace must be a real directory, not a symlink".into());
    }
    let workspace = fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    let hii = ensure_child_dir(&workspace, ".hii")?;
    let category_dir = ensure_child_dir(&hii, category)?;
    let target = category_dir.join(name);
    fs::create_dir(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("capability already exists: {}", target.display())
        } else {
            format!(
                "could not create capability directory {}: {error}",
                target.display()
            )
        }
    })?;

    let result = (|| {
        create_new_file(&target.join(&filename), content.as_bytes())?;
        let metadata = json!({
            "kind": kind,
            "name": name,
            "description": description.trim(),
        });
        create_new_file(
            &target.join("metadata.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?
            )
            .as_bytes(),
        )?;
        let provenance = json!({
            "source": "hii-capability-create",
            "review_status": "draft",
            "approved": false,
            "execution_enabled": false,
        });
        create_new_file(
            &target.join("provenance.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&provenance).map_err(|error| error.to_string())?
            )
            .as_bytes(),
        )?;
        if fs::read(target.join(&filename)).map_err(|error| error.to_string())?
            != content.as_bytes()
        {
            return Err("saved capability content did not match the request".into());
        }
        for file in ["metadata.json", "provenance.json"] {
            let data = fs::read(target.join(file)).map_err(|error| error.to_string())?;
            serde_json::from_slice::<Value>(&data).map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(target)
}

fn ensure_child_dir(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "refusing non-directory or symlink path: {}",
                    path.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&path)
                .map_err(|error| format!("could not create {}: {error}", path.display()))?;
        }
        Err(error) => return Err(format!("could not inspect {}: {error}", path.display())),
    }
    Ok(path)
}

fn create_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("could not flush {}: {error}", path.display()))
}

fn valid_name(name: &str) -> bool {
    name.len() <= 64
        && !name.is_empty()
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && name != "."
        && name != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_forms_and_json_paths_keep_expected_argument_boundaries() {
        assert_eq!(parse_slash("/install").unwrap(), None);
        assert_eq!(
            parse_slash("/install owner/repo").unwrap(),
            Some(InstallRequest {
                kind: InstallKind::Model,
                source: "owner/repo".into(),
                file: None,
            })
        );
        let quoted = parse("/install skill \"/path with spaces\" 'sub dir'")
            .unwrap()
            .unwrap();
        assert_eq!(quoted["source"], "/path with spaces");
        assert_eq!(quoted["file"], "sub dir");
        assert!(parse("/install skill \"unclosed").is_err());
        let workspace = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join("scripts")).unwrap();
        fs::write(
            repo.path().join("scripts/hii-capability-install.mjs"),
            "// fixture",
        )
        .unwrap();
        // The source directory need not be the same as the workspace; this test
        // creates it first so request validation sees a real local skill folder.
        let source = workspace.path().join("skill source");
        let nested = source.join("with spaces");
        fs::create_dir_all(&nested).unwrap();
        let plan = plan(
            repo.path(),
            Path::new("/runtime with spaces"),
            Path::new("/workspace with spaces"),
            &json!({"kind":"skill", "source":nested.to_string_lossy(), "subdir":"examples/one"}),
        )
        .unwrap();
        assert_eq!(plan.program, "node");
        assert!(plan.args[0].ends_with("scripts/hii-capability-install.mjs"));
        assert_eq!(plan.args[2], "/runtime with spaces");
        assert_eq!(plan.args[4], "/workspace with spaces");
        assert_eq!(plan.args[6], nested.to_string_lossy());
        assert_eq!(plan.args[7], "examples/one");
        assert_eq!(plan.timeout_secs, 3600);
    }

    #[test]
    fn install_validation_rejects_traversal_and_invalid_sources() {
        let repo = tempfile::tempdir().unwrap();
        assert!(plan(
            repo.path(),
            Path::new("runtime"),
            Path::new("workspace"),
            &json!({"kind":"model", "source":"owner/../../repo"})
        )
        .is_err());
        assert!(plan(
            repo.path(),
            Path::new("runtime"),
            Path::new("workspace"),
            &json!({"kind":"tool", "source":"foo;touch-pwned"})
        )
        .is_err());
        assert!(plan(
            repo.path(),
            Path::new("runtime"),
            Path::new("workspace"),
            &json!({"kind":"skill", "source":"/not/a/real/skill/path"})
        )
        .is_err());
    }

    #[test]
    fn install_intent_requires_positive_verb_and_exact_requested_capability() {
        let args = json!({"kind":"model", "source":"owner/model", "file":"weights/model.gguf"});
        assert!(explicit_install_intent(
            "Please install owner/model from weights/model.gguf",
            &args
        ));
        assert!(!explicit_install_intent(
            "Do not install owner/model",
            &args
        ));
        assert!(!explicit_install_intent(
            "I do not want you to install owner/model",
            &args
        ));
        assert!(!explicit_install_intent(
            "Please install owner/model-extra",
            &args
        ));
        assert!(!explicit_install_intent(
            "Please install owner/model",
            &args
        ));
        assert!(!explicit_install_intent("Please list owner/model", &args));
    }

    #[test]
    fn creation_rejects_symlink_ancestors_and_collisions_without_overwrite() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().join(".hii");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), &root).unwrap();
            assert!(
                capability_create(workspace.path(), "skill", "safe", "draft", "description")
                    .is_err()
            );
            assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
            fs::remove_file(&root).unwrap();
        }
        let path = capability_create(
            workspace.path(),
            "tool",
            "weather",
            "print('draft')\n",
            "weather helper",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(path.join("weather.py")).unwrap(),
            "print('draft')\n"
        );
        let metadata: Value =
            serde_json::from_slice(&fs::read(path.join("metadata.json")).unwrap()).unwrap();
        assert_eq!(metadata["description"], "weather helper");
        assert!(
            capability_create(workspace.path(), "tool", "weather", "replace", "again").is_err()
        );
        assert_eq!(
            fs::read_to_string(path.join("weather.py")).unwrap(),
            "print('draft')\n"
        );
    }

    #[test]
    fn failed_creation_leaves_no_partial_target() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(capability_create(
            workspace.path(),
            "skill",
            "../escape",
            "draft",
            "description"
        )
        .is_err());
        assert!(capability_create(
            workspace.path(),
            "skill",
            "safe",
            &"x".repeat(MAX_SKILL_BYTES + 1),
            "description"
        )
        .is_err());
        assert!(!workspace.path().join(".hii/skills/safe").exists());
    }
}
