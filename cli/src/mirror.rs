//! A truthful, local-first projection of the operator's Personal Mirror.
//!
//! The Mirror is retrieval-first: source-linked user information stays outside
//! model weights, and the selected model receives only the bounded HII context
//! capsule for the current run. This module intentionally does not create a
//! second profile database or claim that a model is the user.

use crate::{capability_index, config::AppPaths, context::ContextCapsule, contract::Authority};
use clap::ValueEnum;
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorStrength {
    Off,
    Light,
    #[default]
    Balanced,
    Strong,
    Represent,
}

impl MirrorStrength {
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Light => "light",
            Self::Balanced => "balanced",
            Self::Strong => "strong",
            Self::Represent => "represent",
        }
    }

    fn weights(self) -> MirrorWeights {
        match self {
            Self::Off => MirrorWeights::new(0.0, 0.0, 0.0, 1.0),
            Self::Light => MirrorWeights::new(0.25, 0.25, 0.10, 0.90),
            Self::Balanced => MirrorWeights::new(0.55, 0.55, 0.30, 0.75),
            Self::Strong => MirrorWeights::new(0.85, 0.85, 0.75, 0.55),
            Self::Represent => MirrorWeights::new(1.0, 1.0, 1.0, 0.35),
        }
    }

    pub fn uses_personal_context(self) -> bool {
        self != Self::Off
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum MirrorAuthority {
    #[default]
    Answer,
    Suggest,
    Prepare,
    Act,
    Continue,
}

impl MirrorAuthority {
    pub fn label(self) -> &'static str {
        match self {
            Self::Answer => "answer",
            Self::Suggest => "suggest",
            Self::Prepare => "prepare",
            Self::Act => "act",
            Self::Continue => "continue",
        }
    }

    /// Mirror authority is a human-facing posture. The existing HII authority
    /// envelope remains the enforcement boundary beneath it.
    pub fn execution_authority(self) -> Authority {
        match self {
            Self::Answer | Self::Suggest => Authority::ReadOnly,
            Self::Prepare | Self::Act | Self::Continue => Authority::Workspace,
        }
    }

    pub fn is_read_only(self) -> bool {
        matches!(self, Self::Answer | Self::Suggest)
    }

    fn behavior(self) -> &'static str {
        match self {
            Self::Answer => "Answer the question from evidence. Do not change state.",
            Self::Suggest => {
                "Recommend a course of action, show uncertainty, and do not change state."
            }
            Self::Prepare => {
                "Prepare reversible artifacts inside the selected workspace for review."
            }
            Self::Act => {
                "Perform bounded, reversible work inside the selected workspace and verify it."
            }
            Self::Continue => {
                "Pursue the goal for this bounded run and leave a durable next step in the receipt. This does not create a background process."
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorWeights {
    explicit_preferences: f32,
    inferred_patterns: f32,
    voice_and_style: f32,
    evidence_challenge: f32,
}

impl MirrorWeights {
    const fn new(
        explicit_preferences: f32,
        inferred_patterns: f32,
        voice_and_style: f32,
        evidence_challenge: f32,
    ) -> Self {
        Self {
            explicit_preferences,
            inferred_patterns,
            voice_and_style,
            evidence_challenge,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSource {
    pub source_ref: String,
    pub kind: &'static str,
    pub state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySummary {
    pub total: usize,
    pub ready: usize,
    pub other: usize,
    pub by_source: BTreeMap<String, usize>,
    pub ready_examples: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceConnection {
    pub id: &'static str,
    pub state: &'static str,
    pub basis: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSnapshot {
    pub schema_version: u8,
    pub kind: &'static str,
    pub label: &'static str,
    pub claim: &'static str,
    pub workspace: String,
    pub storage: &'static str,
    pub modeling: &'static str,
    pub mirror_strength: MirrorStrength,
    pub mirror_weights: MirrorWeights,
    pub authority: MirrorAuthority,
    pub execution_authority: &'static str,
    pub sources: Vec<MirrorSource>,
    pub capabilities: CapabilitySummary,
    pub surfaces: Vec<SurfaceConnection>,
    pub external_transmission: &'static str,
}

impl MirrorSnapshot {
    pub fn source_refs(&self) -> Vec<String> {
        self.sources
            .iter()
            .map(|source| source.source_ref.clone())
            .collect()
    }

    pub fn system_context(&self) -> String {
        let weights = self.mirror_weights;
        format!(
            "HII PERSONAL MIRROR\n\
             This is a model-based mirror informed by source-linked local information. It is not the user, a consciousness, or proof of mind transfer. Never claim otherwise.\n\
             Current user instruction outranks history. Separate known facts from inference; cite or name sources when material; say when information may be stale.\n\
             Mirror strength: {}. Weights: explicit_preferences={:.2}, inferred_patterns={:.2}, voice_and_style={:.2}, evidence_challenge={:.2}.\n\
             Mirror authority: {}. Enforced HII authority: {}. {}\n\
             Represent may draft in the user's style but never impersonates the user, sends a message, publishes, spends, or expands access.\n\
             Social, GIS/world, cloud, internet, external-agent, and remote-device access are unavailable unless an existing HII capability and the active authority envelope explicitly provide them.",
            self.mirror_strength.label(),
            weights.explicit_preferences,
            weights.inferred_patterns,
            weights.voice_and_style,
            weights.evidence_challenge,
            self.authority.label(),
            self.execution_authority,
            self.authority.behavior(),
        )
    }
}

pub fn inspect(
    paths: &AppPaths,
    workspace: &Path,
    strength: MirrorStrength,
    authority: MirrorAuthority,
) -> MirrorSnapshot {
    let capsule = ContextCapsule::build(&paths.runtime, workspace);
    let mut sources = capsule
        .sources
        .into_iter()
        .map(|source_ref| MirrorSource {
            kind: source_kind(&source_ref),
            source_ref,
            state: "available",
        })
        .collect::<Vec<_>>();

    for path in [
        paths.runtime.join("capabilities.json"),
        paths.runtime.join("skills/_index.json"),
    ] {
        if path.is_file() {
            let source_ref = path.display().to_string();
            if !sources.iter().any(|source| source.source_ref == source_ref) {
                sources.push(MirrorSource {
                    source_ref,
                    kind: "capability-registry",
                    state: "available",
                });
            }
        }
    }
    sources.sort_by(|left, right| left.source_ref.cmp(&right.source_ref));
    sources.dedup_by(|left, right| left.source_ref == right.source_ref);

    let entries = capability_index::load_all(paths);
    let ready = entries
        .iter()
        .filter(|entry| matches!(entry.status.as_str(), "ready" | "verified" | "trusted"))
        .count();
    let mut by_source = BTreeMap::new();
    for entry in &entries {
        *by_source.entry(entry.source.to_string()).or_insert(0) += 1;
    }
    let ready_examples = entries
        .iter()
        .filter(|entry| matches!(entry.status.as_str(), "ready" | "verified" | "trusted"))
        .take(12)
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();

    let capability_state = |id: &str| {
        entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.status.clone())
    };
    let core_agent = capability_state("hii.agent.workspace_run");
    let canvas = capability_state("hii.workspace.creative_canvas");
    let systems = capability_state("hii.daemon.instances");

    MirrorSnapshot {
        schema_version: 1,
        kind: "hii.personal-mirror",
        label: "Personal Mirror",
        claim: "A model-based reflection of source-linked user information and available HII capabilities; not the user or a consciousness.",
        workspace: workspace.display().to_string(),
        storage: "user-owned local HII runtime",
        modeling: "retrieval-first; personal records remain source-linked and replaceable across models",
        mirror_strength: strength,
        mirror_weights: strength.weights(),
        authority,
        execution_authority: authority.execution_authority().label(),
        sources,
        capabilities: CapabilitySummary {
            total: entries.len(),
            ready,
            other: entries.len().saturating_sub(ready),
            by_source,
            ready_examples,
        },
        surfaces: vec![
            SurfaceConnection {
                id: "library",
                state: if capsule.text.is_empty() { "empty" } else { "connected" },
                basis: "bounded HII context capsule with source references".into(),
            },
            SurfaceConnection {
                id: "agent-runtime",
                state: if core_agent.as_deref() == Some("ready") {
                    "ready"
                } else {
                    "declared"
                },
                basis: format!(
                    "hii.agent.workspace_run status={}",
                    core_agent.as_deref().unwrap_or("missing")
                ),
            },
            SurfaceConnection {
                id: "canvas",
                state: if canvas.is_some() { "registered" } else { "not-connected" },
                basis: format!(
                    "hii.workspace.creative_canvas status={}",
                    canvas.as_deref().unwrap_or("missing")
                ),
            },
            SurfaceConnection {
                id: "devices",
                state: if systems.is_some() { "registered-not-live-proven" } else { "not-connected" },
                basis: format!(
                    "hii.daemon.instances status={}; live executor proof remains separate",
                    systems.as_deref().unwrap_or("missing")
                ),
            },
            SurfaceConnection {
                id: "social",
                state: "not-connected",
                basis: "future HII Network surface; this MVP exposes no social capability".into(),
            },
            SurfaceConnection {
                id: "gis-world",
                state: "not-connected",
                basis: "existing site-analysis surfaces are not wired into this CLI Mirror MVP".into(),
            },
            SurfaceConnection {
                id: "internet-and-external-agents",
                state: "explicit-only",
                basis: "not used by mirror inspection; runs remain bounded by registered tools and HII authority".into(),
            },
        ],
        external_transmission: "none during mirror inspection; a mirror run inherits the explicitly selected HII model and tool boundaries",
    }
}

pub fn render(snapshot: &MirrorSnapshot, json: bool) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(snapshot).map_err(|error| error.to_string());
    }
    let mut output = vec![
        "HII Personal Mirror".to_string(),
        snapshot.claim.to_string(),
        format!(
            "mirror      {} (preferences {:.0}%, inference {:.0}%, voice {:.0}%, challenge {:.0}%)",
            snapshot.mirror_strength.label(),
            snapshot.mirror_weights.explicit_preferences * 100.0,
            snapshot.mirror_weights.inferred_patterns * 100.0,
            snapshot.mirror_weights.voice_and_style * 100.0,
            snapshot.mirror_weights.evidence_challenge * 100.0,
        ),
        format!(
            "authority   {} -> {}",
            snapshot.authority.label(),
            snapshot.execution_authority
        ),
        format!("sources     {} source-linked", snapshot.sources.len()),
        format!(
            "capabilities {} total, {} ready",
            snapshot.capabilities.total, snapshot.capabilities.ready
        ),
        "surfaces".to_string(),
    ];
    output.extend(snapshot.surfaces.iter().map(|surface| {
        format!(
            "- {:<28} {:<28} {}",
            surface.id, surface.state, surface.basis
        )
    }));
    output.push("inspect      hii mirror show --json".into());
    output.push(
        "ask          hii mirror ask <question> --strength balanced --authority answer".into(),
    );
    output.push("run          hii mirror run <goal> --strength strong --authority prepare".into());
    Ok(output.join("\n"))
}

fn source_kind(source: &str) -> &'static str {
    if source.starts_with("hii-receipt:") {
        "receipt"
    } else if source.starts_with("git:") {
        "workspace-state"
    } else if source.ends_with("AGENTS.md") {
        "workspace-instructions"
    } else if source.ends_with("USER.md")
        || source.ends_with("profile.md")
        || source.ends_with("user.md")
    {
        "user-profile"
    } else if source.contains("tasks.jsonl") {
        "goal-ledger"
    } else if source.contains("skills") {
        "capability-registry"
    } else {
        "local-context"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, AppPaths) {
        let root = TempDir::new().expect("temp root");
        let repo = root.path().join("repo");
        let runtime = root.path().join("runtime");
        fs::create_dir_all(&repo).expect("repo");
        fs::create_dir_all(runtime.join("skills")).expect("skills");
        fs::write(repo.join("AGENTS.md"), "Use local evidence.").expect("instructions");
        fs::write(runtime.join("profile.md"), "Prefers spatial interfaces.").expect("profile");
        fs::write(runtime.join("skills/_index.json"), "[]").expect("index");
        (root, AppPaths { repo, runtime })
    }

    #[test]
    fn snapshot_is_source_linked_and_keeps_future_surfaces_truthful() {
        let (_root, paths) = fixture();
        let snapshot = inspect(
            &paths,
            &paths.repo,
            MirrorStrength::Balanced,
            MirrorAuthority::Answer,
        );
        assert!(snapshot
            .sources
            .iter()
            .any(|source| source.kind == "user-profile"));
        assert!(snapshot
            .sources
            .iter()
            .any(|source| source.kind == "workspace-instructions"));
        assert_eq!(snapshot.execution_authority, "read-only");
        assert!(snapshot
            .surfaces
            .iter()
            .any(|surface| surface.id == "social" && surface.state == "not-connected"));
        assert!(snapshot
            .surfaces
            .iter()
            .any(|surface| surface.id == "gis-world" && surface.state == "not-connected"));
    }

    #[test]
    fn mirror_strength_and_authority_are_independent() {
        assert!(!MirrorStrength::Off.uses_personal_context());
        assert!(MirrorStrength::Light.uses_personal_context());
        assert_eq!(MirrorStrength::Represent.weights().voice_and_style, 1.0);
        assert_eq!(
            MirrorAuthority::Suggest.execution_authority(),
            Authority::ReadOnly
        );
        assert_eq!(
            MirrorAuthority::Act.execution_authority(),
            Authority::Workspace
        );
        assert!(MirrorAuthority::Answer.is_read_only());
        assert!(!MirrorAuthority::Prepare.is_read_only());
    }

    #[test]
    fn system_context_never_claims_identity_or_persistent_background_work() {
        let (_root, paths) = fixture();
        let snapshot = inspect(
            &paths,
            &paths.repo,
            MirrorStrength::Represent,
            MirrorAuthority::Continue,
        );
        let context = snapshot.system_context();
        assert!(context.contains("not the user, a consciousness"));
        assert!(context.contains("does not create a background process"));
        assert!(context.contains("never impersonates the user"));
    }
}
