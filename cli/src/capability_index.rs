//! Unified capability discovery across every local registry HII owns.
//!
//! HII grew three disjoint registries: registered skills (`~/.hii/skills/*.json`,
//! read until now only by the Node adapter), declared capabilities
//! (`~/.hii/capabilities.json`), and skill drafts awaiting promotion
//! (`~/.hii/skills/proposed/*/manifest.json`). An agent had no way to ask "what
//! can HII already do about X" without loading all of them into context.
//!
//! This module folds them into one ranked, source-tagged answer so an agent can
//! ask `hii find "inspect a pull request"` and get back the few entries that
//! matter instead of the whole surface.

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path};

use crate::config::AppPaths;

const DEFAULT_LIMIT: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Which registry this came from: `skill`, `capability`, or `draft`.
    pub source: &'static str,
    pub category: String,
    pub tags: Vec<String>,
    /// How to actually invoke it, when the registry records that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invoke: Option<String>,
    /// `ready`, `draft`, or whatever the source registry declares.
    pub status: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Match {
    pub score: u32,
    #[serde(flatten)]
    pub entry: Entry,
}

/// Load every registry. Missing or malformed registries are skipped rather than
/// failing the search — a broken capabilities.json must not hide the 131 skills.
pub fn load_all(paths: &AppPaths) -> Vec<Entry> {
    let runtime = &paths.runtime;
    let mut entries = Vec::new();
    entries.extend(load_skills(&runtime.join("skills")));
    entries.extend(load_capabilities(&runtime.join("capabilities.json")));
    entries.extend(load_drafts(&runtime.join("skills/proposed")));
    apply_lifecycle(paths, &mut entries);
    entries
}

/// Fold the skill lifecycle over the raw registries.
///
/// The lifecycle is the authority on standing, so it does two things here: it
/// stamps each entry with the state its evidence supports, and it drops
/// rejected skills entirely — a skill a human rejected must stop being offered
/// as an answer. Skills that reached `verified` or `trusted` without a registry
/// file are added, so promotion alone is enough to make a skill findable.
fn apply_lifecycle(paths: &AppPaths, entries: &mut Vec<Entry>) {
    let lifecycle = crate::skill_lifecycle::load(paths);
    if lifecycle.skills.is_empty() {
        return;
    }
    entries.retain(|entry| {
        lifecycle
            .skills
            .get(&entry.id)
            .map(|record| record.state != crate::skill_lifecycle::SkillState::Rejected)
            .unwrap_or(true)
    });
    for entry in entries.iter_mut() {
        if let Some(record) = lifecycle.skills.get(&entry.id) {
            entry.status = record.state.label().to_string();
        }
    }
    for record in crate::skill_lifecycle::promoted(&lifecycle) {
        if entries.iter().any(|entry| entry.id == record.id) {
            continue;
        }
        entries.push(Entry {
            id: record.id.clone(),
            name: record.name.clone(),
            description: record.description.clone(),
            source: "skill",
            category: "lifecycle".into(),
            tags: Vec::new(),
            invoke: Some(format!("hii skill run {}", record.id)),
            status: record.state.label().to_string(),
            examples: Vec::new(),
        });
    }
}

fn load_skills(dir: &Path) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for file in read.flatten() {
        let path = file.path();
        // `_index.json` is a derived summary of the very files beside it, and
        // `actions.jsonl` is a log; indexing either would double-count.
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('_') {
            continue;
        }
        let Some(value) = read_json(&path) else {
            continue;
        };
        let Some(id) = str_field(&value, "id") else {
            continue;
        };
        entries.push(Entry {
            name: str_field(&value, "name").unwrap_or_else(|| id.clone()),
            description: str_field(&value, "description").unwrap_or_default(),
            source: "skill",
            category: str_field(&value, "category").unwrap_or_default(),
            tags: str_array(&value, "tags"),
            invoke: Some(format!("hii skill run {id}")),
            status: "ready".into(),
            examples: str_array(&value, "examples"),
            id,
        });
    }
    entries
}

fn load_capabilities(path: &Path) -> Vec<Entry> {
    let Some(Value::Array(items)) = read_json(path) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|value| {
            let id = str_field(&value, "id")?;
            Some(Entry {
                name: str_field(&value, "name").unwrap_or_else(|| id.clone()),
                description: str_field(&value, "summary")
                    .or_else(|| str_field(&value, "description"))
                    .unwrap_or_default(),
                source: "capability",
                category: str_field(&value, "owner").unwrap_or_default(),
                tags: str_array(&value, "permissions"),
                invoke: str_field(&value, "runtime"),
                status: str_field(&value, "status").unwrap_or_else(|| "declared".into()),
                examples: str_array(&value, "evidence"),
                id,
            })
        })
        .collect()
}

fn load_drafts(dir: &Path) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for file in read.flatten() {
        let manifest = file.path().join("manifest.json");
        let Some(value) = read_json(&manifest) else {
            continue;
        };
        let fallback = file.file_name().to_string_lossy().to_string();
        let id = str_field(&value, "id").unwrap_or(fallback);
        let observations = value
            .get("observations")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        entries.push(Entry {
            name: str_field(&value, "name").unwrap_or_else(|| id.clone()),
            description: str_field(&value, "description").unwrap_or_default(),
            source: "draft",
            category: "proposed".into(),
            tags: Vec::new(),
            invoke: None,
            status: format!("draft · {observations} proof(s)"),
            examples: Vec::new(),
            id,
        });
    }
    entries
}

/// Words that carry no capability meaning. Queries arrive as natural language
/// ("read my messages"), and without this an entry is judged on whether it
/// happens to contain "my".
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "as", "at", "be", "can", "do", "for", "from", "get", "how",
    "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "then", "these",
    "this", "to", "up", "want", "was", "what", "when", "which", "with", "you", "your",
];

fn tokenize(query: &str) -> Vec<String> {
    let terms: Vec<String> = query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '-' && ch != '_' && ch != '.')
        .map(|term| term.trim().to_ascii_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    let meaningful: Vec<String> = terms
        .iter()
        .filter(|term| !STOPWORDS.contains(&term.as_str()))
        .cloned()
        .collect();
    // A query made entirely of stopwords still deserves a literal attempt
    // rather than silently matching everything.
    if meaningful.is_empty() {
        terms
    } else {
        meaningful
    }
}

/// Rank entries against a free-text query.
///
/// Weighting reflects how much each field says about *what a capability does*:
/// an exact id match is decisive, a name match is strong, tags and description
/// are supporting evidence. Entries need not match every term — natural
/// language carries filler — but breadth of coverage dominates the ranking, so
/// something matching "pull" and "request" always outranks one matching only
/// "pull".
pub fn search(entries: &[Entry], query: &str, limit: usize) -> Vec<Match> {
    let terms = tokenize(query);
    if terms.is_empty() {
        return Vec::new();
    }

    let mut matches: Vec<Match> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.id.to_ascii_lowercase();
            let name = entry.name.to_ascii_lowercase();
            let description = entry.description.to_ascii_lowercase();
            let category = entry.category.to_ascii_lowercase();
            let tags = entry.tags.join(" ").to_ascii_lowercase();

            let mut score = 0u32;
            let mut matched_terms = 0u32;
            for term in &terms {
                let mut term_score = 0u32;
                if id == *term {
                    term_score += 100;
                } else if id.contains(term.as_str()) {
                    term_score += 40;
                }
                if name.contains(term.as_str()) {
                    term_score += 30;
                }
                if tags.contains(term.as_str()) {
                    term_score += 20;
                }
                if category.contains(term.as_str()) {
                    term_score += 10;
                }
                if description.contains(term.as_str()) {
                    term_score += 8;
                }
                if term_score > 0 {
                    matched_terms += 1;
                    score += term_score;
                }
            }
            // Nothing matched at all: not a result, just noise.
            if matched_terms == 0 {
                return None;
            }
            // Coverage dominates field weighting. Matching two of the query's
            // words anywhere beats matching one word very well, which is what
            // makes multi-word intent queries behave sensibly.
            score += matched_terms * 200;
            // Prefer things that are actually runnable today over declarations.
            if entry.source == "skill" {
                score += 5;
            }
            Some(Match {
                score,
                entry: entry.clone(),
            })
        })
        .collect();

    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.entry.id.cmp(&b.entry.id))
    });
    matches.truncate(limit);
    matches
}

pub fn find(paths: &AppPaths, query: &str, limit: Option<usize>, json: bool) -> Result<(), String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("find requires a query, e.g. hii find \"inspect a pull request\"".into());
    }
    let entries = load_all(paths);
    if entries.is_empty() {
        return Err(format!(
            "no capability registries found under {}",
            paths.runtime.display()
        ));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).max(1);
    let matches = search(&entries, query, limit);

    if json {
        let payload = serde_json::json!({
            "query": query,
            "indexed": entries.len(),
            "matches": matches,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    if matches.is_empty() {
        println!(
            "No local capability matched `{query}` across {} indexed entries.\nTry `hii discover web \"{query}\"` to look outside HII.",
            entries.len()
        );
        return Ok(());
    }

    for hit in &matches {
        let entry = &hit.entry;
        println!("{}  [{}] {}", entry.id, entry.source, entry.status);
        if !entry.description.is_empty() {
            println!("  {}", truncate(&entry.description, 240));
        }
        if let Some(invoke) = &entry.invoke {
            println!("  → {invoke}");
        }
        println!();
    }
    println!(
        "{} of {} indexed entries matched.",
        matches.len(),
        entries.len()
    );
    Ok(())
}

/// Print the whole index grouped by source, for auditing what HII actually owns.
pub fn summary(paths: &AppPaths, json: bool) -> Result<(), String> {
    let entries = load_all(paths);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&entries).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    let mut skills = 0;
    let mut capabilities = 0;
    let mut drafts = 0;
    for entry in &entries {
        match entry.source {
            "skill" => skills += 1,
            "capability" => capabilities += 1,
            _ => drafts += 1,
        }
    }
    println!("HII capability index — {} entries", entries.len());
    println!("  {skills} registered skill(s)");
    println!("  {capabilities} declared capability/ies");
    println!("  {drafts} skill draft(s) awaiting promotion");
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|found| !found.is_empty())
}

fn str_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let head: String = value.chars().take(max).collect();
    format!("{}…", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, name: &str, description: &str, tags: &[&str]) -> Entry {
        Entry {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            source: "skill",
            category: "test".into(),
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            invoke: None,
            status: "ready".into(),
            examples: Vec::new(),
        }
    }

    #[test]
    fn ranks_id_match_above_description_match() {
        let entries = vec![
            entry("daemon-status", "Daemon Status", "check things", &[]),
            entry(
                "unrelated",
                "Unrelated",
                "reports daemon-status somewhere",
                &[],
            ),
        ];
        let matches = search(&entries, "daemon-status", 10);
        assert_eq!(matches[0].entry.id, "daemon-status");
    }

    #[test]
    fn ignores_stopwords_so_natural_queries_match() {
        let entries = vec![entry(
            "apple-context",
            "Apple Context",
            "reads Messages and Notes",
            &["apple"],
        )];
        // "my" is filler and must not disqualify an otherwise good match.
        assert_eq!(search(&entries, "read my messages", 10).len(), 1);
    }

    #[test]
    fn broader_coverage_outranks_a_single_strong_field() {
        let entries = vec![
            entry("pull", "Pull", "pull something", &[]),
            entry("gh-review", "PR Review", "inspect a pull request diff", &[]),
        ];
        let matches = search(&entries, "pull request", 10);
        assert_eq!(matches[0].entry.id, "gh-review");
    }

    #[test]
    fn wholly_unrelated_queries_match_nothing() {
        let entries = vec![entry(
            "apple-context",
            "Apple Context",
            "reads Messages",
            &["apple"],
        )];
        assert!(search(&entries, "kubernetes", 10).is_empty());
    }

    #[test]
    fn matches_on_tags() {
        let entries = vec![entry(
            "apple-context",
            "Reader",
            "compact records",
            &["imessage"],
        )];
        assert_eq!(search(&entries, "imessage", 10).len(), 1);
    }

    #[test]
    fn empty_query_matches_nothing() {
        let entries = vec![entry("a", "A", "b", &[])];
        assert!(search(&entries, "   ", 10).is_empty());
    }

    #[test]
    fn respects_limit() {
        let entries = vec![
            entry("skill-one", "One", "shared word", &[]),
            entry("skill-two", "Two", "shared word", &[]),
            entry("skill-three", "Three", "shared word", &[]),
        ];
        assert_eq!(search(&entries, "shared", 2).len(), 2);
    }
}
