-- One row per person waiting on a surface. The email is the identity, so it is
-- unique and signing up twice is a no-op rather than a duplicate or an error.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  surface TEXT NOT NULL DEFAULT 'hii',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS waitlist_surface_idx ON waitlist (surface, created_at);
