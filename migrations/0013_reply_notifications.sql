CREATE TABLE app_reply_reads (
  reply_id TEXT PRIMARY KEY REFERENCES app_comments(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL
);
CREATE INDEX app_comments_recipient ON app_comments(visitor_hash, id);
CREATE INDEX app_comments_parent ON app_comments(parent_id, status, created_at DESC, id DESC);
