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

Per the governing directive — *"STOP and verify F fully before implementing
Grasshopper"* — F is now fully verified and the Grasshopper gate is open.

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
