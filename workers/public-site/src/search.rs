use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Env, Fetch, Headers, Request, RequestInit, Response, Result, Url};

#[derive(Deserialize)]
struct BraveResponse {
    web: Option<BraveWeb>,
}

#[derive(Deserialize)]
struct BraveWeb {
    results: Option<Vec<BraveResult>>,
}

#[derive(Deserialize)]
struct BraveResult {
    title: Option<String>,
    url: Option<String>,
    description: Option<String>,
}

pub async fn handle_search(request: &Request, env: &Env) -> Result<Response> {
    let query = request
        .url()?
        .query_pairs()
        .find_map(|(key, value)| {
            (key == "q").then(|| value.trim().chars().take(300).collect::<String>())
        })
        .filter(|value| !value.is_empty());
    let Some(query) = query else {
        return json_response(400, json!({ "error": "q required" }));
    };
    let Ok(secret) = env.secret("BRAVE_SEARCH_API_KEY") else {
        return json_response(503, json!({ "error": "Web search is not configured." }));
    };

    let mut upstream_url = Url::parse("https://api.search.brave.com/res/v1/web/search")?;
    upstream_url
        .query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("count", "8");
    let headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("x-subscription-token", secret.to_string().as_str())?;
    let mut init = RequestInit::new();
    init.with_headers(headers);
    let upstream_request = Request::new_with_init(upstream_url.as_str(), &init)?;
    let mut upstream = Fetch::Request(upstream_request).send().await?;
    if !(200..300).contains(&upstream.status_code()) {
        return json_response(
            502,
            json!({ "error": format!("Search failed ({}).", upstream.status_code()) }),
        );
    }
    let data: BraveResponse = upstream.json().await?;
    let results = data
        .web
        .and_then(|web| web.results)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|result| {
            let title = result.title?.trim().to_owned();
            let url = result.url?;
            let parsed = Url::parse(&url).ok()?;
            if title.is_empty() || !matches!(parsed.scheme(), "http" | "https") {
                return None;
            }
            Some(json!({
                "title": title,
                "url": url,
                "description": strip_tags(result.description.as_deref().unwrap_or("")),
            }))
        })
        .collect::<Vec<_>>();
    json_response(200, json!({ "results": results }))
}

fn strip_tags(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut inside = false;
    for character in value.chars() {
        match character {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => output.push(character),
            _ => {}
        }
    }
    output
}

fn json_response(status: u16, value: Value) -> Result<Response> {
    Ok(Response::from_json(&value)?.with_status(status))
}

#[cfg(test)]
mod tests {
    use super::strip_tags;

    #[test]
    fn removes_markup_from_search_descriptions() {
        assert_eq!(
            strip_tags("A <strong>local</strong> result"),
            "A local result"
        );
    }
}
