from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class PlannedTask:
    title: str
    priority: str = "Medium"
    workflow_label: str = ""
    details: str = ""


_INTENT_PATTERNS = [
    (
        ("site", "layout", "development"),
        [
            PlannedTask("Generate massing model", "High", "design", "Create initial massing options from the site brief."),
            PlannedTask("Check zoning laws", "High", "compliance", "Verify setbacks, FAR, height, and use constraints."),
            PlannedTask("Analyze sun exposure", "Medium", "analysis", "Review daylight and overshadowing impacts."),
            PlannedTask("Prepare mixed-use circulation plan", "Medium", "design", "Outline retail, residential, and service flows."),
            PlannedTask("Submit design for approval", "Medium", "review", "Package the preferred concept for stakeholder review."),
        ],
    ),
    (
        ("approval", "permit"),
        [
            PlannedTask("Assemble permit package", "High", "documentation"),
            PlannedTask("Run code compliance check", "High", "compliance"),
            PlannedTask("Prepare approval submission", "Medium", "review"),
        ],
    ),
    (
        ("launch", "product"),
        [
            PlannedTask("Define launch checklist", "High", "planning"),
            PlannedTask("Draft release communications", "Medium", "coordination"),
            PlannedTask("Prepare post-launch monitoring", "Medium", "operations"),
        ],
    ),
]


def parse_intent_to_tasks(intent: str) -> list[PlannedTask]:
    lowered = (intent or "").strip().lower()
    if not lowered:
        return []

    for keywords, tasks in _INTENT_PATTERNS:
        if all(keyword in lowered for keyword in keywords):
            return tasks

    fragments = [part.strip(" .") for part in lowered.replace(" and ", ",").split(",") if part.strip(" .")]
    if not fragments:
        fragments = [lowered]
    planned = []
    for index, fragment in enumerate(fragments[:5], start=1):
        planned.append(
            PlannedTask(
                title=fragment[:1].upper() + fragment[1:],
                priority="High" if index == 1 else "Medium",
                workflow_label="generated",
                details="Generated from free-form intent parsing.",
            )
        )
    return planned


def suggest_next_steps(task: dict, sibling_tasks: Iterable[dict]) -> list[str]:
    status = (task.get("status") or "").lower()
    label = (task.get("workflow_label") or "").lower()
    suggestions: list[str] = []
    if status == "completed":
        pending = [item for item in sibling_tasks if item.get("status") == "Planned"]
        if pending:
            suggestions.append(f"Start next queued task: {pending[0]['title']}")
        if label == "design":
            suggestions.append("Run a code compliance check before external review.")
        if label == "review":
            suggestions.append("Capture approval notes and convert them into follow-up tasks.")
    elif status == "failed":
        reason = (task.get("failure_reason") or "").lower()
        if "zoning" in reason or "height" in reason:
            suggestions.append("Reduce building height or massing before rerunning compliance.")
        suggestions.append("Attach a note describing the failure so future retries keep the context.")
    else:
        suggestions.append("Clarify dependencies and mark the task In Progress once execution starts.")
    return suggestions
