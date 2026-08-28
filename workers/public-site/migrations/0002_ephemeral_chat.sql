PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_devices (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ecdh_public_jwk TEXT NOT NULL CHECK(length(ecdh_public_jwk) BETWEEN 64 AND 1024),
  signing_public_jwk TEXT NOT NULL CHECK(length(signing_public_jwk) BETWEEN 64 AND 1024),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS chat_devices_account
  ON chat_devices(account_id, revoked_at);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('invited', 'active', 'left')),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  left_at INTEGER,
  PRIMARY KEY (conversation_id, account_id)
);

CREATE INDEX IF NOT EXISTS chat_members_account
  ON chat_members(account_id, state, conversation_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK(length(id) = 43),
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_account_id TEXT NOT NULL REFERENCES accounts(id),
  sender_device_id TEXT NOT NULL REFERENCES chat_devices(id),
  envelope_json TEXT NOT NULL CHECK(length(envelope_json) BETWEEN 128 AND 16384),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at = created_at + 86400000)
);

CREATE INDEX IF NOT EXISTS chat_messages_live
  ON chat_messages(conversation_id, expires_at, seq);

CREATE TABLE IF NOT EXISTS chat_rate_limits (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, action, bucket)
);

CREATE INDEX IF NOT EXISTS chat_rate_limits_expiry
  ON chat_rate_limits(expires_at);
