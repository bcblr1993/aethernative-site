-- 小型反馈截图与正文在同一事务保存；每张最多 512 KiB，不进入列表响应。
ALTER TABLE feedback ADD COLUMN screenshot_ids TEXT NOT NULL DEFAULT '[]';
CREATE TABLE feedback_screenshots (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 524288)
);
CREATE INDEX feedback_screenshots_feedback ON feedback_screenshots(feedback_id);
