"""
HII Skill Registry

Every action HII can take is a skill with a written schema.
Skills are stored as JSON files in ~/.hii/skills/.
Before doing ANYTHING, search the registry first. If a skill exists, execute it.
If not, do the work, then register it as a skill for next time.

This saves tokens. Period.

Schema format:
{
  "id": "psyche-init",
  "name": "Initialize Psyche Profile",
  "description": "Seed the psyche profile with identity, roles, domains, values",
  "category": "psyche",
  "target": "local" | "architect",
  "inputs": { "name": "str", "roles": "list[str]", ... },
  "script": "python -m engine.cli psyche init --name '{name}' ...",
  "template": null | "prompt template for architect tasks",
  "examples": ["hii skill run psyche-init --name 'Ummi Green'"],
  "created_at": "ISO timestamp"
}
"""

import json
from pathlib import Path
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional, Any

SKILLS_DIR = Path.home() / ".hii" / "skills"
INDEX_FILE = SKILLS_DIR / "_index.json"


@dataclass
class Skill:
    id: str
    name: str
    description: str
    category: str                       # psyche, task, agent, daemon, rag, web, build, git, etc.
    target: str                         # local | architect
    inputs: dict[str, str]              # param_name -> type description
    script: Optional[str] = None        # for local: exact command template
    template: Optional[str] = None      # for architect: prompt template
    outputs: Optional[str] = None       # what the skill returns
    examples: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    version: int = 1


def _ensure_dir():
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)


def register(skill: Skill) -> str:
    """Save a skill to disk and update the index."""
    _ensure_dir()
    # Write skill file
    skill_file = SKILLS_DIR / f"{skill.id}.json"
    skill_file.write_text(json.dumps(asdict(skill), indent=2))
    # Update index
    _update_index()
    return str(skill_file)


def get(skill_id: str) -> Optional[Skill]:
    """Load a skill by ID."""
    skill_file = SKILLS_DIR / f"{skill_id}.json"
    if not skill_file.exists():
        return None
    raw = json.loads(skill_file.read_text())
    return Skill(**raw)


def search(query: str, category: Optional[str] = None) -> list[Skill]:
    """Search skills by keyword in name/description/tags. Token-cheap lookup."""
    _ensure_dir()
    results = []
    q = query.lower()
    for f in SKILLS_DIR.glob("*.json"):
        if f.name == "_index.json":
            continue
        try:
            raw = json.loads(f.read_text())
            # Match against name, description, tags, category
            searchable = f"{raw.get('name', '')} {raw.get('description', '')} {' '.join(raw.get('tags', []))} {raw.get('category', '')}".lower()
            if q in searchable:
                if category and raw.get("category") != category:
                    continue
                results.append(Skill(**raw))
        except Exception:
            continue
    return results


def list_all(category: Optional[str] = None) -> list[dict]:
    """List all skills (compact — id, name, category only). For token efficiency."""
    _ensure_dir()
    index = _load_index()
    if category:
        index = [s for s in index if s.get("category") == category]
    return index


def remove(skill_id: str) -> bool:
    skill_file = SKILLS_DIR / f"{skill_id}.json"
    if skill_file.exists():
        skill_file.unlink()
        _update_index()
        return True
    return False


def _load_index() -> list[dict]:
    if INDEX_FILE.exists():
        try:
            return json.loads(INDEX_FILE.read_text())
        except Exception:
            pass
    return _rebuild_index()


def _rebuild_index() -> list[dict]:
    _ensure_dir()
    index = []
    for f in sorted(SKILLS_DIR.glob("*.json")):
        if f.name == "_index.json":
            continue
        try:
            raw = json.loads(f.read_text())
            index.append({
                "id": raw["id"],
                "name": raw["name"],
                "category": raw["category"],
                "target": raw["target"],
                "description": raw["description"][:80],
            })
        except Exception:
            continue
    INDEX_FILE.write_text(json.dumps(index, indent=2))
    return index


def _update_index():
    _rebuild_index()


def render_script(skill: Skill, params: dict[str, Any]) -> str:
    """Fill in a skill's script template with params."""
    if not skill.script:
        raise ValueError(f"Skill {skill.id} has no script (architect-only?)")
    result = skill.script
    for key, val in params.items():
        result = result.replace(f"{{{key}}}", str(val))
    return result


def render_prompt(skill: Skill, params: dict[str, Any]) -> str:
    """Fill in a skill's prompt template with params."""
    if not skill.template:
        raise ValueError(f"Skill {skill.id} has no template")
    result = skill.template
    for key, val in params.items():
        result = result.replace(f"{{{key}}}", str(val))
    return result
