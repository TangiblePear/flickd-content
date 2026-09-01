-- What we have SEEN in the archive, so a collapsed header can say a conversation
-- exists without asking commsuni.
--
-- ⚠️ This is the positive twin of `archive_misses`, and it exists for the same reason:
-- the answer arrives as a by-product of a read we were already making, and throwing it
-- away means paying for it again. The miss table records "nothing here" so the next
-- open skips the call; this records "N here" so a header can render a signal that would
-- otherwise cost one `read_unit` per detail view — the exact cost the sheet is
-- collapsed by default to avoid.
--
-- ⚠️ **Only what a read discovered.** An entity nobody has ever opened has no row and
-- gets no signal. That is the whole design: there is no bulk or counts endpoint
-- upstream (the meter is 1 `read_unit` per comment page), so knowing about an unopened
-- entity means fetching it, and fetching it is what this avoids. Coverage grows with
-- use rather than being crawled.
--
-- Keyed by entity reference to match `archive_misses` exactly — a show and its episodes
-- are separate conversations and are counted, and expire, independently.
CREATE TABLE IF NOT EXISTS archive_counts (
  entity_ref TEXT PRIMARY KEY,        -- 'show/tvdb-121361', 'show/tvdb-121361-s2e5'
  -- Top-level comments the last read returned, AFTER product-wide suppression and
  -- BEFORE the per-reader block filter. Shared by every reader, so it must not carry
  -- one reader's block list — that is the cross-account leak the comments module warns
  -- about at the top of the file.
  count      INTEGER NOT NULL,
  -- Whether that count is the whole conversation or a page of it. A page is capped, so
  -- an incomplete read is a FLOOR ("20+"), not a total. Stored rather than inferred so
  -- a renderer never has to guess which it is holding.
  complete   INTEGER NOT NULL DEFAULT 0,
  seen_at    INTEGER NOT NULL
);

-- The staleness sweep, and the read the payload build makes.
CREATE INDEX IF NOT EXISTS idx_archive_counts_seen ON archive_counts(seen_at);
