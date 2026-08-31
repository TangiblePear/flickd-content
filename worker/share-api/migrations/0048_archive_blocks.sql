-- Blocking an author in another partner's app.
--
-- ⚠️ **Server-side, not on the device.** A block has to survive a reinstall and follow
-- the account onto a second device; a local list does neither, and "I blocked this
-- person and they came back" is the failure that makes the feature worthless.
--
-- ⚠️ **`display_name` and `author_color` are SNAPSHOTS**, for the same reason migration
-- 0011 snapshots them on `blocks`: there is no profile route for a foreign author —
-- `400 unsupported_author_scope` by design — so a block that cannot name itself is a
-- block the user cannot recognise and therefore cannot lift. Storing the name at block
-- time is the only chance we get.
--
-- ⚠️ This store is for FOREIGN authors only. One of our own users is blocked through
-- `blocks` via the existing friend graph, so that blocking someone in Flickto also hides
-- their mirrored comments everywhere. One block store per person; two would drift, and a
-- user would have to block the same human twice.
CREATE TABLE IF NOT EXISTS archive_blocks (
  blocker_id   TEXT NOT NULL,        -- our users.id
  source_slug  TEXT NOT NULL,        -- which partner they commented from
  -- The archive's own opaque author id. Stable inside the archive projection but NOT a
  -- real account id anywhere, which is why it is scoped by slug: the same string from
  -- two partners is two different people.
  author_id    TEXT NOT NULL,
  display_name TEXT,
  author_color TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, source_slug, author_id)
);

-- The read path loads one reader's whole block set per request, so the index has to
-- serve `blocker_id` alone. Bounded in practice by how many people one user blocks.
CREATE INDEX IF NOT EXISTS idx_archive_blocks_blocker ON archive_blocks(blocker_id);
