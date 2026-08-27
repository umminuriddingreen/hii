"""The same tasks, through HII's own tool convention rather than the tools API.

This matters more than it looks. `gate.py` measures the model against the
OpenAI-style `tools` array, which llama.cpp parses using the model's trained
chat template -- a path Qwen was tuned for. HII's agent loop does something
else entirely (agent.rs:1723): it names the tools in one compressed line of
the system prompt and asks for bare JSON back.

Those are different capabilities, and a small model can be good at the first
and poor at the second. Since HII's loop is what would actually run, this is
the number that decides whether a 9B can drive it.
"""
import argparse
import json
import re
import sys
import urllib.request

from gate import TASKS, GUID          # noqa: F401  (GUID is used via TASKS)

# The tool vocabulary, written the way HII writes it: names in T, argument
# names in F. Deliberately terse -- copying the real prompt's economy rather
# than giving this eval a friendlier one it would not get in production.
TOOL_NAMES = ",".join([
    "rhino_object_create",
    "rhino_object_delete",
    "rhino_undo",
    "rhino_document_describe",
    "rhino_document_objects",
    "rhino_object_get",
    "rhino_geometry_bounding_box",
    "rhino_session_describe",
])

FIELDS = "kind,size_mm,origin,anchor,object_id"

SYSTEM = f"""You are HII, the work system, driving Rhino 8.
Loop: intent -> context -> bounded work -> verify -> receipt. No plan narration.
JSON only; no native tool tags. T:{TOOL_NAMES}. F:{FIELDS}.
Sizes in F:size_mm are millimetres (a number for a cube, or three numbers
[width,depth,height]). F:origin is [x,y,z]. F:anchor is corner|centre.
Create: {{"type":"rhino_object_create","kind":"box","size_mm":40,"origin":[0,0,0]}}
Finish: {{"type":"final","summary":"result","verification":["checks run"],"next":null}}
If a request is missing a value you need, or asks for something no tool
supports, emit a final saying so instead of inventing one."""


def extract(text):
    """Pull the first flat JSON object out of a reply.

    HII's own parser is more forgiving than a strict json.loads, so being
    strict here would measure the harness rather than the model. Fenced
    blocks and leading prose are tolerated exactly because HII tolerates
    them; anything beyond that counts as a failure to follow the convention.
    """
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    depth = 0
    start = None
    for index, character in enumerate(text):
        if character == "{":
            if depth == 0:
                start = index
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    return json.loads(text[start:index + 1])
                except json.JSONDecodeError:
                    start = None
    return None


def ask(endpoint, model, prompt, temperature):
    """Return calls in gate.py's shape, so the same judges can score them."""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": prompt}],
        "temperature": temperature,
        "top_p": 0.8,
        "max_tokens": 2048,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    request = urllib.request.Request(
        f"{endpoint}/v1/chat/completions", body,
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        message = json.load(response)["choices"][0]["message"]

    text = (message.get("content") or "").strip()
    emitted = extract(text)
    if not isinstance(emitted, dict):
        return [], text
    kind = emitted.pop("type", None)
    if kind in (None, "final"):
        # A `final` is HII's way of answering without acting, which is what
        # the restraint tasks are asking for. Reported as "no call".
        return [], text
    return [(kind, emitted)], text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:8090")
    parser.add_argument("--model", default="qwen3.5-9b")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--only")
    options = parser.parse_args()

    tasks = [t for t in TASKS if not options.only or options.only in t[0]]
    print(f"model {options.model}  temp {options.temperature}  "
          f"HII prompt convention (no tools array)  {options.runs} run(s) per task\n")

    total = passed = 0
    malformed = 0
    for name, prompt, judge in tasks:
        results = []
        for _ in range(options.runs):
            try:
                calls, text = ask(options.endpoint, options.model, prompt, options.temperature)
                if not calls and extract(text) is None:
                    malformed += 1
                ok, why = judge(calls)
            except Exception as error:                      # noqa: BLE001
                ok, why = False, f"{type(error).__name__}: {error}"
            results.append((ok, why))
            total += 1
            passed += ok

        hits = sum(1 for ok, _ in results if ok)
        mark = "PASS" if hits == len(results) else ("FLAKY" if hits else "FAIL")
        print(f"{mark:5} {name:22} {hits}/{len(results)}")
        for ok, why in results:
            if not ok:
                print(f"        {why}")

    print(f"\n{passed}/{total} ({100 * passed / total:.0f}%)"
          f"   {malformed} reply/replies contained no parseable JSON at all")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
