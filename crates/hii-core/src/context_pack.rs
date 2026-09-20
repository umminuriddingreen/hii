// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! Runtime-owned, bounded context compilation for HII agents.
//!
//! Every adapter reads an existing canonical store. The compiler ranks handles,
//! freezes a small source-linked working set, records what was excluded, and
//! binds approval to one deterministic fingerprint.

use crate::{
    operational::{database, migrate},
    runtime::IdentityRefV1,
};
use chrono::Utc;
use ring::digest::{digest, SHA256};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::Path,
};
use uuid::Uuid;

pub const DEFAULT_CONTEXT_BUDGET: u64 = 8_000;
pub const MAX_CONTEXT_BUDGET: u64 = 24_000;
pub const MAX_SELECTED_OBJECTS: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompileRequestV1 {
    pub version: u8,
    #[serde(default)]
    pub space_id: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    pub intent: String,
    #[serde(default)]
    pub selected_object_ids: Vec<String>,
    /// Explicit review removals override selection and ambient retrieval.
    #[serde(default)]
    pub excluded_object_ids: Vec<String>,
    pub actor: IdentityRefV1,
    #[serde(default = "default_authority")]
    pub authority: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub budget_tokens: Option<u64>,
    #[serde(default)]
    pub previous_fingerprint: Option<String>,
}

fn default_authority() -> String {
    "read-only".into()
}

fn default_mode() -> String {
    "plan".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextPackStatusV1 {
    Draft,
    Approved,
    Stale,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextRiskActionV1 {
    AutoStart,
    Review,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRiskV1 {
    pub action: ContextRiskActionV1,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRefV1 {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackItemV1 {
    #[serde(rename = "ref")]
    pub context_ref: ContextRefV1,
    pub title: String,
    pub item_type: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub provenance: String,
    pub transmission_scope: String,
    pub relevance_reasons: Vec<String>,
    pub estimated_tokens: u64,
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextExclusionV1 {
    #[serde(rename = "ref")]
    pub context_ref: ContextRefV1,
    pub title: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetV1 {
    pub maximum_tokens: u64,
    pub used_tokens: u64,
    pub remaining_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackV1 {
    pub version: u8,
    pub id: String,
    pub status: ContextPackStatusV1,
    pub intent: String,
    pub space_id: String,
    pub workspace_root: String,
    pub actor: IdentityRefV1,
    pub authority: String,
    pub mode: String,
    pub items: Vec<ContextPackItemV1>,
    pub excluded: Vec<ContextExclusionV1>,
    pub source_errors: Vec<String>,
    pub budget: ContextBudgetV1,
    pub transmission_scope: String,
    pub fingerprint: String,
    pub previous_fingerprint: Option<String>,
    pub changed_since_previous: bool,
    pub risk: ContextRiskV1,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextApproveRequestV1 {
    pub version: u8,
    pub pack_id: String,
    pub fingerprint: String,
    pub approved_by: IdentityRefV1,
}

#[derive(Clone, Debug)]
struct Candidate {
    item: ContextPackItemV1,
    score: i64,
    blocked_reason: Option<String>,
}

pub fn compile(runtime: &Path, request: &ContextCompileRequestV1) -> Result<ContextPackV1, String> {
    validate_request(request)?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let pack = build(runtime, request, id, created_at)?;
    persist(runtime, request, &pack)?;
    Ok(pack)
}

pub fn get(runtime: &Path, id: &str) -> Result<ContextPackV1, String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    migrate_context(&connection)?;
    let raw = connection
        .query_row(
            "SELECT pack_json FROM context_packs WHERE id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("ContextPack not found: {id}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("invalid stored ContextPack: {error}"))
}

pub fn approve(runtime: &Path, request: &ContextApproveRequestV1) -> Result<ContextPackV1, String> {
    if request.version != 1 {
        return Err(format!(
            "Unsupported ContextPack approval version {}",
            request.version
        ));
    }
    let mut pack = get(runtime, &request.pack_id)?;
    if pack.status == ContextPackStatusV1::Blocked
        || pack.risk.action == ContextRiskActionV1::Blocked
    {
        return Err(
            "Blocked context cannot be approved; remove or refresh the blocked source.".into(),
        );
    }
    if request.fingerprint != pack.fingerprint {
        return Err("Context changed after review; compile a fresh pack before approval.".into());
    }
    let local_policy =
        request.approved_by.id == "policy:local-readonly" && request.approved_by.kind == "service";
    if local_policy && pack.risk.action != ContextRiskActionV1::AutoStart {
        return Err("Local policy may approve only unchanged local read-only ContextPacks.".into());
    }
    if !local_policy && request.approved_by.kind != "human" {
        return Err(
            "ContextPack review requires the local human or the bounded read-only policy.".into(),
        );
    }
    revalidate(runtime, &pack)?;
    let now = Utc::now().to_rfc3339();
    pack.status = ContextPackStatusV1::Approved;
    pack.approved_at = Some(now.clone());
    pack.approved_by = Some(request.approved_by.id.clone());
    let connection = database(runtime)?;
    migrate(&connection)?;
    migrate_context(&connection)?;
    connection
        .execute(
            "UPDATE context_packs SET status='approved', approved_at=?2, approved_by=?3, pack_json=?4 WHERE id=?1",
            params![pack.id, now, request.approved_by.id, json_string(&pack)?],
        )
        .map_err(|error| error.to_string())?;
    Ok(pack)
}

pub fn require_approved(
    runtime: &Path,
    id: &str,
    fingerprint: &str,
) -> Result<ContextPackV1, String> {
    let mut pack = get(runtime, id)?;
    if pack.status != ContextPackStatusV1::Approved {
        return Err("The ContextPack has not been approved for execution.".into());
    }
    if pack.fingerprint != fingerprint {
        return Err("The requested ContextPack fingerprint does not match its approval.".into());
    }
    if let Err(error) = revalidate(runtime, &pack) {
        pack.status = ContextPackStatusV1::Stale;
        let connection = database(runtime)?;
        migrate(&connection)?;
        migrate_context(&connection)?;
        connection
            .execute(
                "UPDATE context_packs SET status='stale', pack_json=?2 WHERE id=?1",
                params![pack.id, json_string(&pack)?],
            )
            .map_err(|database_error| database_error.to_string())?;
        return Err(error);
    }
    Ok(pack)
}

pub fn render_for_model(pack: &ContextPackV1) -> String {
    let mut lines = vec![
        format!("HII CONTEXT PACK {}", pack.id),
        format!("fingerprint: {}", pack.fingerprint),
        format!("scope: Space {} · {}", pack.space_id, pack.workspace_root),
        format!("authority: {} · transmission: {}", pack.authority, pack.transmission_scope),
        "This exact pack is the approved model context. Do not assume missing detail or silently widen scope.".into(),
        String::new(),
    ];
    for item in &pack.items {
        lines.push(format!(
            "[{}:{}] {} ({})\n{}\nsource: {} · provenance: {}",
            item.context_ref.kind,
            item.context_ref.id,
            item.title,
            item.item_type,
            item.summary,
            item.source.as_deref().unwrap_or("HII Runtime"),
            item.provenance,
        ));
    }
    if !pack.excluded.is_empty() {
        lines.push(String::new());
        lines.push("EXCLUDED CONTEXT".into());
        for item in &pack.excluded {
            lines.push(format!("- {}: {}", item.title, item.reason));
        }
    }
    lines.join("\n")
}

pub fn search_pack(pack: &ContextPackV1, query: &str, limit: usize) -> Vec<ContextPackItemV1> {
    let terms = terms(query);
    let mut items = pack
        .items
        .iter()
        .filter(|item| {
            let haystack = format!(
                "{} {} {}",
                item.title,
                item.summary,
                item.source.as_deref().unwrap_or("")
            )
            .to_ascii_lowercase();
            terms.is_empty() || terms.iter().all(|term| haystack.contains(term))
        })
        .cloned()
        .collect::<Vec<_>>();
    items.truncate(limit.clamp(1, 50));
    items
}

fn revalidate(runtime: &Path, pack: &ContextPackV1) -> Result<(), String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    migrate_context(&connection)?;
    let request_raw = connection
        .query_row(
            "SELECT request_json FROM context_packs WHERE id=?1",
            [&pack.id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    let request: ContextCompileRequestV1 = serde_json::from_str(&request_raw)
        .map_err(|error| format!("invalid stored ContextPack request: {error}"))?;
    let current = build(runtime, &request, pack.id.clone(), pack.created_at.clone())?;
    if current.fingerprint != pack.fingerprint {
        return Err(
            "Context sources changed after approval; compile and review a fresh pack.".into(),
        );
    }
    Ok(())
}

fn build(
    runtime: &Path,
    request: &ContextCompileRequestV1,
    id: String,
    created_at: String,
) -> Result<ContextPackV1, String> {
    let connection = database(runtime)?;
    migrate(&connection)?;
    migrate_context(&connection)?;
    let space_id = request.space_id.clone().unwrap_or_else(|| "default".into());
    let workspace_root = match request
        .workspace_root
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => crate::default_workspace_root()?.display().to_string(),
    };
    let budget = request
        .budget_tokens
        .unwrap_or(DEFAULT_CONTEXT_BUDGET)
        .clamp(512, MAX_CONTEXT_BUDGET);
    let excluded_ids = request
        .excluded_object_ids
        .iter()
        .map(|id| canonical_object_id(&space_id, id))
        .collect::<BTreeSet<_>>();
    let selected = request
        .selected_object_ids
        .iter()
        .filter(|id| !excluded_ids.contains(&canonical_object_id(&space_id, id)))
        .take(MAX_SELECTED_OBJECTS)
        .cloned()
        .collect::<BTreeSet<_>>();
    let query_terms = terms(&request.intent);
    let mut candidates = Vec::new();
    let mut source_errors = Vec::new();
    // Hosted account work is not permission to retrieve unrelated private
    // machine context. This persisted binding is set by authenticated sync,
    // not by a model-supplied request flag, and is checked again on approval.
    let has_account_bindings: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='hii_account_workspace_sync')",
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let account_bound: bool = has_account_bindings
        && connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM hii_account_workspace_sync WHERE workspace_id=?1)",
                [&space_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;

    if !account_bound {
        collect_workspace_instructions(&workspace_root, &mut candidates, &mut source_errors);
    }
    collect_runtime(
        &connection,
        &space_id,
        &selected,
        &query_terms,
        &mut candidates,
        &mut source_errors,
    );
    if !account_bound {
        collect_context_dock(
            &connection,
            &workspace_root,
            &request.intent,
            &mut candidates,
            &mut source_errors,
        );
        collect_knowledge(
            &connection,
            &request.intent,
            &mut candidates,
            &mut source_errors,
        );
        collect_information(
            &connection,
            &request.intent,
            &mut candidates,
            &mut source_errors,
        );
        collect_board(
            runtime,
            &workspace_root,
            &query_terms,
            &mut candidates,
            &mut source_errors,
        );
        collect_skills(runtime, &query_terms, &mut candidates, &mut source_errors);
        collect_capability_jobs(
            runtime,
            &workspace_root,
            &query_terms,
            &mut candidates,
            &mut source_errors,
        );
        collect_receipts(
            runtime,
            &workspace_root,
            &query_terms,
            &mut candidates,
            &mut source_errors,
        );
        collect_operations(
            &connection,
            &space_id,
            &query_terms,
            &mut candidates,
            &mut source_errors,
        );
    } else {
        candidates.retain(|candidate| candidate.item.selected);
    }

    let mut excluded = excluded_ids
        .iter()
        .map(|id| ContextExclusionV1 {
            context_ref: ContextRefV1 {
                kind: "runtime-object".into(),
                id: id.clone(),
                scope: Some(space_id.clone()),
                anchor: None,
            },
            title: id.clone(),
            reason: "explicitly excluded from this ContextPack by the user".into(),
        })
        .collect::<Vec<_>>();
    let mut deduped = BTreeMap::<String, Candidate>::new();
    for candidate in candidates {
        let excluded_object = candidate.item.context_ref.kind == "runtime-object"
            && excluded_ids.contains(&candidate.item.context_ref.id);
        let excluded_event = candidate.item.context_ref.kind == "runtime-event"
            && candidate
                .item
                .source
                .as_ref()
                .is_some_and(|target| excluded_ids.contains(target));
        if excluded_object || excluded_event {
            continue;
        }
        let key = format!(
            "{}:{}:{}",
            candidate.item.context_ref.kind,
            candidate.item.context_ref.scope.as_deref().unwrap_or(""),
            candidate.item.context_ref.id
        );
        match deduped.get(&key) {
            Some(existing) if existing.score >= candidate.score => {}
            _ => {
                deduped.insert(key, candidate);
            }
        }
    }
    let mut candidates = deduped.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .item
            .selected
            .cmp(&left.item.selected)
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| left.item.title.cmp(&right.item.title))
            .then_with(|| left.item.context_ref.id.cmp(&right.item.context_ref.id))
    });

    let mut items = Vec::new();
    let mut used: u64 = 180;
    let mut selected_budget_block = false;
    for candidate in candidates {
        if let Some(reason) = candidate.blocked_reason {
            excluded.push(ContextExclusionV1 {
                context_ref: candidate.item.context_ref,
                title: candidate.item.title,
                reason,
            });
            continue;
        }
        if used.saturating_add(candidate.item.estimated_tokens) > budget {
            if candidate.item.selected {
                selected_budget_block = true;
            }
            excluded.push(ContextExclusionV1 {
                context_ref: candidate.item.context_ref,
                title: candidate.item.title,
                reason: "excluded by ContextPack token budget".into(),
            });
            continue;
        }
        used = used.saturating_add(candidate.item.estimated_tokens);
        items.push(candidate.item);
    }

    for selected_id in &selected {
        let runtime_id = format!("workspace:{space_id}:object:{selected_id}");
        let found = items
            .iter()
            .any(|item| item.context_ref.id == *selected_id || item.context_ref.id == runtime_id)
            || excluded.iter().any(|item| {
                item.context_ref.id == *selected_id || item.context_ref.id == runtime_id
            });
        if !found {
            excluded.push(ContextExclusionV1 {
                context_ref: ContextRefV1 {
                    kind: "runtime-object".into(),
                    id: selected_id.clone(),
                    scope: Some(space_id.clone()),
                    anchor: None,
                },
                title: selected_id.clone(),
                reason: "selected object is missing from the authoritative Runtime Space".into(),
            });
        }
    }

    let blocked_selected = selected_budget_block
        || excluded.iter().any(|entry| {
            selected.contains(&entry.context_ref.id)
                || selected.contains(entry.context_ref.id.rsplit(':').next().unwrap_or(""))
        });
    let requested_external = matches!(
        request.authority.as_str(),
        "external-preview" | "external-commit"
    );
    if requested_external {
        for item in &mut items {
            item.transmission_scope = "external-model".into();
        }
    }
    let expanded = items
        .iter()
        .any(|item| !item.selected && item.context_ref.kind != "workspace-instructions");
    let write = !matches!(request.mode.as_str(), "plan" | "browse" | "see")
        || request.authority != "read-only";
    let external = requested_external;
    let mut risk_reasons = Vec::new();
    let risk_action = if blocked_selected {
        risk_reasons
            .push("selected context is missing, blocked, or cannot fit the declared budget".into());
        ContextRiskActionV1::Blocked
    } else if write || external || expanded {
        if write {
            risk_reasons.push("the requested mode can change the approved workspace".into());
        }
        if external {
            risk_reasons.push("the pack permits external model transmission".into());
        }
        if expanded {
            risk_reasons.push("HII inferred relevant context beyond the explicit selection".into());
        }
        ContextRiskActionV1::Review
    } else {
        risk_reasons.push("local read-only work uses only explicit selected context".into());
        ContextRiskActionV1::AutoStart
    };
    let status = if risk_action == ContextRiskActionV1::Blocked {
        ContextPackStatusV1::Blocked
    } else {
        ContextPackStatusV1::Draft
    };
    let transmission_scope = if external {
        "external-model"
    } else {
        "local-only"
    }
    .to_string();
    let fingerprint = fingerprint(
        request,
        &space_id,
        &workspace_root,
        budget,
        &items,
        &excluded,
        &transmission_scope,
    )?;
    let previous_fingerprint = request.previous_fingerprint.clone();
    let changed_since_previous = previous_fingerprint
        .as_ref()
        .is_some_and(|previous| previous != &fingerprint);
    Ok(ContextPackV1 {
        version: 1,
        id,
        status,
        intent: request.intent.clone(),
        space_id,
        workspace_root,
        actor: request.actor.clone(),
        authority: request.authority.clone(),
        mode: request.mode.clone(),
        items,
        excluded,
        source_errors,
        budget: ContextBudgetV1 {
            maximum_tokens: budget,
            used_tokens: used.min(budget),
            remaining_tokens: budget.saturating_sub(used),
        },
        transmission_scope,
        fingerprint,
        previous_fingerprint,
        changed_since_previous,
        risk: ContextRiskV1 {
            action: risk_action,
            reasons: risk_reasons,
        },
        created_at,
        approved_at: None,
        approved_by: None,
    })
}

fn canonical_object_id(space_id: &str, id: &str) -> String {
    if id.starts_with("workspace:") {
        id.to_string()
    } else {
        format!("workspace:{space_id}:object:{id}")
    }
}

fn persist(
    runtime: &Path,
    request: &ContextCompileRequestV1,
    pack: &ContextPackV1,
) -> Result<(), String> {
    let mut connection = database(runtime)?;
    migrate(&connection)?;
    migrate_context(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO context_packs
             (id, space_id, workspace_root, status, intent, fingerprint, transmission_scope,
              budget_tokens, request_json, pack_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                pack.id,
                pack.space_id,
                pack.workspace_root,
                status_name(&pack.status),
                pack.intent,
                pack.fingerprint,
                pack.transmission_scope,
                pack.budget.maximum_tokens,
                json_string(request)?,
                json_string(pack)?,
                pack.created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    for (ordinal, item) in pack.items.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO context_pack_items
                 (pack_id, ordinal, ref_kind, ref_id, included, item_json)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                params![
                    pack.id,
                    ordinal as i64,
                    item.context_ref.kind,
                    item.context_ref.id,
                    json_string(item)?,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    for (offset, item) in pack.excluded.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO context_pack_items
                 (pack_id, ordinal, ref_kind, ref_id, included, item_json)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                params![
                    pack.id,
                    (pack.items.len() + offset) as i64,
                    item.context_ref.kind,
                    item.context_ref.id,
                    json_string(item)?,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn migrate_context(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS context_packs (
               id TEXT PRIMARY KEY,
               space_id TEXT NOT NULL,
               workspace_root TEXT NOT NULL,
               status TEXT NOT NULL,
               intent TEXT NOT NULL,
               fingerprint TEXT NOT NULL,
               transmission_scope TEXT NOT NULL,
               budget_tokens INTEGER NOT NULL,
               request_json TEXT NOT NULL,
               pack_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               approved_at TEXT,
               approved_by TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_context_packs_space_created
               ON context_packs(space_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS context_pack_items (
               pack_id TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               ref_kind TEXT NOT NULL,
               ref_id TEXT NOT NULL,
               included INTEGER NOT NULL CHECK (included IN (0,1)),
               item_json TEXT NOT NULL,
               PRIMARY KEY(pack_id, ordinal),
               FOREIGN KEY(pack_id) REFERENCES context_packs(id) ON DELETE CASCADE
             );
             INSERT OR IGNORE INTO schema_migrations(version)
               VALUES ('hii-context-pack-v1');",
        )
        .map_err(|error| error.to_string())
}

fn collect_workspace_instructions(
    workspace_root: &str,
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    if workspace_root.is_empty() {
        return;
    }
    let path = Path::new(workspace_root).join("AGENTS.md");
    if !path.is_file() {
        return;
    }
    match fs::read_to_string(&path) {
        Ok(content) => out.push(candidate(
            "workspace-instructions",
            &path.display().to_string(),
            Some(workspace_root),
            "Workspace instructions",
            "instructions",
            &truncate(&redact(&content), 12_000),
            Some(path.display().to_string()),
            None,
            Some(sha256(content.as_bytes())),
            "workspace authority file",
            vec!["authoritative workspace instructions".into()],
            9_500,
            false,
        )),
        Err(error) => errors.push(format!("workspace instructions unavailable: {error}")),
    }
}

fn collect_runtime(
    connection: &Connection,
    space_id: &str,
    selected: &BTreeSet<String>,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let mut statement = match connection.prepare(
        "SELECT id, type, properties_json, provenance_json, updated_at
         FROM operational_objects WHERE space_id=?1 AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 300",
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Runtime objects unavailable: {error}"));
            return;
        }
    };
    let rows = match statement.query_map([space_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Runtime objects unreadable: {error}"));
            return;
        }
    };
    for row in rows.flatten() {
        let properties = serde_json::from_str::<Value>(&row.2).unwrap_or(Value::Null);
        let legacy_id = row.0.rsplit(':').next().unwrap_or(&row.0);
        let is_selected = selected.contains(legacy_id) || selected.contains(&row.0);
        let title = value_text(
            &properties,
            &["/payload/title", "/payload/name", "/payload/label"],
        )
        .unwrap_or_else(|| legacy_id.to_string());
        let summary = object_summary(&properties);
        let relevance = overlap(query_terms, &format!("{title} {summary}"));
        if !is_selected && relevance == 0 {
            continue;
        }
        let provenance = serde_json::from_str::<Value>(&row.3)
            .ok()
            .and_then(|value| {
                value
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "HII Runtime object".into());
        out.push(candidate(
            "runtime-object",
            &row.0,
            Some(space_id),
            &title,
            &row.1,
            &summary,
            value_text(&properties, &["/payload/source", "/object/source"]),
            Some(row.4),
            None,
            &provenance,
            if is_selected {
                vec!["explicitly selected on the canvas".into()]
            } else {
                vec!["intent matched a Space object".into()]
            },
            if is_selected {
                10_000
            } else {
                900 + relevance as i64
            },
            is_selected,
        ));
    }
}

fn collect_context_dock(
    connection: &Connection,
    workspace_root: &str,
    intent: &str,
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    if !table_exists(connection, "context_chunks_fts") || workspace_root.is_empty() {
        return;
    }
    let project_id = connection
        .query_row(
            "SELECT id FROM context_projects
             WHERE approved_root=1 AND excluded=0 AND (?1=root_path OR ?1 LIKE root_path || '/%')
             ORDER BY length(root_path) DESC LIMIT 1",
            [workspace_root],
            |row| row.get::<_, String>(0),
        )
        .optional();
    let project_id = match project_id {
        Ok(Some(value)) => value,
        Ok(None) => return,
        Err(error) => {
            errors.push(format!("Context Dock project lookup failed: {error}"));
            return;
        }
    };
    let Some(query) = fts_query(intent) else {
        return;
    };
    let mut statement = match connection.prepare(
        "SELECT c.id, c.source_path, c.content, c.line_start, c.line_end,
                c.freshness_at, c.content_hash, c.pinned, bm25(context_chunks_fts)
         FROM context_chunks_fts f JOIN context_chunks c ON c.id=f.chunk_id
         WHERE context_chunks_fts MATCH ?1 AND c.project_id=?2 AND c.approved_root=1 AND c.excluded=0
         ORDER BY c.pinned DESC, bm25(context_chunks_fts) LIMIT 12",
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Context Dock search unavailable: {error}"));
            return;
        }
    };
    let rows = match statement.query_map(params![query, project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, u64>(3)?,
            row.get::<_, u64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, bool>(7)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Context Dock results unreadable: {error}"));
            return;
        }
    };
    for row in rows.flatten() {
        let mut item = candidate(
            "context-chunk",
            &row.0,
            Some(&project_id),
            Path::new(&row.1)
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or(&row.1),
            "project-source",
            &truncate(&row.2, 2_400),
            Some(row.1.clone()),
            Some(row.5),
            Some(row.6),
            "approved Context Dock index",
            vec![format!("FTS match at lines {}-{}", row.3, row.4)],
            if row.7 { 880 } else { 800 },
            false,
        );
        item.item.context_ref.anchor = Some(json!({"lineStart": row.3, "lineEnd": row.4}));
        out.push(item);
    }
}

fn collect_knowledge(
    connection: &Connection,
    intent: &str,
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    if !table_exists(connection, "knowledge_notes_fts") {
        return;
    }
    let Some(query) = fts_query(intent) else {
        return;
    };
    let mut statement = match connection.prepare(
        "SELECT n.id, n.title, n.path, n.content, n.updated_at, n.pinned, n.metadata_json
         FROM knowledge_notes_fts f JOIN knowledge_notes n ON n.id=f.note_id
         WHERE knowledge_notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY n.pinned DESC, bm25(knowledge_notes_fts) LIMIT 10",
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Knowledge search unavailable: {error}"));
            return;
        }
    };
    let rows = match statement.query_map([query], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, bool>(5)?,
            row.get::<_, String>(6)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Knowledge results unreadable: {error}"));
            return;
        }
    };
    for row in rows.flatten() {
        let metadata = serde_json::from_str::<Value>(&row.6).unwrap_or(Value::Null);
        let accepted = metadata
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|value| matches!(value, "accepted" | "active" | "completed"));
        out.push(candidate(
            "knowledge-note",
            &row.0,
            None,
            &row.1,
            "knowledge-note",
            &truncate(&row.3, 2_400),
            Some(row.2),
            Some(row.4),
            Some(sha256(row.3.as_bytes())),
            "HII Knowledge Workspace",
            vec![if accepted {
                "accepted knowledge matched intent".into()
            } else {
                "knowledge FTS match".into()
            }],
            700 + if row.5 || accepted { 80 } else { 0 },
            false,
        ));
    }
}

fn collect_information(
    connection: &Connection,
    intent: &str,
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    if !table_exists(connection, "information_fts") {
        return;
    }
    let Some(query) = fts_query(intent) else {
        return;
    };
    let mut statement = match connection.prepare(
        "SELECT s.id, s.title, s.url, s.excerpt, s.content_hash, s.updated_at
         FROM information_fts f JOIN information_sources s ON s.id=f.source_id
         WHERE information_fts MATCH ?1 ORDER BY bm25(information_fts) LIMIT 8",
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Information search unavailable: {error}"));
            return;
        }
    };
    let rows = match statement.query_map([query], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Information results unreadable: {error}"));
            return;
        }
    };
    for row in rows.flatten() {
        out.push(candidate(
            "information-source",
            &row.0,
            None,
            &row.1,
            "captured-web-source",
            &truncate(&row.3, 1_600),
            Some(row.2),
            Some(row.5),
            Some(row.4),
            "locally cached HII Information source",
            vec!["cached information FTS match".into()],
            520,
            false,
        ));
    }
}

fn collect_board(
    runtime: &Path,
    workspace_root: &str,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let path = runtime.join("board/tasks.jsonl");
    let file = match fs::File::open(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            errors.push(format!("Board unavailable: {error}"));
            return;
        }
    };
    let mut tasks = BTreeMap::<String, Value>::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("created") => {
                if let Some(task) = event.get("task") {
                    if let Some(id) = task.get("id").and_then(Value::as_str) {
                        tasks.insert(id.into(), task.clone());
                    }
                }
            }
            Some("updated") => {
                if let Some(id) = event.get("id").and_then(Value::as_str) {
                    if let (Some(task), Some(patch)) = (
                        tasks.get_mut(id).and_then(Value::as_object_mut),
                        event.get("patch").and_then(Value::as_object),
                    ) {
                        for (key, value) in patch {
                            task.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (id, task) in tasks.into_iter().rev() {
        if task.get("lane").and_then(Value::as_str) == Some("done") {
            continue;
        }
        let title = task.get("title").and_then(Value::as_str).unwrap_or(&id);
        let notes = task.get("notes").and_then(Value::as_str).unwrap_or("");
        let coordinate = task.get("coordinate").and_then(Value::as_str).unwrap_or("");
        let relevance = overlap(query_terms, &format!("{title} {notes} {coordinate}"));
        if coordinate != workspace_root && relevance == 0 {
            continue;
        }
        out.push(candidate(
            "board-task",
            &id,
            None,
            title,
            "task",
            &truncate(notes, 1_200),
            Some(path.display().to_string()),
            task.get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            None,
            "canonical HII board event log",
            vec![if coordinate == workspace_root {
                "task belongs to this workspace".into()
            } else {
                "task matched intent".into()
            }],
            620 + relevance as i64,
            false,
        ));
        if out
            .iter()
            .filter(|item| item.item.context_ref.kind == "board-task")
            .count()
            >= 6
        {
            break;
        }
    }
}

fn collect_skills(
    runtime: &Path,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let path = runtime.join("skills/_index.json");
    let raw = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            errors.push(format!("Skill index unavailable: {error}"));
            return;
        }
    };
    let value = match serde_json::from_str::<Value>(&raw) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Skill index invalid: {error}"));
            return;
        }
    };
    for skill in value.as_array().into_iter().flatten() {
        let id = skill.get("id").and_then(Value::as_str).unwrap_or("");
        let title = skill.get("name").and_then(Value::as_str).unwrap_or(id);
        let summary = skill
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("");
        let relevance = overlap(query_terms, &format!("{id} {title} {summary}"));
        if relevance == 0 {
            continue;
        }
        out.push(candidate(
            "skill",
            id,
            None,
            title,
            "skill-summary",
            summary,
            Some(path.display().to_string()),
            None,
            None,
            "reviewed HII skill index",
            vec!["skill summary matched intent".into()],
            430 + relevance as i64,
            false,
        ));
    }
}

fn collect_capability_jobs(
    runtime: &Path,
    workspace_root: &str,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let path = runtime.join("capability-jobs.jsonl");
    let file = match fs::File::open(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            errors.push(format!("Capability jobs unavailable: {error}"));
            return;
        }
    };
    let mut jobs = BTreeMap::<String, Value>::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Ok(job) = serde_json::from_str::<Value>(&line) {
            if let Some(id) = job.get("id").and_then(Value::as_str) {
                jobs.insert(id.into(), job);
            }
        }
    }
    for (id, job) in jobs.into_iter().rev() {
        let title = job
            .get("inputSummary")
            .and_then(Value::as_str)
            .unwrap_or(&id);
        let root = job
            .pointer("/metadata/workspaceRoot")
            .and_then(Value::as_str)
            .unwrap_or("");
        let relevance = overlap(query_terms, title);
        if root != workspace_root && relevance == 0 {
            continue;
        }
        let status = job
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        out.push(candidate(
            "capability-run",
            &id,
            None,
            title,
            "capability-run",
            &format!("status: {status}"),
            Some(path.display().to_string()),
            job.get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            None,
            "canonical HII capability job ledger",
            vec![if root == workspace_root {
                "capability run belongs to this workspace".into()
            } else {
                "capability run matched intent".into()
            }],
            610 + relevance as i64,
            false,
        ));
        if out
            .iter()
            .filter(|item| item.item.context_ref.kind == "capability-run")
            .count()
            >= 4
        {
            break;
        }
    }
}

fn collect_receipts(
    runtime: &Path,
    workspace_root: &str,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let root = runtime.join("runs/cli");
    let entries = match fs::read_dir(&root) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            errors.push(format!("Receipts unavailable: {error}"));
            return;
        }
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path().join("receipt.json"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| right.cmp(left));
    for path in paths.into_iter().take(80) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(receipt) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if receipt.get("workspace").and_then(Value::as_str) != Some(workspace_root) {
            continue;
        }
        let goal = receipt.get("goal").and_then(Value::as_str).unwrap_or("");
        let summary = receipt.get("summary").and_then(Value::as_str).unwrap_or("");
        let status = receipt
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let relevance = overlap(query_terms, &format!("{goal} {summary}"));
        let unresolved = status != "completed";
        if relevance == 0 && !unresolved {
            continue;
        }
        let id = receipt
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                path.parent()
                    .and_then(Path::file_name)
                    .and_then(|value| value.to_str())
                    .unwrap_or("receipt")
            });
        out.push(candidate(
            "receipt",
            id,
            None,
            &truncate(goal, 240),
            "run-receipt",
            &format!(
                "{}; record={}",
                truncate(summary, 1_600),
                if unresolved {
                    "unresolved-unverified"
                } else {
                    "verified-history"
                }
            ),
            Some(path.display().to_string()),
            receipt
                .get("finished_at_unix_ms")
                .map(|value| value.to_string()),
            Some(sha256(raw.as_bytes())),
            "HII CLI receipt",
            vec![if unresolved {
                "unfinished workspace receipt preserves continuation".into()
            } else {
                "prior receipt matched intent".into()
            }],
            if unresolved {
                690
            } else {
                640 + relevance as i64
            },
            false,
        ));
        if out
            .iter()
            .filter(|item| item.item.context_ref.kind == "receipt")
            .count()
            >= 5
        {
            break;
        }
    }
}

fn collect_operations(
    connection: &Connection,
    space_id: &str,
    query_terms: &[String],
    out: &mut Vec<Candidate>,
    errors: &mut Vec<String>,
) {
    let mut statement = match connection.prepare(
        "SELECT id, type, target_id, payload_json, created_at FROM operational_operations
         WHERE space_id=?1 ORDER BY lamport DESC LIMIT 40",
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Operational history unavailable: {error}"));
            return;
        }
    };
    let rows = match statement.query_map([space_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    }) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("Operational history unreadable: {error}"));
            return;
        }
    };
    for row in rows.flatten() {
        let relevance = overlap(query_terms, &format!("{} {}", row.1, row.3));
        if relevance == 0 {
            continue;
        }
        out.push(candidate(
            "runtime-event",
            &row.0,
            Some(space_id),
            &row.1,
            "runtime-event",
            &truncate(&row.3, 1_000),
            row.2,
            Some(row.4),
            None,
            "append-only HII Runtime history",
            vec!["recent same-Space event matched intent".into()],
            330 + relevance as i64,
            false,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn candidate(
    kind: &str,
    id: &str,
    scope: Option<&str>,
    title: &str,
    item_type: &str,
    summary: &str,
    source: Option<String>,
    revision: Option<String>,
    sha256_value: Option<String>,
    provenance: &str,
    relevance_reasons: Vec<String>,
    score: i64,
    selected: bool,
) -> Candidate {
    let summary = truncate(&redact(summary), 2_400);
    let title = truncate(&redact(title), 240);
    let blocked_reason = source
        .as_deref()
        .filter(|source| sensitive_source(source))
        .map(|_| "secret-like sources cannot enter a ContextPack".into());
    Candidate {
        item: ContextPackItemV1 {
            context_ref: ContextRefV1 {
                kind: kind.into(),
                id: id.into(),
                scope: scope.map(str::to_string),
                anchor: None,
            },
            title,
            item_type: item_type.into(),
            estimated_tokens: estimate_tokens(summary.len() + provenance.len() + 160),
            summary,
            source,
            revision,
            sha256: sha256_value,
            provenance: provenance.into(),
            transmission_scope: "local-only".into(),
            relevance_reasons,
            selected,
        },
        score,
        blocked_reason,
    }
}

fn fingerprint(
    request: &ContextCompileRequestV1,
    space_id: &str,
    workspace_root: &str,
    budget: u64,
    items: &[ContextPackItemV1],
    excluded: &[ContextExclusionV1],
    transmission_scope: &str,
) -> Result<String, String> {
    let value = json!({
        "intent": request.intent,
        "spaceId": space_id,
        "workspaceRoot": workspace_root,
        "actor": request.actor,
        "authority": request.authority,
        "mode": request.mode,
        "budgetTokens": budget,
        "transmissionScope": transmission_scope,
        "items": items,
        "excluded": excluded,
    });
    Ok(sha256(
        &serde_json::to_vec(&value).map_err(|error| error.to_string())?,
    ))
}

fn validate_request(request: &ContextCompileRequestV1) -> Result<(), String> {
    if request.version != 1 {
        return Err(format!(
            "Unsupported ContextPack contract version {}",
            request.version
        ));
    }
    let intent = request.intent.trim();
    if intent.is_empty() || intent.chars().count() > 16_000 {
        return Err("Context compilation needs an intent between 1 and 16000 characters.".into());
    }
    if request.selected_object_ids.len() > MAX_SELECTED_OBJECTS {
        return Err(format!(
            "Context compilation accepts at most {MAX_SELECTED_OBJECTS} selected objects."
        ));
    }
    if request.excluded_object_ids.len() > MAX_SELECTED_OBJECTS {
        return Err(format!(
            "Context compilation accepts at most {MAX_SELECTED_OBJECTS} excluded objects."
        ));
    }
    if !matches!(
        request.mode.as_str(),
        "build" | "plan" | "browse" | "see" | "show"
    ) {
        return Err(format!("Unsupported HII canvas mode: {}", request.mode));
    }
    if !matches!(
        request.authority.as_str(),
        "read-only" | "workspace" | "external-preview" | "external-commit"
    ) {
        return Err(format!("Unsupported HII authority: {}", request.authority));
    }
    Ok(())
}

fn terms(value: &str) -> Vec<String> {
    let stop = [
        "the", "and", "for", "with", "this", "that", "from", "into", "what", "should", "hii",
    ];
    let mut found = value
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .map(str::to_ascii_lowercase)
        .filter(|term| term.len() > 2 && !stop.contains(&term.as_str()))
        .collect::<Vec<_>>();
    found.sort();
    found.dedup();
    found.truncate(12);
    found
}

fn fts_query(value: &str) -> Option<String> {
    let terms = terms(value);
    (!terms.is_empty()).then(|| {
        terms
            .into_iter()
            .map(|term| format!("\"{}\"", term.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

fn overlap(query_terms: &[String], value: &str) -> usize {
    let value = value.to_ascii_lowercase();
    query_terms
        .iter()
        .filter(|term| value.contains(term.as_str()))
        .count()
}

fn object_summary(value: &Value) -> String {
    for pointer in [
        "/payload/content",
        "/payload/text",
        "/payload/summary",
        "/payload/excerpt",
        "/payload/url",
        "/payload/path",
        "/object/status",
    ] {
        if let Some(text) = value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            return truncate(text, 2_400);
        }
    }
    truncate(&value.to_string(), 1_200)
}

fn value_text(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
    })
}

fn table_exists(connection: &Connection, name: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE (type='table' OR type='view') AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn sensitive_source(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        ".env",
        "id_rsa",
        "id_ed25519",
        "credentials",
        "private_key",
        "secret",
        "token",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn redact(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            if [
                "API_KEY",
                "ACCESS_KEY",
                "SECRET",
                "TOKEN",
                "PASSWORD",
                "PRIVATE KEY",
                "AUTHORIZATION:",
            ]
            .iter()
            .any(|marker| upper.contains(marker))
                || line.contains("sk-")
                || line.contains("ghp_")
                || line.contains("hii_runner_")
            {
                "[redacted]".into()
            } else {
                line.into()
            }
        })
        .collect::<Vec<String>>()
        .join("\n")
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect::<String>()
}

fn estimate_tokens(characters: usize) -> u64 {
    ((characters as u64).saturating_add(3) / 4).max(1)
}

fn sha256(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn json_string(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn status_name(status: &ContextPackStatusV1) -> &'static str {
    match status {
        ContextPackStatusV1::Draft => "draft",
        ContextPackStatusV1::Approved => "approved",
        ContextPackStatusV1::Stale => "stale",
        ContextPackStatusV1::Blocked => "blocked",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn runtime() -> PathBuf {
        std::env::temp_dir().join(format!("hii-context-pack-{}", Uuid::new_v4()))
    }

    fn request(root: &Path) -> ContextCompileRequestV1 {
        ContextCompileRequestV1 {
            version: 1,
            space_id: Some("default".into()),
            workspace_root: Some(root.display().to_string()),
            intent: "continue the launch decision".into(),
            selected_object_ids: vec!["launch".into()],
            excluded_object_ids: Vec::new(),
            actor: IdentityRefV1 {
                id: "human:local".into(),
                kind: "human".into(),
            },
            authority: "read-only".into(),
            mode: "plan".into(),
            budget_tokens: Some(2_000),
            previous_fingerprint: None,
        }
    }

    fn initialize(runtime: &Path, root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("AGENTS.md"), "Keep proof source-linked.").unwrap();
        let document = json!({
            "version": 1, "revision": 0, "updatedAt": "2026-08-28T00:00:00Z",
            "viewport": {"x":0,"y":0,"zoom":1}, "nextZ": 2,
            "nodes": [{"id":"launch","type":"note","x":0,"y":0,"w":200,"h":100,"z":1,"createdAt":"2026-08-28T00:00:00Z","updatedAt":"2026-08-28T00:00:00Z","payload":{"title":"Launch decision","content":"Ship the bounded context spine first."}}],
            "links": []
        });
        crate::runtime::initialize_space(runtime, "default", &document).unwrap();
    }

    #[test]
    fn account_context_never_retrieves_ambient_machine_instructions() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let connection = database(&runtime).unwrap();
        connection.execute_batch("CREATE TABLE hii_account_workspace_sync (workspace_id TEXT PRIMARY KEY); INSERT INTO hii_account_workspace_sync VALUES ('default');").unwrap();
        let pack = compile(&runtime, &request(&root)).unwrap();
        assert!(!pack.items.is_empty());
        assert!(pack
            .items
            .iter()
            .all(|item| item.selected && item.context_ref.kind == "runtime-object"));
        assert!(!serde_json::to_string(&pack)
            .unwrap()
            .contains("Keep proof source-linked"));
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn review_exclusions_override_selection_and_ambient_retrieval() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let original = compile(&runtime, &request(&root)).unwrap();
        for (selected, excluded) in [
            (vec![], "launch"),
            (vec!["launch".into()], "workspace:default:object:launch"),
            (vec!["workspace:default:object:launch".into()], "launch"),
        ] {
            let mut reviewed = request(&root);
            reviewed.selected_object_ids = selected;
            reviewed.excluded_object_ids = vec![excluded.into()];
            reviewed.previous_fingerprint = Some(original.fingerprint.clone());
            let pack = compile(&runtime, &reviewed).unwrap();
            assert!(!pack
                .items
                .iter()
                .any(|item| item.context_ref.id == "workspace:default:object:launch"));
            assert!(!pack
                .items
                .iter()
                .any(|item| item.summary.contains("bounded context spine")));
            assert!(pack.excluded.iter().any(|item| item.context_ref.id
                == "workspace:default:object:launch"
                && item.reason.contains("explicitly excluded")));
            assert_ne!(pack.risk.action, ContextRiskActionV1::Blocked);
            assert!(pack.changed_since_previous);
            let approved = approve(
                &runtime,
                &ContextApproveRequestV1 {
                    version: 1,
                    pack_id: pack.id.clone(),
                    fingerprint: pack.fingerprint.clone(),
                    approved_by: reviewed.actor.clone(),
                },
            )
            .unwrap();
            assert!(require_approved(&runtime, &approved.id, &approved.fingerprint).is_ok());
        }
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn excluded_objects_cannot_return_through_targeted_operational_history() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let mut snapshot = crate::runtime::read_space(&runtime, "default")
            .unwrap()
            .unwrap();
        snapshot.document["nodes"][0]["payload"]["content"] = json!("updated launch content");
        crate::runtime::apply_space(
            &runtime,
            "default",
            &crate::runtime::RuntimeSpaceApplyV1 {
                version: 1,
                space_id: Some("default".into()),
                expected_sequence: 0,
                actor: request(&root).actor,
                authority_grant_id: None,
                run_id: None,
                idempotency_key: "context-exclusion-history".into(),
                document: snapshot.document,
            },
        )
        .unwrap();
        let mut reviewed = request(&root);
        reviewed.selected_object_ids.clear();
        reviewed.excluded_object_ids = vec!["launch".into()];
        reviewed.authority = "external-preview".into();
        let pack = compile(&runtime, &reviewed).unwrap();
        assert!(pack.items.iter().all(|item| item.context_ref.id
            != "workspace:default:object:launch"
            && item.source.as_deref() != Some("workspace:default:object:launch")));
        assert!(pack
            .items
            .iter()
            .all(|item| !item.summary.contains("launch content")));
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn legacy_requests_default_to_no_explicit_exclusions() {
        let mut value = serde_json::to_value(request(Path::new("."))).unwrap();
        value.as_object_mut().unwrap().remove("excludedObjectIds");
        let decoded: ContextCompileRequestV1 = serde_json::from_value(value).unwrap();
        assert!(decoded.excluded_object_ids.is_empty());
    }

    #[test]
    fn selected_context_is_bounded_persisted_and_fingerprint_approved() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let pack = compile(&runtime, &request(&root)).unwrap();
        assert!(pack.budget.used_tokens <= 2_000);
        assert_eq!(pack.risk.action, ContextRiskActionV1::AutoStart);
        assert!(pack
            .items
            .iter()
            .any(|item| item.selected && item.title == "Launch decision"));
        assert_eq!(
            get(&runtime, &pack.id).unwrap().fingerprint,
            pack.fingerprint
        );
        let approved = approve(
            &runtime,
            &ContextApproveRequestV1 {
                version: 1,
                pack_id: pack.id.clone(),
                fingerprint: pack.fingerprint.clone(),
                approved_by: IdentityRefV1 {
                    id: "policy:local-readonly".into(),
                    kind: "service".into(),
                },
            },
        )
        .unwrap();
        assert_eq!(approved.status, ContextPackStatusV1::Approved);
        assert!(require_approved(&runtime, &pack.id, &pack.fingerprint).is_ok());
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn write_scope_requires_review_and_missing_selection_blocks() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let mut write = request(&root);
        write.mode = "build".into();
        write.authority = "workspace".into();
        let review = compile(&runtime, &write).unwrap();
        assert_eq!(review.risk.action, ContextRiskActionV1::Review);
        assert!(approve(
            &runtime,
            &ContextApproveRequestV1 {
                version: 1,
                pack_id: review.id.clone(),
                fingerprint: review.fingerprint.clone(),
                approved_by: IdentityRefV1 {
                    id: "policy:local-readonly".into(),
                    kind: "service".into(),
                },
            },
        )
        .unwrap_err()
        .contains("only unchanged local read-only"));

        let mut external = request(&root);
        external.authority = "external-preview".into();
        let external = compile(&runtime, &external).unwrap();
        assert_eq!(external.transmission_scope, "external-model");
        assert!(external
            .items
            .iter()
            .all(|item| item.transmission_scope == "external-model"));

        let mut missing = request(&root);
        missing.selected_object_ids = vec!["does-not-exist".into()];
        let blocked = compile(&runtime, &missing).unwrap();
        assert_eq!(blocked.status, ContextPackStatusV1::Blocked);
        assert_eq!(blocked.risk.action, ContextRiskActionV1::Blocked);
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn identical_inputs_produce_the_same_fingerprint() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let first = compile(&runtime, &request(&root)).unwrap();
        let second = compile(&runtime, &request(&root)).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(first.fingerprint, second.fingerprint);
        fs::remove_dir_all(runtime).unwrap();
    }

    #[test]
    fn changed_source_invalidates_approval() {
        let runtime = runtime();
        let root = runtime.join("workspace");
        initialize(&runtime, &root);
        let pack = compile(&runtime, &request(&root)).unwrap();
        approve(
            &runtime,
            &ContextApproveRequestV1 {
                version: 1,
                pack_id: pack.id.clone(),
                fingerprint: pack.fingerprint.clone(),
                approved_by: IdentityRefV1 {
                    id: "human:local".into(),
                    kind: "human".into(),
                },
            },
        )
        .unwrap();
        fs::write(root.join("AGENTS.md"), "Changed instructions.").unwrap();
        assert!(require_approved(&runtime, &pack.id, &pack.fingerprint)
            .unwrap_err()
            .contains("changed"));
        assert_eq!(
            get(&runtime, &pack.id).unwrap().status,
            ContextPackStatusV1::Stale
        );
        fs::remove_dir_all(runtime).unwrap();
    }
}
