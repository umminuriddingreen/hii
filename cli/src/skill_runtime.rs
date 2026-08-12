//! Load reviewed skills as bounded context for governed agent runs.

use std::{fs, path::Path};

use crate::{config::AppPaths, skill_lifecycle::SkillState};

const MAX_SKILL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug)]
pub struct LoadedSkill {
    pub id: String,
    pub instructions: String,
}

pub fn load(paths: &AppPaths, id: &str) -> Result<LoadedSkill, String> {
    let id = validate_id(id)?;
    let lifecycle = crate::skill_lifecycle::load(paths);
    if lifecycle
        .skills
        .get(id)
        .is_some_and(|record| record.state == SkillState::Rejected)
    {
        return Err(format!("skill `{id}` was rejected and cannot run"));
    }

    let registered = paths.runtime.join("skills/registered").join(id);
    ensure_direct_child(&paths.runtime.join("skills/registered"), &registered)?;
    let manifest = registered.join("manifest.json");
    let instructions = registered.join("SKILL.md");
    if !manifest.is_file() || !instructions.is_file() {
        return Err(format!(
            "skill `{id}` is not reviewed and registered; drafts cannot execute"
        ));
    }
    let metadata = fs::metadata(&instructions).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
        return Err(format!(
            "skill `{id}` instructions must be a regular file no larger than {MAX_SKILL_BYTES} bytes"
        ));
    }
    let instructions = fs::read_to_string(&instructions).map_err(|error| error.to_string())?;
    if instructions.trim().is_empty() {
        return Err(format!("skill `{id}` has empty instructions"));
    }
    Ok(LoadedSkill {
        id: id.into(),
        instructions,
    })
}

fn validate_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty()
        || id == "."
        || id == ".."
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("skill id may contain only ASCII letters, numbers, '.', '-', and '_'".into());
    }
    Ok(id)
}

fn ensure_direct_child(parent: &Path, child: &Path) -> Result<(), String> {
    if child.parent() != Some(parent) {
        return Err("skill path escaped the registered skill directory".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_like_skill_ids() {
        for id in ["", "..", "../secret", "a/b", "a b"] {
            assert!(validate_id(id).is_err(), "{id:?} must be rejected");
        }
        assert_eq!(validate_id("build-hii.v2").unwrap(), "build-hii.v2");
    }
}
