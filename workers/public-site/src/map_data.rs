use crate::now_ms;
use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};
use wasm_bindgen::JsValue;
use worker::{
    AbortController, Cache, Delay, Fetch, Method, Request, RequestInit, Response, Result,
    wasm_bindgen_futures::spawn_local,
};

const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_ITEMS: usize = 40;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const DEFAULT_RADIUS_METERS: u32 = 1_500;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
struct Center {
    lat: f64,
    lon: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiningPlace {
    id: String,
    name: String,
    category: String,
    lat: f64,
    lon: f64,
    distance_meters: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    cuisine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opening_hours: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    website: Option<String>,
    osm_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiningResponse {
    schema_version: u8,
    source: &'static str,
    attribution: &'static str,
    fetched_at: i64,
    center: Center,
    radius_meters: u32,
    items: Vec<DiningPlace>,
}

pub fn is_path(path: &str) -> bool {
    path == "/api/map/restaurants"
}

fn query_coordinates(request: &Request) -> std::result::Result<(Center, u32), &'static str> {
    let url = request.url().map_err(|_| "invalid_query")?;
    parse_query_parameters(
        url.query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned())),
    )
}

fn parse_query_parameters<I>(parameters: I) -> std::result::Result<(Center, u32), &'static str>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut lat = None;
    let mut lon = None;
    let mut radius = None;
    for (key, value) in parameters {
        match key.as_str() {
            "lat" if lat.is_none() => {
                lat = Some(value.parse::<f64>().map_err(|_| "invalid_coordinates")?)
            }
            "lon" if lon.is_none() => {
                lon = Some(value.parse::<f64>().map_err(|_| "invalid_coordinates")?)
            }
            "radius" if radius.is_none() => {
                radius = Some(value.parse::<u32>().map_err(|_| "invalid_radius")?)
            }
            _ => return Err("invalid_query"),
        }
    }
    let (Some(lat), Some(lon)) = (lat, lon) else {
        return Err("invalid_coordinates");
    };
    let radius = radius.unwrap_or(DEFAULT_RADIUS_METERS);
    if !lat.is_finite()
        || !lon.is_finite()
        || lat.abs() > 85.0
        || lon.abs() > 180.0
        || !(500..=2_000).contains(&radius)
    {
        return Err("invalid_coordinates_or_radius");
    }
    // A 0.001-degree key remains useful at restaurant-search scale while
    // letting nearby requests reuse the same public-data snapshot.
    Ok((
        Center {
            lat: round_to(lat, 3),
            lon: round_to(lon, 3),
        },
        radius,
    ))
}

fn round_to(value: f64, decimals: u32) -> f64 {
    let scale = 10_f64.powi(decimals as i32);
    (value * scale).round() / scale
}

fn overpass_query(center: Center, radius: u32) -> String {
    format!(
        "[out:json][timeout:10];(nwr(around:{radius},{:.3},{:.3})[\"amenity\"~\"^(restaurant|cafe|fast_food)$\"][\"name\"];);out center tags {MAX_ITEMS};",
        center.lat, center.lon
    )
}

fn distance_meters(a: Center, b: Center) -> f64 {
    let lat1 = a.lat.to_radians();
    let lat2 = b.lat.to_radians();
    let dlat = lat2 - lat1;
    let dlon = (b.lon - a.lon).to_radians();
    let haversine =
        (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * haversine.sqrt().asin()
}

fn bounded_tag(tags: &Value, key: &str, max_chars: usize) -> Option<String> {
    let value = tags.get(key)?.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(max_chars).collect())
    }
}

fn append_bounded_chunk(body: &mut Vec<u8>, chunk: &[u8], maximum: usize) -> bool {
    if body.len().saturating_add(chunk.len()) > maximum {
        return false;
    }
    body.extend_from_slice(chunk);
    true
}

fn upstream_error(status: u16) -> (u16, &'static str) {
    if matches!(status, 429 | 502 | 503 | 504) {
        (503, "places_source_busy")
    } else {
        (502, "places_source_unavailable")
    }
}

fn abort_upstream(controller: &Rc<RefCell<Option<AbortController>>>) {
    if let Some(controller) = controller.borrow_mut().take() {
        controller.abort();
    }
}

async fn read_bounded_body(response: &mut Response, maximum: usize) -> Result<String> {
    let bytes = response
        .stream()?
        .try_fold(Vec::new(), |mut body, chunk| async move {
            if !append_bounded_chunk(&mut body, &chunk, maximum) {
                return Err(worker::Error::RustError(
                    "upstream_body_exceeds_limit".to_owned(),
                ));
            }
            Ok(body)
        })
        .await?;
    String::from_utf8(bytes).map_err(|error| worker::Error::RustError(error.to_string()))
}

fn parse_dining_places(body: &str, center: Center, radius: u32) -> Option<Vec<DiningPlace>> {
    let payload: Value = serde_json::from_str(body).ok()?;
    if payload.get("remark").is_some() {
        return None;
    }
    let elements = payload.get("elements")?.as_array()?;
    let mut places = Vec::new();
    for element in elements.iter().take(MAX_ITEMS) {
        let Some(element_type) = element.get("type").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(element_type, "node" | "way" | "relation") {
            continue;
        }
        let Some(id) = element.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(tags) = element.get("tags") else {
            continue;
        };
        let Some(name) = bounded_tag(tags, "name", 120) else {
            continue;
        };
        let Some(amenity) = tags.get("amenity").and_then(Value::as_str) else {
            continue;
        };
        let category = match amenity {
            "restaurant" => "Restaurant",
            "cafe" => "Cafe",
            "fast_food" => "Fast food",
            _ => continue,
        };
        let Some(position) = element.get("lat").zip(element.get("lon")).or_else(|| {
            element
                .get("center")
                .and_then(|value| value.get("lat").zip(value.get("lon")))
        }) else {
            continue;
        };
        let (Some(lat), Some(lon)) = (position.0.as_f64(), position.1.as_f64()) else {
            continue;
        };
        if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
            continue;
        }
        let distance = distance_meters(center, Center { lat, lon });
        if distance > radius as f64 {
            continue;
        }
        let website = bounded_tag(tags, "website", 400)
            .filter(|value| value.starts_with("https://") || value.starts_with("http://"));
        places.push(DiningPlace {
            id: format!("{element_type}/{id}"),
            name,
            category: category.to_owned(),
            lat,
            lon,
            distance_meters: distance.round() as u32,
            cuisine: bounded_tag(tags, "cuisine", 100),
            opening_hours: bounded_tag(tags, "opening_hours", 100),
            website,
            osm_url: format!("https://www.openstreetmap.org/{element_type}/{id}"),
        });
    }
    places.sort_by_key(|place| place.distance_meters);
    places.dedup_by(|a, b| a.id == b.id);
    Some(places)
}

fn cache_key(center: Center, radius: u32) -> String {
    format!(
        "https://humaninformationinterface.com/api/map/restaurants?lat={:.3}&lon={:.3}&radius={radius}",
        center.lat, center.lon
    )
}

fn response_json<T: Serialize>(value: &T, cacheable: bool) -> Result<Response> {
    let mut response = Response::from_json(value)?;
    response.headers_mut().set(
        "Cache-Control",
        if cacheable {
            "public, max-age=300, s-maxage=300"
        } else {
            "no-store"
        },
    )?;
    Ok(response)
}

pub async fn nearby(request: &Request) -> Result<Response> {
    if request.method() != Method::Get {
        return Ok(response_json(&json!({"error":"method_not_allowed"}), false)?.with_status(405));
    }
    let (center, radius) = match query_coordinates(request) {
        Ok(value) => value,
        Err(error) => {
            let code = error;
            return Ok(response_json(&json!({"error":code}), false)?.with_status(400));
        }
    };
    let key = cache_key(center, radius);
    let cache = Cache::default();
    if let Ok(Some(cached)) = cache.get(key.as_str(), true).await {
        return Ok(cached);
    }

    let query = overpass_query(center, radius);
    let form = format!("data={}", query.replace(' ', "+"));
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(JsValue::from_str(&form)));
    init.headers
        .set("Content-Type", "application/x-www-form-urlencoded")?;
    init.headers.set("Accept", "application/json")?;
    init.headers.set(
        "User-Agent",
        "HII Map public places/1.0 (https://humaninformationinterface.com/)",
    )?;
    let outbound = Request::new_with_init(OVERPASS_URL, &init)?;

    let controller = Rc::new(RefCell::new(Some(AbortController::default())));
    let signal = controller
        .borrow()
        .as_ref()
        .expect("controller is present")
        .signal();
    let timed_out = Rc::new(Cell::new(false));
    let finished = Rc::new(Cell::new(false));
    let timeout_flag = timed_out.clone();
    let finished_flag = finished.clone();
    let timeout_controller = controller.clone();
    spawn_local(async move {
        Delay::from(REQUEST_TIMEOUT).await;
        if !finished_flag.get() {
            timeout_flag.set(true);
            if let Some(controller) = timeout_controller.borrow_mut().take() {
                controller.abort();
            }
        }
    });
    let mut upstream = match Fetch::Request(outbound).send_with_signal(&signal).await {
        Ok(response) => response,
        Err(_) => {
            finished.set(true);
            return crate::api_error(
                if timed_out.get() { 504 } else { 502 },
                "places_source_unavailable",
            );
        }
    };
    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        finished.set(true);
        abort_upstream(&controller);
        let (status, code) = upstream_error(status);
        return crate::api_error(status, code);
    }
    if upstream
        .headers()
        .get("Content-Length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_BODY_BYTES)
    {
        finished.set(true);
        abort_upstream(&controller);
        return crate::api_error(502, "places_source_too_large");
    }
    let body = match read_bounded_body(&mut upstream, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => {
            if error.to_string().contains("upstream_body_exceeds_limit") {
                abort_upstream(&controller);
            }
            finished.set(true);
            if error.to_string().contains("upstream_body_exceeds_limit") {
                return crate::api_error(502, "places_source_too_large");
            }
            return crate::api_error(
                if timed_out.get() { 504 } else { 502 },
                "places_source_unavailable",
            );
        }
    };
    finished.set(true);
    if timed_out.get() {
        return crate::api_error(504, "places_source_timeout");
    }
    if body.len() > MAX_BODY_BYTES {
        return crate::api_error(502, "places_source_too_large");
    }
    let Some(items) = parse_dining_places(&body, center, radius) else {
        return crate::api_error(502, "places_source_invalid_response");
    };

    let data = DiningResponse {
        schema_version: 1,
        source: "OpenStreetMap via Overpass API",
        attribution: "© OpenStreetMap contributors · ODbL",
        fetched_at: now_ms(),
        center,
        radius_meters: radius,
        items,
    };
    let mut response = response_json(&data, true)?;
    if let Ok(copy) = response.cloned() {
        let _ = cache.put(key.as_str(), copy).await;
    }
    response
        .headers_mut()
        .set("X-HII-Data-Source", "OpenStreetMap")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overpass_query_is_spatially_bounded_and_caps_results() {
        let ql = overpass_query(
            Center {
                lat: 40.7128,
                lon: -74.006,
            },
            1_500,
        );
        assert!(ql.contains("around:1500,40.713,-74.006"));
        assert!(ql.contains("[timeout:10]"));
        assert!(ql.contains("out center tags 40"));
        assert!(ql.contains("restaurant|cafe|fast_food"));
    }

    #[test]
    fn result_parser_keeps_only_named_places_inside_radius_and_sorts_by_distance() {
        let body = json!({"elements":[
            {"type":"node","id":2,"lat":40.72,"lon":-74.006,"tags":{"amenity":"restaurant","name":"Far","cuisine":"pizza"}},
            {"type":"way","id":3,"center":{"lat":40.713,"lon":-74.006},"tags":{"amenity":"cafe","name":"Near","opening_hours":"Mo-Fr"}},
            {"type":"node","id":4,"lat":40.713,"lon":-74.006,"tags":{"amenity":"restaurant","name":""}},
            {"type":"node","id":5,"lat":40.713,"lon":-74.006,"tags":{"amenity":"bar","name":"Not dining"}}
        ]}).to_string();
        let places = parse_dining_places(
            &body,
            Center {
                lat: 40.713,
                lon: -74.006,
            },
            1_500,
        )
        .unwrap();
        assert_eq!(places.len(), 2);
        assert_eq!(places[0].name, "Near");
        assert_eq!(places[0].category, "Cafe");
        assert!(places[0].opening_hours.is_some());
        assert_eq!(places[1].name, "Far");
        assert_eq!(places[1].cuisine.as_deref(), Some("pizza"));
    }

    #[test]
    fn bad_coordinates_radius_duplicates_and_unbounded_parameters_are_rejected() {
        let parse = |pairs: &[(&str, &str)]| {
            parse_query_parameters(
                pairs
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_string())),
            )
        };
        assert!(parse(&[("lat", "91"), ("lon", "0")]).is_err());
        assert!(parse(&[("lat", "1"), ("lon", "2"), ("radius", "9000")]).is_err());
        assert!(parse(&[("lat", "1"), ("lat", "2"), ("lon", "3")]).is_err());
        assert!(parse(&[("lat", "1"), ("lon", "2"), ("url", "https://evil")]).is_err());
    }

    #[test]
    fn bounded_stream_accumulator_rejects_the_first_chunk_over_limit() {
        let mut body = vec![1, 2];
        assert!(append_bounded_chunk(&mut body, &[3, 4], 4));
        assert!(!append_bounded_chunk(&mut body, &[5], 4));
        assert_eq!(body, vec![1, 2, 3, 4]);
        assert!(!append_bounded_chunk(&mut Vec::new(), &[0; 5], 4));
    }

    #[test]
    fn overloaded_overpass_statuses_are_reported_as_temporary_source_busy() {
        assert_eq!(upstream_error(504), (503, "places_source_busy"));
        assert_eq!(upstream_error(503), (503, "places_source_busy"));
        assert_eq!(upstream_error(404), (502, "places_source_unavailable"));
    }
}
