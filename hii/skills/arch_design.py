"""
arch-design — natural-language brief → parametric Rhino/Grasshopper model + ComfyUI render + report.

Composes existing HII subsystems:
  - hii.harness.grasshopper_bridge : socket bridge to Rhino/Grasshopper
  - hii.harness.comfyui            : ComfyUI txt2img client

Usage:
  python -m hii.skills.arch_design --brief "twisted biophilic 40-floor tower" --seed 42
  python -m hii.skills.arch_design --brief "..." --dry-run     # plan only, no Rhino/ComfyUI calls
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from hii.harness import comfyui
from hii.harness import grasshopper_bridge as gh

ARTIFACT_ROOT = Path.home() / ".hii" / "artifacts" / "arch-design"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Brief → spec (rule-based parser; LLM-callable shape, but no LLM dependency)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class DesignSpec:
    brief: str
    typology: str = "tower"
    floors: int = 30
    footprint_m: float = 35.0
    floor_height_m: float = 3.6
    twist_deg_per_floor: float = 0.0
    facade: str = "glass curtain wall"
    program: list[str] = field(default_factory=lambda: ["office"])
    sustainability: list[str] = field(default_factory=list)


def parse_brief(brief: str, typology_hint: str | None = None) -> DesignSpec:
    """Extract a structured spec from a natural-language brief.

    Deterministic regex-based parser — no LLM call needed for this scope.
    Hooks for an LLM-driven parser can replace this function without changing callers.
    """
    text = brief.lower()
    spec = DesignSpec(brief=brief)

    if typology_hint:
        spec.typology = typology_hint
    elif "courtyard" in text:
        spec.typology = "courtyard"
    elif "slab" in text or "linear" in text:
        spec.typology = "slab"
    else:
        spec.typology = "tower"

    floor_match = re.search(r"(\d{1,3})[\s-]*(?:floor|story|storey|stories|level)", text)
    if floor_match:
        spec.floors = max(1, min(120, int(floor_match.group(1))))

    twist_match = re.search(r"(\d{1,2}(?:\.\d+)?)\s*(?:deg|degree|°)", text)
    if twist_match:
        spec.twist_deg_per_floor = float(twist_match.group(1))
    elif "twist" in text or "spiral" in text:
        spec.twist_deg_per_floor = 1.5

    footprint_match = re.search(r"(\d{2,3})\s*m(?:\s|$|\W)", text)
    if footprint_match:
        spec.footprint_m = float(footprint_match.group(1))

    if "biophilic" in text or "garden" in text or "vegetation" in text:
        spec.sustainability.append("vertical-gardens")
    if "solar" in text or "photovoltaic" in text or "bipv" in text:
        spec.sustainability.append("BIPV")
    if "passive" in text or "natural ventilation" in text:
        spec.sustainability.append("natural-ventilation")
    if "geothermal" in text:
        spec.sustainability.append("geothermal")

    if "residential" in text or "housing" in text or "apartments" in text:
        spec.program = ["residential"]
    elif "mixed-use" in text or "mixed use" in text:
        spec.program = ["retail", "office", "residential"]
    elif "office" in text or "commercial" in text:
        spec.program = ["office"]
    elif "museum" in text or "cultural" in text:
        spec.program = ["cultural"]

    if "wood" in text or "timber" in text or "clt" in text:
        spec.facade = "CLT timber panels with operable windows"
    elif "stone" in text or "masonry" in text:
        spec.facade = "stone-clad with punched openings"
    elif "biophilic" in text:
        spec.facade = "double-skin glass with integrated vertical gardens"

    return spec


# ─────────────────────────────────────────────────────────────────────────────
# 2. Spec → Grasshopper component chain (tower typology)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class GhStep:
    """One step in the planned Grasshopper component chain. Used for dry-run + execution."""
    op: str                   # "add" | "connect" | "save" | "clear"
    args: dict[str, Any]


def plan_tower_chain(spec: DesignSpec, out_3dm: Path) -> list[GhStep]:
    """Plan the GH component sequence for a tower typology.

    Builds: Polygon (footprint) → Extrude (per-floor) → Rotate-by-index (twist) → Loft → Bake.
    Returned as a list of GhSteps so the orchestrator can dry-run-print or execute.
    """
    steps: list[GhStep] = []
    steps.append(GhStep("clear", {}))

    # Base polygon footprint (n-gon approximating a square; radius from footprint_m)
    steps.append(GhStep("add", {
        "component_name": "Polygon",
        "x": 100.0, "y": 100.0,
        "params": {"R": spec.footprint_m / 2.0, "S": 4, "F": 0.0},
        "ref": "footprint",
    }))

    # Range 0..floors-1 for floor index
    steps.append(GhStep("add", {
        "component_name": "Range",
        "x": 100.0, "y": 250.0,
        "params": {"D": float(spec.floors - 1), "N": spec.floors},
        "ref": "floor_index",
    }))

    # Move-Z per floor (floor_index * floor_height)
    steps.append(GhStep("add", {
        "component_name": "Multiplication",
        "x": 250.0, "y": 250.0,
        "params": {"B": spec.floor_height_m},
        "ref": "z_per_floor",
    }))
    steps.append(GhStep("connect", {"src": "floor_index", "out": "R", "dst": "z_per_floor", "in": "A"}))

    # Rotate per floor (floor_index * twist_rad)
    steps.append(GhStep("add", {
        "component_name": "Multiplication",
        "x": 250.0, "y": 350.0,
        "params": {"B": spec.twist_deg_per_floor * 3.14159265 / 180.0},
        "ref": "angle_per_floor",
    }))
    steps.append(GhStep("connect", {"src": "floor_index", "out": "R", "dst": "angle_per_floor", "in": "A"}))

    steps.append(GhStep("add", {
        "component_name": "Rotate",
        "x": 450.0, "y": 200.0,
        "params": {},
        "ref": "rotated_curve",
    }))
    steps.append(GhStep("connect", {"src": "footprint", "out": "P", "dst": "rotated_curve", "in": "G"}))
    steps.append(GhStep("connect", {"src": "angle_per_floor", "out": "R", "dst": "rotated_curve", "in": "A"}))

    steps.append(GhStep("add", {
        "component_name": "Move",
        "x": 600.0, "y": 200.0,
        "params": {},
        "ref": "moved_curve",
    }))
    steps.append(GhStep("connect", {"src": "rotated_curve", "out": "G", "dst": "moved_curve", "in": "G"}))
    steps.append(GhStep("connect", {"src": "z_per_floor", "out": "R", "dst": "moved_curve", "in": "T"}))

    # Loft the rotated/moved floor curves into a tower massing
    steps.append(GhStep("add", {
        "component_name": "Loft",
        "x": 800.0, "y": 200.0,
        "params": {},
        "ref": "tower_brep",
    }))
    steps.append(GhStep("connect", {"src": "moved_curve", "out": "G", "dst": "tower_brep", "in": "C"}))

    # Save the resulting Grasshopper definition + baked Rhino doc
    steps.append(GhStep("save", {"file_path": str(out_3dm)}))
    return steps


def execute_chain(steps: list[GhStep], dry_run: bool = False) -> dict[str, Any]:
    """Execute or dry-run the planned chain. Returns a structured log."""
    log: list[dict[str, Any]] = []
    refs: dict[str, str] = {}      # ref alias → component_id returned by Grasshopper

    for step in steps:
        entry = {"op": step.op, "args": step.args}
        if dry_run:
            entry["result"] = "DRY_RUN"
            log.append(entry)
            continue

        if step.op == "clear":
            entry["result"] = gh.grasshopper_request("clear_document", {})
        elif step.op == "add":
            ref = step.args.pop("ref", None)
            entry["result"] = gh.grasshopper_request("add_component", step.args)
            cid = (entry["result"].get("result") or {}).get("component_id") if isinstance(entry["result"], dict) else None
            if ref and cid:
                refs[ref] = cid
        elif step.op == "connect":
            src_id = refs.get(step.args["src"])
            dst_id = refs.get(step.args["dst"])
            if not src_id or not dst_id:
                entry["result"] = {"success": False, "error": f"unresolved ref {step.args}"}
            else:
                entry["result"] = gh.grasshopper_request("connect_components", {
                    "source_id": src_id,
                    "source_output": step.args["out"],
                    "target_id": dst_id,
                    "target_input": step.args["in"],
                })
        elif step.op == "save":
            entry["result"] = gh.grasshopper_request("save_document", step.args)
        else:
            entry["result"] = {"success": False, "error": f"unknown op {step.op}"}
        log.append(entry)
    return {"steps_run": len(log), "refs": refs, "log": log}


# ─────────────────────────────────────────────────────────────────────────────
# 3. ComfyUI render
# ─────────────────────────────────────────────────────────────────────────────

def build_render_prompt(spec: DesignSpec) -> tuple[str, str]:
    sustain = ", ".join(spec.sustainability) if spec.sustainability else "modern sustainable systems"
    twist_phrase = (
        f"parametric twisted form ({spec.twist_deg_per_floor:.1f}° per floor)"
        if spec.twist_deg_per_floor > 0
        else "clean orthogonal massing"
    )
    program = ", ".join(spec.program)
    prompt = (
        f"masterpiece, photorealistic architectural render, a {spec.floors}-floor {spec.typology} "
        f"with {twist_phrase}, {spec.facade}, {sustain}, programmed for {program}, "
        f"golden hour lighting, dramatic sky, urban cityscape background, "
        f"cinematic composition, ultra detailed, 8k"
    )
    negative = (
        "blurry, low quality, distorted, cartoon, anime, sketch, flat, dull lighting, "
        "ugly, deformed, watermark, text, signature, grainy, oversaturated"
    )
    return prompt, negative


def render_with_comfyui(spec: DesignSpec, seed: int, out_dir: Path, dry_run: bool) -> dict[str, Any]:
    prompt, negative = build_render_prompt(spec)
    if dry_run:
        return {"dry_run": True, "prompt": prompt, "negative": negative, "seed": seed}

    result = comfyui.run_text_to_image(
        prompt=prompt,
        negative_prompt=negative,
        width=768,
        height=1024,
        steps=25,
        cfg=7.5,
        seed=seed,
        output_prefix=f"arch-design-{seed}",
        wait=True,
    )
    # Download the first output to out_dir/render.png so the artifact is self-contained
    outputs = result.get("outputs") or []
    if outputs:
        url = outputs[0]["url"]
        target = out_dir / "render.png"
        try:
            with urllib.request.urlopen(url, timeout=30) as resp, open(target, "wb") as fh:
                fh.write(resp.read())
            result["render_path"] = str(target)
        except Exception as exc:
            result["render_path_error"] = str(exc)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# 4. Report assembly
# ─────────────────────────────────────────────────────────────────────────────

def write_report(spec: DesignSpec, seed: int, out_dir: Path, render_info: dict[str, Any], gh_log: dict[str, Any]) -> Path:
    render_line = render_info.get("render_path") or "(render not downloaded — see ComfyUI output folder)"
    sustain = ", ".join(spec.sustainability) if spec.sustainability else "(none specified)"
    program = ", ".join(spec.program)
    twist = (
        f"{spec.twist_deg_per_floor:.2f}° per floor ({spec.twist_deg_per_floor * spec.floors:.1f}° total)"
        if spec.twist_deg_per_floor > 0
        else "no twist (orthogonal)"
    )

    body = f"""# Architectural Design Report

**Brief:** {spec.brief}
**Seed:** {seed}
**Generated:** {time.strftime("%Y-%m-%d %H:%M:%S")}

## Parsed Design Spec

| Parameter | Value |
|---|---|
| Typology | {spec.typology} |
| Floors | {spec.floors} |
| Footprint (m) | {spec.footprint_m} |
| Floor height (m) | {spec.floor_height_m} |
| Twist | {twist} |
| Facade | {spec.facade} |
| Program | {program} |
| Sustainability | {sustain} |

## Pipeline

1. **Brief parsed** → structured `DesignSpec` (rule-based extraction).
2. **Grasshopper chain planned** → {gh_log.get("steps_run", 0)} component operations dispatched to Rhino via HII bridge.
3. **Rhino document saved** → `{out_dir / "model.3dm"}`
4. **ComfyUI render** → SD 1.5, 768×1024, 25 steps, CFG 7.5, dpmpp_2m / karras (seed {seed}).

## Render

![render]({render_line})

## Artifacts

- Spec: `{out_dir / "spec.json"}`
- GH execution log: `{out_dir / "gh_log.json"}`
- Rhino model: `{out_dir / "model.3dm"}`
- Render: `{render_line}`

## Reproducibility

Re-run with same seed to regenerate identical artifacts:

```
hii skill run arch-design --brief "{spec.brief}" --seed {seed}
```
"""
    path = out_dir / "report.md"
    path.write_text(body, encoding="utf-8")
    return path


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def _capability_preflight(skip_rhino: bool, skip_comfy: bool, dry_run: bool) -> dict[str, Any]:
    """Consult the capability map for ComfyUI + Grasshopper-MCP availability.

    Returns {"ok": bool, "warnings": [...]}. Never raises — capabilities is fail-soft.
    """
    if dry_run:
        return {"ok": True, "warnings": [], "skipped": True}
    try:
        from hii import capabilities
        cap = capabilities.get_capability_map()
    except Exception as exc:
        return {"ok": True, "warnings": [f"capability map unavailable: {exc}"]}

    warnings: list[str] = []
    if not skip_comfy:
        svc = next((s for s in cap.services if s.id == "service.comfyui"), None)
        if not svc or not svc.available:
            warnings.append(
                "ComfyUI is offline at the expected endpoint. Start ComfyUI (default http://127.0.0.1:8188) "
                "or pass --skip-comfy."
            )
    if not skip_rhino:
        svc = next((s for s in cap.services if s.id == "service.grasshopper_mcp"), None)
        if not svc or not svc.available:
            warnings.append(
                "Grasshopper MCP bridge is unreachable (default 127.0.0.1:8080). Open Rhino + Grasshopper "
                "with the HII MCP listener enabled, or pass --skip-rhino."
            )
    return {"ok": not warnings, "warnings": warnings}


def run(brief: str, typology: str | None, seed: int, dry_run: bool, skip_rhino: bool, skip_comfy: bool) -> dict[str, Any]:
    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{seed}"
    out_dir = ARTIFACT_ROOT / run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    preflight = _capability_preflight(skip_rhino, skip_comfy, dry_run)
    if preflight.get("warnings"):
        (out_dir / "preflight.json").write_text(json.dumps(preflight, indent=2))

    spec = parse_brief(brief, typology_hint=typology)
    (out_dir / "spec.json").write_text(json.dumps(asdict(spec), indent=2))

    out_3dm = out_dir / "model.3dm"
    steps = plan_tower_chain(spec, out_3dm)  # tower-only for now; other typologies fall through to tower massing

    gh_log: dict[str, Any] = {"skipped": True}
    if not skip_rhino:
        gh_log = execute_chain(steps, dry_run=dry_run)
    (out_dir / "gh_log.json").write_text(json.dumps(gh_log, indent=2, default=str))

    render_info: dict[str, Any] = {"skipped": True}
    if not skip_comfy:
        render_info = render_with_comfyui(spec, seed=seed, out_dir=out_dir, dry_run=dry_run)
    (out_dir / "render_info.json").write_text(json.dumps(render_info, indent=2, default=str))

    report_path = write_report(spec, seed, out_dir, render_info, gh_log)

    summary = {
        "run_id": run_id,
        "artifacts_dir": str(out_dir),
        "report": str(report_path),
        "spec": asdict(spec),
        "gh_steps_planned": len(steps),
        "gh_executed": not skip_rhino and not dry_run,
        "render_executed": not skip_comfy and not dry_run,
        "preflight": preflight,
    }
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="arch-design", description="LLM-driven architectural design pipeline (Rhino + ComfyUI)")
    p.add_argument("--brief", required=True, help="Natural-language design brief")
    p.add_argument("--typology", choices=["tower", "slab", "courtyard"], default=None)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--dry-run", action="store_true", help="Plan only — do not call Rhino or ComfyUI")
    p.add_argument("--skip-rhino", action="store_true", help="Skip Grasshopper chain execution")
    p.add_argument("--skip-comfy", action="store_true", help="Skip ComfyUI render")
    args = p.parse_args(argv)

    try:
        summary = run(
            brief=args.brief,
            typology=args.typology,
            seed=args.seed,
            dry_run=args.dry_run,
            skip_rhino=args.skip_rhino,
            skip_comfy=args.skip_comfy,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps({"ok": True, **summary}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
