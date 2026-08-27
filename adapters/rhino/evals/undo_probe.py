"""Find out what wedges a document's undo system.

Symptom: the acceptance sweep passes once against a fresh Rhino, and every
mutation afterwards is refused with UndoFailed. The suspicion is that the
undo operation itself leaves the document in a state where BeginUndoRecord
will never open another record -- which would mean one HII undo permanently
disables HII mutation for that document.

This walks create/undo/create in order and reads the undo state at every step,
so the exact transition that breaks it is visible rather than inferred.
"""
import json
import sys

from bridge import Bridge, BridgeError

STEPS = []


def state(bridge, when):
    try:
        got = bridge.request("bridge.diagnostics.undo_state")
    except BridgeError as error:
        got = {"error": str(error)}
    STEPS.append((when, got))
    print("  {0:34} {1}".format(when, json.dumps(got)))
    return got


def attempt(bridge, description, operation, arguments=None):
    print("{0}".format(description))
    try:
        result = bridge.request(operation, arguments)
        print("  -> ok  {0}".format(json.dumps(result)[:160]))
        return result
    except BridgeError as error:
        print("  -> REFUSED  {0}".format(error))
        return None


def main():
    bridge = Bridge()
    bridge.use_active_document()
    print("document {0}\n".format(bridge.document))

    state(bridge, "before anything")

    first = attempt(bridge, "create #1", "rhino.object.create", {"kind": "box", "size_mm": 40})
    state(bridge, "after create #1")

    if first:
        attempt(bridge, "undo", "rhino.undo")
        state(bridge, "after undo")

    second = attempt(bridge, "create #2", "rhino.object.create", {"kind": "box", "size_mm": 10})
    state(bridge, "after create #2")

    if second:
        attempt(bridge, "delete #2", "rhino.object.delete",
                {"object_id": second["object_id"]})
        state(bridge, "after delete")

    bridge.close()

    print("\nverdict:", end=" ")
    if first and second:
        print("undo does NOT wedge the document -- the cause is elsewhere")
        return 0
    if first and not second:
        print("confirmed: the undo wedges the document for every later mutation")
        return 1
    print("the very first create already failed -- the document was already wedged")
    return 2


if __name__ == "__main__":
    sys.exit(main())
