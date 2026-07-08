import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock

TRACE_PATH = os.path.expanduser("~/.hii/traces/llm_requests.jsonl")
_trace_lock = Lock()

def trace_llm(entry):
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    entry["source"] = "hii/notes-classify"
    with _trace_lock:
        with open(TRACE_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")

TAXONOMY = [
    "MUSIC",              # songs, lyrics, hooks, bars, unfinished songs
    "BUSINESS & IDEAS",   # business ideas, app ideas, projects, game plans
    "AI & PROMPTS",       # AI prompts, HII/codex/claude related, image-gen prompts
    "COLLEGE & ACADEMIC",  # NJIT, scholarships, SAT/study notes, fencing, speeches, labs
    "REAL ESTATE",        # apartments, redwood hall, harbour 8, real estate notes
    "PERSONAL & JOURNAL",  # life, thoughts, notes to self, can-i-be, wishlist
    "PASSWORDS & SECURITY",  # passwords, codes, locked/private
    "EMAIL DRAFTS",
    "PRESENTATIONS & DOCS",
    "RANDOM / INBOX",     # anything unclear, empty, or junk
]

SYSTEM = (
    "You classify personal Apple Notes into exactly one category. "
    "Categories: " + " | ".join(TAXONOMY) + ". "
    "Reply with ONLY the category name, exactly as listed, nothing else."
)

def classify(name, snippet):
    prompt = f"Title: {name}\nContent: {snippet[:300]}\n\nCategory:"
    payload = {
        "model": "fast-local",
        "system": SYSTEM,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {"temperature": 0, "num_predict": 20}
    }
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    text = resp.get("response", "").strip().upper()
    result = "RANDOM / INBOX"
    for cat in TAXONOMY:
        if cat in text:
            result = cat
            break
    trace_llm({
        "model": "fast-local",
        "purpose": "notes-classification",
        "duration_s": round(time.time() - t0, 2),
        "eval_count": resp.get("eval_count"),
        "prompt_eval_count": resp.get("prompt_eval_count"),
        "note_title": name[:80],
        "category": result,
    })
    return result

done_count = 0

def work(n):
    global done_count
    name = n.get("name") or ""
    snippet = n.get("snippet") or ""
    if not name.strip() and not snippet.strip():
        cat = "RANDOM / INBOX"
    else:
        try:
            cat = classify(name, snippet)
        except Exception:
            cat = "RANDOM / INBOX"
    done_count += 1
    if done_count % 50 == 0:
        print(f"{done_count} done", file=sys.stderr, flush=True)
    return {"id": n["id"], "name": name, "category": cat}

def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    notes = json.load(open(src))
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(work, notes))
    json.dump(results, open(dst, "w"), indent=1)
    print(f"done: {len(results)} -> {dst} in {time.time()-t0:.0f}s", file=sys.stderr)

if __name__ == "__main__":
    main()
