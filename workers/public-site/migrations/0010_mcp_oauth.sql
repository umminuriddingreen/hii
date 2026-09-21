PRAGMA foreign_keys = ON;

-- Public OAuth clients are issued through dynamic client registration. Client
-- identifiers are bearer-like routing material even though they are not
-- secrets, so HII retains only their SHA-256 digests.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id_hash TEXT PRIMARY KEY CHECK(length(client_id_hash) = 43),
  redirect_uris_json TEXT NOT NULL CHECK(length(redirect_uris_json) <= 4096),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 43),
  client_id_hash TEXT NOT NULL REFERENCES oauth_clients(client_id_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL CHECK(length(redirect_uri) <= 512),
  resource TEXT NOT NULL CHECK(length(resource) <= 256),
  scopes TEXT NOT NULL CHECK(length(scopes) <= 256),
  code_challenge TEXT NOT NULL CHECK(length(code_challenge) = 43),
  exchange_nonce TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry
  ON oauth_authorization_codes(expires_at, used_at);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 43),
  grant_id TEXT NOT NULL CHECK(length(grant_id) = 43),
  client_id_hash TEXT NOT NULL REFERENCES oauth_clients(client_id_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK(length(resource) <= 256),
  scopes TEXT NOT NULL CHECK(length(scopes) <= 256),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS oauth_access_tokens_expiry
  ON oauth_access_tokens(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_grant
  ON oauth_access_tokens(grant_id, revoked_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 43),
  grant_id TEXT NOT NULL CHECK(length(grant_id) = 43),
  client_id_hash TEXT NOT NULL REFERENCES oauth_clients(client_id_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK(length(resource) <= 256),
  scopes TEXT NOT NULL CHECK(length(scopes) <= 256),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expiry
  ON oauth_refresh_tokens(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_grant
  ON oauth_refresh_tokens(grant_id, revoked_at);
