use crate::{SessionRow, api_error, json_response, now_ms, random_token};
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{D1Database, Fetch, Method, Request, Response, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewRecord {
    kind: String,
    category: String,
    latitude: f64,
    longitude: f64,
    title: String,
    note: String,
    source_url: Option<String>,
    source_date: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordRow {
    id: String,
    kind: String,
    category: String,
    latitude: f64,
    longitude: f64,
    title: String,
    note: String,
    source_url: Option<String>,
    source_date: Option<String>,
    author_handle: String,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportInput {
    reason: String,
}

#[derive(Deserialize)]
struct CountRow {
    count: i64,
}

pub fn is_path(path: &str) -> bool {
    path == "/api/site-records" || path.starts_with("/api/site-records/")
}

pub async fn osm_map(request: &Request) -> Result<Response> {
    let url = request.url()?;
    let parameter = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.parse::<f64>().ok())
    };
    let (Some(lat), Some(lon), Some(radius)) =
        (parameter("lat"), parameter("lon"), parameter("radius"))
    else {
        return api_error(400, "invalid_coordinates");
    };
    if !lat.is_finite()
        || !lon.is_finite()
        || !radius.is_finite()
        || lat.abs() > 85.0
        || lon.abs() > 180.0
        || !(100.0..=500.0).contains(&radius)
    {
        return api_error(400, "site_radius_exceeds_source_limit");
    }
    let lat_delta = radius / 111_320.0;
    let lon_delta = radius / (111_320.0 * lat.to_radians().cos().abs().max(0.05));
    let source = format!(
        "https://api.openstreetmap.org/api/0.6/map?bbox={:.6},{:.6},{:.6},{:.6}",
        lon - lon_delta,
        lat - lat_delta,
        lon + lon_delta,
        lat + lat_delta
    );
    let mut response = Fetch::Url(source.parse().map_err(|_| worker::Error::BadEncoding)?)
        .send()
        .await?;
    if response.status_code() != 200 {
        return api_error(502, "osm_source_unavailable");
    }
    let xml = response.text().await?;
    if xml.len() > 8 * 1024 * 1024 {
        return api_error(413, "source_area_too_dense");
    }
    let mut result = Response::ok(xml)?;
    result
        .headers_mut()
        .set("Content-Type", "application/xml; charset=utf-8")?;
    result
        .headers_mut()
        .set("X-Site-Source", "OpenStreetMap API 0.6")?;
    Ok(result)
}

pub async fn nearby_history(request: &Request) -> Result<Response> {
    let url = request.url()?;
    let parameter = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.parse::<f64>().ok())
    };
    let (Some(lat), Some(lon)) = (parameter("lat"), parameter("lon")) else {
        return api_error(400, "invalid_coordinates");
    };
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 85.0 || lon.abs() > 180.0 {
        return api_error(400, "invalid_coordinates");
    }
    let source = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord={lat}%7C{lon}&gsradius=10000&gslimit=20&format=json"
    );
    let mut upstream = Request::new(&source, Method::Get)?;
    upstream.headers_mut()?.set(
        "User-Agent",
        "HII-SiteAnalysis/0.1 (https://humaninformationinterface.com/site-analysis; source lookup)",
    )?;
    let mut response = Fetch::Request(upstream).send().await?;
    if response.status_code() != 200 {
        return api_error(502, "history_source_unavailable");
    }
    let body = response.text().await?;
    if body.len() > 256 * 1024 {
        return api_error(502, "history_source_too_large");
    }
    let mut result = Response::ok(body)?;
    result
        .headers_mut()
        .set("Content-Type", "application/json; charset=utf-8")?;
    Ok(result)
}

pub async fn list(request: &Request, db: &D1Database) -> Result<Response> {
    let url = request.url()?;
    let lat = url
        .query_pairs()
        .find(|(key, _)| key == "lat")
        .and_then(|(_, value)| value.parse::<f64>().ok());
    let lon = url
        .query_pairs()
        .find(|(key, _)| key == "lon")
        .and_then(|(_, value)| value.parse::<f64>().ok());
    let (Some(lat), Some(lon)) = (lat, lon) else {
        return api_error(400, "invalid_coordinates");
    };
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 85.0 || lon.abs() > 180.0 {
        return api_error(400, "invalid_coordinates");
    }
    let lat_delta = 0.1;
    let lon_delta = 0.1 / lat.to_radians().cos().abs().max(0.1);
    let rows: Vec<RecordRow> = db.prepare("SELECT r.id, r.kind, r.category, r.latitude, r.longitude, r.title, r.note, r.source_url, r.source_date, a.handle AS author_handle, r.created_at FROM site_records r JOIN accounts a ON a.id = r.author_account_id WHERE r.state = 'visible' AND r.latitude BETWEEN ?1 AND ?2 AND r.longitude BETWEEN ?3 AND ?4 ORDER BY r.created_at DESC LIMIT 50")
        .bind(&[JsValue::from_f64(lat - lat_delta), JsValue::from_f64(lat + lat_delta), JsValue::from_f64(lon - lon_delta), JsValue::from_f64(lon + lon_delta)])?.all().await?.results()?;
    json_response(200, json!({ "items": rows }))
}

pub async fn write(
    request: &mut Request,
    db: &D1Database,
    session: &SessionRow,
) -> Result<Response> {
    let csrf = request.headers().get("x-hii-csrf")?.unwrap_or_default();
    if csrf.is_empty() || csrf != session.csrf_token {
        return api_error(403, "csrf_denied");
    }
    let path = request.url()?.path().to_owned();
    if path == "/api/site-records" {
        let input: NewRecord = match crate::read_json(request).await {
            Ok(input) => input,
            Err(_) => return api_error(400, "invalid_body"),
        };
        if !matches!(input.kind.as_str(), "request" | "source")
            || !matches!(
                input.category.as_str(),
                "history" | "demographics" | "terrain" | "other"
            )
            || !input.latitude.is_finite()
            || !input.longitude.is_finite()
            || input.latitude.abs() > 85.0
            || input.longitude.abs() > 180.0
            || !(8..=160).contains(&input.title.trim().chars().count())
            || input.note.chars().count() > 2000
        {
            return api_error(400, "invalid_record");
        }
        let source_url = input.source_url.as_deref().unwrap_or("").trim();
        if input.kind == "source"
            && (source_url.len() > 1000 || !source_url.starts_with("https://"))
        {
            return api_error(400, "source_url_required");
        }
        if !source_url.is_empty()
            && (source_url.len() > 1000 || !source_url.starts_with("https://"))
        {
            return api_error(400, "invalid_source_url");
        }
        let recent = db.prepare("SELECT COUNT(*) AS count FROM site_records WHERE author_account_id = ?1 AND created_at > ?2").bind(&[JsValue::from_str(&session.account_id), JsValue::from_f64((now_ms() - 86_400_000) as f64)])?.first::<CountRow>(None).await?.map_or(0, |row| row.count);
        if recent >= 10 {
            return api_error(429, "daily_limit");
        }
        let id = random_token()?;
        let created_at = now_ms();
        db.prepare("INSERT INTO site_records (id, author_account_id, kind, category, latitude, longitude, title, note, source_url, source_date, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
            .bind(&[JsValue::from_str(&id), JsValue::from_str(&session.account_id), JsValue::from_str(&input.kind), JsValue::from_str(&input.category), JsValue::from_f64(input.latitude), JsValue::from_f64(input.longitude), JsValue::from_str(input.title.trim()), JsValue::from_str(input.note.trim()), JsValue::from_str(source_url), JsValue::from_str(input.source_date.as_deref().unwrap_or("")), JsValue::from_f64(created_at as f64)])?.run().await?;
        return json_response(201, json!({ "id": id, "createdAt": created_at }));
    }
    if let Some(id) = path
        .strip_prefix("/api/site-records/")
        .and_then(|path| path.strip_suffix("/report"))
    {
        if id.len() != 43
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return api_error(404, "not_found");
        }
        let input: ReportInput = match crate::read_json(request).await {
            Ok(input) => input,
            Err(_) => return api_error(400, "invalid_body"),
        };
        if !matches!(
            input.reason.as_str(),
            "spam" | "inaccurate" | "private" | "other"
        ) {
            return api_error(400, "invalid_reason");
        }
        db.prepare("INSERT OR IGNORE INTO site_record_reports (record_id, reporter_account_id, reason, created_at) SELECT id, ?2, ?3, ?4 FROM site_records WHERE id = ?1 AND state = 'visible'")
            .bind(&[JsValue::from_str(id), JsValue::from_str(&session.account_id), JsValue::from_str(&input.reason), JsValue::from_f64(now_ms() as f64)])?.run().await?;
        return json_response(200, json!({ "reported": true }));
    }
    api_error(404, "not_found")
}
