-- Watch history moves out of D1 and into one gzipped R2 document per user.
--
-- ## Why, in one number
--
-- Measured on 2,917 real events built into the exact post-0019 schema: **362 bytes per
-- event** in D1 (table + indexes), against **6.1 bytes** packed per-title and gzipped.
-- At 100k users x 20k events that is 725 GB versus 12 GB — and D1's ceiling is 10 GB per
-- database, which Cloudflare states cannot be raised.
--
-- The per-event design therefore wedges at roughly 1,500 users with large histories. This
-- is not a cost optimisation; it is the difference between reaching 100k users and being
-- structurally unable to.
--
-- ## Where the 59x comes from — repetition, not compression
--
-- Every row restated `user_id` (26 chars) and an event id like
-- `watch-EPISODE-1396-s2e5-1753027200` (35 chars). At 2 billion rows that is ~122 GB of
-- pure key repetition. In the document the user id is the object's NAME and the event id
-- is derivable from title + season + episode + second, so neither is stored at all. Add
-- index key duplication, per-row SQLite overhead, and the fact that D1 cannot compress
-- (gzip alone is 5.6x on this shape).
--
-- ## What the original plan got wrong
--
-- It modelled **500 events per user per year** and concluded ~7 GB at 100k users after
-- ~1.4 years. But this app's headline feature is importing an entire Trakt / SIMKL /
-- TV Time / Netflix back-catalogue at signup: 20,000 events is FORTY YEARS of that rate,
-- arriving in one sync. The model described organic accumulation for a product built
-- around bulk import.

-- ── The pointer row ─────────────────────────────────────────────────────────
--
-- One row per USER — never per event, never per title. It exists for three things the
-- document cannot do cheaply:
--
--   1. `version` lets an idle sync answer "you are current" from ONE indexed read, with
--      no R2 access and NO WRITES. The old design wrote a cursor row on every pass
--      (~192 rows/device/day for data nothing ever read), which alone capped the free
--      tier at ~500 users.
--   2. the counters make the fleet-wide total a `SUM()` over ~100k small rows instead of
--      opening 100k documents.
--   3. it gives account deletion something in D1 to cascade from.
--
-- WITHOUT ROWID: measured today, a rowid table with a composite PK bills 2 rows written
-- per insert before any secondary index; WITHOUT ROWID bills 1. There are deliberately NO
-- secondary indexes — every access is by primary key, and an index here would be a
-- permanent tax on the app's hottest write for a lookup nothing performs.
CREATE TABLE IF NOT EXISTS history_meta (
    user_id         TEXT    NOT NULL REFERENCES users(id),
    -- Bumped on every successful document write. The client echoes the version it last
    -- saw; equal versions mean "nothing to do" and cost zero writes.
    version         INTEGER NOT NULL DEFAULT 0,
    -- Derived from the document on each write, cached here so global stats never read R2.
    event_count     INTEGER NOT NULL DEFAULT 0,
    title_count     INTEGER NOT NULL DEFAULT 0,
    last_watched_at INTEGER,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (user_id)
) WITHOUT ROWID;


-- ── The tables this replaces ────────────────────────────────────────────────
--
-- Dropped rather than left in place. Data still lives on every device in Room, and
-- `ServerHistoryRepository.backfillIfNeeded()` re-uploads it automatically on the next
-- sync — verified doing exactly that on device on 2026-08-02. There is one account, and
-- writing a converter for it would be migration code maintained forever for a single row
-- set that regenerates itself.
--
-- ⚠️ DESTRUCTIVE MIGRATION: deploy the code that stops using these tables BEFORE applying
-- this. `npm run deploy` runs `migrate && deploy`, which is correct for additive changes
-- and exactly backwards here — doing it in that order on 0019 produced ~90 seconds of
-- live HTTP 500s. Use `npm run deploy:code-only` first, then `npm run migrate`.
DROP TABLE IF EXISTS watch_history;

-- Ratings and per-episode ratings fold into the same document. They are per-title and
-- low-volume (an explicit user action, never a watch), so they cost almost nothing there
-- and gain the same free merge semantics as everything else.
DROP TABLE IF EXISTS user_ratings;
DROP TABLE IF EXISTS episode_ratings;

-- `sync_cursors` was already dropped in 0019 — written on every pass, read by nothing.
