-- Remote desktop hosts: one row per machine paired to an account.
-- The host agent authenticates with an opaque bearer token; only its
-- SHA-256 hash is stored, matching the session-token discipline in 0001.
CREATE TABLE IF NOT EXISTS remote_hosts (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 43),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX IF NOT EXISTS remote_hosts_account
  ON remote_hosts(account_id, created_at DESC);
