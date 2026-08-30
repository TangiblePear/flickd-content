-- `(mediaType, tmdbId) → tvdbId`, so the server can address a commsuni.tv entity
-- without a client present.
--
-- The client resolves and sends the TVDB id (shows carry one already; movies resolve
-- via TheTVDB `/search/remoteid/{imdbId}` on first detail open). This caches the pair
-- so the outbox drain and the admin panel can build an entity reference for a title
-- nobody currently has open.
--
-- **Immutable, and therefore cacheable forever.** A title's TVDB id does not change;
-- if it ever did, the old value addressed a conversation that still exists under the
-- old reference. There is deliberately no `updated_at` and nothing rewrites a row.
--
-- ⚠️ Split out of what the plan called `0045_commsuni.sql`. Phase 0 needs only this
-- table — the archive_* tables belong with the code that reads them, in Phase 1, which
-- now takes 0046. Applying a table months before its first reader makes it impossible
-- to tell a schema that is finished from one that is merely applied.
CREATE TABLE IF NOT EXISTS tvdb_map (
  media_type TEXT NOT NULL,          -- 'movie' | 'show'
  tmdb_id    INTEGER NOT NULL,
  tvdb_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);
