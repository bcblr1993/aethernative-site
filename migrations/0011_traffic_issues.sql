-- Private aggregated Cloudflare snapshots. No visitor identifiers or credentials.
CREATE TABLE traffic_cache (days INTEGER PRIMARY KEY CHECK(days IN (7,30)), captured_at INTEGER NOT NULL, payload TEXT NOT NULL);
-- Editorial public summaries are independent from private feedback.
CREATE TABLE known_issues (
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL, title TEXT NOT NULL, title_en TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL, description_en TEXT NOT NULL DEFAULT '', workaround TEXT NOT NULL DEFAULT '', workaround_en TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('investigating','in_progress','fixed')),
 resolved_version TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)), updated_at INTEGER NOT NULL
);
CREATE INDEX known_issues_app ON known_issues(app_id,published,updated_at);
CREATE TABLE issue_feedback (
 feedback_id TEXT PRIMARY KEY REFERENCES feedback(id) ON DELETE CASCADE,
 issue_id TEXT NOT NULL REFERENCES known_issues(id) ON DELETE CASCADE
);
