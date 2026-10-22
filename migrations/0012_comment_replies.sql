-- Replies share the same moderation and rate limits as top-level comments.
-- Keep existing pending comments private; new writes explicitly use approved.
ALTER TABLE app_comments ADD COLUMN parent_id TEXT REFERENCES app_comments(id);
ALTER TABLE app_comments ADD COLUMN thread_id TEXT REFERENCES app_comments(id);
CREATE INDEX app_comments_thread ON app_comments(thread_id, status, created_at DESC, id DESC);
