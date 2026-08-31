-- The write mirror's ledger: which of our comments exist upstream, and as what.
--
-- ⚠️ This table is what makes a DELETE possible. Without a local record of the archive
-- id, a user who deletes a comment in Flickto leaves the text live in every other
-- partner app for ever, with no way to ever find it again — a policy failure, not a
-- bug. Nothing may be mirrored before the row that lets it be unmirrored can be
-- written.
--
-- ⚠️ `author_id` is stored even though `comment_id` could reach it through `comments`,
-- because the delete must be made with THAT AUTHOR's actor id and the local row is
-- gone by the time the teardown runs. Reading the author from a deleted row is not
-- possible, so the ledger has to carry it independently.
CREATE TABLE IF NOT EXISTS archive_comment_refs (
  comment_id  TEXT PRIMARY KEY,     -- our comments.id
  archive_id  TEXT NOT NULL,        -- the commsuni UUID we were handed on 201
  author_id   TEXT NOT NULL,        -- users.id, for the actor header on teardown
  -- Edits are delete + repost upstream, which costs 2 write_units and mints a NEW
  -- archive id. After three, or once the row has replies hanging off it, we stop:
  -- re-posting a comment that people have replied to would orphan their replies.
  -- `shared = 0` means "was mirrored, no longer is" — deliberately distinct from
  -- having no row at all, which means "never mirrored".
  edits       INTEGER NOT NULL DEFAULT 0,
  shared      INTEGER NOT NULL DEFAULT 1,
  mirrored_at INTEGER NOT NULL
);

-- The dedup read filter joins on this for every archive page, and the teardown looks
-- rows up by archive id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_refs_archive ON archive_comment_refs(archive_id);
-- Erasure and per-author teardown scan by author.
CREATE INDEX IF NOT EXISTS idx_archive_refs_author ON archive_comment_refs(author_id);

-- Whether this account agreed to appear under its own name upstream.
--
-- ⚠️ Absence is NOT consent. A user who has never been asked must appear as a
-- generated anonymous persona, which is what the archive does when we send no profile.
-- Storing only the positive case would make "never asked" and "declined" identical and
-- would re-prompt someone who already said no, so both answers are recorded.
CREATE TABLE IF NOT EXISTS archive_identity (
  user_id    TEXT PRIMARY KEY,
  shares     INTEGER NOT NULL,      -- 1 = display name + avatar sent upstream, 0 = persona
  decided_at INTEGER NOT NULL
);
