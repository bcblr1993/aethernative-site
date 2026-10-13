-- Aggregate download initiations only. No IP, user agent, cookie or user ID is stored.
CREATE TABLE download_daily (
  day TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (day, app_id, version)
);
CREATE TABLE download_stats_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at INTEGER NOT NULL
);
INSERT INTO download_stats_meta (id, started_at) VALUES (1, unixepoch() * 1000);
