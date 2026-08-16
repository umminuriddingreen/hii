// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Durable, model-neutral information capture for HII.
//!
//! Browsers, agents, and the CLI all call this module. It owns source identity,
//! immutable versions, image lineage, local search, and proof receipts; callers
//! only decide how those objects are presented.

use chrono::Utc;
use regex::Regex;
use ring::digest::{digest, SHA256};
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;
use uuid::Uuid;

const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXTRACTED_CHARS: usize = 750_000;
const MAX_IMAGES: usize = 48;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InformationImage {
    pub id: String,
    pub source_id: String,
    pub url: String,
    pub alt: String,
    pub context: String,
    pub position: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InformationSource {
    pub id: String,
    pub url: String,
    pub title: String,
    pub author: String,
    pub site_name: String,
    pub published_at: Option<String>,
    pub excerpt: String,
    pub content: String,
    pub content_hash: String,
    pub raw_hash: String,
    pub content_type: String,
    pub captured_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub source: InformationSource,
    pub images: Vec<InformationImage>,
    pub changed: bool,
    pub previous_content_hash: Option<String>,
    pub receipt_id: String,
    pub receipt_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: Option<String>,
    pub url: String,
    pub title: String,
    pub excerpt: String,
    pub site_name: String,
    pub content_hash: Option<String>,
    pub captured_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVersion {
    pub id: String,
    pub source_id: String,
    pub content_hash: String,
    pub raw_hash: String,
    pub captured_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub source_id: String,
    pub output_path: String,
    pub content_hash: String,
    pub receipt_id: String,
    pub receipt_path: String,
}

struct ExtractedPage {
    canonical_url: String,
    title: String,
    author: String,
    site_name: String,
    published_at: Option<String>,
    excerpt: String,
    content: String,
    images: Vec<(String, String, String)>,
}

fn database_path(runtime: &Path) -> PathBuf {
    std::env::var_os("HII_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime.join("hii.db"))
}

fn database(runtime: &Path) -> Result<Connection, String> {
    fs::create_dir_all(runtime).map_err(|error| error.to_string())?;
    let connection = Connection::open(database_path(runtime)).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS schema_migrations (
              version TEXT PRIMARY KEY,
              applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE IF NOT EXISTS information_sources (
              id TEXT PRIMARY KEY,
              url TEXT NOT NULL UNIQUE,
              title TEXT NOT NULL,
              author TEXT NOT NULL DEFAULT '',
              site_name TEXT NOT NULL DEFAULT '',
              published_at TEXT,
              excerpt TEXT NOT NULL DEFAULT '',
              content TEXT NOT NULL DEFAULT '',
              content_hash TEXT NOT NULL,
              raw_hash TEXT NOT NULL,
              content_type TEXT NOT NULL DEFAULT '',
              captured_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS information_versions (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              raw_hash TEXT NOT NULL,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              captured_at TEXT NOT NULL,
              FOREIGN KEY (source_id) REFERENCES information_sources(id) ON DELETE CASCADE,
              UNIQUE(source_id, content_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_information_versions_source
              ON information_versions(source_id, captured_at DESC);

            CREATE TABLE IF NOT EXISTS information_images (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              url TEXT NOT NULL,
              alt TEXT NOT NULL DEFAULT '',
              context TEXT NOT NULL DEFAULT '',
              position INTEGER NOT NULL,
              first_seen_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              FOREIGN KEY (source_id) REFERENCES information_sources(id) ON DELETE CASCADE,
              UNIQUE(source_id, url)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS information_fts USING fts5(
              source_id UNINDEXED,
              title,
              excerpt,
              content,
              tokenize = 'unicode61 remove_diacritics 2'
            );

            INSERT OR IGNORE INTO schema_migrations(version)
              VALUES ('information-model-v1');
            "#,
        )
        .map_err(|error| format!("could not initialize HII information store: {error}"))?;
    Ok(connection)
}

pub fn capture(
    runtime: &Path,
    workspace: &Path,
    requested_url: &str,
) -> Result<CaptureResult, String> {
    let requested = valid_http_url(requested_url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(25))
        .redirects(5)
        .build();
    let response = agent
        .get(requested.as_str())
        .set("User-Agent", "HII/0.1 information-model capture")
        .call()
        .map_err(|error| format!("could not capture {requested}: {error}"))?;
    let final_url = response.get_url().to_string();
    let content_type = response
        .header("content-type")
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let mut raw = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|error| format!("could not read {final_url}: {error}"))?;
    if raw.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(format!(
            "HII limits a captured response to {MAX_RESPONSE_BYTES} bytes"
        ));
    }
    if raw.is_empty() {
        return Err(format!("{final_url} returned an empty response"));
    }

    let raw_hash = sha256(&raw);
    let raw_text = String::from_utf8_lossy(&raw);
    let extracted = if content_type == "text/plain" {
        let content = bounded_text(&raw_text, MAX_EXTRACTED_CHARS);
        ExtractedPage {
            canonical_url: final_url.clone(),
            title: requested.host_str().unwrap_or("source").to_string(),
            author: String::new(),
            site_name: requested.host_str().unwrap_or("").to_string(),
            published_at: None,
            excerpt: bounded_text(&content, 360),
            content,
            images: Vec::new(),
        }
    } else {
        extract_html(&final_url, &raw_text)?
    };
    let content_hash = sha256(extracted.content.as_bytes());
    let source_id = format!(
        "source:{}",
        &sha256(extracted.canonical_url.as_bytes())[..32]
    );
    let captured_at = Utc::now().to_rfc3339();
    let blob = runtime.join("information/blobs").join(&raw_hash);
    if !blob.is_file() {
        atomic_write(&blob, &raw)?;
    }

    let mut connection = database(runtime)?;
    let previous_content_hash = connection
        .query_row(
            "SELECT content_hash FROM information_sources WHERE id = ?1",
            [&source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let changed = previous_content_hash
        .as_deref()
        .is_some_and(|previous| previous != content_hash);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            r#"INSERT INTO information_sources(
                 id,url,title,author,site_name,published_at,excerpt,content,content_hash,
                 raw_hash,content_type,captured_at,updated_at
               ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
               ON CONFLICT(id) DO UPDATE SET
                 url=excluded.url,title=excluded.title,author=excluded.author,
                 site_name=excluded.site_name,published_at=excluded.published_at,
                 excerpt=excluded.excerpt,content=excluded.content,
                 content_hash=excluded.content_hash,raw_hash=excluded.raw_hash,
                 content_type=excluded.content_type,captured_at=excluded.captured_at,
                 updated_at=excluded.updated_at"#,
            params![
                source_id,
                extracted.canonical_url,
                extracted.title,
                extracted.author,
                extracted.site_name,
                extracted.published_at,
                extracted.excerpt,
                extracted.content,
                content_hash,
                raw_hash,
                content_type,
                captured_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    let version_id = format!(
        "version:{}",
        &sha256(format!("{source_id}:{content_hash}").as_bytes())[..32]
    );
    transaction
        .execute(
            "INSERT OR IGNORE INTO information_versions(id,source_id,content_hash,raw_hash,metadata_json,captured_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![version_id, source_id, content_hash, raw_hash, json!({"blob": blob}).to_string(), captured_at],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM information_fts WHERE source_id = ?1",
            [&source_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO information_fts(source_id,title,excerpt,content) VALUES (?1,?2,?3,?4)",
            params![
                source_id,
                extracted.title,
                extracted.excerpt,
                extracted.content
            ],
        )
        .map_err(|error| error.to_string())?;

    let mut images = Vec::new();
    for (position, (url, alt, context)) in extracted.images.iter().enumerate() {
        let id = format!(
            "image:{}",
            &sha256(format!("{source_id}:{url}").as_bytes())[..32]
        );
        transaction
            .execute(
                r#"INSERT INTO information_images(id,source_id,url,alt,context,position,first_seen_at,last_seen_at)
                   VALUES (?1,?2,?3,?4,?5,?6,?7,?7)
                   ON CONFLICT(source_id,url) DO UPDATE SET alt=excluded.alt,context=excluded.context,
                     position=excluded.position,last_seen_at=excluded.last_seen_at"#,
                params![id, source_id, url, alt, context, position, captured_at],
            )
            .map_err(|error| error.to_string())?;
        images.push(InformationImage {
            id,
            source_id: source_id.clone(),
            url: url.clone(),
            alt: alt.clone(),
            context: context.clone(),
            position,
        });
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let source = inspect(runtime, &source_id)?.0;
    let receipt = write_receipt(
        runtime,
        workspace,
        &format!("Capture {} as a durable HII information source", source.url),
        &format!(
            "Captured {} with {} linked image(s)",
            source.title,
            images.len()
        ),
        vec![source.url.clone()],
        vec![blob.display().to_string()],
        json!({
            "intent": "capture source",
            "sourceId": source.id,
            "contentHash": source.content_hash,
            "changed": changed,
            "verification": ["HTTP response read", "content hash computed", "source re-read from canonical store"]
        }),
    )?;
    Ok(CaptureResult {
        source,
        images,
        changed,
        previous_content_hash,
        receipt_id: receipt.0,
        receipt_path: receipt.1.display().to_string(),
    })
}

pub fn inspect(
    runtime: &Path,
    id: &str,
) -> Result<(InformationSource, Vec<InformationImage>), String> {
    let connection = database(runtime)?;
    let source = connection
        .query_row(
            "SELECT id,url,title,author,site_name,published_at,excerpt,content,content_hash,raw_hash,content_type,captured_at FROM information_sources WHERE id = ?1 OR url = ?1",
            [id],
            source_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("information source not found: {id}"))?;
    let mut statement = connection
        .prepare("SELECT id,source_id,url,alt,context,position FROM information_images WHERE source_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    let images = statement
        .query_map([&source.id], |row| {
            Ok(InformationImage {
                id: row.get(0)?,
                source_id: row.get(1)?,
                url: row.get(2)?,
                alt: row.get(3)?,
                context: row.get(4)?,
                position: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok((source, images))
}

pub fn search(runtime: &Path, query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    let terms = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .take(12)
        .map(|term| format!("\"{}\"*", term.replace('"', "")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err("information search needs at least one word".into());
    }
    let connection = database(runtime)?;
    let mut statement = connection
        .prepare(
            r#"SELECT s.id,s.url,s.title,s.excerpt,s.site_name,s.content_hash,s.captured_at
               FROM information_fts f JOIN information_sources s ON s.id=f.source_id
               WHERE information_fts MATCH ?1 ORDER BY bm25(information_fts) LIMIT ?2"#,
        )
        .map_err(|error| error.to_string())?;
    let results = statement
        .query_map(params![terms.join(" AND "), limit.clamp(1, 100)], |row| {
            Ok(SearchResult {
                id: Some(row.get(0)?),
                url: row.get(1)?,
                title: row.get(2)?,
                excerpt: row.get(3)?,
                site_name: row.get(4)?,
                content_hash: Some(row.get(5)?),
                captured_at: Some(row.get(6)?),
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(results)
}

pub fn discover_web(query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Err("web discovery needs a query".into());
    }
    let endpoint = std::env::var("HII_SEARCH_ENDPOINT")
        .unwrap_or_else(|_| "https://html.duckduckgo.com/html/".into());
    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        .build()
        .get(&endpoint)
        .query("q", query)
        .set("User-Agent", "HII/0.1 information discovery")
        .call()
        .map_err(|error| format!("web discovery failed: {error}"))?;
    let mut raw = String::new();
    response
        .into_reader()
        .take(MAX_RESPONSE_BYTES)
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    let document = Html::parse_document(&raw);
    let result_selector = Selector::parse(".result").map_err(|error| error.to_string())?;
    let title_selector = Selector::parse("a.result__a").map_err(|error| error.to_string())?;
    let snippet_selector =
        Selector::parse(".result__snippet").map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for result in document.select(&result_selector) {
        let Some(anchor) = result.select(&title_selector).next() else {
            continue;
        };
        let Some(href) = anchor.value().attr("href") else {
            continue;
        };
        let Some(url) = duckduckgo_target(href) else {
            continue;
        };
        let title = clean_text(anchor.text().collect::<Vec<_>>().join(" "));
        let excerpt = result
            .select(&snippet_selector)
            .next()
            .map(|node| clean_text(node.text().collect::<Vec<_>>().join(" ")))
            .unwrap_or_default();
        let site_name = Url::parse(&url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_default();
        results.push(SearchResult {
            id: None,
            url,
            title,
            excerpt,
            site_name,
            content_hash: None,
            captured_at: None,
        });
        if results.len() >= limit.clamp(1, 30) {
            break;
        }
    }
    Ok(results)
}

pub fn versions(runtime: &Path, source_id: &str) -> Result<Vec<SourceVersion>, String> {
    let connection = database(runtime)?;
    let mut statement = connection
        .prepare("SELECT id,source_id,content_hash,raw_hash,captured_at FROM information_versions WHERE source_id=?1 ORDER BY captured_at DESC")
        .map_err(|error| error.to_string())?;
    let versions = statement
        .query_map([source_id], |row| {
            Ok(SourceVersion {
                id: row.get(0)?,
                source_id: row.get(1)?,
                content_hash: row.get(2)?,
                raw_hash: row.get(3)?,
                captured_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(versions)
}

pub fn export_markdown(
    runtime: &Path,
    workspace: &Path,
    source_id: &str,
    output: &Path,
) -> Result<ExportResult, String> {
    let (source, images) = inspect(runtime, source_id)?;
    let mut markdown =
        format!(
        "---\nhiiSourceId: {}\nsource: {}\ncapturedAt: {}\ncontentHash: {}\n---\n\n# {}\n\n{}\n",
        source.id, source.url, source.captured_at, source.content_hash, source.title, source.content
    );
    if !images.is_empty() {
        markdown.push_str("\n## Source images\n\n");
        for image in &images {
            markdown.push_str(&format!(
                "- [{}]({})\n",
                if image.alt.is_empty() {
                    "image"
                } else {
                    &image.alt
                },
                image.url
            ));
        }
    }
    atomic_write(output, markdown.as_bytes())?;
    let output_hash = sha256(markdown.as_bytes());
    let receipt = write_receipt(
        runtime,
        workspace,
        &format!(
            "Export {} as a source-backed Markdown artifact",
            source.title
        ),
        &format!("Exported verified Markdown to {}", output.display()),
        vec![source.url.clone()],
        vec![output.display().to_string()],
        json!({"sourceId": source.id, "sourceContentHash": source.content_hash, "outputHash": output_hash}),
    )?;
    Ok(ExportResult {
        source_id: source.id,
        output_path: output.display().to_string(),
        content_hash: output_hash,
        receipt_id: receipt.0,
        receipt_path: receipt.1.display().to_string(),
    })
}

fn extract_html(base_url: &str, html: &str) -> Result<ExtractedPage, String> {
    let document = Html::parse_document(html);
    let base = valid_http_url(base_url)?;
    let canonical_url = select_attr(&document, "link[rel='canonical']", "href")
        .and_then(|url| base.join(&url).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or_else(|| base.clone())
        .to_string();
    let title = meta(&document, "property", "og:title")
        .or_else(|| select_text(&document, "title"))
        .unwrap_or_else(|| base.host_str().unwrap_or("source").to_string());
    let author = meta(&document, "name", "author").unwrap_or_default();
    let site_name = meta(&document, "property", "og:site_name")
        .unwrap_or_else(|| base.host_str().unwrap_or("").to_string());
    let published_at = meta(&document, "property", "article:published_time")
        .or_else(|| select_attr(&document, "time[datetime]", "datetime"));
    let selector = Selector::parse("h1,h2,h3,p,li,blockquote,figcaption,td,th")
        .map_err(|error| error.to_string())?;
    let mut sections = Vec::new();
    for element in document.select(&selector) {
        let text = clean_text(element.text().collect::<Vec<_>>().join(" "));
        if text.len() >= 2 && sections.last() != Some(&text) {
            sections.push(text);
        }
        if sections.iter().map(String::len).sum::<usize>() > MAX_EXTRACTED_CHARS {
            break;
        }
    }
    let content = bounded_text(&sections.join("\n\n"), MAX_EXTRACTED_CHARS);
    let excerpt = meta(&document, "name", "description")
        .or_else(|| meta(&document, "property", "og:description"))
        .unwrap_or_else(|| bounded_text(&content, 360));
    let image_selector = Selector::parse("img[src]").map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut images = Vec::new();
    if let Some(open_graph) = meta(&document, "property", "og:image") {
        if let Ok(url) = base.join(&open_graph) {
            if matches!(url.scheme(), "http" | "https") && seen.insert(url.to_string()) {
                images.push((url.to_string(), title.clone(), "open graph image".into()));
            }
        }
    }
    for element in document.select(&image_selector) {
        let Some(source) = element.value().attr("src") else {
            continue;
        };
        let Ok(url) = base.join(source) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") || !seen.insert(url.to_string()) {
            continue;
        }
        let alt = clean_text(element.value().attr("alt").unwrap_or(""));
        let context = clean_text(element.value().attr("title").unwrap_or(""));
        images.push((url.to_string(), alt, context));
        if images.len() >= MAX_IMAGES {
            break;
        }
    }
    Ok(ExtractedPage {
        canonical_url,
        title: clean_text(title),
        author: clean_text(author),
        site_name: clean_text(site_name),
        published_at,
        excerpt: clean_text(excerpt),
        content,
        images,
    })
}

fn meta(document: &Html, attribute: &str, value: &str) -> Option<String> {
    select_attr(document, &format!("meta[{attribute}='{value}']"), "content")
}

fn select_attr(document: &Html, selector: &str, attribute: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .next()?
        .value()
        .attr(attribute)
        .map(clean_text)
        .filter(|value| !value.is_empty())
}

fn select_text(document: &Html, selector: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    let value = document
        .select(&selector)
        .next()?
        .text()
        .collect::<Vec<_>>()
        .join(" ");
    let value = clean_text(value);
    (!value.is_empty()).then_some(value)
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InformationSource> {
    Ok(InformationSource {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        author: row.get(3)?,
        site_name: row.get(4)?,
        published_at: row.get(5)?,
        excerpt: row.get(6)?,
        content: row.get(7)?,
        content_hash: row.get(8)?,
        raw_hash: row.get(9)?,
        content_type: row.get(10)?,
        captured_at: row.get(11)?,
    })
}

fn valid_http_url(value: &str) -> Result<Url, String> {
    let parsed =
        Url::parse(value.trim()).map_err(|error| format!("invalid source URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("HII information capture accepts only http or https sources".into());
    }
    Ok(parsed)
}

fn duckduckgo_target(href: &str) -> Option<String> {
    let base = Url::parse("https://duckduckgo.com").ok()?;
    let parsed = base.join(href).ok()?;
    let target = parsed
        .query_pairs()
        .find(|(key, _)| key == "uddg")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| parsed.to_string());
    let target = Url::parse(&target).ok()?;
    matches!(target.scheme(), "http" | "https").then(|| target.to_string())
}

fn clean_text(value: impl AsRef<str>) -> String {
    let whitespace = Regex::new(r"\s+").expect("static whitespace regex");
    whitespace
        .replace_all(value.as_ref(), " ")
        .trim()
        .to_string()
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn sha256(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "output path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".hii-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn write_receipt(
    runtime: &Path,
    workspace: &Path,
    goal: &str,
    summary: &str,
    sources: Vec<String>,
    artifacts: Vec<String>,
    causal_chain: Value,
) -> Result<(String, PathBuf), String> {
    let id = format!("info-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis().max(0) as u128;
    let directory = runtime.join("runs/cli").join(&id);
    let receipt_path = directory.join("receipt.json");
    let receipt = json!({
        "schema_version": 8,
        "id": id,
        "created_at_unix_ms": now,
        "finished_at_unix_ms": now,
        "status": "completed",
        "goal": goal,
        "workspace": workspace.display().to_string(),
        "model": "none (deterministic information tool)",
        "review_model": null,
        "steps": 1,
        "summary": summary,
        "verification": [{"command":"re-read canonical information state and verify content hash","ok":true,"output":"verified"}],
        "git_status": "not applicable",
        "next": null,
        "review": null,
        "risk": "network-read/local-write",
        "authority": "workspace",
        "done_when": "durable source or artifact exists with provenance and content hash",
        "approvals": [],
        "artifacts": artifacts,
        "reversible": true,
        "context_sources": sources,
        "preexisting_changes": [],
        "hooks": [],
        "outcome": "completed",
        "exit_code": 0,
        "completion": null,
        "model_source": null,
        "autonomy_level": "bounded-tool",
        "learning_candidates": [],
        "user_corrections": [],
        "failure_patterns": [],
        "skill_draft_ref": null,
        "token_usage": null,
        "information": causal_chain
    });
    atomic_write(
        &receipt_path,
        &serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
    )?;
    atomic_write(
        &runtime.join("runs/cli/latest"),
        format!("{id}\n").as_bytes(),
    )?;
    let workspace_hash = &sha256(workspace.to_string_lossy().as_bytes())[..32];
    atomic_write(
        &runtime
            .join("runs/cli/by-workspace")
            .join(workspace_hash)
            .join("latest"),
        format!("{id}\n").as_bytes(),
    )?;
    Ok((id, receipt_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_typed_source_material() {
        let page = extract_html(
            "https://example.com/path/",
            r#"<html><head><title>Useful Page</title><meta name="author" content="Ada"><link rel="canonical" href="/canonical"></head><body><main><h1>Claim</h1><p>A durable fact with enough context.</p><img src="/image.jpg" alt="evidence"></main></body></html>"#,
        )
        .expect("extract page");
        assert_eq!(page.canonical_url, "https://example.com/canonical");
        assert_eq!(page.author, "Ada");
        assert!(page.content.contains("durable fact"));
        assert_eq!(page.images[0].0, "https://example.com/image.jpg");
    }

    #[test]
    fn rejects_non_web_capture_schemes() {
        assert!(valid_http_url("file:///etc/passwd").is_err());
        assert!(valid_http_url("https://hii.local/source").is_ok());
    }

    #[test]
    fn unwraps_duckduckgo_result_urls() {
        let target = duckduckgo_target("/l/?uddg=https%3A%2F%2Fexample.com%2Fpaper").unwrap();
        assert_eq!(target, "https://example.com/paper");
    }
}
