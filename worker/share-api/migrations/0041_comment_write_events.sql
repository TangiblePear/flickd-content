-- Burst-limit ledger for the comment write path.
--
-- ⚠️ **This replaces the `unsafe.bindings` ratelimit approach, which silently did
-- nothing.** Deployed 2026-08-15 with `COMMENT_USER_LIMITER` / `COMMENT_IP_LIMITER`
-- configured and listed by `wrangler deploy`, eight comment writes in 27 seconds were
-- all accepted against a limit of 5/60s. The binding is optional-chained, so an absent
-- one is indistinguishable from a passing one — it failed open and silently. The
-- binding type is experimental, every code path for it in the pinned wrangler 3.114 is
-- local-dev/miniflare only, and upgrading wrangler is ruled out (shared pnpm workspace).
--
-- So: count real rows in a window, the shape `friends.ts` and `match.ts` already use
-- and which is proven against this account.
--
-- The IP is stored HASHED. The older R2 limiter (`rl/{scope}/{ip}/{hour}.json`) keeps
-- the raw address in the object key; that is not a precedent worth copying into a table
-- with no lifecycle rule behind it. A hash is all a counter needs.

CREATE TABLE IF NOT EXISTS comment_write_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  -- SHA-256 of CF-Connecting-IP, hex. NULL when the header is absent.
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);

-- One index per key the limiter counts on. Both are (key, time) so the window scan is
-- a range seek rather than a table scan — D1 bills rows SCANNED, not rows returned.
CREATE INDEX IF NOT EXISTS idx_comment_write_events_user_time
  ON comment_write_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_write_events_ip_time
  ON comment_write_events (ip_hash, created_at DESC);
