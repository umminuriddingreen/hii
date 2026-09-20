# HII Drive Architecture

Status: proposed prototype, not a shipped replication capability.

The sections below describe intended behavior. Current code has local chunk
storage, a prototype SQLite index, and file projection helpers. Watcher change
detection, peer negotiation/transfer, device authentication, encryption,
replication policy, conflict handling, and canonical operational-graph integration
are not implemented. No `hii drive` subcommand is registered. Passing crate
tests does not establish any cross-device capability. See
[current implementation limits](../hii-drive/README.md) before using this code.

The separate `index.sqlite` is experimental storage, not an accepted replacement
for HII's canonical `hii.db` authority. Resolve that boundary before activation.

## Overview

HII Drive is a native, user-owned distributed filesystem/object layer that operates entirely within your HII network. No third-party services. Your computers become the cloud infrastructure.

## Design Decisions

### 1. **Content-Addressed Storage**

Instead of synchronizing folders by blindly copying files, we build a content-addressed object synchronization layer.

**File Record Structure:**
```
FileRecord
├── path: Architecture/Studio/site-model.3dm
├── object_id: f_8c29...
├── version: 183
├── size: 248 MB
├── modified_by: macbook
├── modified_at: timestamp
└── chunks:
    ├── sha256:a81...
    ├── sha256:93f...
    ├── sha256:42c...
```

### 2. **Storage Layout**

```
~/.hii/drive/
├── objects/           # content-addressed chunks (a8/93/42...)
├── manifests/         # file metadata, versions
├── index.sqlite       # file index, device registry
└── workspace/         # live filesystem projection
```

### 3. **Sync Protocol**

Minimal messages for peer-to-peer sync:

```
HELLO           → device identification
STATE           → current state exchange
MANIFEST_HAVE   → "I have this manifest"
MANIFEST_WANT   → "I need updates"
CHUNK_HAVE      → "I have this chunk"
CHUNK_WANT      → "Request missing chunks"
CHUNK_DATA      → chunk payload
COMMIT          → "verified + committed"
ACK             → acknowledgment
```

### 4. **Replication Policy**

Each folder/object can have replication constraints:

```yaml
replication:
  minimum_copies: 2

pin:
  macbook: true
  windows: true
  iphone: metadata_only
```

This lets you selectively sync folders:
- `HII/` → Windows + Mac
- `Architecture/` → Windows + Mac
- `Photos/` → Windows only
- `Current Semester/` → Windows + Mac + iPhone

### 5. **Cloud Placeholder Support**

Files can be marked for on-demand fetch:

```
Archive/
├── 2024-project.zip       ☁  8.3 GB (fetch on demand)
├── scans.pdf              ☁  930 MB (fetch on demand)
└── current-model.3dm      ●  local
```

### 6. **Conflicts & Versioning**

For binary files (Rhino, PDFs, videos), use deterministic conflict handling:

```
Mac edits v14 → v15a
Windows edits v14 → v15b

HII preserves both:
  site-model.3dm (v15a)
  site-model (conflict - Windows).3dm (v15b)

OG knows both descend from v14.
```

### 7. **Implementation Components**

```
hii-drive/
├── watcher       # filesystem change detection
├── index         # files, manifests, versions, devices (SQLite)
├── store         # content-addressed chunks
├── sync          # peer reconciliation protocol
└── projection    # presents objects as normal files
```

### 8. **Operational Graph Events**

Sync becomes HII events:

```
artifact.created
artifact.modified
artifact.version.created
artifact.chunk.available
artifact.replicated
artifact.deleted
artifact.restored
```

### 9. **Network Transport**

Use existing HII network as transport:

```
HII Drive (sync protocol)
    ↓
HII Network (identity, encryption, discovery, routing)
    ↓
OS (TCP/QUIC/filesystem)
```

Keep layers separate. The Drive layer doesn't care if peer connection is LAN, relay, or direct internet.

### 10. **Authority Model**

Your Windows PC can be the initial authority node:

```
       Windows (authority)
      /                   \
    Mac  ←────────────→  iPhone

Each device syncs directly, Windows maintains canonical namespace.
```

## Next Steps

### Phase 1: Core Primitive (1-2 weeks)

1. Put `foo.txt` in `~/HII`
2. Mac watcher detects change
3. HII hashes and chunks it
4. Manifest enters OG
5. Windows learns about it
6. Windows requests bytes
7. Hash verifies
8. `~/HII/foo.txt` appears on Windows
9. Modify on Windows → change returns to Mac

### Phase 2: Selective Sync (1 week)

- Add replication policies
- Implement cloud placeholders
- Add device filtering

### Phase 3: Advanced Features (2-3 weeks)

- Conflict resolution
- Version history
- Mobile clients (metadata browser)
- WebDAV/proxy interface

## Why This Fits HII

- **User-owned**: Your machines, your rules
- **No third parties**: Built into your HII network
- **Operational Graph native**: Sync events become first-class objects
- **Rust-based**: Fast, safe, fits your CLI-first approach
- **Local-first**: Works offline, syncs when connected

## Required Security Work (Not Implemented)

- Use existing HII encryption layer
- Device authentication via HII identity system
- Content-addressed chunks prevent tampering
- Version history provides audit trail

## References

See the full implementation specification in this document's linked design artifacts and the operational graph integration patterns.
