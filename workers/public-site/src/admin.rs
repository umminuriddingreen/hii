//! Operator visibility into the accounts this deployment has created.
//!
//! Two constraints shape this module. First, it reports only what the service
//! already stores to do its job — handles, creation times, device and workspace
//! counts, and the `last_seen_at` the device table already keeps. Nothing new is
//! collected about anyone, and no behavioural tracking is introduced.
//!
//! Second, an operator surface on a site whose premise is privacy is a target.
//! Access is granted by the `HII_ADMIN_HANDLES` secret rather than a database
//! column, so a write to D1 cannot escalate anyone to operator, and a
//! non-operator is answered with the same `404` the router gives an unknown
//! path — the endpoint does not admit it exists.

use crate::{SessionRow, api_error, json_response, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::{D1Database, Env, Method, Request, Response, Result};

/// Most recent accounts returned in one response.
const ROSTER_LIMIT: i64 = 500;
/// Weeks of signup history summarised for the sparkline.
const HISTORY_WEEKS: i64 = 12;
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub fn is_admin_api_path(path: &str) -> bool {
    path == "/api/admin/accounts"
}

#[derive(Deserialize, Serialize)]
struct AccountRow {
    handle: String,
    created_at: i64,
    devices: i64,
    workspaces: i64,
    last_seen_at: Option<i64>,
}

#[derive(Deserialize)]
struct CountRow {
    count: i64,
}

#[derive(Deserialize)]
struct WeekRow {
    week: i64,
    count: i64,
}

/// True when the signed-in account is named in the `HII_ADMIN_HANDLES` secret.
///
/// The secret is a comma-separated handle list. An unset or empty secret grants
/// nobody access, so a deployment that never configures it has no operator
/// surface at all rather than an open one.
fn is_operator(env: &Env, handle: &str) -> bool {
    let Ok(configured) = env.secret("HII_ADMIN_HANDLES") else {
        return false;
    };
    configured
        .to_string()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry.eq_ignore_ascii_case(handle))
}

pub async fn handle_admin_api(
    request: &Request,
    env: &Env,
    db: &D1Database,
    session: &SessionRow,
) -> Result<Response> {
    if !is_operator(env, &session.handle) {
        return api_error(404, "not_found");
    }
    if request.method() != Method::Get {
        return api_error(405, "method_not_allowed");
    }
    accounts_overview(db).await
}

async fn accounts_overview(db: &D1Database) -> Result<Response> {
    let now = now_ms();

    let total = db
        .prepare("SELECT COUNT(*) AS count FROM accounts")
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0);

    let since_7d = now - WEEK_MS;
    let since_30d = now - 30 * 24 * 60 * 60 * 1000;
    let new_7d = count_since(db, since_7d).await?;
    let new_30d = count_since(db, since_30d).await?;

    // Signups bucketed by week, oldest first, for a sparkline. Buckets are
    // computed in SQL so the worker does not page the whole table into memory.
    let history_start = now - HISTORY_WEEKS * WEEK_MS;
    let weeks = db
        .prepare(
            "SELECT (created_at / ?1) AS week, COUNT(*) AS count FROM accounts
             WHERE created_at >= ?2 GROUP BY week ORDER BY week ASC",
        )
        .bind(&[WEEK_MS.into(), history_start.into()])?
        .all()
        .await?
        .results::<WeekRow>()?;

    // Counts come from correlated subqueries rather than joins so an account
    // with no devices or workspaces still appears, with zeroes.
    let accounts = db
        .prepare(
            "SELECT a.handle, a.created_at,
                    (SELECT COUNT(*) FROM account_devices d
                      WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices,
                    (SELECT COUNT(*) FROM workspace_members m
                      WHERE m.account_id = a.id AND m.revoked_at IS NULL) AS workspaces,
                    (SELECT MAX(d.last_seen_at) FROM account_devices d
                      WHERE d.account_id = a.id) AS last_seen_at
             FROM accounts a ORDER BY a.created_at DESC LIMIT ?1",
        )
        .bind(&[ROSTER_LIMIT.into()])?
        .all()
        .await?
        .results::<AccountRow>()?;

    json_response(
        200,
        json!({
            "generatedAt": now,
            "totalAccounts": total,
            "newLast7d": new_7d,
            "newLast30d": new_30d,
            "rosterLimit": ROSTER_LIMIT,
            "signupsByWeek": weeks
                .into_iter()
                .map(|row| json!({ "weekStart": row.week * WEEK_MS, "count": row.count }))
                .collect::<Vec<_>>(),
            "accounts": accounts
        }),
    )
}

async fn count_since(db: &D1Database, since: i64) -> Result<i64> {
    Ok(db
        .prepare("SELECT COUNT(*) AS count FROM accounts WHERE created_at >= ?1")
        .bind(&[since.into()])?
        .first::<CountRow>(None)
        .await?
        .map(|row| row.count)
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::is_admin_api_path;

    #[test]
    fn claims_only_the_admin_route() {
        assert!(is_admin_api_path("/api/admin/accounts"));
        assert!(!is_admin_api_path("/api/admin"));
        assert!(!is_admin_api_path("/api/admin/accounts/extra"));
        assert!(!is_admin_api_path("/api/devices"));
    }
}
