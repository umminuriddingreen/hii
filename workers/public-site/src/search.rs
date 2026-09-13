use serde_json::{Value, json};
use worker::{Request, Response, Result};

pub async fn handle_search(request: &Request) -> Result<Response> {
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
    json_response(
        410,
        json!({
            "error": "local_search_required",
            "query": query,
            "message": "Search in HII uses the local search service on a connected computer."
        }),
    )
}

fn json_response(status: u16, value: Value) -> Result<Response> {
    Ok(Response::from_json(&value)?.with_status(status))
}
