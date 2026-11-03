#!/usr/bin/env python3
"""
HII system-native loop, first vertical slice.

observe -> act through the user's world -> verify by re-reading native state -> receipt

No canvas. No captured copy. No workspace chooser.
"""
import hashlib, json, os, pathlib, subprocess, sys, time, uuid

HII = pathlib.Path.home() / ".hii"

def osa(script: str):
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None

# ---------- 1. OBSERVE: the user's world, not HII's ----------
def observe():
    ctx, sources = {}, []
    app = osa('tell application "System Events" to name of first '
              'application process whose frontmost is true')
    if app:
        ctx["frontmost_app"] = app
        sources.append(f"system-events:frontmost-app:{app}")
    title = osa('tell application "System Events" to tell (first application '
                'process whose frontmost is true) to try\n return name of front window\nend try')
    if title:
        ctx["window_title"] = title
        sources.append(f"system-events:window-title:{title}")
    if app:
        url = osa(f'tell application "{app}" to try\n return URL of active tab of front window\nend try')
        if url and url.startswith("http"):
            ctx["url"] = url
            sources.append(f"{app.lower()}:active-tab-url:{url}")
    finder = osa('tell application "Finder" to try\n return POSIX path of '
                 '(target of front window as alias)\nend try')
    if finder:
        ctx["finder_dir"] = finder
        sources.append(f"finder:front-window:{finder}")
    return ctx, sources

# ---------- 2. ACT: through the user's world, producing a normal user-owned file ----------
def act(ctx, outdir):
    outdir.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() or c in "-_ " else "" for c in
                   ctx.get("window_title", "context"))[:60].strip().replace(" ", "-") or "context"
    path = outdir / f"{time.strftime('%Y-%m-%d')}-{slug}.md"
    body = [f"# {ctx.get('window_title', 'Captured context')}", ""]
    body.append(f"- observed_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}")
    for k in ("frontmost_app", "url", "finder_dir"):
        if ctx.get(k):
            body.append(f"- {k}: {ctx[k]}")
    body += ["", "## Notes", "", ""]
    text = "\n".join(body)
    path.write_text(text)
    return path, hashlib.sha256(text.encode()).hexdigest()

# ---------- 3. VERIFY: re-read reality, do not trust the actor ----------
def verify(path, expected_hash, ctx):
    checks = []
    ok_disk = path.exists()
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if ok_disk else ""
    checks.append({"command": f"re-read {path} from disk and compare sha256",
                   "ok": ok_disk and actual == expected_hash,
                   "output": "verified" if actual == expected_hash else f"MISMATCH {actual}"})
    now_app = osa('tell application "System Events" to name of first '
                  'application process whose frontmost is true')
    checks.append({"command": "re-observe frontmost app to detect context drift",
                   "ok": now_app == ctx.get("frontmost_app"),
                   "output": f"observed={ctx.get('frontmost_app')} now={now_app}"})
    vis = osa(f'tell application "Finder" to return exists (POSIX file "{path}" as alias)')
    checks.append({"command": "confirm the artifact is visible to Finder as a real user file",
                   "ok": vis == "true", "output": f"finder_exists={vis}"})
    return checks

def main():
    intent = " ".join(sys.argv[1:]) or "Save what I am looking at as a note I own"
    outdir = pathlib.Path.home() / "Documents" / "HII Notes"
    rid = f"native-{uuid.uuid4()}"
    started = time.time()

    ctx, sources = observe()
    path, h = act(ctx, outdir)
    checks = verify(path, h, ctx)
    passed = all(c["ok"] for c in checks)

    receipt = {
        "schema_version": 8, "id": rid,
        "created_at_unix_ms": int(started * 1000),
        "finished_at_unix_ms": int(time.time() * 1000),
        "status": "completed" if passed else "incomplete",
        "outcome": "completed" if passed else "verify-failed",
        "goal": intent,
        "observed_context": ctx,
        "context_sources": sources,
        "acted_through": ctx.get("frontmost_app", "filesystem"),
        "authority": "user-documents",
        "done_when": "a normal user-owned file exists, hash-verified, visible to Finder",
        "verification": checks,
        "artifacts": [str(path)],
        "content_hash": h,
        "reversible": True,
        "summary": f"Observed {ctx.get('frontmost_app','?')} and wrote {path.name} to {outdir}",
    }
    d = HII / "runs" / "native" / rid
    d.mkdir(parents=True, exist_ok=True)
    (d / "receipt.json").write_text(json.dumps(receipt, indent=2))
    print(json.dumps({"receipt": str(d / "receipt.json"), "artifact": str(path),
                      "verified": passed}, indent=2))
    return 0 if passed else 1

if __name__ == "__main__":
    sys.exit(main())
