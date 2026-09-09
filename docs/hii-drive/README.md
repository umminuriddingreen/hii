# HII Drive prototype

HII Drive explores local content-addressed storage and eventual transfer between
user-owned devices. It is not a working synchronized drive or backup system.
No `hii drive` command is registered; `cli/src/drive.rs` is unwired prototype code.

## Current implementation limits

Local chunk storage and file projection helpers exist. Watcher change detection,
peer connections/transfers, authentication, encryption, replication policy,
conflict history, and canonical operational-graph integration do not.
`SyncPeer::broadcast_file` only stores/indexes a local file; it does not broadcast.
Its `sync_events` table is separate from HII's operational graph.

Local helpers now reject unsafe chunk identifiers, projection traversal and
existing symlinks, verify chunk hashes on reads, and reconstruct through an atomic
temporary file so missing/corrupt chunks preserve the destination. This is not a
hostile concurrent-filesystem sandbox: handle-relative operations are still needed
before remote writers are enabled. Resolve index timestamp serialization and canonical `hii.db` ownership before treating
the experimental `index.sqlite` as durable authority. The examples and protocols
below are design targets, not claims of completed capabilities.

## Quick Start

### Initialize HII Drive

```bash
bash scripts/hii-drive-init.sh
```

This creates:
- `~/.hii/drive/` - base storage
- `~/.hii/drive/objects/` - content-addressed chunks
- `~/.hii/drive/workspace/` - live filesystem projection
- `~/.hii/drive/index.sqlite` - file registry

### Add Files

Files can be copied to the workspace, but this does not start processing:

```bash
cp important-file.pdf ~/.hii/drive/workspace/
```

Initialization only creates directories and empty tables. It starts no watcher
or service. The intended pipeline, not yet implemented, is:
1. Detect the file change
2. Hash and chunk it (1MB chunks)
3. Store chunks in the content-addressed store
4. Create a manifest record
5. Log an `artifact.created` event to the OG
6. Sync to connected peers (when available)

### Planned Sync Between Devices

The proposed protocol would exchange manifests and request missing chunks:

```
Mac → Windows: "I have manifest X, hash Y"
Windows → Mac: "I don't have chunks A8, 93, 42"
Mac → Windows: <sends chunk data>
Windows → Mac: "verified + committed"
```

## Architecture

### Components

- **watcher** - Filesystem change detection
- **index** - SQLite database for files, manifests, versions, devices
- **store** - Content-addressed chunk storage (a8/93/42/...)
- **sync** - Peer-to-peer synchronization protocol
- **projection** - Presents objects as normal files in workspace

### Storage Layout

```
~/.hii/drive/
├── objects/           # content-addressed chunks
│   └── a8/...         # chunk files named by hash
├── manifests/         # file metadata and versions
├── index.sqlite       # file registry, device list
└── workspace/         # live filesystem projection
```

### Sync Protocol

Messages exchanged between peers:

| Message | Description |
|---------|-------------|
| `HELLO` | Device identification |
| `STATE` | Current state exchange |
| `MANIFEST_HAVE` | "I have this manifest" |
| `MANIFEST_WANT` | "I need updates" |
| `CHUNK_HAVE` | "I have this chunk" |
| `CHUNK_WANT` | "Request missing chunks" |
| `CHUNK_DATA` | Chunk payload |
| `COMMIT` | "verified + committed" |
| `ACK` | Acknowledgment |

### Replication Policy

Each folder/object can specify replication constraints:

```yaml
replication:
  minimum_copies: 2

pin:
  macbook: true
  windows: true
  iphone: metadata_only
```

This allows selective sync:
- `HII/` → Windows + Mac
- `Architecture/` → Windows + Mac + Rhino models
- `Photos/` → Windows only (backup)
- `Current Semester/` → Windows + Mac + iPhone

### Cloud Placeholders

Large files can be marked for on-demand fetch:

```
Archive/
├── 2024-project.zip       ☁  8.3 GB (fetch on demand)
├── scans.pdf              ☁  930 MB (fetch on demand)
└── current-model.3dm      ●  local
```

## Operational Graph Integration

Sync events become first-class HII events:

```
artifact.created
artifact.modified
artifact.version.created
artifact.chunk.available
artifact.replicated
artifact.deleted
artifact.restored
```

Example event payload:

```json
{
  "event_id": "e58162a...",
  "event_type": "artifact.replicated",
  "object_id": "f_8c29...",
  "payload": {
    "from_device": "macbook",
    "to_device": "windows",
    "chunks_transferred": 3,
    "size_bytes": 248320512
  }
}
```

## Required Security Work (Not Implemented)

- **Device Authentication**: Integrate scoped HII identity and revocation.
- **Content-Addressed**: Local reads verify hashes; incoming transfers remain unimplemented.
- **Version History**: Preserve conflicts and prove recovery rather than overwrite.
- **Encryption**: Establish authenticated encrypted transport before remote exposure.

## Testing

Run tests:

```bash
cargo test -p hii-drive
cargo clippy -p hii-drive --all-targets -- -D warnings
```

Tests cover object construction, chunk round trips, local projection operations,
path/symlink rejection, corruption detection, and preservation after reconstruction
failure. They do not prove indexing round trips, automatic
detection, authenticated transfer, replication, or recovery.

Future integration acceptance example (will not pass with the current watcher):

```bash
# Create test file
echo "Hello HII Drive" > ~/test.txt

# Copy to workspace
cp ~/test.txt ~/.hii/drive/workspace/

# Verify chunks were created
ls -la ~/.hii/drive/objects/

# Verify index entry
sqlite3 ~/.hii/drive/index.sqlite "SELECT path, size, version FROM file_records;"

# Clean up
rm ~/test.txt
```

## Next Steps

1. Build the watcher with filesystem change detection
2. Implement the sync peer with TCP/QUIC transport
3. Add conflict resolution for binary files
4. Build mobile clients (iPhone/iPad metadata browser)
5. Create web interface for file browsing

## See Also

- [HII Drive Architecture Decision](../decisions/006-hii-drive-architecture.md)
- [HII Network Protocol](../protocol/)
- [Operational Graph](../operational-graph/)
