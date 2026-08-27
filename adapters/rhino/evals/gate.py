"""Phase 1: can a local model emit valid, correct tool calls at all?

No Rhino required. This answers one question and only one: given the real
catalogue, does the model name the right operation with the right arguments?
Whether the bridge then does the right thing is phase 2's question, and
conflating the two makes both unanswerable.

Scoring is deliberately strict about arguments. A model that picks
rhino_object_create and then asks for a 40-unit box in a document measured
in inches has not succeeded at anything useful.
"""
import argparse, json, sys, urllib.request
from tools import TOOLS, SYSTEM

GUID = "3f2b1c8a-0000-4a00-9000-abcdefabcdef"


def call(tool, *, first_of_many=False, **args):
    """Expect a call to `tool`, and check its arguments.

    `first_of_many` allows the model to emit the rest of a multi-step plan in
    the same turn. Doing so is not a defect — llama.cpp surfaces parallel tool
    calls and a model that plans ahead is behaving well. What is being scored
    is whether the *first* move is right.
    """
    def check(calls):
        if not calls:
            return False, "no tool call"
        if len(calls) != 1 and not first_of_many:
            return False, f"{len(calls)} tool call(s), expected 1"
        name, got = calls[0]
        if name != tool:
            return False, f"called {name}"
        for key, want in args.items():
            if key not in got:
                return False, f"missing {key!r}"
            if not (want(got[key]) if callable(want) else got[key] == want):
                return False, f"{key}={got[key]!r}"
        return True, "ok"
    return check


def no_call(calls):
    """Expect the model to answer in words rather than act."""
    if calls:
        return False, f"called {calls[0][0]}({json.dumps(calls[0][1])})"
    return True, "answered without acting"


def size(*want):
    """size_mm may legitimately arrive as a number or as three numbers."""
    want = list(want) if len(want) > 1 else [want[0]] * 3
    def check(value):
        got = [value] * 3 if isinstance(value, (int, float)) else value
        return isinstance(got, list) and len(got) == 3 and [float(v) for v in got] == want
    return check


def near(*want):
    def check(value):
        return (isinstance(value, list) and len(value) == 3
                and all(abs(float(a) - b) < 1e-6 for a, b in zip(value, want)))
    return check


def centred(value):
    return value in ("centre", "center")


TASKS = [
    # The acceptance request itself.
    ("box-40-origin", "Create a 40 mm box at the origin.",
     call("rhino_object_create", kind="box", size_mm=size(40))),

    # 'cube' and 'centred' both have to survive the trip.
    ("cube-25-centred", "Make a 25 mm cube centred on the origin.",
     call("rhino_object_create", kind="box", size_mm=size(25), anchor=centred)),

    # Three different dimensions, in the order the tool documents.
    ("box-oblong", "Add a box 10 mm wide, 20 mm deep and 30 mm tall at the origin.",
     call("rhino_object_create", kind="box", size_mm=size(10, 20, 30))),

    # A non-zero origin, stated in a form that is not already a triple.
    ("box-offset", "Put a 50 mm cube at x=100, y=0, z=0.",
     call("rhino_object_create", kind="box", size_mm=size(50), origin=near(100, 0, 0))),

    # Unit trap: centimetres must be converted, not passed through.
    ("box-units-cm", "Create a cube 2 cm on a side at the origin.",
     call("rhino_object_create", kind="box", size_mm=size(20))),

    # Plain reads â€” the cheapest thing a model can get wrong.
    ("read-objects", "What's in the document right now?",
     call("rhino_document_objects")),
    ("read-units", "What units is this document in?",
     call("rhino_document_describe")),
    ("read-session", "Which Rhino process am I connected to?",
     call("rhino_session_describe")),

    ("undo", "Undo that.", call("rhino_undo")),
    ("delete", f"Delete the object {GUID}.",
     call("rhino_object_delete", object_id=lambda v: GUID in str(v).lower())),
    ("measure", f"How big is object {GUID}?",
     call("rhino_geometry_bounding_box", object_id=lambda v: GUID in str(v).lower())),

    # Restraint. The bridge builds boxes and nothing else; inventing a
    # kind='sphere' is a failure even though the call would look well-formed.
    ("refuse-sphere", "Make me a sphere 30 mm across.", no_call),

    # Restraint again: no size was given, and picking one is not helping.
    ("ask-missing-size", "Create a box at the origin.", no_call),

    # Multi-step: the first move is what is being scored.
    ("sequence-first-step",
     "Make a 40 mm box at the origin, then tell me how many objects are in the document.",
     call("rhino_object_create", kind="box", size_mm=size(40), first_of_many=True)),
]


def ask(endpoint, model, prompt, temperature):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": prompt}],
        "tools": TOOLS,
        "temperature": temperature,
        "top_p": 0.8,
        "max_tokens": 2048,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    request = urllib.request.Request(
        f"{endpoint}/v1/chat/completions", body,
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = json.load(response)

    message = payload["choices"][0]["message"]
    calls = []
    for entry in message.get("tool_calls") or []:
        raw = entry["function"].get("arguments") or "{}"
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            # Unparseable arguments are a distinct and important failure:
            # the model called a real tool and said nothing usable.
            parsed = {"__unparseable__": raw}
        calls.append((entry["function"]["name"], parsed))
    return calls, (message.get("content") or "").strip()


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
          f"{len(TOOLS)} tools  {options.runs} run(s) per task\n")

    total = passed = 0
    for name, prompt, judge in tasks:
        results = []
        for _ in range(options.runs):
            try:
                calls, text = ask(options.endpoint, options.model, prompt, options.temperature)
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

    print(f"\n{passed}/{total} ({100 * passed / total:.0f}%)")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
