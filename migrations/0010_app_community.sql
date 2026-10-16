-- Anonymous browser credentials are hashed; no account, IP or nickname is attached to reviews.
CREATE TABLE app_votes (
  app_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  liked INTEGER NOT NULL DEFAULT 0 CHECK (liked IN (0, 1)),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  PRIMARY KEY (app_id, visitor_hash)
);
CREATE TABLE app_comments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (visitor_hash, request_id)
);
CREATE INDEX app_comments_public ON app_comments(app_id, status, created_at DESC, id DESC);
CREATE INDEX app_comments_moderation ON app_comments(status, created_at DESC, id DESC);
CREATE TABLE community_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX community_limits_expiry ON community_limits(expires_at);
CREATE TABLE community_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO community_settings VALUES ('rate_salt', lower(hex(randomblob(32))));
