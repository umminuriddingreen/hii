//! A truthful projection of HII's ongoing relationship with its operator.
//!
//! Presence is not a consciousness claim. It joins durable local continuity,
//! current attention, recent proof, and the authority boundary into one small
//! system-owned view. Models may later reflect over this projection, but they
//! do not own it and their inferences never become the operator's identity.

use crate::{
    board::{Board, Task},
    config::AppPaths,
    receipt::{find_receipt, Receipt},
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_ATTENTION: usize = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Presence {
    schema_version: u8,
    kind: &'static str,
    state: &'static str,
    claim: &'static str,
    relationship: Relationship,
    continuity: Continuity,
    attention: Vec<Attention>,
    recent_proof: Option<RecentProof>,
    authority: Authority,
    next: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Relationship {
    system: &'static str,
    operator: &'static str,
    representation: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Continuity {
    profile: Option<String>,
    board: String,
    receipts: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Attention {
    id: String,
    title: String,
    lane: String,
    owner: String,
    coordinate: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentProof {
    id: String,
    status: String,
    goal: String,
    verified: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Authority {
    observe: &'static str,
    propose: &'static str,
    act: &'static str,
    represent: &'static str,
}

pub fn show(paths: &AppPaths, workspace: &Path, json: bool) -> Result<(), String> {
    let presence = snapshot(paths, workspace)?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&presence).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    println!("HII Presence  ·  grounded, local, ongoing");
    println!("state       {}", presence.state);
    println!(
        "continuity  profile={} · {} open thread(s) · {} receipt(s)",
        presence.continuity.profile.as_deref().unwrap_or("missing"),
        presence.attention.len(),
        presence.continuity.receipts,
    );
    if let Some(proof) = &presence.recent_proof {
        println!(
            "proof       {} · {} · {} verified check(s)",
            proof.id, proof.status, proof.verified
        );
    } else {
        println!("proof       no receipt for this workspace yet");
    }
    println!("boundary    observes state · proposes visibly · acts only with granted authority");
    println!("identity    HII interpretations stay labeled until you adopt them");
    println!("next        {}", presence.next);
    Ok(())
}

fn snapshot(paths: &AppPaths, workspace: &Path) -> Result<Presence, String> {
    let tasks = Board::open(&paths.runtime).tasks(false)?;
    let attention = tasks
        .iter()
        .filter(|task| task.lane == "doing" || task.lane == "next")
        .take(MAX_ATTENTION)
        .map(attention_from)
        .collect::<Vec<_>>();
    let recent_receipt = latest_receipt(&paths.runtime, workspace);
    let recent_proof = recent_receipt.as_ref().map(|receipt| RecentProof {
        id: receipt.id.clone(),
        status: receipt.status.clone(),
        goal: receipt.goal.clone(),
        verified: receipt.verification.iter().filter(|check| check.ok).count(),
    });
    let profile = profile_path(&paths.runtime);
    let next = attention
        .first()
        .map(|item| format!("Return to '{}' at {}", item.title, item.coordinate))
        .unwrap_or_else(|| {
            "Tell HII what deserves attention; it will keep the thread and proof.".into()
        });

    Ok(Presence {
        schema_version: 1,
        kind: "hii.presence",
        state: if attention.is_empty() {
            "available"
        } else {
            "attending"
        },
        claim: "operational presence, not a claim of consciousness or sentience",
        relationship: Relationship {
            system: "HII",
            operator: "user",
            representation: "user-authored context with source-labeled system inference",
        },
        continuity: Continuity {
            profile: profile.map(|path| path.display().to_string()),
            board: Board::open(&paths.runtime)
                .store_path()
                .display()
                .to_string(),
            receipts: usize::from(recent_receipt.is_some()),
        },
        attention,
        recent_proof,
        authority: Authority {
            observe: "read-only local state",
            propose: "visible and reversible",
            act: "only within explicit granted authority",
            represent: "never attribute HII inference to the user without adoption",
        },
        next,
    })
}

fn latest_receipt(runtime: &Path, workspace: &Path) -> Option<Receipt> {
    let path = find_receipt(runtime, None, workspace).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn attention_from(task: &Task) -> Attention {
    Attention {
        id: task.id.clone(),
        title: task.title.clone(),
        lane: task.lane.clone(),
        owner: task.owner.clone(),
        coordinate: task.coordinate.clone(),
    }
}

fn profile_path(runtime: &Path) -> Option<PathBuf> {
    [runtime.join("profile.md"), runtime.join("user.md")]
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            dirs::home_dir()
                .map(|home| home.join(".hermes/memories/USER.md"))
                .filter(|path| path.is_file())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::AddOptions;
    use std::{fs, time::SystemTime};

    #[test]
    fn presence_is_grounded_in_user_owned_state_and_keeps_identity_boundary() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("hii-presence-{unique}"));
        let runtime = root.join("runtime");
        let workspace = root.join("workspace");
        fs::create_dir_all(&runtime).expect("runtime");
        fs::create_dir_all(&workspace).expect("workspace");
        fs::write(runtime.join("profile.md"), "# My authored context\n").expect("profile");
        Board::open(&runtime)
            .add(
                &workspace,
                AddOptions {
                    title: "Continue the living HII loop".into(),
                    lane: Some("next".into()),
                    priority: Some("high".into()),
                    owner: Some("user".into()),
                    coordinate: Some(workspace.display().to_string()),
                    notes: None,
                    tags: None,
                },
            )
            .expect("task");

        let presence = snapshot(
            &AppPaths {
                repo: workspace.clone(),
                runtime: runtime.clone(),
            },
            &workspace,
        )
        .expect("presence");

        assert_eq!(presence.kind, "hii.presence");
        assert_eq!(presence.state, "attending");
        assert!(presence.claim.contains("not a claim of consciousness"));
        assert_eq!(presence.attention.len(), 1);
        assert_eq!(
            presence.relationship.representation,
            "user-authored context with source-labeled system inference"
        );
        assert_eq!(
            presence.authority.act,
            "only within explicit granted authority"
        );
        assert_eq!(
            presence.continuity.profile,
            Some(runtime.join("profile.md").display().to_string())
        );

        fs::remove_dir_all(root).expect("cleanup");
    }
}
