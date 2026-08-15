-- Sticker catalogue + popularity.
--
-- ── Why this is in D1 and not R2 ──
--
-- The community market has worked so far off R2 key prefixes: presence of
-- `stickers/by-title/{type}/{tmdbId}/{id}` means "listed for this title", and one `list`
-- answers the query with no per-object reads. That works because the only question asked
-- was "which stickers belong to this title", and a prefix IS that answer.
--
-- "Browse everything, most popular first" is a different question. R2 can list keys in
-- lexical order and nothing else, so ordering by a counter would mean either reading
-- every object to sort in memory, or encoding the count into the key and REWRITING that
-- key on every use — a rename per adoption, racing itself. A counter that goes up needs
-- a store that can increment and sort; that is D1.
--
-- The R2 prefixes stay. They serve the per-title rail, which is on a hot path (a detail
-- page open) and must not become a database query.
--
-- ── uses ──
--
-- How many people have taken this sticker, INCLUDING its author. Starts at 1 on upload,
-- +1 on an adoption, and +1 when a second person cuts byte-identical pixels and is handed
-- the existing object instead of storing a duplicate — that last one is a real signal of
-- wanting it, not an accident, and counting it is what makes "popular" mean "many people
-- arrived at this image" rather than "many people clicked a button".
--
-- Deliberately NOT a count of profile placements or comment attachments: those are reads
-- of an object someone already owns, so counting them would rank by how often a handful
-- of people re-used their own sticker.
CREATE TABLE IF NOT EXISTS stickers (
  id           TEXT PRIMARY KEY,
  -- The uploader. Not exposed by any listing; here so a future takedown can find an
  -- author's whole catalogue without walking R2.
  owner_id     TEXT NOT NULL,
  tmdb_id      INTEGER NOT NULL DEFAULT 0,
  media_type   TEXT NOT NULL DEFAULT '',
  -- Title at upload time, for a browse listing that must not do 60 catalogue lookups.
  title        TEXT NOT NULL DEFAULT '',
  -- SHA-256 of the stored PNG. The dedupe key: identical bytes are the same sticker, and
  -- byte-identity is the only definition that can never hand someone a DIFFERENT cut-out
  -- than the one they previewed. UNIQUE, so the dedupe cannot race itself into two rows.
  sha256       TEXT NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- The dedupe lookup, and the constraint that makes it safe under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stickers_sha ON stickers(sha256);

-- The browse ordering. `id` breaks ties so paging is stable — without it two stickers on
-- the same count can swap places between pages and one of them is never shown.
CREATE INDEX IF NOT EXISTS idx_stickers_popular ON stickers(uses DESC, id);

-- Per-title browse, for a future "most popular for this show" that wants ordering the R2
-- prefix cannot give.
CREATE INDEX IF NOT EXISTS idx_stickers_title ON stickers(media_type, tmdb_id, uses DESC);
