#!/usr/bin/env python3
"""Validate core HII architectural package integrity without dependencies."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


FILES = ("project.json", "design-state.json", "issues.json", "evidence-receipt.json")
UNITS = {"mm", "cm", "m", "in", "ft"}
PHASES = {"discovery", "concept", "schematic", "design-development", "permit", "construction", "record"}
STATUSES = {"pass", "fail", "unknown", "not_applicable", "open", "resolved", "accepted"}
SEVERITIES = {"critical", "major", "minor", "advisory"}
EVIDENCE_CLASSES = {"sourced", "observed", "calculated", "assumed", "inferred", "illustrative", "unknown"}


def finite_numbers(value: Any) -> bool:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(finite_numbers(item) for item in value)
    if isinstance(value, dict):
        return all(finite_numbers(item) for item in value.values())
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    args = parser.parse_args()
    errors: list[str] = []
    data: dict[str, Any] = {}

    for name in FILES:
        path = args.project_dir / name
        if not path.is_file():
            errors.append(f"missing required file: {name}")
            continue
        try:
            data[name] = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            errors.append(f"invalid {name}: {error}")

    if errors:
        return report(errors)

    project = data["project.json"]
    state = data["design-state.json"]
    issues = data["issues.json"]
    receipt = data["evidence-receipt.json"]
    project_id = project.get("project_id")

    if not isinstance(project_id, str) or not project_id.strip() or project_id == "replace-me":
        errors.append("project.json project_id must be set")
    if project.get("phase") not in PHASES:
        errors.append("project.json phase is invalid")
    if project.get("units") not in UNITS:
        errors.append("project.json units are invalid")
    for name, value in data.items():
        if value.get("project_id") != project_id:
            errors.append(f"{name} project_id does not match project.json")
        if not finite_numbers(value):
            errors.append(f"{name} contains a non-finite or unsupported value")
    if state.get("units") != project.get("units"):
        errors.append("design-state.json units do not match project.json")

    objects = state.get("objects")
    if not isinstance(objects, list):
        errors.append("design-state.json objects must be an array")
        objects = []
    ids: list[str] = []
    for index, obj in enumerate(objects):
        if not isinstance(obj, dict):
            errors.append(f"object[{index}] must be an object")
            continue
        obj_id = obj.get("id")
        if not isinstance(obj_id, str) or not obj_id:
            errors.append(f"object[{index}] requires a non-empty id")
        else:
            ids.append(obj_id)
        if not isinstance(obj.get("semantic_type"), str) or not obj.get("semantic_type"):
            errors.append(f"object[{index}] requires semantic_type")
        if not isinstance(obj.get("version"), int) or obj.get("version", 0) < 1:
            errors.append(f"object[{index}] requires version >= 1")
    duplicates = sorted({item for item in ids if ids.count(item) > 1})
    if duplicates:
        errors.append(f"duplicate object ids: {', '.join(duplicates)}")
    id_set = set(ids)

    relations = state.get("relations", [])
    if not isinstance(relations, list):
        errors.append("design-state.json relations must be an array")
        relations = []
    for index, relation in enumerate(relations):
        if not isinstance(relation, dict):
            errors.append(f"relation[{index}] must be an object")
            continue
        for endpoint in ("from", "to"):
            if relation.get(endpoint) not in id_set:
                errors.append(f"relation[{index}] {endpoint} references unknown object")
        if not relation.get("type"):
            errors.append(f"relation[{index}] requires type")

    options = state.get("options", [])
    option_ids = [item.get("id") for item in options if isinstance(item, dict)]
    if len(option_ids) != len(set(option_ids)):
        errors.append("design-state.json option ids must be unique")
    current = project.get("current_option_id")
    if current is not None and current not in option_ids:
        errors.append("project.json current_option_id does not resolve")

    for index, issue in enumerate(issues.get("issues", [])):
        if issue.get("severity") not in SEVERITIES:
            errors.append(f"issue[{index}] severity is invalid")
        if issue.get("status") not in STATUSES:
            errors.append(f"issue[{index}] status is invalid")
        for obj_id in issue.get("object_ids", []):
            if obj_id not in id_set:
                errors.append(f"issue[{index}] references unknown object {obj_id}")

    if receipt.get("confidence") not in {"low", "medium", "high"}:
        errors.append("evidence-receipt.json confidence is invalid")
    for index, source in enumerate(receipt.get("sources", [])):
        evidence_class = source.get("evidence_class") if isinstance(source, dict) else None
        if evidence_class not in EVIDENCE_CLASSES:
            errors.append(f"receipt source[{index}] evidence_class is invalid")
    if not isinstance(receipt.get("next_action"), str):
        errors.append("evidence-receipt.json next_action must be a string")

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        print(f"FAIL: {len(errors)} architectural package issue(s)")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: architectural package core integrity validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
