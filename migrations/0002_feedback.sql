-- 用户反馈。app_id 不做外键：软件列表来自构建时的内容目录，接口只校验格式；'general' 表示网站或其他问题。
-- status：new 已收到 → triaged 处理中 → replied 已回复 → closed 已关闭；admin_reply 由管理员在 D1 中填写。
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id      TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'other')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  app_version TEXT,
  os_version  TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'replied', 'closed')),
  admin_reply TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX feedback_user ON feedback(user_id, created_at);
CREATE INDEX feedback_status ON feedback(status, created_at);
