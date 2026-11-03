PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE CHECK(length(handle) BETWEEN 3 AND 48),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_json TEXT NOT NULL CHECK(length(credential_json) <= 16384),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS credentials_account_id ON credentials(account_id);

CREATE TABLE IF NOT EXISTS ceremonies (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
  account_id TEXT,
  handle TEXT,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ceremonies_expires_at ON ceremonies(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY (key, bucket)
);
