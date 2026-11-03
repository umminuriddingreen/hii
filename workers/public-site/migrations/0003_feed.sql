PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  author_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('text', 'sticker', 'ink')),
  snapshot_json TEXT NOT NULL CHECK(length(snapshot_json) <= 65536),
  source_ref_hash TEXT NOT NULL CHECK(length(source_ref_hash) = 43),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 43),
  source_updated_at TEXT NOT NULL CHECK(length(source_updated_at) BETWEEN 20 AND 64),
  client_request_id TEXT NOT NULL CHECK(length(client_request_id) BETWEEN 8 AND 64),
  moderation_state TEXT NOT NULL DEFAULT 'visible'
    CHECK(moderation_state IN ('visible', 'hidden', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(author_account_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS feed_items_visible_cursor
  ON feed_items(moderation_state, revoked_at, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS feed_items_author
  ON feed_items(author_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_reports (
  item_id TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  reporter_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('spam', 'abuse', 'private', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(item_id, reporter_account_id)
);

CREATE INDEX IF NOT EXISTS feed_reports_reporter
  ON feed_reports(reporter_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 43),
  item_id TEXT NOT NULL,
  actor_account_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('published', 'revoked', 'moderated')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS feed_events_item
  ON feed_events(item_id, created_at);
