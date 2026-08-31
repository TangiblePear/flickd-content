-- Moderating comments we do not own.
--
-- Reporting an archive comment has to land in TWO places: our own queue, so we can
-- act for our users immediately, and upstream, so operators can act archive-wide.
-- Neither substitutes for the other — we cannot hide a row in someone else's app, and
-- the operator cannot know our thresholds.

-- Product-wide local hide of an archive comment.
--
-- ⚠️ We cannot hide anything upstream, so our auto-hide threshold writes HERE instead:
-- the comment stays live in every other partner app and disappears from ours. §10
-- permits exactly this ("for that user, or for every viewer in your product").
--
-- Provisional and restorable, for the same anti-brigading reason `setHidden` is: a
-- coordinated set of reports must be reversible by a moderator, and reversing it has
-- to dismiss the reports that caused it or the next single report re-trips the
-- threshold and one person overturns the decision.
CREATE TABLE IF NOT EXISTS archive_suppressed (
  archive_id TEXT PRIMARY KEY,       -- the commsuni UUID
  hidden_at  INTEGER NOT NULL,
  reason     TEXT
);

-- Outbound work that could not land: 503 archive_writes_maintenance, 429, 5xx.
--
-- ⚠️ Drained opportunistically from request traffic, NOT a cron. The account is at its
-- 5-cron limit, which is why the orphan reaper is already triggered this way.
--
-- ⚠️ The drain must be BOUNDED (≤5 items). It rides someone else's request and each
-- item is an outbound subrequest, so an unbounded drain of a 40-item backlog would
-- blow the 50-subrequest cap and take down whatever request happened to trigger it. A
-- backlog drains over several requests; there is no deadline.
CREATE TABLE IF NOT EXISTS archive_outbox (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,     -- 'comment' | 'reply' | 'delete' | 'report'
  -- Reused verbatim on every retry, so a replay is the original write rather than a
  -- second one. A report dropped as a duplicate still costs a write_unit — quota is
  -- charged on the request, not the outcome — so retrying blindly costs real money.
  idempotency_key TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL,     -- users.id; the actor ID is derived, never stored
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_at         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_outbox_due ON archive_outbox(next_at);

-- `reports` gains no columns. Two new `kind` values instead — see ARCHIVE_COMMENT_KINDS
-- in moderationQueue.ts. `target_id` holds the archive UUID, which is why the queue's
-- `LEFT JOIN comments` matches nothing for these and the display fields come from the
-- report-time snapshot instead.
