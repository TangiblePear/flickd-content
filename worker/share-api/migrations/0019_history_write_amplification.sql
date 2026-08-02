-- Cut the D1 write cost of a watch event from ~7 rows to ~4.
--
-- ## The measurement that prompted this
--
-- On 2026-08-02, syncing ~1,400 real watch events produced **10,530 rows written** —
-- roughly 7.5 per event. The data is one row; the multiplier is INDEXES. Every index
-- covers every row, so each insert files an entry in each one, and D1 bills each of
-- those as a row written. `watch_history` carried six secondary indexes plus the
-- primary-key autoindex.
--
-- The economics are lopsided and decide every judgement below: D1 charges **$1.00 per
-- million rows written** and **$0.001 per million rows read** — reads are a THOUSAND
-- times cheaper. Trading an index for a per-user scan is therefore almost always
-- correct here, and doubly so because the queries in question are already cached in
-- KV for five minutes.
--
-- On the free tier the same arithmetic is the difference between ~500 users and
-- ~10,000, because the limit there is 100,000 rows written per DAY.

-- ── sync_cursors: written every pass, read by nothing ───────────────────────
--
-- This table was in the original plan and was faithfully implemented: every
-- `POST /api/history/sync` upserted a row into it. Nothing has ever read it. The
-- CLIENT holds its own cursor in DataStore and sends it as `lastSyncTimestamp`; the
-- server never consults this table to answer anything.
--
-- That made it pure cost, and the worst-shaped kind: ~2 rows written (row + primary
-- key) on EVERY sync pass including completely idle ones. At a 15-minute cadence that
-- is ~192 rows per device per day with nobody watching anything — which at 10,000
-- users is 1.9M rows/day of pure heartbeat, nineteen times the entire free daily
-- allowance, for data no code path consumes.
--
-- Dropped rather than merely left unwritten: an empty table nobody reads is a trap for
-- the next person, who will reasonably assume it means something. Phase 3 wants
-- per-integration push state, but that is `pending_integration_push` with a different
-- shape — if a cursor table is ever genuinely needed, one migration adds it back.
DROP TABLE IF EXISTS sync_cursors;

-- ── Indexes that cost more than they earn ───────────────────────────────────

-- Added for Phase 3 ("everything that came from Trakt"). Phase 3 does not exist, and
-- no query in the Worker references `source` at all. An index maintained on every
-- insert for a feature that has not been built is the clearest possible case of
-- paying now for a benefit that may never arrive.
DROP INDEX IF EXISTS idx_wh_user_source;

-- Served the `?type=` filter on the history page and the movie/episode totals in the
-- stats derivation. Both now fall back to a scan of one user's rows under
-- `idx_wh_user_time`, which already leads with `user_id` — so the scan is bounded by
-- that user's history, never the whole table. Stats are KV-cached for five minutes,
-- so this runs at most once per user per five minutes; the history filter is a
-- deliberate user action, not a background loop.
DROP INDEX IF EXISTS idx_wh_user_type;

-- Served the per-show GROUP BY in the stats derivation. Same reasoning, and this one
-- was the most expensive of the three: although declared partial
-- (`WHERE show_tmdb_id IS NOT NULL`), the predicate matches every EPISODE row, and
-- episodes are the overwhelming majority of a real history — so in practice it was
-- paid on nearly every insert.
DROP INDEX IF EXISTS idx_wh_user_show;

-- ── What deliberately stays ─────────────────────────────────────────────────
--
--   idx_wh_user_time     (user_id, watched_at DESC, id DESC)
--     The history page, and its keyset pagination. It cannot be served by the primary
--     key, which is sorted by the client's event id (`watch-EPISODE-1396-s2e5-…`) and
--     therefore not chronological.
--
--   idx_wh_user_updated  (user_id, updated_at)
--     The sync delta — the hottest read in the whole feature, run by every device on
--     every pass. This is the one index whose absence would actually hurt: it would
--     turn each sync into a full scan of that user's history.
--
--   idx_wh_deleted       (deleted_at) WHERE deleted_at IS NOT NULL
--     Free on the write path. A normal watch does not match the predicate, so an
--     ordinary insert files nothing here; only tombstones ever appear.
--
-- Plus the primary-key autoindex on (user_id, id), which is not optional — it enforces
-- one row per watch and is what makes `DELETE /api/history/{id}` a seek.
--
-- Floor is therefore ~4 rows per event: the row, the primary key, and two indexes.
-- Any index added here in future is a permanent tax on the app's hottest write; the
-- question to ask is not "would this query be faster" but "is this query frequent
-- enough, and uncached, to be worth paying for on every watch anyone ever logs".
