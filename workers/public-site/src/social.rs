//! Signed-in-only account profiles and a small follow graph.

use crate::{SessionRow, api_error, json_response, normalize_handle, now_ms};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{D1Database, Method, Request, Response, Result};

const PAGE_SIZE: i64 = 50;
const MAX_OFFSET: i64 = 10_000;

pub fn is_social_api_path(path: &str) -> bool {
    path == "/api/social" || path.starts_with("/api/social/")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayNameInput {
    display_name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandleInput {
    handle: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    handle: String,
    display_name: Option<String>,
    followers_count: i64,
    following_count: i64,
    is_following: bool,
    is_self: bool,
}

#[derive(Deserialize)]
struct ProfileRow {
    id: String,
    handle: String,
    display_name: Option<String>,
    followers_count: i64,
    following_count: i64,
    is_following: i64,
}

pub async fn handle_social_api(
    request: &mut Request,
    db: &D1Database,
    session: &SessionRow,
) -> Result<Response> {
    let url = request.url()?;
    let path = url.path().to_owned();
    match (request.method(), path.as_str()) {
        (Method::Get, "/api/social/me") => {
            profile_response(db, &session.account_id, &session.account_id).await
        }
        (Method::Patch, "/api/social/me") => {
            if !csrf_allowed(request, session)? {
                return api_error(403, "csrf_denied");
            }
            let input: DisplayNameInput = match read_json(request).await {
                Ok(input) => input,
                Err(code) => return api_error(400, code),
            };
            let Some(cleaned) = clean_display_name(&input.display_name) else {
                return api_error(400, "invalid_display_name");
            };
            db.prepare("UPDATE accounts SET display_name = ?1 WHERE id = ?2")
                .bind(&[
                    cleaned.map_or(JsValue::NULL, |value| JsValue::from_str(&value)),
                    JsValue::from_str(&session.account_id),
                ])?
                .run()
                .await?;
            profile_response(db, &session.account_id, &session.account_id).await
        }
        (Method::Get, "/api/social/profile") => {
            let Some(raw) = url
                .query_pairs()
                .find(|(key, _)| key == "handle")
                .map(|(_, value)| value.to_string())
            else {
                return api_error(400, "invalid_handle");
            };
            let Some(handle) = normalize_handle(&raw) else {
                return api_error(400, "invalid_handle");
            };
            let Some(account_id) = db
                .prepare("SELECT id FROM accounts WHERE handle = ?1 LIMIT 1")
                .bind(&[JsValue::from_str(&handle)])?
                .first::<String>(Some("id"))
                .await?
            else {
                return api_error(404, "not_found");
            };
            profile_response(db, &account_id, &session.account_id).await
        }
        (Method::Get, "/api/social/followers") | (Method::Get, "/api/social/following") => {
            let Some(raw) = url
                .query_pairs()
                .find(|(key, _)| key == "handle")
                .map(|(_, value)| value.to_string())
            else {
                return api_error(400, "invalid_handle");
            };
            let Some(handle) = normalize_handle(&raw) else {
                return api_error(400, "invalid_handle");
            };
            let Some(target_id) = db
                .prepare("SELECT id FROM accounts WHERE handle = ?1 LIMIT 1")
                .bind(&[JsValue::from_str(&handle)])?
                .first::<String>(Some("id"))
                .await?
            else {
                return api_error(404, "not_found");
            };
            let cursor = url
                .query_pairs()
                .find(|(key, _)| key == "cursor")
                .map(|(_, value)| value.to_string());
            let offset = match parse_offset(cursor.as_deref()) {
                Some(offset) => offset,
                None => return api_error(400, "invalid_cursor"),
            };
            let followers = path.ends_with("/followers");
            let (sql, bound_account) = if followers {
                (
                    "SELECT a.id, a.handle, a.display_name, (SELECT COUNT(*) FROM account_follows f WHERE f.followee_account_id = a.id) AS followers_count, (SELECT COUNT(*) FROM account_follows f WHERE f.follower_account_id = a.id) AS following_count, EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_account_id = ?1 AND f.followee_account_id = a.id) AS is_following FROM account_follows edge JOIN accounts a ON a.id = edge.follower_account_id WHERE edge.followee_account_id = ?2 ORDER BY edge.created_at DESC, a.handle LIMIT ?3 OFFSET ?4",
                    target_id.as_str(),
                )
            } else {
                (
                    "SELECT a.id, a.handle, a.display_name, (SELECT COUNT(*) FROM account_follows f WHERE f.followee_account_id = a.id) AS followers_count, (SELECT COUNT(*) FROM account_follows f WHERE f.follower_account_id = a.id) AS following_count, EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_account_id = ?1 AND f.followee_account_id = a.id) AS is_following FROM account_follows edge JOIN accounts a ON a.id = edge.followee_account_id WHERE edge.follower_account_id = ?2 ORDER BY edge.created_at DESC, a.handle LIMIT ?3 OFFSET ?4",
                    target_id.as_str(),
                )
            };
            let rows = db
                .prepare(sql)
                .bind(&[
                    JsValue::from_str(&session.account_id),
                    JsValue::from_str(bound_account),
                    JsValue::from_f64((PAGE_SIZE + 1) as f64),
                    JsValue::from_f64(offset as f64),
                ])?
                .all()
                .await?
                .results::<ProfileRow>()?;
            let mut rows = rows;
            let has_more = rows.len() > PAGE_SIZE as usize;
            rows.truncate(PAGE_SIZE as usize);
            let items = rows
                .into_iter()
                .map(|row| profile(row, &session.account_id))
                .collect::<Vec<_>>();
            let next_cursor = next_cursor(offset, has_more);
            json_response(200, json!({"items": items, "nextCursor": next_cursor}))
        }
        (Method::Post, "/api/social/follow") | (Method::Delete, "/api/social/follow") => {
            if !csrf_allowed(request, session)? {
                return api_error(403, "csrf_denied");
            }
            let input: HandleInput = match read_json(request).await {
                Ok(input) => input,
                Err(code) => return api_error(400, code),
            };
            let Some(handle) = normalize_handle(&input.handle) else {
                return api_error(400, "invalid_handle");
            };
            if handle == session.handle {
                return api_error(400, "cannot_follow_self");
            }
            if request.method() == Method::Post {
                db.prepare("INSERT INTO account_follows (follower_account_id, followee_account_id, created_at) SELECT ?1, id, ?3 FROM accounts WHERE handle = ?2 ON CONFLICT(follower_account_id, followee_account_id) DO NOTHING")
                    .bind(&[JsValue::from_str(&session.account_id), JsValue::from_str(&handle), JsValue::from_f64(now_ms() as f64)])?
                    .run().await?;
            } else {
                db.prepare("DELETE FROM account_follows WHERE follower_account_id = ?1 AND followee_account_id = (SELECT id FROM accounts WHERE handle = ?2)")
                    .bind(&[JsValue::from_str(&session.account_id), JsValue::from_str(&handle)])?
                    .run().await?;
            }
            let Some(target_id) = db
                .prepare("SELECT id FROM accounts WHERE handle = ?1 LIMIT 1")
                .bind(&[JsValue::from_str(&handle)])?
                .first::<String>(Some("id"))
                .await?
            else {
                return api_error(404, "not_found");
            };
            profile_response(db, &target_id, &session.account_id).await
        }
        _ => api_error(404, "not_found"),
    }
}

async fn profile_response(db: &D1Database, target_id: &str, viewer_id: &str) -> Result<Response> {
    let row = db.prepare("SELECT a.id, a.handle, a.display_name, (SELECT COUNT(*) FROM account_follows f WHERE f.followee_account_id = a.id) AS followers_count, (SELECT COUNT(*) FROM account_follows f WHERE f.follower_account_id = a.id) AS following_count, EXISTS(SELECT 1 FROM account_follows f WHERE f.follower_account_id = ?2 AND f.followee_account_id = a.id) AS is_following FROM accounts a WHERE a.id = ?1 LIMIT 1")
        .bind(&[JsValue::from_str(target_id), JsValue::from_str(viewer_id)])?.first::<ProfileRow>(None).await?;
    match row {
        Some(row) => json_response(200, json!({"profile": profile(row, viewer_id)})),
        None => api_error(404, "not_found"),
    }
}

fn profile(row: ProfileRow, viewer_id: &str) -> Profile {
    let is_self = row.id == viewer_id;
    Profile {
        id: row.id,
        handle: row.handle,
        display_name: row.display_name,
        followers_count: row.followers_count,
        following_count: row.following_count,
        is_following: row.is_following != 0,
        is_self,
    }
}

fn clean_display_name(value: &str) -> Option<Option<String>> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() > 80 {
        return None;
    }
    Some((!value.is_empty()).then_some(value))
}

fn parse_offset(value: Option<&str>) -> Option<i64> {
    match value {
        None | Some("") => Some(0),
        Some(value) if value.len() <= 5 && value.bytes().all(|byte| byte.is_ascii_digit()) => value
            .parse::<i64>()
            .ok()
            .filter(|offset| *offset <= MAX_OFFSET),
        _ => None,
    }
}

fn next_cursor(offset: i64, has_more: bool) -> Option<String> {
    let next = offset.saturating_add(PAGE_SIZE);
    (has_more && next <= MAX_OFFSET).then(|| next.to_string())
}

fn csrf_allowed(request: &Request, session: &SessionRow) -> Result<bool> {
    let supplied = request.headers().get("x-hii-csrf")?.unwrap_or_default();
    Ok(!supplied.is_empty() && supplied == session.csrf_token)
}

async fn read_json<T: for<'de> Deserialize<'de>>(
    request: &mut Request,
) -> std::result::Result<T, &'static str> {
    if request
        .headers()
        .get("content-length")
        .map_err(|_| "invalid_body")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > 2048)
    {
        return Err("body_too_large");
    }
    let bytes = request
        .stream()
        .map_err(|_| "invalid_body")?
        .try_fold(Vec::new(), |mut body, chunk| async move {
            if body.len().saturating_add(chunk.len()) > 2048 {
                return Err(worker::Error::RustError("body_too_large".into()));
            }
            body.extend_from_slice(&chunk);
            Ok(body)
        })
        .await
        .map_err(|error| {
            if error.to_string().contains("body_too_large") {
                "body_too_large"
            } else {
                "invalid_body"
            }
        })?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid_body")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_trimmed_bounded_and_clearable() {
        assert_eq!(
            clean_display_name("  Ada   Lovelace "),
            Some(Some("Ada Lovelace".into()))
        );
        assert_eq!(clean_display_name("  "), Some(None));
        assert_eq!(clean_display_name(&"x".repeat(81)), None);
    }

    #[test]
    fn cursors_are_small_bounded_offsets() {
        assert_eq!(parse_offset(None), Some(0));
        assert_eq!(parse_offset(Some("50")), Some(50));
        assert_eq!(parse_offset(Some("10001")), None);
        assert_eq!(parse_offset(Some("1;DROP")), None);
        assert_eq!(next_cursor(9_950, true).as_deref(), Some("10000"));
        assert_eq!(next_cursor(10_000, true), None);
    }

    #[test]
    fn social_routes_are_narrow() {
        assert!(is_social_api_path("/api/social/me"));
        assert!(!is_social_api_path("/api/socially"));
    }

    #[test]
    fn d1_profile_rows_use_snake_case_columns_and_public_json_uses_camel_case() {
        let row: ProfileRow = serde_json::from_value(serde_json::json!({
            "id": "account-1",
            "handle": "ada",
            "display_name": "Ada",
            "followers_count": 4,
            "following_count": 2,
            "is_following": 1
        }))
        .expect("D1 row with SQL column names deserializes");
        let public = serde_json::to_value(profile(row, "viewer")).expect("profile serializes");
        assert_eq!(public["displayName"], "Ada");
        assert_eq!(public["followersCount"], 4);
        assert_eq!(public["followingCount"], 2);
        assert_eq!(public["isFollowing"], true);
    }
}
