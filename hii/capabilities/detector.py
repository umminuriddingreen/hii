"""Top-level capability detector.

Composes runtime, apps, services+models, workflows, and assets scanners into
one CapabilityMap. Each scanner failing independently is non-fatal — the rest
still produce a usable map and the failure surfaces as a warning/error on the
scanner report.

Usage:
    python -m hii.capabilities.detector            # detect + write cache + agent context
    from hii.capabilities import detector
    cap = detector.run()
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

from . import apps as apps_scanner
from . import assets as assets_scanner
from . import cache
from . import export
from . import models as services_scanner
from . import runtime as runtime_scanner
from . import trace
from . import workflows as workflows_scanner
from .schema import CapabilityMap, ScannerReport


def _safe_scan(name: str, fn, scan_id: str):
    """Call a scanner, capturing exceptions into a ScannerReport so the run continues."""
    t0 = time.time()
    try:
        result = fn()
        # scanner returns (caps, report) OR (services, models, report)
        if len(result) == 3:
            a, b, rep = result
            trace.emit(scan_id, "scanner_finished", scanner=name, status=rep.status,
                       duration_ms=rep.duration_ms, detected_count=rep.detected_count,
                       warnings=rep.warnings, errors=rep.errors)
            return (a, b, rep)
        caps, rep = result
        trace.emit(scan_id, "scanner_finished", scanner=name, status=rep.status,
                   duration_ms=rep.duration_ms, detected_count=rep.detected_count,
                   warnings=rep.warnings, errors=rep.errors)
        return (caps, rep)
    except Exception as exc:
        duration = (time.time() - t0) * 1000
        rep = ScannerReport(scanner=name, status="failed", duration_ms=duration,
                            errors=[f"unhandled exception: {exc}"])
        trace.emit(scan_id, "scanner_failed", scanner=name, status="failed",
                   duration_ms=duration, errors=[str(exc)])
        return ([], rep)


def run(*, write_cache: bool = True, write_context: bool = True) -> CapabilityMap:
    """Execute every scanner, build the map, optionally persist."""
    scan_id = uuid.uuid4().hex[:12]
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    trace.emit(scan_id, "scan_started")

    cap = CapabilityMap(scan_id=scan_id, generated_at=started)

    # runtime
    runtime_caps, rep_runtime = _safe_scan("runtime", runtime_scanner.scan, scan_id)
    cap.runtime = runtime_caps
    cap.scanner_reports.append(rep_runtime)

    # apps
    app_caps, rep_apps = _safe_scan("apps", apps_scanner.scan, scan_id)
    cap.apps = app_caps
    cap.scanner_reports.append(rep_apps)

    # services + models (one scanner produces both)
    svc_result = _safe_scan("services_models", services_scanner.scan, scan_id)
    if len(svc_result) == 3:
        services, models, rep_svc = svc_result
    else:
        services, models, rep_svc = [], [], svc_result[1]
    cap.services = services
    cap.models = models
    cap.scanner_reports.append(rep_svc)

    # workflows
    wf_caps, rep_wf = _safe_scan("workflows", workflows_scanner.scan, scan_id)
    cap.workflows = wf_caps
    cap.scanner_reports.append(rep_wf)

    # assets
    asset_caps, rep_assets = _safe_scan("assets", assets_scanner.scan, scan_id)
    cap.assets = asset_caps
    cap.scanner_reports.append(rep_assets)

    # Host summary (compact)
    host = next((r for r in cap.runtime if r.id == "runtime.host"), None)
    if host:
        cap.host = {
            "os": host.metadata.get("os"),
            "architecture": host.metadata.get("architecture"),
            "hostname": host.metadata.get("hostname"),
            "username": host.metadata.get("username"),
            "home": host.metadata.get("home"),
            "cwd": host.metadata.get("cwd"),
        }

    # Allowed roots — what the scanners actually descended into
    cap.allowed_roots = [str(p) for p in (
        workflows_scanner.default_roots() + assets_scanner.default_roots()
    )]

    # Aggregate
    for rep in cap.scanner_reports:
        cap.warnings.extend([f"[{rep.scanner}] {w}" for w in rep.warnings])
        cap.errors.extend([f"[{rep.scanner}] {e}" for e in rep.errors])

    any_failed = any(r.status == "failed" for r in cap.scanner_reports)
    if write_cache:
        try:
            cache.write(cap, mark_last_good=not any_failed)
        except Exception as exc:
            cap.errors.append(f"cache.write failed: {exc}")
            trace.emit(scan_id, "cache_write_failed", errors=[str(exc)])

    if write_context:
        try:
            export.write_agent_context(cap)
        except Exception as exc:
            cap.errors.append(f"export.write_agent_context failed: {exc}")
            trace.emit(scan_id, "agent_context_write_failed", errors=[str(exc)])

    trace.emit(scan_id, "scan_finished",
               status="failed" if any_failed else "success",
               detected_count=sum(cap.counts().values()),
               warnings=cap.warnings, errors=cap.errors)
    return cap


def main() -> int:
    cap = run()
    counts = cap.counts()
    print(f"scan_id={cap.scan_id} at={cap.generated_at}")
    for k, v in counts.items():
        print(f"  {k:10} {v}")
    if cap.warnings:
        print(f"warnings: {len(cap.warnings)}")
    if cap.errors:
        print(f"errors: {len(cap.errors)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
