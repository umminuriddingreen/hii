import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_notes import TAXONOMY, SYSTEM, trace_llm

MODEL = "qwen-work"
SUSPECT_CATS = {"REAL ESTATE", "MUSIC"}

def classify_big(name, snippet):
    prompt = f"Title: {name}\nContent: {snippet[:400]}\n\nCategory:"
    payload = {
        "model": MODEL,
        "system": SYSTEM,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {"temperature": 0, "num_predict": 20},
    }
    req = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    text = resp.get("response", "").strip().upper()
    result = None
    for cat in TAXONOMY:
        if cat in text:
            result = cat
            break
    trace_llm({
        "model": MODEL,
        "purpose": "notes-classification-refine",
        "duration_s": round(time.time() - t0, 2),
        "eval_count": resp.get("eval_count"),
        "prompt_eval_count": resp.get("prompt_eval_count"),
        "note_title": name[:80],
        "category": result,
    })
    return result

def main():
    export = {n["id"]: n for n in json.load(open(sys.argv[1]))}
    classified = json.load(open(sys.argv[2]))
    dst = sys.argv[3]

    targets = []
    for row in classified:
        snippet = (export.get(row["id"], {}).get("snippet") or "").strip()
        if row["category"] in SUSPECT_CATS and snippet:
            targets.append(row)
        elif row["category"] == "RANDOM / INBOX" and len(snippet) >= 40:
            targets.append(row)
    print(f"refining {len(targets)} of {len(classified)}", file=sys.stderr, flush=True)

    changed = 0
    lock = Lock()

    def work(row):
        nonlocal changed
        n = export[row["id"]]
        try:
            new_cat = classify_big(n.get("name") or "", n.get("snippet") or "")
        except Exception:
            new_cat = None
        if new_cat and new_cat != row["category"]:
            with lock:
                changed += 1
            row["category"] = new_cat

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(work, targets))
    json.dump(classified, open(dst, "w"), indent=1)
    print(f"refined: {changed} changed of {len(targets)} in {time.time()-t0:.0f}s -> {dst}", file=sys.stderr)

if __name__ == "__main__":
    main()
