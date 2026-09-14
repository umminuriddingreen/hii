# HII local file memory

This is the first CLI-owned slice of Universal Memory. It uses the existing
`hii.db` operational graph and append-only operation log. It does not activate
the separate experimental HII Drive `index.sqlite`.

## Try it

```bash
hii memory save ~/Documents/notes.txt
hii memory watch ~/Documents/Research
hii memory monitor --interval-seconds 5
```

`watch` registers a selected file or folder and immediately reconciles all
registered watches. `monitor` is a foreground polling process: while it is
running, edits create immutable versions. After a restart, `hii memory scan`
reconciles missed changes. No background service is installed.

```bash
hii memory search notes
hii memory get OBJECT_ID
hii memory versions OBJECT_ID
hii memory restore OBJECT_ID 1 ~/Documents/notes-old.txt
hii memory status
```

`save` first commits a source-path reference to the graph, then copies bytes
into `~/.hii/memory/blobs/blake3/` (or `HII_RUNTIME_DIR`). It verifies content
by BLAKE3 and creates a new version only when bytes changed. Restore verifies
the blob again and refuses to overwrite an existing destination. Files remain
where the user put them. Symlinks are not followed. Text content up to 1 MiB is
indexed locally with SQLite FTS5; larger and binary files remain searchable by
path. A failed copy leaves a visible `referenced` object instead of claiming a
verified version.

## Current boundary

This code is local only. `hii memory status` reports peer sync and encryption
as unavailable. It does not move bytes between devices, mirror folders, pair
devices, encrypt metadata or blobs in transit, run OCR or embeddings, serve
mobile clients, or expose canvas and agent projections. No Cloudflare account,
paid service, or always-on host is needed for the local functions above.
The scanner records created and changed files; it does not yet model deletes,
renames, or simultaneous edits on different devices.

Before enabling peer sync, the next implementation must integrate HII's device
trust authority, encrypt metadata and blobs before transfer, test revocation and
conflicts, and prove a real Mac/Windows round trip with Cloudflare unreachable.
Do not use an unencrypted folder-sharing workaround as a substitute for that
gate. Native watched paths also need OS event notifications and scheduled
reconciliation before background capture can be called automatic.
