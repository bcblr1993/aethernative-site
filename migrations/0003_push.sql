-- iPhone App 的推送设备与订阅。时间均为 Unix 毫秒。
-- 设备以“安装 ID”标识（App 首次运行时生成并存入 Keychain），修改需携带设备密钥，数据库只存其 SHA-256；
-- 只知道 device token 的人无法改动别人的订阅。
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  secret_hash  TEXT NOT NULL,
  -- APNs device token（十六进制）；同一 token 只能属于一个安装
  token        TEXT NOT NULL UNIQUE,
  env          TEXT NOT NULL CHECK (env IN ('production', 'sandbox')),
  locale       TEXT NOT NULL CHECK (locale IN ('zh', 'en')),
  -- 系统通知权限是否开启；关闭时不推送，但保留订阅设置
  enabled      INTEGER NOT NULL DEFAULT 1,
  -- 接收官方公告
  news         INTEGER NOT NULL DEFAULT 1,
  -- 1：接收全部软件（含以后新上线的）的正式版；0：只接收 device_apps 里列出的软件
  all_apps     INTEGER NOT NULL DEFAULT 1,
  app_version  TEXT,
  -- 登录后关联账号（用于推送反馈回复）；注销账号时解除关联，设备本身保留
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_seen ON devices(last_seen_at);
CREATE INDEX devices_user ON devices(user_id);

-- 按软件的订阅（两项相互独立）：
--   stable = 1：接收该软件的正式版（all_apps = 1 时无论有没有记录都接收）；
--   beta   = 1：接收该软件的测试版。
CREATE TABLE device_apps (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  app_id    TEXT NOT NULL,
  stable    INTEGER NOT NULL DEFAULT 0,
  beta      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, app_id)
);
CREATE INDEX device_apps_app ON device_apps(app_id);

-- 推送服务的运行状态（单行）：最近一次心跳、上一轮的发送统计。供后台查看服务是否正常。
CREATE TABLE push_status (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen_at INTEGER NOT NULL,
  detail       TEXT
);
