ALTER TABLE users ADD COLUMN disabled_at INTEGER;
CREATE INDEX users_created ON users(created_at, id);
CREATE INDEX users_disabled ON users(disabled_at);
