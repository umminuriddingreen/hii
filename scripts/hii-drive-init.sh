#!/bin/bash
# Initialize HII Drive in the current workspace

set -e

HII_BASE="${HII_BASE:-$HOME/.hii/drive}"

echo "Initializing HII Drive..."
echo "Base path: $HII_BASE"

# Create directory structure
mkdir -p "$HII_BASE/objects"
mkdir -p "$HII_BASE/workspace"
mkdir -p "$HII_BASE/manifests"

# Initialize SQLite database
sqlite3 "$HII_BASE/index.sqlite" <<EOF
CREATE TABLE IF NOT EXISTS file_records (
    object_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    version INTEGER NOT NULL,
    size INTEGER NOT NULL,
    modified_by TEXT NOT NULL,
    modified_at INTEGER NOT NULL,
    chunks TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    is_authority INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_events (
    event_id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_records_path ON file_records(path);
CREATE INDEX IF NOT EXISTS idx_sync_events_object_id ON sync_events(object_id);
EOF

echo "✓ HII Drive initialized at $HII_BASE"
echo "  - Objects store: $HII_BASE/objects"
echo "  - Workspace: $HII_BASE/workspace"
echo "  - Database: $HII_BASE/index.sqlite"
echo ""
echo "Next steps:"
echo "  1. Add files to the workspace: cp your-file.txt $HII_BASE/workspace/"
echo "  2. This prototype does not start a watcher or synchronize files"
echo "  3. See docs/hii-drive/README.md for implementation limits"
