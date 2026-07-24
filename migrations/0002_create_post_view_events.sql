CREATE TABLE IF NOT EXISTS post_view_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  ip_hash TEXT,
  referrer TEXT,
  user_agent TEXT,
  accept_language TEXT,
  country TEXT,
  colo TEXT,
  viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_view_events_path_time
  ON post_view_events (path, viewed_at);

CREATE INDEX IF NOT EXISTS idx_post_view_events_viewed_at
  ON post_view_events (viewed_at);

CREATE TRIGGER IF NOT EXISTS cleanup_post_view_events
AFTER INSERT ON post_view_events
BEGIN
  DELETE FROM post_view_events
  WHERE viewed_at < datetime('now', '-90 days');
END;
