PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS browser_snapshot_usage (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  bytes_used INTEGER NOT NULL DEFAULT 0 CHECK(bytes_used >= 0)
);

CREATE TABLE IF NOT EXISTS browser_snapshots (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  sender_device_id TEXT NOT NULL REFERENCES chat_devices(id),
  bytes_used INTEGER NOT NULL CHECK(bytes_used >= 0),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(account_id, id)
);

CREATE INDEX IF NOT EXISTS browser_snapshots_account_seq
  ON browser_snapshots(account_id, seq);
