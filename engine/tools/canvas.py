#!/usr/bin/env python3
"""
HII Canvas LMS Integration — NJIT

Pulls courses, assignments, submissions, and grades from Canvas LMS
and organizes them into the HII portfolio system.

Usage:
    python3 -m engine.tools.canvas courses
    python3 -m engine.tools.canvas assignments [--current]
    python3 -m engine.tools.canvas submissions <course_id>
    python3 -m engine.tools.canvas portfolio [--output ~/portfolio]
    python3 -m engine.tools.canvas todo
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TOKEN = os.environ.get("CANVAS_TOKEN", "")
BASE_URL = os.environ.get("CANVAS_URL", "https://njit.instructure.com")
API = f"{BASE_URL}/api/v1"

# Try vault first, then fall back to .env
if not TOKEN:
    try:
        from engine.core.vault import get_secret_quiet
        TOKEN = get_secret_quiet("CANVAS_TOKEN") or ""
    except Exception:
        pass

if not TOKEN:
    env_file = Path.home() / ".hii" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("CANVAS_TOKEN="):
                TOKEN = line.split("=", 1)[1].strip()
            elif line.startswith("CANVAS_URL="):
                BASE_URL = line.split("=", 1)[1].strip()
                API = f"{BASE_URL}/api/v1"

SP26_COURSE_IDS = {64560, 64188, 64236, 64250}


def _get(endpoint: str, params: str = "") -> list | dict:
    url = f"{API}{endpoint}{'?' + params if params else ''}"
    req = Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        print(f"  error: {e.code} {e.reason}", file=sys.stderr)
        return []


def cmd_courses():
    courses = _get("/courses", "per_page=100")
    current = [c for c in courses if c["id"] in SP26_COURSE_IDS]
    past = [c for c in courses if c["id"] not in SP26_COURSE_IDS]

    print("CURRENT SEMESTER (SP26)")
    print("-" * 60)
    for c in current:
        print(f"  {c['id']:>6}  {c.get('name', '?')}")

    print(f"\nPAST / OTHER ({len(past)} courses)")
    print("-" * 60)
    for c in past:
        print(f"  {c['id']:>6}  {c.get('name', '?')}")


def cmd_assignments(current_only=True):
    courses = _get("/courses", "per_page=100")
    if current_only:
        courses = [c for c in courses if c["id"] in SP26_COURSE_IDS]

    now = datetime.utcnow().isoformat() + "Z"
    for course in courses:
        cid = course["id"]
        name = course.get("name", "?")
        assignments = _get(f"/courses/{cid}/assignments", "per_page=100&order_by=due_at")
        if not assignments:
            continue

        print(f"\n{name}")
        print("=" * len(name))
        for a in assignments:
            due = a.get("due_at")
            pts = a.get("points_possible", "?")
            status = ""
            if due and due < now:
                status = " [PAST]"
            elif due:
                status = ""
            else:
                status = " [no due date]"
            due_str = due[:10] if due else "none"
            print(f"  {a['name']}")
            print(f"    due: {due_str}  |  pts: {pts}{status}")


def cmd_submissions(course_id: int):
    course = _get(f"/courses/{course_id}")
    print(f"Submissions for: {course.get('name', course_id)}\n")

    assignments = _get(f"/courses/{course_id}/assignments", "per_page=100")
    for a in assignments:
        aid = a["id"]
        sub = _get(f"/courses/{course_id}/assignments/{aid}/submissions/self")
        if not sub:
            continue
        score = sub.get("score", "?")
        grade = sub.get("grade", "?")
        state = sub.get("workflow_state", "?")
        print(f"  {a['name']}")
        print(f"    score: {score}/{a.get('points_possible','?')}  grade: {grade}  state: {state}")
        attachments = sub.get("attachments", [])
        for att in attachments:
            print(f"    file: {att.get('display_name', '?')} ({att.get('url', '')})")


def cmd_todo():
    items = _get("/users/self/todo", "per_page=50")
    if not items:
        print("Nothing due. Clean slate.")
        return
    print("UPCOMING\n")
    for item in items:
        a = item.get("assignment", {})
        course = item.get("context_name", "?")
        due = a.get("due_at", "none")
        due_str = due[:10] if due else "none"
        print(f"  {a.get('name', '?')}")
        print(f"    course: {course}  |  due: {due_str}")


def cmd_portfolio(output_dir: str = None):
    out = Path(output_dir or Path.home() / "portfolio" / "njit")
    out.mkdir(parents=True, exist_ok=True)

    courses = _get("/courses", "per_page=100")
    manifest = {"generated": datetime.utcnow().isoformat(), "courses": []}

    for course in courses:
        cid = course["id"]
        cname = course.get("name", str(cid))
        code = course.get("course_code", cname)

        # Create course directory
        course_dir = out / code.replace("/", "-").replace(" ", "_")
        course_dir.mkdir(exist_ok=True)

        assignments = _get(f"/courses/{cid}/assignments", "per_page=100")
        course_data = {"id": cid, "name": cname, "code": code, "assignments": []}

        for a in assignments:
            aid = a["id"]
            sub = _get(f"/courses/{cid}/assignments/{aid}/submissions/self")
            if not sub or sub.get("workflow_state") == "unsubmitted":
                continue

            a_data = {
                "name": a["name"],
                "due": a.get("due_at"),
                "points": a.get("points_possible"),
                "score": sub.get("score"),
                "grade": sub.get("grade"),
                "submitted_at": sub.get("submitted_at"),
                "files": [],
            }

            # Download attachments
            for att in sub.get("attachments", []):
                fname = att.get("display_name", f"file_{att['id']}")
                fpath = course_dir / fname
                url = att.get("url")
                if url and not fpath.exists():
                    try:
                        req = Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
                        with urlopen(req) as resp:
                            fpath.write_bytes(resp.read())
                        print(f"  downloaded: {fpath.name}")
                    except Exception as e:
                        print(f"  failed: {fname} ({e})")
                a_data["files"].append(str(fpath))

            course_data["assignments"].append(a_data)

        manifest["courses"].append(course_data)
        if course_data["assignments"]:
            print(f"{cname}: {len(course_data['assignments'])} submissions")

    # Write manifest
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nPortfolio saved to {out}")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    if not TOKEN:
        print("error: CANVAS_TOKEN not set. Add to ~/.hii/.env")
        sys.exit(1)

    args = sys.argv[1:]
    if not args or args[0] == "courses":
        cmd_courses()
    elif args[0] == "assignments":
        cmd_assignments(current_only="--current" in args)
    elif args[0] == "submissions" and len(args) > 1:
        cmd_submissions(int(args[1]))
    elif args[0] == "todo":
        cmd_todo()
    elif args[0] == "portfolio":
        output = args[2] if len(args) > 2 and args[1] == "--output" else None
        cmd_portfolio(output)
    else:
        print(__doc__)
