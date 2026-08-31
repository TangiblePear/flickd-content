-- The archive negative cache.
--
-- ⚠️ **The single biggest cost lever in the integration.** Most of the catalogue has
-- no archive conversation at all — TV Time shut down 2026-07-15, so every episode
-- aired since is empty until a partner writes there — and without this, every open of
-- every such title burns one `read_unit` and one subrequest to be told "nothing here".
--
-- The requirement is precise, and the obvious implementation misses it: on a hit this
-- must **skip the upstream call entirely**, not fetch and then render empty. Rendering
-- empty is the visible behaviour either way; the cost is the whole point.
--
-- Keyed by entity reference rather than by (tmdbId, mediaType, season, episode)
-- because the reference is what the miss was actually about — a show and its episodes
-- are cached and expire independently, which is correct: a series can be archived
-- while last night's episode is not.
--
-- `expires_at` is a few hours, not forever: the moment one of our own users writes
-- there, the entity exists. Phase 2's mirror deletes the row on a successful write;
-- until then the TTL is the only thing that clears it.
CREATE TABLE IF NOT EXISTS archive_misses (
  entity_ref TEXT PRIMARY KEY,       -- 'tvdb-121361-s2e5', 'movie/tvdb-12345'
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The sweep that keeps this from growing without bound. Expired rows are dead weight
-- and the table is written on every miss, so the long tail of the catalogue would
-- otherwise accumulate here indefinitely.
CREATE INDEX IF NOT EXISTS idx_archive_misses_expiry ON archive_misses(expires_at);
