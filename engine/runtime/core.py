from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


HII_DIR = Path.home() / ".hii"
RUNTIME_DB = HII_DIR / "runtime.sqlite3"
RUNTIME_ARTIFACTS = HII_DIR / "runtime" / "artifacts"


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def slugify(value: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", value.lower())).strip("-") or "artifact"


@dataclass
class Intent:
    id: str
    text: str
    kind: str
    inputs: dict[str, Any]
    constraints: list[str]
    created_at: str = field(default_factory=now_iso)


@dataclass
class Job:
    id: str
    intent_id: str
    kind: str
    status: str
    plan: list[str]
    schedule: str
    evaluation: dict[str, Any]
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass
class JobStep:
    id: str
    job_id: str
    name: str
    status: str
    sequence: int
    detail: dict[str, Any]
    created_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    completed_at: str | None = None


@dataclass
class Artifact:
    id: str
    job_id: str
    kind: str
    title: str
    path: str
    payload: dict[str, Any]
    score: float
    constraints: list[str]
    rationale: str
    created_at: str = field(default_factory=now_iso)


@dataclass
class Memory:
    id: str
    kind: str
    ref_id: str
    content: dict[str, Any]
    created_at: str = field(default_factory=now_iso)


def connect() -> sqlite3.Connection:
    HII_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(RUNTIME_DB)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS intents (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            kind TEXT NOT NULL,
            body_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            intent_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            body_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS job_steps (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            body_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            path TEXT NOT NULL,
            score REAL NOT NULL,
            body_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            ref_id TEXT NOT NULL,
            body_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()


def _insert_object(conn: sqlite3.Connection, table: str, payload: dict[str, Any], **columns: Any) -> None:
    body_json = json.dumps(payload, indent=2)
    merged = {**columns, "body_json": body_json}
    names = ", ".join(merged.keys())
    placeholders = ", ".join("?" for _ in merged)
    conn.execute(f"INSERT INTO {table} ({names}) VALUES ({placeholders})", tuple(merged.values()))


def save_intent(conn: sqlite3.Connection, intent: Intent) -> None:
    payload = asdict(intent)
    _insert_object(
        conn,
        "intents",
        payload,
        id=intent.id,
        text=intent.text,
        kind=intent.kind,
        created_at=intent.created_at,
    )
    conn.commit()


def save_job(conn: sqlite3.Connection, job: Job) -> None:
    payload = asdict(job)
    conn.execute(
        """
        INSERT INTO jobs (id, intent_id, kind, status, body_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            body_json = excluded.body_json,
            updated_at = excluded.updated_at
        """,
        (job.id, job.intent_id, job.kind, job.status, json.dumps(payload, indent=2), job.created_at, job.updated_at),
    )
    conn.commit()


def save_job_step(conn: sqlite3.Connection, step: JobStep) -> None:
    payload = asdict(step)
    conn.execute(
        """
        INSERT INTO job_steps (id, job_id, name, status, sequence, body_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            sequence = excluded.sequence,
            body_json = excluded.body_json
        """,
        (
            step.id,
            step.job_id,
            step.name,
            step.status,
            step.sequence,
            json.dumps(payload, indent=2),
            step.created_at,
        ),
    )
    conn.commit()


def save_artifact(conn: sqlite3.Connection, artifact: Artifact) -> None:
    payload = asdict(artifact)
    _insert_object(
        conn,
        "artifacts",
        payload,
        id=artifact.id,
        job_id=artifact.job_id,
        kind=artifact.kind,
        title=artifact.title,
        path=artifact.path,
        score=artifact.score,
        created_at=artifact.created_at,
    )
    conn.commit()


def save_memory(conn: sqlite3.Connection, memory: Memory) -> None:
    payload = asdict(memory)
    _insert_object(
        conn,
        "memory",
        payload,
        id=memory.id,
        kind=memory.kind,
        ref_id=memory.ref_id,
        created_at=memory.created_at,
    )
    conn.commit()


def parse_intent(text: str, option_count: int | None = None) -> Intent:
    raw = text.strip()
    if not raw:
        raise ValueError("intent text is required")

    requested = option_count or _extract_option_count(raw)
    requested = max(3, min(5, requested))
    site = _extract_site(raw)
    constraints = _extract_constraints(raw)
    inputs = {
        "vertical": "architecture-option-space",
        "requested_options": requested,
        "site": site,
        "goal": raw,
    }
    return Intent(
        id=new_id("intent"),
        text=raw,
        kind="architecture.option_space",
        inputs=inputs,
        constraints=constraints,
    )


def create_job(intent: Intent) -> Job:
    plan = [
        "intent -> normalize architecture brief",
        "job -> lock architecture option-space vertical",
        "plan -> build scored massing option brief",
        "execute -> generate and evaluate 3-5 options",
        "artifacts -> persist options as JSON artifacts",
        "history -> write job summary into memory",
    ]
    return Job(
        id=new_id("job"),
        intent_id=intent.id,
        kind=intent.kind,
        status="planned",
        plan=plan,
        schedule=_choose_schedule(intent.text),
        evaluation={},
    )


def run_intent(text: str, option_count: int | None = None) -> dict[str, Any]:
    conn = connect()
    intent = parse_intent(text, option_count=option_count)
    save_intent(conn, intent)

    job = create_job(intent)
    save_job(conn, job)

    plan_step = JobStep(
        id=new_id("step"),
        job_id=job.id,
        name="plan",
        status="done",
        sequence=1,
        detail={
            "loop": "intent -> job -> plan -> execute -> artifacts -> history",
            "plan": job.plan,
            "vertical": "architecture-option-space",
        },
        started_at=now_iso(),
        completed_at=now_iso(),
    )
    save_job_step(conn, plan_step)

    route = _choose_route(intent.text)
    execute_detail = {
        "route": route,
        "schedule": job.schedule,
        "classification": "architecture-option-space",
        "realtime": job.schedule == "realtime",
    }
    execute_step = JobStep(
        id=new_id("step"),
        job_id=job.id,
        name="execute",
        status="running",
        sequence=2,
        detail=execute_detail,
        started_at=now_iso(),
    )
    save_job_step(conn, execute_step)

    artifacts = _generate_architecture_artifacts(job, intent, route, job.schedule)
    for artifact in artifacts:
        save_artifact(conn, artifact)

    execute_step.status = "done"
    execute_step.detail = {**execute_detail, "artifact_ids": [artifact.id for artifact in artifacts]}
    execute_step.completed_at = now_iso()
    save_job_step(conn, execute_step)

    artifact_step = JobStep(
        id=new_id("step"),
        job_id=job.id,
        name="artifacts",
        status="done",
        sequence=3,
        detail={
            "count": len(artifacts),
            "artifact_paths": [artifact.path for artifact in artifacts],
        },
        started_at=now_iso(),
        completed_at=now_iso(),
    )
    save_job_step(conn, artifact_step)

    memory = Memory(
        id=new_id("memory"),
        kind="job_history",
        ref_id=job.id,
        content={
            "intent": intent.text,
            "job_id": job.id,
            "kind": job.kind,
            "options": [
                {
                    "artifact_id": artifact.id,
                    "title": artifact.title,
                    "score": artifact.score,
                    "path": artifact.path,
                }
                for artifact in artifacts
            ],
        },
    )
    save_memory(conn, memory)

    history_step = JobStep(
        id=new_id("step"),
        job_id=job.id,
        name="history",
        status="done",
        sequence=4,
        detail={"memory_id": memory.id},
        started_at=now_iso(),
        completed_at=now_iso(),
    )
    save_job_step(conn, history_step)

    job.status = "done"
    job.updated_at = now_iso()
    job.evaluation = {
        "top_score": max(artifact.score for artifact in artifacts),
        "option_count": len(artifacts),
        "route": route,
        "schedule": job.schedule,
    }
    save_job(conn, job)

    return {
        "intent": asdict(intent),
        "job": asdict(job),
        "steps": [asdict(plan_step), asdict(execute_step), asdict(artifact_step), asdict(history_step)],
        "artifacts": [asdict(artifact) for artifact in artifacts],
        "memory": asdict(memory),
    }


def list_jobs(limit: int = 20) -> list[dict[str, Any]]:
    conn = connect()
    rows = conn.execute(
        "SELECT body_json FROM jobs ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [json.loads(row["body_json"]) for row in rows]


def load_job_bundle(job_id: str) -> dict[str, Any]:
    conn = connect()
    job_row = conn.execute("SELECT body_json FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not job_row:
        raise ValueError(f"job not found: {job_id}")
    job = json.loads(job_row["body_json"])
    intent_row = conn.execute("SELECT body_json FROM intents WHERE id = ?", (job["intent_id"],)).fetchone()
    steps = conn.execute(
        "SELECT body_json FROM job_steps WHERE job_id = ? ORDER BY sequence ASC",
        (job_id,),
    ).fetchall()
    artifacts = conn.execute(
        "SELECT body_json FROM artifacts WHERE job_id = ? ORDER BY score DESC, created_at ASC",
        (job_id,),
    ).fetchall()
    memory_rows = conn.execute(
        "SELECT body_json FROM memory WHERE ref_id = ? ORDER BY created_at DESC",
        (job_id,),
    ).fetchall()
    return {
        "intent": json.loads(intent_row["body_json"]) if intent_row else None,
        "job": job,
        "steps": [json.loads(row["body_json"]) for row in steps],
        "artifacts": [json.loads(row["body_json"]) for row in artifacts],
        "memory": [json.loads(row["body_json"]) for row in memory_rows],
    }


def _extract_option_count(text: str) -> int:
    match = re.search(r"\b([3-5])\b(?:\s+|[-])?(?:massing\s+)?options?\b", text, re.IGNORECASE)
    if match:
        return int(match.group(1))
    return 3


def _extract_site(text: str) -> str:
    lowered = text.lower()
    under_index = lowered.find(" under ")
    boundary = len(text) if under_index == -1 else under_index
    source = text[:boundary]
    match = re.search(r"\bfor\s+(.+)$", source, re.IGNORECASE)
    if match:
        return match.group(1).strip().rstrip(".")
    return "unspecified site"


def _extract_constraints(text: str) -> list[str]:
    lowered = text.lower()
    under_index = lowered.find(" under ")
    if under_index == -1:
        detected: list[str] = []
        if "faa" in lowered:
            detected.append("FAA")
        if "zoning" in lowered:
            detected.append("zoning")
        return detected
    tail = text[under_index + len(" under "):]
    tail = re.split(r"\b(with|that|while|and return|return)\b", tail, maxsplit=1, flags=re.IGNORECASE)[0]
    parts = re.split(r"\s*(?:\+|,|/|\band\b)\s*", tail)
    clean = [part.strip(" .") for part in parts if part.strip(" .")]
    normalized = []
    for item in clean:
        if item.lower() == "faa":
            normalized.append("FAA")
        else:
            normalized.append(item)
    return normalized


def _choose_route(text: str) -> str:
    lowered = text.lower()
    if any(token in lowered for token in ("faa", "zoning", "constraint", "site")):
        return "retrieval+small-model"
    if any(token in lowered for token in ("compare", "evaluate", "tradeoff")):
        return "small-model"
    return "tool"


def _choose_schedule(text: str) -> str:
    lowered = text.lower()
    if "batch" in lowered:
        return "batch"
    if "cheap window" in lowered or "overnight" in lowered:
        return "cheap-window"
    return "realtime"


def _generate_architecture_artifacts(job: Job, intent: Intent, route: str, schedule: str) -> list[Artifact]:
    requested = int(intent.inputs["requested_options"])
    site = str(intent.inputs["site"])
    constraints = intent.constraints or ["site fit"]
    prompt = intent.text.lower()

    profiles = [
        {
            "title": "Option 1 - Density Optimized",
            "focus": "maximize buildable envelope while staying legible",
            "massing": {
                "podium_levels": 5,
                "tower_count": 2,
                "tower_height_strategy": "push to the upper compliance envelope",
                "open_space_ratio": 0.18,
            },
            "tradeoffs": [
                "strong yield, weaker solar relief",
                "best for program intensity, not frontage softness",
            ],
            "score": 8.6,
        },
        {
            "title": "Option 2 - Civic Frontage Optimized",
            "focus": "strengthen street edge, entries, and public-facing base",
            "massing": {
                "podium_levels": 4,
                "tower_count": 1,
                "tower_height_strategy": "moderate height with framed street wall",
                "open_space_ratio": 0.24,
            },
            "tradeoffs": [
                "better public edge, lower raw yield",
                "stronger address and frontage sequence",
            ],
            "score": 8.4,
        },
        {
            "title": "Option 3 - Environmental Optimized",
            "focus": "improve daylight, setbacks, and passive performance",
            "massing": {
                "podium_levels": 3,
                "tower_count": 1,
                "tower_height_strategy": "slender form with aggressive setbacks",
                "open_space_ratio": 0.31,
            },
            "tradeoffs": [
                "best environmental posture, least aggressive FAR capture",
                "simpler compliance story for air and light",
            ],
            "score": 8.5,
        },
        {
            "title": "Option 4 - Phasing Optimized",
            "focus": "stage delivery while preserving a coherent final form",
            "massing": {
                "podium_levels": 4,
                "tower_count": 2,
                "tower_height_strategy": "split volume for phased delivery",
                "open_space_ratio": 0.22,
            },
            "tradeoffs": [
                "more operational flexibility, less formal purity",
                "useful when entitlement or capital timing is uncertain",
            ],
            "score": 8.1,
        },
        {
            "title": "Option 5 - Balanced Mixed-Use",
            "focus": "balance yield, frontage, and performance",
            "massing": {
                "podium_levels": 4,
                "tower_count": 2,
                "tower_height_strategy": "mid-height pair with shared podium",
                "open_space_ratio": 0.26,
            },
            "tradeoffs": [
                "not best at any single objective, strongest all-around compromise",
                "easiest option to compare against the others as a baseline",
            ],
            "score": 8.3,
        },
    ]

    artifacts: list[Artifact] = []
    for index, profile in enumerate(profiles[:requested], start=1):
        score = profile["score"]
        if "faa" in prompt and "upper compliance envelope" in profile["massing"]["tower_height_strategy"]:
            score -= 0.2
        if "zoning" in prompt and profile["massing"]["podium_levels"] in (4, 5):
            score += 0.1
        if "environment" in prompt or "environmental" in prompt:
            if "Environmental" in profile["title"]:
                score += 0.25
        if "civic" in prompt and "Civic" in profile["title"]:
            score += 0.2
        score = round(score, 2)

        rationale = (
            f"{profile['focus'].capitalize()} for {site}. "
            f"Route: {route}. Schedule: {schedule}. "
            f"Primary constraints carried through: {', '.join(constraints)}."
        )
        payload = {
            "option_index": index,
            "site": site,
            "focus": profile["focus"],
            "massing": profile["massing"],
            "tradeoffs": profile["tradeoffs"],
            "route": route,
            "schedule": schedule,
            "constraints": constraints,
        }
        artifact_path = _write_artifact_file(job.id, profile["title"], payload | {"score": score, "rationale": rationale})
        artifacts.append(
            Artifact(
                id=new_id("artifact"),
                job_id=job.id,
                kind="architecture.option",
                title=profile["title"],
                path=str(artifact_path),
                payload=payload,
                score=score,
                constraints=constraints,
                rationale=rationale,
            )
        )
    return artifacts


def _write_artifact_file(job_id: str, title: str, payload: dict[str, Any]) -> Path:
    target_dir = RUNTIME_ARTIFACTS / job_id
    target_dir.mkdir(parents=True, exist_ok=True)
    file_path = target_dir / f"{slugify(title)}.json"
    file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return file_path
