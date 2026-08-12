#!/usr/bin/env python3
"""Initialize a dependency-free HII architectural project package."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "assets" / "templates"
FILES = ("project.json", "design-state.json", "issues.json", "evidence-receipt.json")
PHASES = ("discovery", "concept", "schematic", "design-development", "permit", "construction", "record")
UNITS = ("mm", "cm", "m", "in", "ft")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--units", choices=UNITS, default="ft")
    parser.add_argument("--phase", choices=PHASES, default="concept")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=False)
    for name in FILES:
        shutil.copy2(TEMPLATE_DIR / name, args.output_dir / name)

    for name in FILES:
        path = args.output_dir / name
        value = json.loads(path.read_text())
        value["project_id"] = args.project_id
        if name == "project.json":
            value["name"] = args.name
            value["units"] = args.units
            value["phase"] = args.phase
        elif name == "design-state.json":
            value["units"] = args.units
        path.write_text(json.dumps(value, indent=2) + "\n")

    print(f"Initialized {args.project_id} at {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
