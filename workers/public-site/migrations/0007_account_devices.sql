PRAGMA foreign_keys = ON;

-- A workspace device is a narrower authority than a remote-control host. The
-- one-time link code is hash-only, and the resulting bearer token can only
-- synchronize workspaces the linked account can currently access.
CREATE TABLE IF NOT EXISTS account_device_link_codes (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redemption_nonce TEXT,
  CHECK(expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_device_link_codes_active
  ON account_device_link_codes(account_id, expires_at, redeemed_at);

CREATE TABLE IF NOT EXISTS account_devices (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 43),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS account_devices_account
  ON account_devices(account_id, revoked_at, created_at DESC);
