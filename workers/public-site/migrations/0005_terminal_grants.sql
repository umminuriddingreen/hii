-- Short-lived, account-owned authority for one terminal session on one host.
CREATE TABLE IF NOT EXISTS terminal_grants (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES remote_hosts(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL CHECK(length(cwd) BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS terminal_grants_active
  ON terminal_grants(account_id, host_id, expires_at, revoked_at);
