# Live acceptance record

`cargo run -p hii-rhino-ipc --example acceptance -- running`, against Rhino
8.34.26223.11001, adapter `0.1.0+b155b12`, pid 51048, instance
`a6ebceba-cb46-48a8-9cbe-a5891fb03205`.

**43/43 checks passed.**

The point of this file is one line of that sweep:

```
PASS  F  the count the undo reports is the count anyone else can see
         — undo said Some(0), an independent read says Some(0)
```

`21c056e` added that check and it had never executed. It needs Rhino running
with `Hii`, and until this run nothing had confirmed that the object count
`rhino.undo` reports is the count an independent read of the document agrees
with. An undo that reports its own bookkeeping rather than the document's is
exactly the failure the four-state verdict exists to catch, and the earlier
`UndoActive` misreading proves this is not a hypothetical class of bug.

**The gate this was supposed to open stays shut.** See below: the sweep passes
and the document is unusable afterwards, which means passing this sweep is not
the same as F holding.

## Still untested

**Criterion H**, unexpected Rhino termination. `--example acceptance -- watch`
leaves the bridge connected and waits for Rhino to be closed at a moment the
harness does not choose. It has never been run. It costs one Rhino restart.

## One defect this run surfaced

Discovery found **two** advertisements and chose "the most recent":

```
C:\Users\ummin\.hii\rhino\instances\29028-8f4554a0-....json   pid 29028 — dead
C:\Users\ummin\.hii\rhino\instances\51048-a6ebceba-....json   pid 51048 — live
```

Nothing removed the first when its Rhino went away, and recency is a heuristic
standing in for liveness. It happened to select correctly here because the live
process was also the newer one. It would select a dead pipe if the newest
advertisement were the stale one — a crashed Rhino that has not been restarted.
The connect would then fail rather than mislead, so this is a diagnosability
defect and not a safety one, but discovery should be filtering on whether the
advertised pid is alive rather than on a timestamp.


## The sweep passes and leaves the document wedged

`evals/live.py` — phase 2, the model's own calls executed against this same
Rhino minutes after the 43/43 — could not create a single object:

```
Failed  box-40-origin  0/1 postconditions
  - the bridge refused the call: undo_failed: Rhino would not open an undo
    record, so this change was not made (undo record 9 is still open)
```

All five creation tasks, same refusal. `evals/undo_probe.py` reproduces it in
isolation and localises it exactly:

```
before anything   {"recording_enabled": true, "recording_is_active": true,
                   "current_record_serial": 9, "next_record_serial": 10,
                   "undo_in_progress": true}
create #1  -> REFUSED  undo record 9 is still open
create #2  -> REFUSED  undo record 9 is still open
verdict: the very first create already failed -- the document was already wedged
```

Causally: create succeeded during the sweep, so `BeginUndoRecord` worked then.
`rhino.undo` ran. Every mutation since is refused. **One HII undo permanently
disables HII mutation for that document.** Record 9 never closes and
`UndoActive` never clears.

The bridge behaves correctly at the moment of failure — it refuses rather than
making a change the user could not reverse, and `DescribeUndoState` says which
of the two causes it was instead of leaving them indistinguishable. That
diagnostic is why this took one probe rather than a day. The defect is upstream
of it, in `Undo.Execute` calling `document.Undo()` and leaving the document's
undo system mid-flight.

### What this says about the sweep

The wedged state is printed inside a check the sweep marks **PASS**:

```
PASS  F  one undo is accepted — {... "current_record_serial":9,
         "recording_is_active":true, "undo_in_progress":true}
```

The sweep carried the evidence in its own passing output and nothing looked at
it, because the sweep does its undo last and never mutates again. So 43/43 is
true and does not mean what it was being read to mean. F is not fully verified
until the sweep ends with a create *after* the undo, and Grasshopper stays
behind the gate until it does.
