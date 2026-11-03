CREATE TABLE IF NOT EXISTS account_library (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  revision INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  previous_manifest_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_library_chunks (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  hash TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0 AND size <= 1048576),
  ready INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  committed_revision INTEGER,
  gc_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,hash)
);
