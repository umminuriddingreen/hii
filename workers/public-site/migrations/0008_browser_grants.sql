-- Short-lived, account-owned authority for one isolated browser session.
CREATE TABLE IF NOT EXISTS browser_grants (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES remote_hosts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK(expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS browser_grants_active
  ON browser_grants(account_id, host_id, expires_at, revoked_at);
