-- iPhone App 登录。时间均为 Unix 毫秒。

-- 会话来源：web（Cookie）/ ios（Authorization: Bearer）。App 会话有效期更长，使用时自动续期。
ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'web';

-- 用 Apple 登录时换得的 refresh token（AES-GCM 加密）。注销账号时用它调用 Apple 的撤销接口（App Store 审核要求）。
ALTER TABLE identities ADD COLUMN apple_refresh_token TEXT;

-- App 内用 Google / GitHub 登录：网站回调后把一次性 code 交给 App，App 携带 PKCE verifier 换取会话。
-- 只存 code 的 SHA-256；2 分钟内有效，使用一次即删除。
CREATE TABLE auth_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_codes_expires ON auth_codes(expires_at);
