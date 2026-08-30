-- Lift one-comment-per-user-per-subject.
--
-- The restriction was widely described as *structural* — `comments.id` is
-- `{userId}:{subject}`, so a second comment was the same row. That is only half of
-- it. The other half is `idx_comments_author_subject`, a **UNIQUE** index created in
-- 0003 explicitly because "the id is client-supplied" and could not be trusted. It
-- is the real enforcement, and without dropping it every second comment on a subject
-- fails the INSERT with a UNIQUE constraint violation regardless of what id the
-- client mints.
--
-- ⚠️ This migration MUST land before the worker that allows a second comment. That
-- ordering is what `npm run deploy` already guarantees (migrate, then deploy) — do
-- not use `deploy:code-only` for this change.
--
-- The index is REPLACED, not merely dropped. Its column prefix still serves two live
-- reads: the per-subject hourly cap added alongside this migration
-- (`subjectRateLimited`, an indexed COUNT over exactly these columns plus
-- `created_at`), and the archive-mirror guard that asks which of a subject's comments
-- an author wrote. `created_at` is appended so the cap's range predicate is a seek
-- rather than a scan over an author's rows on a hot subject.
DROP INDEX IF EXISTS idx_comments_author_subject;

CREATE INDEX IF NOT EXISTS idx_comments_author_subject
  ON comments(author_id, tmdb_id, media_type, season, episode, created_at DESC);
