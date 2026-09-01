-- Replying to another app's comment: where our reply hangs.
--
-- A reply to an archive comment has no native parent — the thing it answers lives in
-- a partner's database and has never been in `comments`. `parent_id` therefore cannot
-- hold it: that column is a self-reference the reply reads and the depth/flatten logic
-- walks, and pointing it at a UUID that matches no row would break both.
--
-- ⚠️ These two columns are MUTUALLY EXCLUSIVE, and the difference is not cosmetic.
-- `parent_id` places a row inside our own thread tree; `parent_archive_id` says the
-- conversation belongs to someone else and we are a participant in it. A row with
-- both set is meaningless, and the post handler rejects it rather than picking one.
--
-- ⚠️ The UUID is stored BARE, exactly as the partner API names it — no `slug:` prefix.
-- The client prefixes archive ids so the merged list can be keyed on `(source, id)`
-- without a composite everywhere, but that prefix is a rendering concern: the mirror
-- publishes to `/comments/{parentArchiveId}/replies` and a prefixed value would 404
-- there. The prefix is stripped at the boundary, once, and never stored.
ALTER TABLE comments ADD COLUMN parent_archive_id TEXT;

-- Serving a thread reads every reply under one archive parent, newest last, which is
-- the same shape the native reply read uses.
CREATE INDEX IF NOT EXISTS idx_comments_parent_archive
  ON comments(parent_archive_id, created_at);
