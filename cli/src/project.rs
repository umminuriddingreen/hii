// SPDX-License-Identifier: LicenseRef-BSL-1.1
//! HII's project operating model for physical work.
//!
//! The first profile is architectural delivery, but the substrate is broader:
//! objectives, KPIs, stakeholder questions, dependent tasks, budget lines,
//! supplier needs, quotes, approvals, and evidence live in one revisioned local
//! object. Prices are planning estimates until source-backed quotes replace the
//! allowances; no estimate is represented as a bid or professional certification.

use chrono::Utc;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const MAX_OPTIONS: usize = 8;
const BASIS_POINTS: u64 = 10_000;

const PHASES: [PhaseSpec; 4] = [
    PhaseSpec {
        code: "sd",
        name: "Schematic Design",
        weight_bps: 2_000,
        jobs: [
            "Verify site and existing conditions",
            "Confirm program, objectives, and decision criteria",
            "Generate and compare design alternatives",
            "Coordinate initial structure, enclosure, and building systems",
            "Issue SD cost, schedule, risk, and owner-decision package",
        ],
    },
    PhaseSpec {
        code: "dd",
        name: "Design Development",
        weight_bps: 2_500,
        jobs: [
            "Resolve the selected design and major dimensions",
            "Coordinate structural, MEP, civil, landscape, and specialist inputs",
            "Develop envelope, materials, assemblies, and performance targets",
            "Review code, accessibility, life-safety, and jurisdictional issues",
            "Issue DD cost, schedule, coordination, and owner-approval package",
        ],
    },
    PhaseSpec {
        code: "cd",
        name: "Construction Documents",
        weight_bps: 4_000,
        jobs: [
            "Produce coordinated drawings, schedules, and specifications",
            "Integrate consultant documents and resolve clashes",
            "Develop construction details and system interfaces",
            "Perform constructability, completeness, and QA review",
            "Issue permit or construction set with documented review boundary",
        ],
    },
    PhaseSpec {
        code: "active-project-development",
        name: "Active Project Development",
        weight_bps: 1_500,
        jobs: [
            "Coordinate procurement, supplier questions, and submittals",
            "Track RFIs, decisions, revisions, and change exposure",
            "Observe work and record source-linked field issues",
            "Update cost, schedule, risk, and stakeholder communications",
            "Verify closeout, unresolved items, and record information",
        ],
    },
];

const SYSTEM_ALLOCATIONS: [SystemAllocation; 11] = [
    SystemAllocation {
        id: "site-civil",
        name: "Site and civil",
        weight_bps: 800,
        needs_quote: true,
    },
    SystemAllocation {
        id: "structure",
        name: "Structure",
        weight_bps: 1_500,
        needs_quote: true,
    },
    SystemAllocation {
        id: "enclosure",
        name: "Envelope and enclosure",
        weight_bps: 1_300,
        needs_quote: true,
    },
    SystemAllocation {
        id: "interiors",
        name: "Interiors and finishes",
        weight_bps: 1_500,
        needs_quote: true,
    },
    SystemAllocation {
        id: "mechanical",
        name: "Mechanical systems",
        weight_bps: 1_000,
        needs_quote: true,
    },
    SystemAllocation {
        id: "electrical",
        name: "Electrical and lighting",
        weight_bps: 800,
        needs_quote: true,
    },
    SystemAllocation {
        id: "plumbing-fire",
        name: "Plumbing and fire protection",
        weight_bps: 700,
        needs_quote: true,
    },
    SystemAllocation {
        id: "equipment",
        name: "Equipment and furnishings",
        weight_bps: 400,
        needs_quote: true,
    },
    SystemAllocation {
        id: "general-conditions",
        name: "General conditions and logistics",
        weight_bps: 800,
        needs_quote: true,
    },
    SystemAllocation {
        id: "design-permits",
        name: "Design, consultants, permits, and insurance",
        weight_bps: 700,
        needs_quote: false,
    },
    SystemAllocation {
        id: "construction-contingency",
        name: "Construction contingency",
        weight_bps: 500,
        needs_quote: false,
    },
];

#[derive(Clone, Copy)]
struct PhaseSpec {
    code: &'static str,
    name: &'static str,
    weight_bps: u32,
    jobs: [&'static str; 5],
}

#[derive(Clone, Copy)]
struct SystemAllocation {
    id: &'static str,
    name: &'static str,
    weight_bps: u32,
    needs_quote: bool,
}

#[derive(Debug, Clone)]
pub struct CreateOptions {
    pub name: String,
    pub project_type: String,
    pub location: Option<String>,
    pub currency: String,
    pub construction_budget: Option<String>,
    pub base_hours: u64,
    pub blended_rate: String,
    pub consultant_allowance: String,
    pub direct_costs: String,
    pub contingency_bps: u32,
    pub markup_bps: u32,
    pub total_weeks: u32,
    pub option_count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct RepriceOptions {
    pub base_hours: Option<u64>,
    pub blended_rate: Option<String>,
    pub consultant_allowance: Option<String>,
    pub direct_costs: Option<String>,
    pub contingency_bps: Option<u32>,
    pub markup_bps: Option<u32>,
    pub total_weeks: Option<u32>,
    pub option_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u8,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub project_type: String,
    pub location: Option<String>,
    pub currency: String,
    pub construction_budget_minor: Option<u64>,
    pub revision: u64,
    pub status: String,
    pub current_phase: String,
    pub selected_option_id: Option<String>,
    pub objectives: Vec<Objective>,
    pub kpis: Vec<Kpi>,
    pub stakeholders: Vec<Stakeholder>,
    pub questions: Vec<StakeholderQuestion>,
    pub tasks: Vec<ProjectTask>,
    pub budget_lines: Vec<BudgetLine>,
    pub supplier_needs: Vec<SupplierNeed>,
    pub pricing_basis: PricingBasis,
    pub delivery_options: Vec<DeliveryOption>,
    pub approvals: Vec<Approval>,
    pub events: Vec<ProjectEvent>,
    pub assumptions: Vec<String>,
    pub exclusions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Objective {
    pub id: String,
    pub title: String,
    pub owner: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kpi {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub target: String,
    pub calculation: String,
    pub owner: String,
    pub current_value: Option<String>,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stakeholder {
    pub id: String,
    pub name: String,
    pub role: String,
    pub decision_scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StakeholderQuestion {
    pub id: String,
    pub question: String,
    pub asked_by: String,
    pub owner: String,
    pub status: String,
    pub answer: Option<String>,
    pub source_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub id: String,
    pub phase: String,
    pub system: String,
    pub title: String,
    pub owner: String,
    pub status: String,
    pub depends_on: Vec<String>,
    pub objective_ids: Vec<String>,
    pub kpi_ids: Vec<String>,
    pub budget_line_ids: Vec<String>,
    pub stakeholder_question_ids: Vec<String>,
    pub evidence_required: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLine {
    pub id: String,
    pub system: String,
    pub description: String,
    pub allowance_minor: u64,
    pub quoted_minor: Option<u64>,
    pub committed_minor: u64,
    pub forecast_minor: u64,
    pub source: String,
    pub source_url: Option<String>,
    pub confidence: String,
    pub needs_quote: bool,
    pub supplier_need_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierNeed {
    pub id: String,
    pub budget_line_id: String,
    pub category: String,
    pub requirements: String,
    pub location: Option<String>,
    pub status: String,
    pub suppliers: Vec<Supplier>,
    pub contact_draft: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplier {
    pub id: String,
    pub name: String,
    pub url: Option<String>,
    pub contact: Option<String>,
    pub quote_minor: Option<u64>,
    pub quote_source: Option<String>,
    pub discovery_excerpt: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingBasis {
    pub basis: String,
    pub base_hours: u64,
    pub blended_rate_minor: u64,
    pub consultant_allowance_minor: u64,
    pub direct_costs_minor: u64,
    pub contingency_bps: u32,
    pub markup_bps: u32,
    pub total_weeks: u32,
    pub option_count: usize,
    pub phase_weights_bps: Vec<PhaseWeight>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseWeight {
    pub phase: String,
    pub weight_bps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub scope_multiplier_bps: u32,
    pub design_variants: u32,
    pub iteration_rounds: u32,
    pub total_hours: u64,
    pub duration_weeks: u32,
    pub phases: Vec<PhaseEstimate>,
    pub subtotal_minor: u64,
    pub contingency_minor: u64,
    pub markup_minor: u64,
    pub total_minor: u64,
    pub effective_percent_of_construction_budget_bps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseEstimate {
    pub phase: String,
    pub name: String,
    pub phase_weight_bps: u32,
    pub labor_hours: u64,
    pub duration_weeks: u32,
    pub deliverables: Vec<String>,
    pub line_items: Vec<PriceLine>,
    pub total_minor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceLine {
    pub id: String,
    pub category: String,
    pub description: String,
    pub quantity: u64,
    pub unit: String,
    pub unit_rate_minor: u64,
    pub total_minor: u64,
    pub source: String,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub scope: String,
    pub project_revision: u64,
    pub option_id: Option<String>,
    pub actor: String,
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEvent {
    pub event: String,
    pub actor: String,
    pub detail: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Triage {
    pub schema_version: u8,
    pub kind: String,
    pub project_id: String,
    pub project_revision: u64,
    pub current_phase: String,
    pub kpis: Vec<KpiReading>,
    pub attention: Vec<AttentionItem>,
    pub next_actions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KpiReading {
    pub id: String,
    pub name: String,
    pub value: String,
    pub target: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub priority: String,
    pub kind: String,
    pub id: String,
    pub summary: String,
}

pub fn create(runtime: &Path, options: CreateOptions) -> Result<Project, String> {
    validate_options(
        options.option_count,
        options.base_hours,
        options.contingency_bps,
        options.markup_bps,
        options.total_weeks,
    )?;
    let currency = normalize_currency(&options.currency)?;
    let budget = options
        .construction_budget
        .as_deref()
        .map(parse_money)
        .transpose()?;
    let pricing_basis = PricingBasis {
        basis:
            "planning estimate from explicit hours, rates, allowances, and basis-point adjustments"
                .into(),
        base_hours: options.base_hours,
        blended_rate_minor: parse_money(&options.blended_rate)?,
        consultant_allowance_minor: parse_money(&options.consultant_allowance)?,
        direct_costs_minor: parse_money(&options.direct_costs)?,
        contingency_bps: options.contingency_bps,
        markup_bps: options.markup_bps,
        total_weeks: options.total_weeks,
        option_count: options.option_count,
        phase_weights_bps: PHASES
            .iter()
            .map(|phase| PhaseWeight {
                phase: phase.code.into(),
                weight_bps: phase.weight_bps,
            })
            .collect(),
    };
    let now = now();
    let project_id = format!(
        "{}-{}",
        slug(&options.name),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let (budget_lines, supplier_needs) = build_system_budget(budget, options.location.as_deref());
    let mut project = Project {
        schema_version: SCHEMA_VERSION,
        kind: "hii.project/1".into(),
        id: project_id,
        name: options.name.trim().to_string(),
        project_type: options.project_type.trim().to_string(),
        location: options
            .location
            .clone()
            .filter(|value| !value.trim().is_empty()),
        currency,
        construction_budget_minor: budget,
        revision: 1,
        status: "planning".into(),
        current_phase: PHASES[0].code.into(),
        selected_option_id: None,
        objectives: vec![Objective {
            id: "deliver-project".into(),
            title: "Deliver the approved project scope within the governed budget, schedule, quality, and review boundaries".into(),
            owner: "project sponsor".into(),
            status: "active".into(),
        }],
        kpis: default_kpis(),
        stakeholders: vec![Stakeholder {
            id: "project-sponsor".into(),
            name: "Local operator".into(),
            role: "Project sponsor".into(),
            decision_scope: "Scope, budget, phase gates, supplier contact, purchasing, and external commitments".into(),
        }],
        questions: initial_questions(&options),
        tasks: build_tasks(),
        budget_lines,
        supplier_needs,
        delivery_options: generate_options(&pricing_basis, budget)?,
        pricing_basis,
        approvals: Vec::new(),
        events: vec![ProjectEvent {
            event: "project.created".into(),
            actor: "local operator".into(),
            detail: "Created the project, planning estimates, task graph, KPI set, budget allowances, and supplier requirements".into(),
            created_at: now.clone(),
        }],
        assumptions: vec![
            "All prices are planning estimates in integer minor currency units until replaced by source-backed quotes.".into(),
            "Default system allocations are a completeness checklist and budget hypothesis, not a contractor bid.".into(),
            "SD, DD, CD, and Active Project Development phase weights are configurable planning assumptions.".into(),
            "Supplier discovery may collect public sources; outreach, purchasing, and other external commitments require separate explicit approval.".into(),
        ],
        exclusions: vec![
            "Professional licensure, stamped documents, code certification, survey, engineering, legal advice, and construction commitments are not implied.".into(),
            "Taxes, escalation, financing, unknown conditions, and location-specific requirements are excluded unless entered as line items or quotes.".into(),
        ],
        created_at: now.clone(),
        updated_at: now,
    };
    validate_project(&project)?;
    save(runtime, &project)?;
    project.events.shrink_to_fit();
    Ok(project)
}

pub fn list(runtime: &Path) -> Result<Vec<Project>, String> {
    let graph_values = hii_core::operational::list_projects(runtime)?;
    let mut projects = if graph_values.is_empty() {
        snapshot_projects(runtime)?
    } else {
        graph_values
            .into_iter()
            .map(|value| {
                let project = serde_json::from_value::<Project>(value)
                    .map_err(|error| format!("invalid graph-native project state: {error}"))?;
                validate_project(&project)?;
                Ok(project)
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    projects.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(projects)
}

pub fn load(runtime: &Path, id: &str) -> Result<Project, String> {
    let matches = list(runtime)?
        .into_iter()
        .filter(|project| project.id == id || project.id.starts_with(id))
        .collect::<Vec<_>>();
    match matches.len() {
        0 => Err(format!("project not found: {id}")),
        1 => Ok(matches.into_iter().next().expect("one match")),
        _ => Err(format!("project id is ambiguous: {id}")),
    }
}

pub fn reprice(runtime: &Path, id: &str, options: RepriceOptions) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let mut basis = project.pricing_basis.clone();
    if let Some(value) = options.base_hours {
        basis.base_hours = value;
    }
    if let Some(value) = options.blended_rate {
        basis.blended_rate_minor = parse_money(&value)?;
    }
    if let Some(value) = options.consultant_allowance {
        basis.consultant_allowance_minor = parse_money(&value)?;
    }
    if let Some(value) = options.direct_costs {
        basis.direct_costs_minor = parse_money(&value)?;
    }
    if let Some(value) = options.contingency_bps {
        basis.contingency_bps = value;
    }
    if let Some(value) = options.markup_bps {
        basis.markup_bps = value;
    }
    if let Some(value) = options.total_weeks {
        basis.total_weeks = value;
    }
    if let Some(value) = options.option_count {
        basis.option_count = value;
    }
    validate_options(
        basis.option_count,
        basis.base_hours,
        basis.contingency_bps,
        basis.markup_bps,
        basis.total_weeks,
    )?;
    project.delivery_options = generate_options(&basis, project.construction_budget_minor)?;
    project.pricing_basis = basis;
    project.selected_option_id = None;
    material_change(&mut project, "project.repriced", "Regenerated delivery options; prior option selection and revision-scoped approvals were invalidated");
    save(runtime, &project)?;
    Ok(project)
}

pub fn select_option(
    runtime: &Path,
    id: &str,
    option_id: &str,
    actor: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let option = project
        .delivery_options
        .iter()
        .find(|option| option.id == option_id || option.id.starts_with(option_id))
        .ok_or_else(|| format!("delivery option not found: {option_id}"))?;
    let selected = option.id.clone();
    material_change(
        &mut project,
        "option.selected",
        &format!("Selected delivery option {selected}"),
    );
    project.selected_option_id = Some(selected.clone());
    project.approvals.push(Approval {
        id: Uuid::new_v4().to_string(),
        scope: "delivery-option-selection".into(),
        project_revision: project.revision,
        option_id: Some(selected),
        actor: required_text(actor, "approval actor")?,
        note: "Approved for planning and internal activation only; external commitments remain separately gated".into(),
        created_at: now(),
    });
    save(runtime, &project)?;
    Ok(project)
}

pub fn complete_task(
    runtime: &Path,
    id: &str,
    task_id: &str,
    evidence: &[String],
    actor: &str,
) -> Result<Project, String> {
    if evidence.is_empty() || evidence.iter().any(|item| item.trim().is_empty()) {
        return Err("task completion requires at least one --evidence reference".into());
    }
    if !evidence
        .iter()
        .any(|item| item.trim().starts_with("receipt:"))
    {
        return Err("task completion requires a receipt:<id> evidence reference".into());
    }
    let mut project = load(runtime, id)?;
    let index = project
        .tasks
        .iter()
        .position(|task| task.id == task_id || task.id.starts_with(task_id))
        .ok_or_else(|| format!("task not found: {task_id}"))?;
    let blockers = project.tasks[index]
        .depends_on
        .iter()
        .filter(|dependency| {
            project
                .tasks
                .iter()
                .any(|task| &task.id == *dependency && task.status != "completed")
        })
        .cloned()
        .collect::<Vec<_>>();
    if !blockers.is_empty() {
        return Err(format!(
            "task is blocked by incomplete dependencies: {}",
            blockers.join(", ")
        ));
    }
    project.tasks[index].status = "completed".into();
    project.tasks[index].evidence_refs = evidence
        .iter()
        .map(|item| item.trim().to_string())
        .collect();
    let completed_task_id = project.tasks[index].id.clone();
    touch(
        &mut project,
        "task.completed",
        actor,
        &format!(
            "Completed {} with {} evidence reference(s)",
            completed_task_id,
            evidence.len()
        ),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn add_question(
    runtime: &Path,
    id: &str,
    question: &str,
    asked_by: &str,
    owner: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    project.questions.push(StakeholderQuestion {
        id: format!("question-{}", &Uuid::new_v4().simple().to_string()[..8]),
        question: required_text(question, "question")?,
        asked_by: required_text(asked_by, "stakeholder")?,
        owner: required_text(owner, "question owner")?,
        status: "open".into(),
        answer: None,
        source_refs: Vec::new(),
    });
    material_change(
        &mut project,
        "question.added",
        &format!(
            "{asked_by} added a stakeholder question; prior revision-scoped approvals are now historical"
        ),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn add_stakeholder(
    runtime: &Path,
    id: &str,
    name: &str,
    role: &str,
    decision_scope: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let base = slug(name);
    let stakeholder_id = if project.stakeholders.iter().any(|item| item.id == base) {
        format!("{}-{}", base, &Uuid::new_v4().simple().to_string()[..6])
    } else {
        base
    };
    project.stakeholders.push(Stakeholder {
        id: stakeholder_id,
        name: required_text(name, "stakeholder name")?,
        role: required_text(role, "stakeholder role")?,
        decision_scope: required_text(decision_scope, "decision scope")?,
    });
    material_change(
        &mut project,
        "stakeholder.added",
        "Added a project stakeholder and decision boundary; prior revision-scoped approvals are now historical",
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn add_kpi(
    runtime: &Path,
    id: &str,
    name: &str,
    unit: &str,
    target: &str,
    calculation: &str,
    owner: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let kpi_id = format!("kpi-{}", slug(name));
    if project.kpis.iter().any(|kpi| kpi.id == kpi_id) {
        return Err(format!("KPI already exists: {kpi_id}"));
    }
    project.kpis.push(Kpi {
        id: kpi_id,
        name: required_text(name, "KPI name")?,
        unit: required_text(unit, "KPI unit")?,
        target: required_text(target, "KPI target")?,
        calculation: required_text(calculation, "KPI calculation")?,
        owner: required_text(owner, "KPI owner")?,
        current_value: None,
        source_refs: Vec::new(),
    });
    material_change(
        &mut project,
        "kpi.added",
        "Added an organization-specific KPI; prior revision-scoped approvals are now historical",
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn update_kpi(
    runtime: &Path,
    id: &str,
    kpi_id: &str,
    value: &str,
    sources: &[String],
    actor: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let kpi = project
        .kpis
        .iter_mut()
        .find(|kpi| kpi.id == kpi_id || kpi.id.starts_with(kpi_id))
        .ok_or_else(|| format!("KPI not found: {kpi_id}"))?;
    kpi.current_value = Some(required_text(value, "KPI value")?);
    kpi.source_refs = sources
        .iter()
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty())
        .collect();
    touch(
        &mut project,
        "kpi.updated",
        actor,
        &format!(
            "Updated {kpi_id} with {} source reference(s)",
            sources.len()
        ),
    );
    save(runtime, &project)?;
    Ok(project)
}

#[derive(Debug, Clone)]
pub struct AddTaskOptions {
    pub title: String,
    pub phase: String,
    pub system: String,
    pub owner: String,
    pub depends_on: Vec<String>,
    pub kpi_ids: Vec<String>,
    pub budget_line_ids: Vec<String>,
    pub evidence_required: Vec<String>,
}

pub fn add_task(runtime: &Path, id: &str, options: AddTaskOptions) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let phase = normalize_phase(&options.phase)?;
    for dependency in &options.depends_on {
        if !project.tasks.iter().any(|task| task.id == *dependency) {
            return Err(format!("task dependency not found: {dependency}"));
        }
    }
    for kpi in &options.kpi_ids {
        if !project.kpis.iter().any(|candidate| candidate.id == *kpi) {
            return Err(format!("KPI not found: {kpi}"));
        }
    }
    for line in &options.budget_line_ids {
        if !project
            .budget_lines
            .iter()
            .any(|candidate| candidate.id == *line)
        {
            return Err(format!("budget line not found: {line}"));
        }
    }
    let task_id = format!(
        "{}-custom-{}",
        phase,
        &Uuid::new_v4().simple().to_string()[..8]
    );
    project.tasks.push(ProjectTask {
        id: task_id,
        phase,
        system: required_text(&options.system, "task system")?,
        title: required_text(&options.title, "task title")?,
        owner: required_text(&options.owner, "task owner")?,
        status: "planned".into(),
        depends_on: options.depends_on,
        objective_ids: vec!["deliver-project".into()],
        kpi_ids: options.kpi_ids,
        budget_line_ids: options.budget_line_ids,
        stakeholder_question_ids: Vec::new(),
        evidence_required: if options.evidence_required.is_empty() {
            vec!["receipt or source-linked completion evidence".into()]
        } else {
            options.evidence_required
        },
        evidence_refs: Vec::new(),
    });
    material_change(
        &mut project,
        "task.added",
        "Added a custom organization project task; revision-scoped approvals were invalidated",
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn answer_question(
    runtime: &Path,
    id: &str,
    question_id: &str,
    answer: &str,
    sources: &[String],
    actor: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let question = project
        .questions
        .iter_mut()
        .find(|question| question.id == question_id || question.id.starts_with(question_id))
        .ok_or_else(|| format!("question not found: {question_id}"))?;
    question.answer = Some(required_text(answer, "answer")?);
    question.source_refs = sources
        .iter()
        .map(|source| source.trim().to_string())
        .filter(|source| !source.is_empty())
        .collect();
    question.status = if question.source_refs.is_empty() {
        "answered-unverified"
    } else {
        "answered"
    }
    .into();
    material_change(
        &mut project,
        "question.answered",
        &format!(
            "{actor} answered {question_id}; prior revision-scoped approvals are now historical"
        ),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn add_supplier(
    runtime: &Path,
    id: &str,
    need_id: &str,
    name: &str,
    url: Option<String>,
    contact: Option<String>,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let need = project
        .supplier_needs
        .iter_mut()
        .find(|need| need.id == need_id || need.id.starts_with(need_id))
        .ok_or_else(|| format!("supplier need not found: {need_id}"))?;
    need.suppliers.push(Supplier {
        id: format!("supplier-{}", &Uuid::new_v4().simple().to_string()[..8]),
        name: required_text(name, "supplier name")?,
        url: url.filter(|value| !value.trim().is_empty()),
        contact: contact.filter(|value| !value.trim().is_empty()),
        quote_minor: None,
        quote_source: None,
        discovery_excerpt: None,
        status: "candidate".into(),
    });
    need.status = "candidates-found".into();
    touch(
        &mut project,
        "supplier.candidate-added",
        "local operator",
        &format!("Added a candidate for {need_id}"),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn research_suppliers(
    runtime: &Path,
    id: &str,
    need_id: &str,
    limit: usize,
) -> Result<(Project, String, usize), String> {
    let mut project = load(runtime, id)?;
    let need_index = project
        .supplier_needs
        .iter()
        .position(|need| need.id == need_id || need.id.starts_with(need_id))
        .ok_or_else(|| format!("supplier need not found: {need_id}"))?;
    let need = &project.supplier_needs[need_index];
    let query = format!(
        "{} supplier {} {} request quote",
        need.category,
        need.location.as_deref().unwrap_or(""),
        project.project_type
    );
    let results = hii_core::information::discover_web(&query, limit.clamp(1, 20))?;
    let mut added = 0usize;
    for result in results {
        if project.supplier_needs[need_index]
            .suppliers
            .iter()
            .any(|supplier| supplier.url.as_deref() == Some(result.url.as_str()))
        {
            continue;
        }
        project.supplier_needs[need_index].suppliers.push(Supplier {
            id: format!("supplier-{}", &Uuid::new_v4().simple().to_string()[..8]),
            name: result.title,
            url: Some(result.url),
            contact: None,
            quote_minor: None,
            quote_source: None,
            discovery_excerpt: (!result.excerpt.is_empty()).then_some(result.excerpt),
            status: "research-candidate".into(),
        });
        added += 1;
    }
    if added > 0 {
        project.supplier_needs[need_index].status = "candidates-found".into();
    }
    touch(
        &mut project,
        "supplier.researched",
        "local operator",
        &format!("Recorded {added} public search candidate(s) for {need_id}; no contact was sent"),
    );
    save(runtime, &project)?;
    Ok((project, query, added))
}

pub fn record_quote(
    runtime: &Path,
    id: &str,
    need_id: &str,
    supplier_id: &str,
    amount: &str,
    source: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let amount_minor = parse_money(amount)?;
    let need_index = project
        .supplier_needs
        .iter()
        .position(|need| need.id == need_id || need.id.starts_with(need_id))
        .ok_or_else(|| format!("supplier need not found: {need_id}"))?;
    let budget_line_id = project.supplier_needs[need_index].budget_line_id.clone();
    let supplier = project.supplier_needs[need_index]
        .suppliers
        .iter_mut()
        .find(|supplier| supplier.id == supplier_id || supplier.id.starts_with(supplier_id))
        .ok_or_else(|| format!("supplier not found: {supplier_id}"))?;
    supplier.quote_minor = Some(amount_minor);
    supplier.quote_source = Some(required_text(source, "quote source")?);
    supplier.status = "quoted".into();
    project.supplier_needs[need_index].status = "quoted".into();
    if let Some(line) = project
        .budget_lines
        .iter_mut()
        .find(|line| line.id == budget_line_id)
    {
        line.quoted_minor = Some(amount_minor);
        line.forecast_minor = amount_minor;
        line.source = format!("supplier quote: {}", source.trim());
        line.source_url = source
            .trim()
            .starts_with("http")
            .then(|| source.trim().to_string());
        line.confidence = "quoted".into();
    }
    material_change(
        &mut project,
        "supplier.quote-recorded",
        &format!("Recorded source-backed quote for {need_id}"),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn approve_phase(
    runtime: &Path,
    id: &str,
    phase: &str,
    actor: &str,
    note: &str,
) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let phase = normalize_phase(phase)?;
    if phase != project.current_phase {
        return Err(format!(
            "current phase is {}; cannot approve {phase}",
            project.current_phase
        ));
    }
    if project.selected_option_id.is_none() {
        return Err("select a delivery option before approving the phase".into());
    }
    let incomplete = project
        .tasks
        .iter()
        .filter(|task| task.phase == phase && task.status != "completed")
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if !incomplete.is_empty() {
        return Err(format!(
            "phase {phase} cannot be approved with incomplete tasks: {}",
            incomplete.join(", ")
        ));
    }
    project.approvals.push(Approval {
        id: Uuid::new_v4().to_string(),
        scope: format!("phase:{phase}"),
        project_revision: project.revision,
        option_id: project.selected_option_id.clone(),
        actor: required_text(actor, "approval actor")?,
        note: required_text(note, "approval note")?,
        created_at: now(),
    });
    let revision = project.revision;
    touch(
        &mut project,
        "phase.approved",
        actor,
        &format!("Approved phase {phase} at revision {revision}"),
    );
    save(runtime, &project)?;
    Ok(project)
}

pub fn advance(runtime: &Path, id: &str) -> Result<Project, String> {
    let mut project = load(runtime, id)?;
    let current = project.current_phase.clone();
    if project.selected_option_id.is_none() {
        return Err("select a delivery option before advancing the project".into());
    }
    let incomplete = project
        .tasks
        .iter()
        .filter(|task| task.phase == current && task.status != "completed")
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if !incomplete.is_empty() {
        return Err(format!(
            "phase {current} has incomplete tasks: {}",
            incomplete.join(", ")
        ));
    }
    let approved = project.approvals.iter().any(|approval| {
        approval.scope == format!("phase:{current}")
            && approval.project_revision == project.revision
            && approval.option_id == project.selected_option_id
    });
    if !approved {
        return Err(format!(
            "phase {current} needs approval for project revision {} and the selected option",
            project.revision
        ));
    }
    let index = PHASES
        .iter()
        .position(|phase| phase.code == current)
        .expect("valid stored phase");
    if let Some(next) = PHASES.get(index + 1) {
        project.current_phase = next.code.into();
        project.status = "active".into();
        material_change(
            &mut project,
            "phase.advanced",
            &format!("Advanced from {current} to {}", next.code),
        );
    } else {
        project.status = "completed".into();
        material_change(
            &mut project,
            "project.completed",
            "Completed the final project phase",
        );
    }
    save(runtime, &project)?;
    Ok(project)
}

pub fn triage(project: &Project) -> Triage {
    let total_tasks = project.tasks.len().max(1);
    let completed_tasks = project
        .tasks
        .iter()
        .filter(|task| task.status == "completed")
        .count();
    let open_questions = project
        .questions
        .iter()
        .filter(|question| !question.status.starts_with("answered"))
        .collect::<Vec<_>>();
    let sourced_lines = project
        .budget_lines
        .iter()
        .filter(|line| line.confidence == "quoted" || !line.needs_quote)
        .count();
    let supplier_coverage = project
        .supplier_needs
        .iter()
        .filter(|need| {
            need.suppliers
                .iter()
                .any(|supplier| supplier.quote_minor.is_some())
        })
        .count();
    let forecast = project
        .budget_lines
        .iter()
        .map(|line| line.forecast_minor)
        .sum::<u64>();
    let mut attention = Vec::new();
    let mut next_actions = Vec::new();
    if project.selected_option_id.is_none() {
        attention.push(AttentionItem { priority: "urgent".into(), kind: "decision".into(), id: "delivery-option".into(), summary: "No delivery option is selected, so phase activation and fee planning remain blocked.".into() });
        next_actions.push(format!(
            "hii project select {} <option> --by <decision-maker>",
            project.id
        ));
    }
    for question in open_questions.iter().take(5) {
        attention.push(AttentionItem {
            priority: "high".into(),
            kind: "stakeholder-question".into(),
            id: question.id.clone(),
            summary: question.question.clone(),
        });
    }
    if let Some(question) = open_questions.first() {
        next_actions.push(format!(
            "hii project question-answer {} {} <answer> --source <evidence>",
            project.id, question.id
        ));
    }
    for need in project
        .supplier_needs
        .iter()
        .filter(|need| {
            !need
                .suppliers
                .iter()
                .any(|supplier| supplier.quote_minor.is_some())
        })
        .take(5)
    {
        attention.push(AttentionItem {
            priority: "normal".into(),
            kind: "supplier-quote".into(),
            id: need.id.clone(),
            summary: format!(
                "{} still needs source-backed supplier candidates and quotes.",
                need.category
            ),
        });
    }
    if let Some(need) = project
        .supplier_needs
        .iter()
        .find(|need| need.suppliers.is_empty())
    {
        next_actions.push(format!("hii project rfq {} {}", project.id, need.id));
    }
    if let Some(task) = project.tasks.iter().find(|task| {
        task.phase == project.current_phase
            && task.status != "completed"
            && task.depends_on.iter().all(|dependency| {
                project
                    .tasks
                    .iter()
                    .any(|candidate| &candidate.id == dependency && candidate.status == "completed")
            })
    }) {
        next_actions.push(format!("Complete {}: {}", task.id, task.title));
    }
    let budget_status = match project.construction_budget_minor {
        Some(budget) if forecast > budget => "off-track",
        Some(_) => "on-track",
        None => "unknown",
    };
    let budget_target = project
        .construction_budget_minor
        .map(|value| format_money(value, &project.currency))
        .unwrap_or_else(|| "budget not set".into());
    Triage {
        schema_version: SCHEMA_VERSION,
        kind: "hii.project.triage/1".into(),
        project_id: project.id.clone(),
        project_revision: project.revision,
        current_phase: project.current_phase.clone(),
        kpis: {
            let mut readings = vec![
                reading(
                    "task-progress",
                    "Task completion",
                    percent(completed_tasks, total_tasks),
                    "100%",
                    if completed_tasks == total_tasks {
                        "on-track"
                    } else {
                        "working"
                    },
                ),
                reading(
                    "budget-source-coverage",
                    "Budget lines with quote-level or non-quote basis",
                    percent(sourced_lines, project.budget_lines.len().max(1)),
                    "100%",
                    if sourced_lines == project.budget_lines.len() {
                        "on-track"
                    } else {
                        "attention"
                    },
                ),
                reading(
                    "stakeholder-questions",
                    "Stakeholder questions resolved",
                    percent(
                        project.questions.len().saturating_sub(open_questions.len()),
                        project.questions.len().max(1),
                    ),
                    "100%",
                    if open_questions.is_empty() {
                        "on-track"
                    } else {
                        "attention"
                    },
                ),
                reading(
                    "supplier-quote-coverage",
                    "Supplier needs with quotes",
                    percent(supplier_coverage, project.supplier_needs.len().max(1)),
                    "100%",
                    if supplier_coverage == project.supplier_needs.len() {
                        "on-track"
                    } else {
                        "attention"
                    },
                ),
                reading(
                    "budget-forecast",
                    "Construction budget forecast",
                    format_money(forecast, &project.currency),
                    &budget_target,
                    budget_status,
                ),
            ];
            for kpi in project.kpis.iter().filter(|kpi| kpi.id.starts_with("kpi-")) {
                readings.push(reading(
                    &kpi.id,
                    &kpi.name,
                    kpi.current_value
                        .clone()
                        .unwrap_or_else(|| "not reported".into()),
                    &kpi.target,
                    if kpi.current_value.is_some() && !kpi.source_refs.is_empty() {
                        "reported"
                    } else {
                        "attention"
                    },
                ));
            }
            readings
        },
        attention,
        next_actions,
    }
}

pub fn rfq(project: &Project, need_id: &str) -> Result<String, String> {
    let need = project
        .supplier_needs
        .iter()
        .find(|need| need.id == need_id || need.id.starts_with(need_id))
        .ok_or_else(|| format!("supplier need not found: {need_id}"))?;
    let line = project
        .budget_lines
        .iter()
        .find(|line| line.id == need.budget_line_id)
        .ok_or_else(|| "linked budget line is missing".to_string())?;
    Ok(format!(
        "REQUEST FOR QUOTE DRAFT — NOT SENT\n\nProject: {}\nProject ID: {}\nLocation: {}\nCategory: {}\nRequirements: {}\nPlanning allowance: {}\nCurrent phase: {}\n\nPlease provide scope, exclusions, lead time, unit pricing, delivery/shipping, taxes, warranty, quote validity, and the source documents required to compare your proposal. No purchase or commitment is authorized by this request.\n\nHII boundary: review this draft and the recipient before any external contact.",
        project.name,
        project.id,
        project.location.as_deref().unwrap_or("to be confirmed"),
        need.category,
        need.requirements,
        format_money(line.allowance_minor, &project.currency),
        project.current_phase,
    ))
}

pub fn format_project(project: &Project) -> String {
    let triage = triage(project);
    let selected = project.selected_option_id.as_deref().unwrap_or("none");
    let mut output = format!(
        "{}  [{}]\nproject: {}\nphase: {}\nrevision: {}\nselected option: {}\nbudget: {}\n\nDelivery options\n",
        project.name,
        project.status,
        project.id,
        project.current_phase,
        project.revision,
        selected,
        project.construction_budget_minor.map(|value| format_money(value, &project.currency)).unwrap_or_else(|| "not set".into()),
    );
    for option in &project.delivery_options {
        output.push_str(&format!(
            "  {:<14} {:>12}  {} hours  {} weeks  {} variants\n",
            option.id,
            format_money(option.total_minor, &project.currency),
            option.total_hours,
            option.duration_weeks,
            option.design_variants
        ));
    }
    output.push_str("\nKPI triage\n");
    for kpi in &triage.kpis {
        output.push_str(&format!(
            "  {:<12} {:<42} {} / {}\n",
            kpi.status, kpi.name, kpi.value, kpi.target
        ));
    }
    if !triage.next_actions.is_empty() {
        output.push_str("\nNext actions\n");
        for action in &triage.next_actions {
            output.push_str(&format!("  - {action}\n"));
        }
    }
    output.trim_end().to_string()
}

fn generate_options(
    basis: &PricingBasis,
    construction_budget: Option<u64>,
) -> Result<Vec<DeliveryOption>, String> {
    let profiles = option_profiles(basis.option_count)?;
    let labor_base = basis
        .base_hours
        .checked_mul(basis.blended_rate_minor)
        .ok_or_else(|| "labor price overflow".to_string())?;
    let mut options = Vec::new();
    for profile in profiles {
        let labor = scale(labor_base, profile.multiplier_bps)?;
        let consultants = scale(basis.consultant_allowance_minor, profile.multiplier_bps)?;
        let direct = scale(basis.direct_costs_minor, profile.multiplier_bps)?;
        let subtotal = checked_sum(&[labor, consultants, direct])?;
        let contingency = scale(subtotal, basis.contingency_bps)?;
        let markup_base = subtotal
            .checked_add(contingency)
            .ok_or_else(|| "price overflow".to_string())?;
        let markup = scale(markup_base, basis.markup_bps)?;
        let total = checked_sum(&[subtotal, contingency, markup])?;
        let phase_weights = PHASES
            .iter()
            .map(|phase| phase.weight_bps)
            .collect::<Vec<_>>();
        let phase_labor = allocate(labor, &phase_weights)?;
        let phase_consultants = allocate(consultants, &phase_weights)?;
        let phase_direct = allocate(direct, &phase_weights)?;
        let phase_contingency = allocate(contingency, &phase_weights)?;
        let phase_markup = allocate(markup, &phase_weights)?;
        let phase_hours = allocate(
            basis
                .base_hours
                .saturating_mul(profile.multiplier_bps as u64)
                / BASIS_POINTS,
            &phase_weights,
        )?;
        let phase_weeks = allocate(basis.total_weeks as u64, &phase_weights)?;
        let mut phases = Vec::new();
        for (index, phase) in PHASES.iter().enumerate() {
            let job_weights = vec![2_000; phase.jobs.len()];
            let job_hours = allocate(phase_hours[index], &job_weights)?;
            let job_costs = allocate(phase_labor[index], &job_weights)?;
            let mut lines = phase.jobs.iter().enumerate().map(|(job_index, job)| PriceLine {
                id: format!("{}-job-{}", phase.code, job_index + 1),
                category: "professional-labor".into(),
                description: (*job).into(),
                quantity: job_hours[job_index],
                unit: "hour".into(),
                unit_rate_minor: basis.blended_rate_minor,
                total_minor: job_costs[job_index],
                source: "explicit base hours and blended rate allocated by the selected planning profile".into(),
                confidence: "planning".into(),
            }).collect::<Vec<_>>();
            lines.extend([
                price_line(
                    phase.code,
                    "consultants",
                    "Consultant and specialist allowance",
                    phase_consultants[index],
                ),
                price_line(
                    phase.code,
                    "direct-costs",
                    "Direct project expenses",
                    phase_direct[index],
                ),
                price_line(
                    phase.code,
                    "contingency",
                    "Planning contingency",
                    phase_contingency[index],
                ),
                price_line(
                    phase.code,
                    "markup",
                    "Fee markup or overhead adjustment",
                    phase_markup[index],
                ),
            ]);
            let phase_total = lines.iter().map(|line| line.total_minor).sum();
            phases.push(PhaseEstimate {
                phase: phase.code.into(),
                name: phase.name.into(),
                phase_weight_bps: phase.weight_bps,
                labor_hours: phase_hours[index],
                duration_weeks: phase_weeks[index] as u32,
                deliverables: phase.jobs.iter().map(|job| (*job).to_string()).collect(),
                line_items: lines,
                total_minor: phase_total,
            });
        }
        let phase_total = phases.iter().map(|phase| phase.total_minor).sum::<u64>();
        if phase_total != total {
            return Err("phase line items do not reconcile to the option total".into());
        }
        options.push(DeliveryOption {
            id: profile.id.into(),
            name: profile.name.into(),
            description: profile.description.into(),
            scope_multiplier_bps: profile.multiplier_bps,
            design_variants: profile.variants,
            iteration_rounds: profile.iterations,
            total_hours: phases.iter().map(|phase| phase.labor_hours).sum(),
            duration_weeks: phases.iter().map(|phase| phase.duration_weeks).sum(),
            phases,
            subtotal_minor: subtotal,
            contingency_minor: contingency,
            markup_minor: markup,
            total_minor: total,
            effective_percent_of_construction_budget_bps: construction_budget
                .filter(|value| *value > 0)
                .map(|budget| {
                    ((total as u128 * BASIS_POINTS as u128) / budget as u128).min(u32::MAX as u128)
                        as u32
                }),
        });
    }
    Ok(options)
}

#[derive(Clone, Copy)]
struct OptionProfile {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    multiplier_bps: u32,
    variants: u32,
    iterations: u32,
}

fn option_profiles(count: usize) -> Result<Vec<OptionProfile>, String> {
    if !(1..=MAX_OPTIONS).contains(&count) {
        return Err(format!("option count must be between 1 and {MAX_OPTIONS}"));
    }
    let profiles = [
        OptionProfile {
            id: "essential",
            name: "Essential",
            description: "Lean scope with minimum viable alternatives and coordination",
            multiplier_bps: 8_000,
            variants: 2,
            iterations: 1,
        },
        OptionProfile {
            id: "coordinated",
            name: "Coordinated",
            description: "Balanced baseline for normal alternatives, coordination, and review",
            multiplier_bps: 10_000,
            variants: 3,
            iterations: 2,
        },
        OptionProfile {
            id: "integrated",
            name: "Integrated",
            description: "Broader system integration, stakeholder testing, and iteration",
            multiplier_bps: 12_500,
            variants: 4,
            iterations: 3,
        },
        OptionProfile {
            id: "high-assurance",
            name: "High Assurance",
            description: "Expanded coordination, validation, and risk reduction",
            multiplier_bps: 15_000,
            variants: 5,
            iterations: 4,
        },
        OptionProfile {
            id: "expanded-5",
            name: "Expanded 5",
            description: "Custom expanded planning scope",
            multiplier_bps: 17_500,
            variants: 6,
            iterations: 5,
        },
        OptionProfile {
            id: "expanded-6",
            name: "Expanded 6",
            description: "Custom expanded planning scope",
            multiplier_bps: 20_000,
            variants: 7,
            iterations: 6,
        },
        OptionProfile {
            id: "expanded-7",
            name: "Expanded 7",
            description: "Custom expanded planning scope",
            multiplier_bps: 22_500,
            variants: 8,
            iterations: 7,
        },
        OptionProfile {
            id: "expanded-8",
            name: "Expanded 8",
            description: "Custom expanded planning scope",
            multiplier_bps: 25_000,
            variants: 9,
            iterations: 8,
        },
    ];
    Ok(profiles[..count].to_vec())
}

fn build_system_budget(
    budget: Option<u64>,
    location: Option<&str>,
) -> (Vec<BudgetLine>, Vec<SupplierNeed>) {
    let amounts = allocate(
        budget.unwrap_or(0),
        &SYSTEM_ALLOCATIONS
            .iter()
            .map(|item| item.weight_bps)
            .collect::<Vec<_>>(),
    )
    .expect("weights are valid");
    let mut needs = Vec::new();
    let lines = SYSTEM_ALLOCATIONS.iter().enumerate().map(|(index, item)| {
        let need_id = item.needs_quote.then(|| format!("need-{}", item.id));
        if let Some(id) = &need_id {
            needs.push(SupplierNeed {
                id: id.clone(),
                budget_line_id: format!("budget-{}", item.id),
                category: item.name.into(),
                requirements: format!("Confirm phase-appropriate scope, quantities, performance requirements, lead time, exclusions, and total delivered cost for {}.", item.name.to_ascii_lowercase()),
                location: location.map(str::to_string),
                status: "needs-sourcing".into(),
                suppliers: Vec::new(),
                contact_draft: format!("Request a comparable written quote for {}. Draft only; operator approval is required before contact.", item.name.to_ascii_lowercase()),
            });
        }
        BudgetLine {
            id: format!("budget-{}", item.id),
            system: item.id.into(),
            description: item.name.into(),
            allowance_minor: amounts[index],
            quoted_minor: None,
            committed_minor: 0,
            forecast_minor: amounts[index],
            source: if budget.is_some() { "default planning allocation from operator-entered project budget" } else { "unpriced planning placeholder" }.into(),
            source_url: None,
            confidence: if item.needs_quote { "low" } else { "planning" }.into(),
            needs_quote: item.needs_quote,
            supplier_need_id: need_id,
        }
    }).collect();
    (lines, needs)
}

fn build_tasks() -> Vec<ProjectTask> {
    let mut tasks = Vec::new();
    let mut prior: Option<String> = None;
    for phase in PHASES {
        for (index, title) in phase.jobs.iter().enumerate() {
            let id = format!("{}-{}", phase.code, index + 1);
            tasks.push(ProjectTask {
                id: id.clone(),
                phase: phase.code.into(),
                system: task_system(index).into(),
                title: (*title).into(),
                owner: "project team".into(),
                status: "planned".into(),
                depends_on: prior.iter().cloned().collect(),
                objective_ids: vec!["deliver-project".into()],
                kpi_ids: vec!["task-progress".into(), "budget-forecast".into()],
                budget_line_ids: task_budget_lines(index),
                stakeholder_question_ids: if index == 4 {
                    vec!["question-decision-authority".into()]
                } else {
                    Vec::new()
                },
                evidence_required: vec![
                    format!("phase-appropriate artifact or decision record for {id}"),
                    "source or receipt reference".into(),
                ],
                evidence_refs: Vec::new(),
            });
            prior = Some(id);
        }
    }
    tasks
}

fn task_system(index: usize) -> &'static str {
    [
        "context",
        "design",
        "coordination",
        "verification",
        "decision-gate",
    ][index]
}

fn task_budget_lines(index: usize) -> Vec<String> {
    match index {
        0 => vec!["budget-site-civil".into(), "budget-design-permits".into()],
        1 => vec!["budget-interiors".into(), "budget-design-permits".into()],
        2 => vec![
            "budget-structure".into(),
            "budget-enclosure".into(),
            "budget-mechanical".into(),
            "budget-electrical".into(),
            "budget-plumbing-fire".into(),
        ],
        3 => vec![
            "budget-design-permits".into(),
            "budget-construction-contingency".into(),
        ],
        _ => vec![
            "budget-general-conditions".into(),
            "budget-design-permits".into(),
        ],
    }
}

fn default_kpis() -> Vec<Kpi> {
    [
        (
            "task-progress",
            "Task completion",
            "percent",
            "100%",
            "completed tasks / all tasks",
        ),
        (
            "budget-source-coverage",
            "Budget source coverage",
            "percent",
            "100%",
            "quote-level or non-quote budget lines / all budget lines",
        ),
        (
            "stakeholder-questions",
            "Stakeholder questions resolved",
            "percent",
            "100%",
            "answered questions / all questions",
        ),
        (
            "supplier-quote-coverage",
            "Supplier quote coverage",
            "percent",
            "100%",
            "supplier needs with quotes / all supplier needs",
        ),
        (
            "budget-forecast",
            "Budget forecast",
            "currency",
            "at or below approved budget",
            "sum of budget-line forecasts compared with the project budget",
        ),
    ]
    .into_iter()
    .map(|(id, name, unit, target, calculation)| Kpi {
        id: id.into(),
        name: name.into(),
        unit: unit.into(),
        target: target.into(),
        calculation: calculation.into(),
        owner: "project manager".into(),
        current_value: None,
        source_refs: Vec::new(),
    })
    .collect()
}

fn initial_questions(options: &CreateOptions) -> Vec<StakeholderQuestion> {
    let rows = [
        ("question-scope", "What exact scope, users, program, quality level, and exclusions are approved?", None),
        ("question-budget", "What is the approved project budget, its basis date, and contingency policy?", options.construction_budget.as_deref()),
        ("question-schedule", "What milestones, occupancy date, procurement constraints, and decision deadlines govern the schedule?", Some("Initial total duration entered; milestone dates remain to be confirmed.")),
        ("question-decision-authority", "Who can approve scope, phase gates, supplier contact, purchasing, and external commitments?", Some("Local operator is the initial project sponsor; organization-specific authority remains to be confirmed.")),
    ];
    rows.into_iter()
        .map(|(id, question, answer)| StakeholderQuestion {
            id: id.into(),
            question: question.into(),
            asked_by: "HII project setup".into(),
            owner: "project sponsor".into(),
            status: if answer.is_some() {
                "answered-unverified"
            } else {
                "open"
            }
            .into(),
            answer: answer.map(str::to_string),
            source_refs: Vec::new(),
        })
        .collect()
}

fn validate_project(project: &Project) -> Result<(), String> {
    if project.schema_version != SCHEMA_VERSION {
        return Err("unsupported project schema version".into());
    }
    normalize_currency(&project.currency)?;
    normalize_phase(&project.current_phase)?;
    if project
        .pricing_basis
        .phase_weights_bps
        .iter()
        .map(|phase| phase.weight_bps as u64)
        .sum::<u64>()
        != BASIS_POINTS
    {
        return Err("phase weights must total 10000 basis points".into());
    }
    for option in &project.delivery_options {
        if option
            .phases
            .iter()
            .map(|phase| phase.total_minor)
            .sum::<u64>()
            != option.total_minor
        {
            return Err(format!("option {} does not reconcile", option.id));
        }
    }
    for task in &project.tasks {
        for dependency in &task.depends_on {
            if dependency == &task.id {
                return Err(format!("task {} depends on itself", task.id));
            }
            if !project
                .tasks
                .iter()
                .any(|candidate| &candidate.id == dependency)
            {
                return Err(format!(
                    "task {} has missing dependency {dependency}",
                    task.id
                ));
            }
        }
    }
    Ok(())
}

fn validate_options(
    option_count: usize,
    base_hours: u64,
    contingency_bps: u32,
    markup_bps: u32,
    total_weeks: u32,
) -> Result<(), String> {
    if base_hours == 0 {
        return Err("base hours must be greater than zero".into());
    }
    if total_weeks == 0 {
        return Err("total weeks must be greater than zero".into());
    }
    if contingency_bps > 10_000 || markup_bps > 10_000 {
        return Err("contingency and markup must each be between 0 and 10000 basis points".into());
    }
    option_profiles(option_count)?;
    Ok(())
}

fn save(runtime: &Path, project: &Project) -> Result<PathBuf, String> {
    validate_project(project)?;
    let value = serde_json::to_value(project).map_err(|error| error.to_string())?;
    hii_core::operational::upsert_project(
        runtime,
        &project.id,
        project.revision,
        &value,
        "local operator",
        &project.updated_at,
    )?;
    let dir = project_dir(runtime);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.json", project.id));
    let temporary = dir.join(format!(".{}.{}.tmp", project.id, std::process::id()));
    let bytes = serde_json::to_vec_pretty(project).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn snapshot_projects(runtime: &Path) -> Result<Vec<Project>, String> {
    let dir = project_dir(runtime);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map_err(|error| error.to_string()))
        .filter_map(|entry| match entry {
            Ok(entry) if entry.path().extension().and_then(|ext| ext.to_str()) == Some("json") => {
                Some(load_path(&entry.path()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn load_path(path: &Path) -> Result<Project, String> {
    let project =
        serde_json::from_slice::<Project>(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("invalid project state {}: {error}", path.display()))?;
    validate_project(&project)?;
    Ok(project)
}

fn project_dir(runtime: &Path) -> PathBuf {
    runtime.join("projects")
}

fn material_change(project: &mut Project, event: &str, detail: &str) {
    project.revision = project.revision.saturating_add(1);
    touch(project, event, "local operator", detail);
}

fn touch(project: &mut Project, event: &str, actor: &str, detail: &str) {
    project.updated_at = now();
    project.events.push(ProjectEvent {
        event: event.into(),
        actor: actor.into(),
        detail: detail.into(),
        created_at: project.updated_at.clone(),
    });
}

fn price_line(phase: &str, category: &str, description: &str, amount: u64) -> PriceLine {
    PriceLine {
        id: format!("{phase}-{category}"),
        category: category.into(),
        description: description.into(),
        quantity: 1,
        unit: "allowance".into(),
        unit_rate_minor: amount,
        total_minor: amount,
        source: "explicit operator input allocated by phase weight".into(),
        confidence: "planning".into(),
    }
}

fn allocate(total: u64, weights: &[u32]) -> Result<Vec<u64>, String> {
    if weights.is_empty() || weights.iter().map(|value| *value as u64).sum::<u64>() != BASIS_POINTS
    {
        return Err("allocation weights must total 10000 basis points".into());
    }
    let mut rows = weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            let numerator = total as u128 * *weight as u128;
            (
                index,
                (numerator / BASIS_POINTS as u128) as u64,
                numerator % BASIS_POINTS as u128,
            )
        })
        .collect::<Vec<_>>();
    let allocated = rows.iter().map(|(_, amount, _)| *amount).sum::<u64>();
    let remainder = total
        .checked_sub(allocated)
        .ok_or_else(|| "allocation overflow".to_string())?;
    rows.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    for row in rows.iter_mut().take(remainder as usize) {
        row.1 += 1;
    }
    rows.sort_by_key(|row| row.0);
    Ok(rows.into_iter().map(|(_, amount, _)| amount).collect())
}

fn scale(value: u64, bps: u32) -> Result<u64, String> {
    let numerator = value as u128 * bps as u128;
    let rounded = (numerator + (BASIS_POINTS as u128 / 2)) / BASIS_POINTS as u128;
    u64::try_from(rounded).map_err(|_| "price overflow".into())
}

fn checked_sum(values: &[u64]) -> Result<u64, String> {
    values.iter().try_fold(0u64, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| "price overflow".to_string())
    })
}

fn parse_money(value: &str) -> Result<u64, String> {
    let normalized = value.trim().trim_start_matches('$').replace(',', "");
    if normalized.starts_with('-') {
        return Err("money values cannot be negative".into());
    }
    let mut parts = normalized.split('.');
    let major = parts.next().unwrap_or("");
    let minor = parts.next();
    if parts.next().is_some()
        || major.is_empty()
        || !major.chars().all(|character| character.is_ascii_digit())
    {
        return Err(format!("invalid money value: {value}"));
    }
    let minor = match minor {
        None => 0,
        Some("") => 0,
        Some(value)
            if value.len() <= 2 && value.chars().all(|character| character.is_ascii_digit()) =>
        {
            value.parse::<u64>().map_err(|error| error.to_string())?
                * if value.len() == 1 { 10 } else { 1 }
        }
        _ => {
            return Err(format!(
                "money values support at most two decimal places: {value}"
            ))
        }
    };
    major
        .parse::<u64>()
        .map_err(|error| error.to_string())?
        .checked_mul(100)
        .and_then(|major| major.checked_add(minor))
        .ok_or_else(|| "money value overflow".into())
}

fn format_money(minor: u64, currency: &str) -> String {
    format!("{} {}.{:02}", currency, minor / 100, minor % 100)
}
fn percent(part: usize, whole: usize) -> String {
    format!("{}%", part.saturating_mul(100) / whole.max(1))
}
fn reading(id: &str, name: &str, value: String, target: &str, status: &str) -> KpiReading {
    KpiReading {
        id: id.into(),
        name: name.into(),
        value,
        target: target.into(),
        status: status.into(),
    }
}
fn now() -> String {
    Utc::now().to_rfc3339()
}

fn required_text(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} cannot be empty"))
    } else {
        Ok(value.to_string())
    }
}

fn normalize_currency(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() != 3
        || !value
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("currency must be a three-letter code such as USD".into());
    }
    Ok(value)
}

fn normalize_phase(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    PHASES
        .iter()
        .find(|phase| phase.code == normalized)
        .map(|phase| phase.code.to_string())
        .ok_or_else(|| "phase must be sd, dd, cd, or active-project-development".into())
}

fn slug(value: &str) -> String {
    let slug = value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "project".into()
    } else {
        slug.chars().take(48).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRuntime(PathBuf);

    impl TempRuntime {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hii-project-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn create_options() -> CreateOptions {
        CreateOptions {
            name: "Community Workshop".into(),
            project_type: "architecture".into(),
            location: Some("Newark, NJ".into()),
            currency: "USD".into(),
            construction_budget: Some("1250000.00".into()),
            base_hours: 1_400,
            blended_rate: "185.00".into(),
            consultant_allowance: "45000.00".into(),
            direct_costs: "7500.00".into(),
            contingency_bps: 1_000,
            markup_bps: 0,
            total_weeks: 40,
            option_count: 3,
        }
    }

    #[test]
    fn money_is_exact_and_rejects_ambiguous_precision() {
        assert_eq!(parse_money("$1,234.50").unwrap(), 123_450);
        assert_eq!(parse_money("10.1").unwrap(), 1_010);
        assert!(parse_money("10.001").is_err());
        assert!(parse_money("-1").is_err());
    }

    #[test]
    fn allocations_reconcile_rounding_remainders() {
        let allocation = allocate(10_001, &[1_000, 2_000, 3_000, 4_000]).unwrap();
        assert_eq!(allocation.iter().sum::<u64>(), 10_001);
        assert_eq!(allocation, vec![1_000, 2_000, 3_000, 4_001]);
    }

    #[test]
    fn generated_options_and_every_phase_line_reconcile() {
        let basis = PricingBasis {
            basis: "test".into(),
            base_hours: 1_001,
            blended_rate_minor: 17_525,
            consultant_allowance_minor: 400_001,
            direct_costs_minor: 100_001,
            contingency_bps: 750,
            markup_bps: 500,
            total_weeks: 37,
            option_count: 3,
            phase_weights_bps: PHASES
                .iter()
                .map(|phase| PhaseWeight {
                    phase: phase.code.into(),
                    weight_bps: phase.weight_bps,
                })
                .collect(),
        };
        let first = generate_options(&basis, Some(90_000_000)).unwrap();
        let second = generate_options(&basis, Some(90_000_000)).unwrap();
        assert_eq!(
            serde_json::to_vec(&first).unwrap(),
            serde_json::to_vec(&second).unwrap()
        );
        assert_eq!(first.len(), 3);
        for option in first {
            assert_eq!(option.phases.len(), 4);
            assert_eq!(
                option
                    .phases
                    .iter()
                    .map(|phase| phase.total_minor)
                    .sum::<u64>(),
                option.total_minor
            );
            for phase in option.phases {
                assert_eq!(
                    phase
                        .line_items
                        .iter()
                        .map(|line| line.total_minor)
                        .sum::<u64>(),
                    phase.total_minor
                );
            }
        }
    }

    #[test]
    fn option_generation_is_bounded() {
        assert!(option_profiles(0).is_err());
        assert!(option_profiles(MAX_OPTIONS + 1).is_err());
        assert_eq!(option_profiles(MAX_OPTIONS).unwrap().len(), MAX_OPTIONS);
    }

    #[test]
    fn task_dependencies_form_one_deterministic_order() {
        let tasks = build_tasks();
        assert_eq!(tasks.len(), 20);
        assert!(tasks[0].depends_on.is_empty());
        for index in 1..tasks.len() {
            assert_eq!(tasks[index].depends_on, vec![tasks[index - 1].id.clone()]);
        }
    }

    #[test]
    fn system_budget_reconciles_and_marks_supplier_needs() {
        let (lines, needs) = build_system_budget(Some(10_001), Some("Newark, NJ"));
        assert_eq!(
            lines.iter().map(|line| line.allowance_minor).sum::<u64>(),
            10_001
        );
        assert_eq!(
            needs.len(),
            SYSTEM_ALLOCATIONS
                .iter()
                .filter(|item| item.needs_quote)
                .count()
        );
        assert!(needs
            .iter()
            .all(|need| need.location.as_deref() == Some("Newark, NJ")));
    }

    #[test]
    fn project_persists_in_graph_and_portable_snapshot() {
        let runtime = TempRuntime::new();
        let project = create(&runtime.0, create_options()).unwrap();
        assert!(project_dir(&runtime.0)
            .join(format!("{}.json", project.id))
            .is_file());
        assert!(runtime.0.join("hii.db").is_file());
        let reopened = load(&runtime.0, &project.id[..12]).unwrap();
        assert_eq!(reopened.id, project.id);
        assert_eq!(reopened.delivery_options.len(), 3);
        assert_eq!(triage(&reopened).kind, "hii.project.triage/1");
    }

    #[test]
    fn material_repricing_invalidates_selection_and_approvals() {
        let runtime = TempRuntime::new();
        let project = create(&runtime.0, create_options()).unwrap();
        let selected = select_option(&runtime.0, &project.id, "coordinated", "Ummi").unwrap();
        assert_eq!(selected.selected_option_id.as_deref(), Some("coordinated"));
        assert_eq!(selected.approvals.len(), 1);
        let repriced = reprice(
            &runtime.0,
            &project.id,
            RepriceOptions {
                base_hours: Some(1_500),
                ..RepriceOptions::default()
            },
        )
        .unwrap();
        assert!(repriced.selected_option_id.is_none());
        assert_eq!(repriced.approvals.len(), 1, "approval history is immutable");
        assert!(repriced.approvals[0].project_revision < repriced.revision);
        assert!(repriced.revision > selected.revision);
    }

    #[test]
    fn task_and_phase_gates_fail_closed_then_advance() {
        let runtime = TempRuntime::new();
        let project = create(&runtime.0, create_options()).unwrap();
        assert!(complete_task(
            &runtime.0,
            &project.id,
            "sd-2",
            &["receipt:blocked".into()],
            "tester"
        )
        .unwrap_err()
        .contains("blocked"));
        assert!(advance(&runtime.0, &project.id)
            .unwrap_err()
            .contains("select a delivery option"));
        select_option(&runtime.0, &project.id, "coordinated", "Ummi").unwrap();
        for number in 1..=5 {
            complete_task(
                &runtime.0,
                &project.id,
                &format!("sd-{number}"),
                &[format!("receipt:sd-{number}")],
                "project team",
            )
            .unwrap();
        }
        assert!(advance(&runtime.0, &project.id)
            .unwrap_err()
            .contains("needs approval"));
        approve_phase(
            &runtime.0,
            &project.id,
            "sd",
            "Ummi",
            "Approved after reviewing cost, scope, and evidence",
        )
        .unwrap();
        let advanced = advance(&runtime.0, &project.id).unwrap();
        assert_eq!(advanced.current_phase, "dd");
    }

    #[test]
    fn organization_kpis_stakeholders_and_tasks_share_one_project_revision() {
        let runtime = TempRuntime::new();
        let project = create(&runtime.0, create_options()).unwrap();
        add_stakeholder(
            &runtime.0,
            &project.id,
            "Community Board",
            "Stakeholder",
            "Program priorities and public-facing milestone review",
        )
        .unwrap();
        add_kpi(
            &runtime.0,
            &project.id,
            "Local procurement",
            "percent",
            "40%",
            "locally sourced committed value / total committed value",
            "project manager",
        )
        .unwrap();
        update_kpi(
            &runtime.0,
            &project.id,
            "kpi-local-procurement",
            "12%",
            &["receipt:procurement-ledger".into()],
            "project manager",
        )
        .unwrap();
        let updated = add_task(
            &runtime.0,
            &project.id,
            AddTaskOptions {
                title: "Confirm local supplier participation plan".into(),
                phase: "sd".into(),
                system: "procurement".into(),
                owner: "project manager".into(),
                depends_on: vec!["sd-1".into()],
                kpi_ids: vec!["kpi-local-procurement".into()],
                budget_line_ids: vec!["budget-general-conditions".into()],
                evidence_required: vec!["approved supplier participation plan".into()],
            },
        )
        .unwrap();
        assert!(updated
            .stakeholders
            .iter()
            .any(|stakeholder| stakeholder.name == "Community Board"));
        assert!(updated.tasks.iter().any(|task| {
            task.title == "Confirm local supplier participation plan"
                && task.kpi_ids == ["kpi-local-procurement"]
        }));
        assert!(triage(&updated).kpis.iter().any(|kpi| {
            kpi.id == "kpi-local-procurement" && kpi.value == "12%" && kpi.status == "reported"
        }));
    }
}
