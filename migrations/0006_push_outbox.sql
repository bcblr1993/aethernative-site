-- 待发推送队列：管理员回复反馈等事件写入这里，推送服务（push-service）定时领取并发送。时间均为 Unix 毫秒。
-- 领取后 5 分钟内没有确认完成（服务宕机、发送失败）会被重新领取；最多尝试 5 次。
CREATE TABLE push_outbox (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('feedback_reply')),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 关联对象（feedback_reply：反馈 id），用于跳转与去重
  ref_id     TEXT NOT NULL,
  -- 通知内容：{ "zh": { "title", "body" }, "en": { … } }
  alert      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER
);
CREATE INDEX push_outbox_pending ON push_outbox(sent_at, claimed_at);
CREATE INDEX push_outbox_user ON push_outbox(user_id);
