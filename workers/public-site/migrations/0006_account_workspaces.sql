PRAGMA foreign_keys = ON;

-- Account-owned HII workspaces. The document is the current projection; the
-- append-only event table records who advanced each authoritative revision.
CREATE TABLE IF NOT EXISTS account_workspaces (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  document_json TEXT NOT NULL CHECK(length(document_json) <= 786432),
  document_hash TEXT NOT NULL CHECK(length(document_hash) = 43),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  write_nonce TEXT NOT NULL CHECK(length(write_nonce) = 43),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS account_workspaces_owner
  ON account_workspaces(owner_account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'editor', 'viewer')),
  granted_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (workspace_id, account_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_account
  ON workspace_members(account_id, revoked_at, workspace_id);

-- Codes are shown once. Only the SHA-256 hash is retained. The redemption
-- nonce makes the update + membership insert one replay-safe D1 batch.
CREATE TABLE IF NOT EXISTS workspace_share_codes (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash) = 43),
  workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'viewer')),
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  redeemed_at INTEGER,
  redemption_nonce TEXT,
  revoked_at INTEGER,
  CHECK(expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS workspace_share_codes_active
  ON workspace_share_codes(workspace_id, expires_at, redeemed_at, revoked_at);

CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('workspace.created', 'workspace.document.updated', 'workspace.member.granted', 'workspace.member.revoked', 'workspace.share.created', 'workspace.share.redeemed', 'workspace.share.revoked')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  detail_json TEXT NOT NULL CHECK(length(detail_json) <= 4096),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workspace_events_history
  ON workspace_events(workspace_id, created_at DESC, id DESC);
