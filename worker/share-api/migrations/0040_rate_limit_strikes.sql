-- Rate-limit strikes on the comment write path.
--
-- A limiter refuses one request; it does not stop a script, which simply retries
-- at one request per window forever. This table is what turns repeated refusals
-- into an automatic posting suspension (see `recordStrike` in src/comments.ts).
--
-- Deliberately NOT a per-user counter row: a plain append lets the threshold be a
-- windowed COUNT, so changing the window is a code change rather than a migration,
-- and there is no read-modify-write to lose under concurrency.
--
-- Rows are pruned opportunistically by the same function that writes them — this
-- account has no cron budget left, so nothing here may depend on a scheduled job.

CREATE TABLE IF NOT EXISTS rate_limit_strikes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  -- Which limiter was tripped ("comment_write", "comment_hourly"). Kept so the
  -- admin trail can say what someone was doing, not merely that they were stopped.
  scope      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Serves the windowed count in `recordStrike` and the prune sweep's ordering.
CREATE INDEX IF NOT EXISTS idx_rate_limit_strikes_user_time
  ON rate_limit_strikes (user_id, created_at DESC);
