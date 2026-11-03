ALTER TABLE accounts
  ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 80);

CREATE TABLE account_follows (
  follower_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  followee_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_account_id, followee_account_id),
  CHECK (follower_account_id <> followee_account_id)
);

CREATE INDEX account_follows_followee_created
  ON account_follows(followee_account_id, created_at DESC, follower_account_id);
CREATE INDEX account_follows_follower_created
  ON account_follows(follower_account_id, created_at DESC, followee_account_id);
