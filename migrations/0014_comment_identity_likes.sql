ALTER TABLE app_comments ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX app_comments_user ON app_comments(user_id, id);
CREATE TABLE app_comment_likes (
  comment_id TEXT NOT NULL REFERENCES app_comments(id) ON DELETE CASCADE,
  voter_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, voter_hash)
);
