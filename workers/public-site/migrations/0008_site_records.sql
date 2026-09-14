PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_records (
  id TEXT PRIMARY KEY,
  author_account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('request', 'source')),
  category TEXT NOT NULL CHECK(category IN ('history', 'demographics', 'terrain', 'other')),
  latitude REAL NOT NULL CHECK(latitude BETWEEN -85 AND 85),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 8 AND 160),
  note TEXT NOT NULL CHECK(length(note) <= 2000),
  source_url TEXT,
  source_date TEXT,
  state TEXT NOT NULL DEFAULT 'visible' CHECK(state IN ('visible', 'hidden', 'revoked')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS site_records_nearby ON site_records(state, latitude, longitude, created_at DESC);
CREATE INDEX IF NOT EXISTS site_records_author ON site_records(author_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_record_reports (
  record_id TEXT NOT NULL REFERENCES site_records(id) ON DELETE CASCADE,
  reporter_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('spam', 'inaccurate', 'private', 'other')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(record_id, reporter_account_id)
);
