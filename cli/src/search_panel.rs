use std::path::Path;

use url::Url;

use crate::{
    picker::{self, Choice},
    text,
    tools::{Toolbelt, WebSearchResult},
};

pub fn search(workspace: &Path, query: &str) -> Result<String, String> {
    let results = Toolbelt::new(workspace.to_path_buf())?.web_search_results(query)?;
    if !picker::is_available() {
        return Ok(render_results(query, &results));
    }

    let choices = choices(&results);
    let Some(selected) = picker::select(&format!("Search · {query}"), &choices)? else {
        return Ok(format!("Search closed · {} results", results.len()));
    };
    let result = results
        .iter()
        .find(|result| result_label(result) == selected)
        .ok_or_else(|| "selected search result disappeared".to_string())?;
    Ok(format!(
        "{}\n{}\n{}",
        result.title, result.url, result.snippet
    ))
}

fn choices(results: &[WebSearchResult]) -> Vec<Choice> {
    results
        .iter()
        .map(|result| Choice::new(result_label(result), text::clip(&result.snippet, 72)))
        .collect()
}

fn result_label(result: &WebSearchResult) -> String {
    let source = Url::parse(&result.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "source".into());
    text::clip(&format!("{}  ·  {source}", result.title), 96)
}

fn render_results(query: &str, results: &[WebSearchResult]) -> String {
    let mut lines = vec![format!("SEARCH · {query}")];
    for (index, result) in results.iter().enumerate() {
        lines.push(format!("{}. {}", index + 1, result.title));
        lines.push(format!("   {}", result.url));
        if !result.snippet.is_empty() {
            lines.push(format!("   {}", result.snippet));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn results() -> Vec<WebSearchResult> {
        vec![WebSearchResult {
            title: "HII source".into(),
            url: "https://example.com/hii".into(),
            snippet: "A source-backed result for the search panel.".into(),
        }]
    }

    #[test]
    fn choices_preserve_urls_and_show_source_context() {
        let choices = choices(&results());
        assert!(choices[0].value.contains("HII source"));
        assert!(choices[0].value.contains("example.com"));
        assert!(choices[0].detail.contains("source-backed result"));
    }

    #[test]
    fn line_mode_results_keep_titles_urls_and_snippets() {
        let rendered = render_results("human interface", &results());
        assert!(rendered.contains("SEARCH · human interface"));
        assert!(rendered.contains("HII source"));
        assert!(rendered.contains("https://example.com/hii"));
        assert!(rendered.contains("source-backed result"));
    }
}
