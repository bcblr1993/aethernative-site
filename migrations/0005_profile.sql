-- 用户自己修改过昵称：之后用 Google / GitHub / Apple 登录时不再用平台提供的名字覆盖。
ALTER TABLE users ADD COLUMN name_custom INTEGER NOT NULL DEFAULT 0;
