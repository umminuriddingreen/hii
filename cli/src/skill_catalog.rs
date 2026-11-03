//! Small, lazy skill discovery. Search returns metadata; only explicit reads
//! load instructions. The cache is invalidated by file size and modification time.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

const MAX_BYTES: u64 = 64 * 1024;
type Cache = HashMap<PathBuf, (Option<SystemTime>, u64, SkillEntry)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

pub fn roots(repo: &Path, workspace: Option<&Path>, skills_home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        repo.join("skills"),
        repo.join(".hii/skills"),
        skills_home.join("installed"),
        skills_home.join("registered"),
    ];
    if let Some(workspace) = workspace {
        roots.push(workspace.join(".hii/skills"));
    }
    if let Some(home) = dirs::home_dir() {
        for relative in [
            ".pi/agent/skills",
            ".hermes/skills",
            ".codex/skills",
            ".codex/plugins/cache",
            ".claude/skills",
            ".agents/skills",
        ] {
            roots.push(home.join(relative));
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

#[derive(Clone, Debug, Serialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "sourcePath")]
    pub source_path: PathBuf,
}

fn safe_path(root: &Path, source: &Path) -> bool {
    if fs::symlink_metadata(root).map_or(true, |m| m.file_type().is_symlink()) {
        return false;
    }
    let Ok(relative) = source.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return false;
        }
        current.push(component);
        if fs::symlink_metadata(&current).map_or(true, |m| m.file_type().is_symlink()) {
            return false;
        }
    }
    match (fs::canonicalize(root), fs::canonicalize(source)) {
        (Ok(root), Ok(source)) => source.starts_with(root),
        _ => false,
    }
}

fn metadata_entry(file: &Path) -> Option<SkillEntry> {
    let metadata = fs::symlink_metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return None;
    }
    let modified = metadata.modified().ok();
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(cache) = cache.lock() {
        if let Some((time, size, entry)) = cache.get(file) {
            if *time == modified && *size == metadata.len() {
                return Some(entry.clone());
            }
        }
    }
    let mut prefix = Vec::new();
    fs::File::open(file)
        .ok()?
        .take(8192)
        .read_to_end(&mut prefix)
        .ok()?;
    let text = String::from_utf8_lossy(&prefix);
    let mut name = file.parent()?.file_name()?.to_string_lossy().into_owned();
    let mut description = String::new();
    if text.starts_with("---") {
        for line in text.lines().skip(1).take_while(|line| line.trim() != "---") {
            if let Some(value) = line.strip_prefix("name:") {
                name = value.trim().trim_matches(['\'', '"']).to_string();
            }
            if let Some(value) = line.strip_prefix("description:") {
                description = value.trim().trim_matches(['\'', '"']).to_string();
            }
        }
    }
    if description.is_empty() || matches!(description.as_str(), "|" | ">") {
        description = text
            .lines()
            .find(|line| {
                !line.trim().is_empty() && !line.starts_with(['#', '-']) && !line.contains(':')
            })
            .unwrap_or("")
            .trim()
            .to_string();
    }
    let entry = SkillEntry {
        id: format!(
            "skill:{:x}",
            Sha256::digest(file.to_string_lossy().as_bytes())
        ),
        name: name.chars().take(160).collect(),
        description: description.chars().take(500).collect(),
        source_path: file.to_path_buf(),
    };
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(
            file.to_path_buf(),
            (modified, metadata.len(), entry.clone()),
        );
    }
    Some(entry)
}

pub fn search(roots: &[PathBuf], query: &str, limit: usize) -> Vec<SkillEntry> {
    let terms: Vec<_> = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let mut found = HashMap::new();
    for root in roots {
        let mut visited = 0;
        let mut stack = vec![(root.clone(), 0)];
        while let Some((directory, depth)) = stack.pop() {
            if visited >= 4096 {
                break;
            }
            if fs::symlink_metadata(&directory).map_or(true, |m| m.file_type().is_symlink()) {
                continue;
            }
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            for item in entries {
                visited += 1;
                if visited > 4096 {
                    break;
                }
                let path = item.path();
                let Ok(kind) = item.file_type() else {
                    continue;
                };
                if kind.is_dir() && depth < 8 {
                    stack.push((path, depth + 1));
                } else if kind.is_file() && item.file_name() == "SKILL.md" && safe_path(root, &path)
                {
                    if let Some(entry) = metadata_entry(&path) {
                        let haystack =
                            format!("{} {} {}", entry.name, entry.description, path.display())
                                .to_lowercase();
                        if terms.iter().all(|term| haystack.contains(term)) {
                            let score = terms
                                .iter()
                                .filter(|term| entry.name.to_lowercase().contains(term.as_str()))
                                .count();
                            let key = fs::canonicalize(&path).unwrap_or(path);
                            found.insert(key, (score, entry));
                        }
                    }
                }
            }
        }
    }
    let mut found: Vec<_> = found.into_values().collect();
    found.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.name.cmp(&b.1.name))
            .then_with(|| a.1.source_path.cmp(&b.1.source_path))
    });
    found
        .into_iter()
        .take(limit.min(4096))
        .map(|(_, entry)| entry)
        .collect()
}

pub fn read(roots: &[PathBuf], source: &Path) -> Result<String, String> {
    if source.file_name().and_then(|s| s.to_str()) != Some("SKILL.md")
        || !roots.iter().any(|root| safe_path(root, source))
    {
        return Err("skill_read requires a SKILL.md sourcePath inside a discovered skill root; symlinks are refused".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(source).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("skill source is not a regular file".into());
    }
    let mut content = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_BYTES {
        return Err("skill source exceeds 64 KiB".into());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_is_metadata_only_and_cache_refreshes_after_edit() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("SKILL.md");
        fs::write(
            &file,
            "---\nname: Local search\ndescription: Find project files\n---\nPRIVATE_BODY",
        )
        .unwrap();
        let roots = [temp.path().to_path_buf()];
        let results = search(&roots, "project", 8);
        assert_eq!(results.len(), 1);
        assert!(!serde_json::to_string(&results)
            .unwrap()
            .contains("PRIVATE_BODY"));
        assert!(read(&roots, &results[0].source_path)
            .unwrap()
            .contains("PRIVATE_BODY"));
        fs::write(
            &file,
            "---\nname: Geometry\ndescription: Analyze mesh topology\n---\n",
        )
        .unwrap();
        assert!(search(&roots, "project", 8).is_empty());
        assert_eq!(search(&roots, "mesh", 8).len(), 1);
    }
    #[test]
    fn explicit_read_rejects_escape_and_oversized_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("SKILL.md");
        fs::write(&outside, "outside").unwrap();
        assert!(read(&[root.clone()], &outside).is_err());
        fs::write(root.join("SKILL.md"), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read(&[root.clone()], &root.join("SKILL.md")).is_err());
        assert!(search(&[root], "", 8).is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_neither_searched_nor_loaded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir(&root).unwrap();
        let outside = temp.path().join("SKILL.md");
        fs::write(&outside, "hidden").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("SKILL.md")).unwrap();
        assert!(search(&[root.clone()], "", 8).is_empty());
        assert!(read(&[root.clone()], &root.join("SKILL.md")).is_err());
    }
}
