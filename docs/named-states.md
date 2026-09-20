# Named local canvas states

`hii state` saves complete canvas documents as immutable checkpoint events in
the existing Runtime SQLite history. It creates no second state store. This
initial interface belongs to the local Space owner; account workspaces are not
implicitly downloaded, backed up, or synchronized.

```sh
hii state save "before layout change"
hii state list
hii state show "before layout change"
hii state restore "before layout change"
# Inspect the preview, then use its expectedSequence:
hii state restore "before layout change" --apply --expected-sequence 12
```

Every command accepts `--space <id>`; otherwise it binds the selected local Space.
Save/list support `--json`. Show and restore return JSON. A saved state's stable
`checkpoint-…` ID also works wherever a name is accepted. Names are unique within
a Space and cannot be overwritten; `checkpoint-` is reserved for IDs.

Restore previews include the current and proposed documents. A default restore
does not change the canvas or append checkpoint history. Applying requires the
previewed sequence; a concurrent edit refuses the restore. Before applying, HII
saves a uniquely named safety checkpoint of the current state. Restoration then
uses normal Runtime authority checks, sequence checks, and JSON compatibility
export. The safety checkpoint ID is included in the result and remains in history
even if a later race prevents the restore from applying.

These are canvas checkpoints, not machine snapshots. They do not copy file/media
bytes or rewind external files, tools, account state, or running processes.
Historical operator-terminal nodes return as stopped records, with automatic
input and old session identifiers removed; restoring does not replay commands.
The preview shows these changes. Restoring a safety checkpoint uses the same flow.

Saved documents may contain private canvas content. They remain in local `hii.db`
history and should be treated with the same care as other local HII state.
