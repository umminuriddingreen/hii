use serde::Deserialize;
use std::{fs, path::Path, process::Command, time::Duration};
use url::Url;

const DEFAULT_MIN_STARS: u64 = 250;
const MAX_RESULTS: usize = 10;

pub fn default_min_stars() -> u64 {
    DEFAULT_MIN_STARS
}

pub fn search_github(query: &str, min_stars: u64, limit: usize) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("github discovery query cannot be empty".into());
    }
    let limit = limit.clamp(1, MAX_RESULTS);
    let url = format!(
        "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page={limit}",
        percent_encode(&format!("{query} stars:>={min_stars}"))
    );
    let response: GithubSearchResponse = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "HII/0.1 (+capability discovery)")
        .call()
        .map_err(|error| format!("github search failed: {error}"))?
        .into_json()
        .map_err(|error| format!("github search response was not JSON: {error}"))?;

    let mut rows = Vec::new();
    for item in response
        .items
        .into_iter()
        .filter(|item| item.stargazers_count >= min_stars)
    {
        rows.push(format!(
            "{}  ★{}  forks:{}  lang:{}  updated:{}\n  {}\n  {}",
            item.full_name,
            item.stargazers_count,
            item.forks_count,
            item.language.unwrap_or_else(|| "unknown".into()),
            item.updated_at,
            item.html_url,
            item.description.unwrap_or_default()
        ));
    }
    if rows.is_empty() {
        return Ok(format!(
            "No GitHub repositories matched `{query}` above the safe star floor ({min_stars})."
        ));
    }
    Ok(rows.join("\n\n"))
}

pub fn search_x(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("x discovery query cannot be empty".into());
    }
    search_public_web(
        &format!("(site:x.com OR site:twitter.com) {query}"),
        Some(&["x.com", "twitter.com"]),
    )
}

pub fn search_web(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("web discovery query cannot be empty".into());
    }
    search_public_web(query, None)
}

pub fn install_github(
    repo_root: &Path,
    repo: &str,
    min_stars: u64,
    name: Option<&str>,
) -> Result<String, String> {
    let repo = normalize_github_repo(repo)?;
    let metadata = github_repo(&repo)?;
    if metadata.stargazers_count < min_stars {
        return Err(format!(
            "{} has {} stars, below the safe star floor of {min_stars}. Lower --min-stars only after operator review.",
            metadata.full_name, metadata.stargazers_count
        ));
    }
    let external = repo_root.join("external");
    fs::create_dir_all(&external).map_err(|error| error.to_string())?;
    let target_name = name
        .map(safe_dir_name)
        .unwrap_or_else(|| safe_dir_name(repo.rsplit('/').next().unwrap_or(&repo)));
    let target = external.join(target_name);
    if target.exists() {
        return Err(format!("target already exists: {}", target.display()));
    }
    let status = Command::new("git")
        .args(["clone", "--"])
        .arg(&metadata.clone_url)
        .arg(&target)
        .status()
        .map_err(|error| format!("failed to run git clone: {error}"))?;
    if !status.success() {
        return Err(format!("git clone failed with status {status}"));
    }
    let commit = Command::new("git")
        .args(["-C"])
        .arg(&target)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|error| format!("failed to read cloned commit: {error}"))?;
    let commit = String::from_utf8_lossy(&commit.stdout).trim().to_string();
    Ok(format!(
        "installed capability source\nrepo: {}\nstars: {}\nurl: {}\npath: {}\ncommit: {}",
        metadata.full_name,
        metadata.stargazers_count,
        metadata.html_url,
        target.display(),
        commit
    ))
}

fn github_repo(repo: &str) -> Result<GithubRepo, String> {
    let url = format!("https://api.github.com/repos/{repo}");
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "HII/0.1 (+capability discovery)")
        .call()
        .map_err(|error| format!("github repo lookup failed: {error}"))?
        .into_json()
        .map_err(|error| format!("github repo lookup response was not JSON: {error}"))
}

fn normalize_github_repo(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches(".git");
    let repo = value
        .strip_prefix("https://github.com/")
        .or_else(|| value.strip_prefix("http://github.com/"))
        .unwrap_or(value)
        .trim_matches('/');
    let mut parts = repo.split('/').filter(|part| !part.is_empty());
    let owner = parts
        .next()
        .ok_or_else(|| "repo must be owner/name".to_string())?;
    let name = parts
        .next()
        .ok_or_else(|| "repo must be owner/name".to_string())?;
    if parts.next().is_some() || !safe_repo_part(owner) || !safe_repo_part(name) {
        return Err("repo must be a GitHub owner/name or github.com/owner/name URL".into());
    }
    Ok(format!("{owner}/{name}"))
}

fn safe_repo_part(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn safe_dir_name(value: &str) -> String {
    let candidate = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if candidate.is_empty() || candidate == "." || candidate == ".." {
        "capability-source".into()
    } else {
        candidate
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".into(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn search_public_web(query: &str, allowed_domains: Option<&[&str]>) -> Result<String, String> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        percent_encode(query)
    );
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .redirects(0)
        .build()
        .get(&url)
        .set("User-Agent", "HII/0.1 (+capability discovery)")
        .call()
        .map_err(|error| format!("public web search failed: {error}"))?;
    let html = response
        .into_string()
        .map_err(|error| format!("public web search response was not readable: {error}"))?;
    let mut results = parse_web_results(&html, MAX_RESULTS * 2);
    if let Some(allowed_domains) = allowed_domains {
        results.retain(|(_, url, _)| {
            Url::parse(url)
                .ok()
                .and_then(|url| url.domain().map(str::to_string))
                .is_some_and(|domain| allowed_domains.iter().any(|allowed| domain == *allowed))
        });
        results.truncate(MAX_RESULTS);
    }
    if results.is_empty() {
        return Ok(format!("No public web results found for `{query}`."));
    }
    Ok(results
        .into_iter()
        .enumerate()
        .map(|(index, (title, url, snippet))| {
            format!("{}. {}\n   {}\n   {}", index + 1, title, url, snippet)
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

fn parse_web_results(html: &str, limit: usize) -> Vec<(String, String, String)> {
    let anchor = regex::Regex::new(
        r#"(?s)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#,
    )
    .expect("valid result regex");
    let snippet = regex::Regex::new(
        r#"(?s)<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|div)>"#,
    )
    .expect("valid snippet regex");
    let mut snippets = snippet
        .captures_iter(html)
        .filter_map(|capture| capture.get(1))
        .map(|value| clean_html(value.as_str()));
    anchor
        .captures_iter(html)
        .take(limit)
        .filter_map(|capture| {
            let url = extract_duckduckgo_target(&clean_html(capture.get(1)?.as_str()));
            let title = clean_html(capture.get(2)?.as_str());
            let summary = snippets.next().unwrap_or_default();
            Some((title, url, summary))
        })
        .collect()
}

fn extract_duckduckgo_target(value: &str) -> String {
    let absolute = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    };
    Url::parse(&absolute)
        .ok()
        .and_then(|url| {
            (url.domain() == Some("duckduckgo.com")).then(|| {
                url.query_pairs()
                    .find_map(|(key, value)| (key == "uddg").then(|| value.into_owned()))
            })?
        })
        .unwrap_or_else(|| value.to_string())
}

fn clean_html(value: &str) -> String {
    let tags = regex::Regex::new(r"(?s)<[^>]+>").expect("valid tag regex");
    tags.replace_all(value, " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Deserialize)]
struct GithubSearchResponse {
    items: Vec<GithubRepo>,
}

#[derive(Debug, Deserialize)]
struct GithubRepo {
    full_name: String,
    html_url: String,
    clone_url: String,
    description: Option<String>,
    stargazers_count: u64,
    forks_count: u64,
    language: Option<String>,
    updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_github_repo_forms() {
        assert_eq!(
            normalize_github_repo("https://github.com/owner/name.git").unwrap(),
            "owner/name"
        );
        assert_eq!(normalize_github_repo("owner/name").unwrap(), "owner/name");
    }

    #[test]
    fn rejects_unsafe_github_repo_forms() {
        assert!(normalize_github_repo("owner/name/extra").is_err());
        assert!(normalize_github_repo("owner/name;rm").is_err());
        assert!(normalize_github_repo("not-enough").is_err());
    }

    #[test]
    fn safe_dir_name_removes_path_characters() {
        assert_eq!(safe_dir_name("../hello world"), "..-hello-world");
        assert_eq!(safe_dir_name(".."), "capability-source");
    }

    #[test]
    fn parses_duckduckgo_results() {
        let html = r#"
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftool">Example <b>Result</b></a>
        <a class="result__snippet">Useful &amp; compact</a>
        "#;
        assert_eq!(
            parse_web_results(html, 1),
            vec![(
                "Example Result".into(),
                "https://example.com/tool".into(),
                "Useful & compact".into()
            )]
        );
    }
}
