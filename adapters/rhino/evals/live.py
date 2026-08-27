"""Phase 2: the model's own tool calls, executed against a live Rhino.

The difference from phase 1 is the whole point. Phase 1 asks whether the call
was well-formed and plausible. This asks whether the document afterwards is
the one the user asked for -- established by reading it back independently,
not by whether the mutation returned without throwing.

Each task carries its own postconditions. A task is Verified only when every
one of them holds; anything less gets its own verdict rather than being
rounded up to success.
"""
import argparse
import json
import sys

from bridge import Bridge, BridgeError
from gate import ask
from tools import TOOLS

# The model speaks snake_case tool names; the wire speaks dotted operations.
# One mapping, both conventions honoured, exactly as the plan calls for.
OPERATIONS = {
    "rhino_object_create": "rhino.object.create",
    "rhino_object_delete": "rhino.object.delete",
    "rhino_undo": "rhino.undo",
    "rhino_document_describe": "rhino.document.describe",
    "rhino_document_objects": "rhino.document.objects",
    "rhino_object_get": "rhino.object.get",
    "rhino_geometry_bounding_box": "rhino.geometry.bounding_box",
    "rhino_session_describe": "rhino.session.describe",
}

VERIFIED = "Verified"
PARTIAL = "PartiallyVerified"
UNVERIFIED = "Unverified"
FAILED = "Failed"


def live_count(bridge):
    return bridge.request("rhino.document.objects")["total"]


class Postconditions:
    """Independent reads. Never trusts the mutation's own account of itself."""

    def __init__(self, bridge, before):
        self.bridge = bridge
        self.before = before
        self.checks = []

    def check(self, description, ok, detail=""):
        self.checks.append((bool(ok), description, detail))
        return ok

    def box(self, object_id, size_mm, origin, anchor):
        try:
            found = self.bridge.request("rhino.object.get", {"object_id": object_id})
        except BridgeError as error:
            self.check("the object exists when read back", False, str(error))
            return

        self.check("the object exists when read back", True, object_id)
        self.check(
            "it is a solid, not a curve or a surface",
            found.get("object_type") == "Brep",
            str(found.get("object_type")),
        )

        measured = self.bridge.request(
            "rhino.geometry.bounding_box", {"object_id": object_id})
        got = measured.get("size_mm")
        self.check(
            "it measures {0} mm on every axis".format(size_mm),
            got is not None and all(abs(a - b) < 1e-6 for a, b in zip(got, size_mm)),
            "{0} mm".format(got),
        )

        corner = measured.get("min_mm")
        if anchor == "corner" and corner is not None:
            # The origin the user names is in document units; the bounding box
            # comes back in millimetres, so the comparison has to be made in
            # one of them rather than assumed to be the same.
            scale = self.bridge.request(
                "rhino.document.describe")["document"]["millimetres_per_unit"]
            self.check(
                "its near corner is where it was asked for",
                all(abs(c - w * scale) < 1e-6 for c, w in zip(corner, origin)),
                "{0} mm".format(corner),
            )

        after = live_count(self.bridge)
        self.check(
            "the document gained exactly one object",
            after == self.before + 1,
            "{0} then {1}".format(self.before, after),
        )

    def verdict(self):
        if not self.checks:
            return UNVERIFIED
        held = sum(1 for ok, _, _ in self.checks if ok)
        if held == len(self.checks):
            return VERIFIED
        return FAILED if held == 0 else PARTIAL


def reset(bridge):
    """Leave the document as found, so tasks cannot contaminate each other."""
    for entry in bridge.request("rhino.document.objects")["objects"]:
        try:
            bridge.request("rhino.object.delete", {"object_id": entry["object_id"]})
        except BridgeError:
            pass


# (name, prompt, expected size in mm, expected origin in document units, anchor)
TASKS = [
    ("box-40-origin", "Create a 40 mm box at the origin.",
     [40, 40, 40], [0, 0, 0], "corner"),
    ("cube-25-centred", "Make a 25 mm cube centred on the origin.",
     [25, 25, 25], [0, 0, 0], "centre"),
    ("box-oblong", "Add a box 10 mm wide, 20 mm deep and 30 mm tall at the origin.",
     [10, 20, 30], [0, 0, 0], "corner"),
    ("box-offset", "Put a 50 mm cube at x=100, y=0, z=0.",
     [50, 50, 50], [100, 0, 0], "corner"),
    ("box-units-cm", "Create a cube 2 cm on a side at the origin.",
     [20, 20, 20], [0, 0, 0], "corner"),
]


def run_task(bridge, options, prompt, size_mm, origin, anchor):
    calls, text = ask(options.endpoint, options.model, prompt, options.temperature)
    if not calls:
        return FAILED, [(False, "the model called no tool", text[:120])], None

    name, arguments = calls[0]
    operation = OPERATIONS.get(name)
    if operation is None:
        return FAILED, [(False, "the model named a tool that does not exist", name)], None

    before = live_count(bridge)
    try:
        result = bridge.request(operation, arguments)
    except BridgeError as error:
        # A refusal is not automatically a model failure, but every task here
        # is answerable with the catalogue given, so for these it is.
        return FAILED, [(False, "the bridge refused the call", str(error))], arguments

    conditions = Postconditions(bridge, before)
    object_id = result.get("object_id")
    if object_id is None:
        conditions.check(
            "the mutation returned an object id", False, json.dumps(result)[:100])
    else:
        conditions.box(object_id, size_mm, origin, anchor)

    # One HII action is one undoable action, so confirm that too.
    undone = bridge.request("rhino.undo")
    conditions.check(
        "one undo removes it again",
        undone.get("object_count") == before,
        "count {0}, expected {1}".format(undone.get("object_count"), before),
    )
    return conditions.verdict(), conditions.checks, arguments


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:8090")
    parser.add_argument("--model", default="qwen3.5-9b")
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--temperature", type=float, default=0.2)
    options = parser.parse_args()

    bridge = Bridge()
    bridge.use_active_document()
    document = bridge.request("rhino.document.describe")["document"]
    print("model {0}  temp {1}  {2} tools  {3} run(s) per task".format(
        options.model, options.temperature, len(TOOLS), options.runs))
    print("document {0} in {1} @ {2} mm/unit\n".format(
        bridge.document, document["unit_system"], document["millimetres_per_unit"]))

    tally = {VERIFIED: 0, PARTIAL: 0, UNVERIFIED: 0, FAILED: 0}
    try:
        for name, prompt, size_mm, origin, anchor in TASKS:
            for _ in range(options.runs):
                reset(bridge)
                try:
                    verdict, checks, arguments = run_task(
                        bridge, options, prompt, size_mm, origin, anchor)
                except Exception as error:                          # noqa: BLE001
                    verdict = FAILED
                    checks = [(False, type(error).__name__, str(error)[:140])]
                    arguments = None
                tally[verdict] += 1
                held = sum(1 for ok, _, _ in checks if ok)
                print("{0:17} {1:16} {2}/{3} postconditions   {4}".format(
                    verdict, name, held, len(checks),
                    json.dumps(arguments) if arguments else ""))
                for ok, description, detail in checks:
                    if not ok:
                        print("                  - {0}: {1}".format(description, detail))
        reset(bridge)
    finally:
        bridge.close()

    total = sum(tally.values())
    print("\n" + "  ".join(
        "{0} {1}".format(k, v) for k, v in tally.items() if v))
    print("{0}/{1} verified".format(tally[VERIFIED], total))
    return 0 if tally[VERIFIED] == total else 1


if __name__ == "__main__":
    sys.exit(main())
