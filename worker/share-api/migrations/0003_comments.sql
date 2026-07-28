-- Comments, at two levels — title (movie or show) and episode — plus reactions,
-- translations and the moderation column comments force onto `reports`.
--
-- Flat, no threads. Replies multiply the moderation surface and can be added
-- later; un-threading later means discarding user content.
--
-- **Rows scale with comments written, not with the catalogue.** There is no
-- per-title registration: a title nobody has commented on has zero rows and costs
-- an index seek that finds nothing. At ~600 bytes a row, D1's 5 GB holds ~8M
-- comments and the 100k rows/day write budget is 100k comments a day.
--
-- This table is what retires the last E2EE content surface. `social_opinions`
-- migrate into it, client-driven, and every migrated row lands as
-- visibility='friends' regardless of the public default — they were written under
-- an E2EE friends-only promise, and the default applies to NEW comments only.

-- ── Comments ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,            -- client-supplied + stable => idempotent retry
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL,               -- movie | show
  -- ⚠️ -1 sentinels, NOT NULL, deliberately. SQLite permits NULL in composite
  -- PRIMARY KEY columns (a documented deviation from the standard), so a
  -- comment_counts PK containing nullable season/episode would NOT enforce
  -- uniqueness and the counter would silently fork into duplicate rows. Same
  -- reason the subject index below never has to match `IS NULL`.
  season     INTEGER NOT NULL DEFAULT -1, -- -1 = title-level
  episode    INTEGER NOT NULL DEFAULT -1,
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL DEFAULT '',
  -- The MEDIA reaction — "I loved S2E5" — i.e. today's `social_opinions.reaction`.
  -- A column here rather than its own table, which gives the migration a 1:1 row
  -- shape with no reshaping and preserves "react without commenting" (empty body).
  -- NOT to be confused with `comment_reactions` below, which is "I liked what you
  -- wrote". Three different things get called reactions; only two are stored.
  reaction   TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',  -- public | friends
  -- Author-set at compose time, or community-set at 2 spoiler reports. Blurs with
  -- tap-to-reveal; it does NOT hide. A spoiler is a mislabelling, not a violation.
  spoiler    INTEGER NOT NULL DEFAULT 0,
  -- Detected at write time (ML Kit on the client). Present from day one on
  -- purpose: 11 locales ship, so without it a UK reader opens a popular episode to
  -- find the top comments in Turkish — and adding the column later means a
  -- backfill over every comment.
  lang       TEXT,
  -- Attached media. A REFERENCE, never bytes: provider + id + the URL the picker
  -- returned, so media loads from the provider's CDN and costs no R2, no Worker
  -- requests and no bandwidth. `media_provider` stays swappable because Tenor
  -- closed to new API clients in Jan 2026 and GIPHY is a negotiated paid tier.
  -- w/h are stored to reserve layout space without pre-fetching, so a list does
  -- not jump as images land.
  media_kind     TEXT,                    -- null | gif | image
  media_provider TEXT,                    -- giphy | r2
  media_id       TEXT,                    -- provider id, or R2 key
  media_url      TEXT,
  media_w        INTEGER,
  media_h        INTEGER,
  hidden_at  INTEGER,                     -- global moderation (REPORT_AUTOHIDE), provisional
  deleted_at INTEGER,                     -- tombstone; the row survives so moderation history does
  -- Reaction-notification cooldown. Volume is unbounded — a comment that does well
  -- could draw hundreds — and there is no cron budget for a digest, so the write
  -- path itself throttles: notify only if >~15 min since the last one, carrying the
  -- current count rather than one push per reaction.
  last_notified_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ⚠️ `visibility` sits BEFORE `created_at` deliberately. Without it in the key
-- path the public read scans every comment on the episode and filters after, so a
-- hot episode costs thousands of rows to return twenty.
CREATE INDEX IF NOT EXISTS idx_comments_subject
  ON comments(tmdb_id, media_type, season, episode, visibility, created_at DESC);

-- One comment per user per subject, editable. This is the primary anti-spam
-- control: spam is bounded by how many subjects someone can be bothered to visit.
-- Enforced here rather than trusted to the client's deterministic id, because the
-- id is client-supplied.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_author_subject
  ON comments(author_id, tmdb_id, media_type, season, episode);

-- Comments reach the friend feed with NO extra write: `loadFeed` queries this
-- index alongside `feed_events` and merges. `schema.sql` commits to fan-out on
-- READ precisely because reads have a 5M/day budget against 100k writes, and a
-- second indexed query inside the same Worker request is not a second chargeable
-- request.
CREATE INDEX IF NOT EXISTS idx_comments_author_time
  ON comments(author_id, created_at DESC);


-- ── Counters, maintained on write ───────────────────────────────────────────
-- `COUNT(*)` still scans every matching row, so "142 comments" under a poster
-- costs thousands of rows per page view, multiplied by 20 for a rail of posters.
-- That dwarfs every other cost in this design.
--
-- Incremented in the SAME `DB.batch()` as the insert — D1 batches are
-- transactional, so the count cannot diverge from the rows.
--
-- **Public only.** Including friends-only comments leaks that private ones exist
-- and shows a number the reader cannot reconcile with what they can see.
CREATE TABLE IF NOT EXISTS comment_counts (
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  season     INTEGER NOT NULL DEFAULT -1,
  episode    INTEGER NOT NULL DEFAULT -1,
  n_public   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tmdb_id, media_type, season, episode)
);


-- ── Comment reactions ───────────────────────────────────────────────────────
-- "I liked what you wrote". A fixed set of six — 👍 ❤️ 😂 😮 😢 🔥 — one per user
-- per comment, changeable. No 😡: it is a known amplifier of hostile engagement
-- and has no constructive use on a comment about an episode.
--
-- The set may be GROWN safely later; shrinking it strands existing rows here,
-- which then have to be rendered anyway or migrated. Adding is free, removing is
-- not — and fixed → picker is additive while picker → fixed discards reactions
-- people actually made.
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)      -- one reaction per user per comment, changeable
);

-- Counts via atomic upsert, NEVER a JSON blob on `comments`. `ON CONFLICT DO
-- UPDATE SET n = n + 1` is atomic; a `reactions_json` column is a
-- read-modify-write and WILL lose reactions under concurrency. Reading a page of
-- 20 comments costs one extra `WHERE comment_id IN (…)` query.
CREATE TABLE IF NOT EXISTS comment_reaction_counts (
  comment_id TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (comment_id, emoji)
);


-- ── Server-side translations ────────────────────────────────────────────────
-- Filled by the Worker inline, in a request that is already paid for: AI
-- inference and D1 queries inside an invocation are subrequests, not billed
-- invocations, so translating costs zero EXTRA requests. The response becomes
-- per-LANGUAGE rather than per-user, so it still edge-caches — one entry per
-- language instead of one per reader.
--
-- `src_updated_at` is not optional. Editing is allowed forever, and without it a
-- stale translation stays cached indefinitely while readers see text that no
-- longer matches the original.
CREATE TABLE IF NOT EXISTS comment_translations (
  comment_id     TEXT NOT NULL,
  lang           TEXT NOT NULL,
  text           TEXT NOT NULL,
  src_updated_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, lang)
);


-- ── Moderation ──────────────────────────────────────────────────────────────
-- The comment as it read when the report was filed. Editing forever is otherwise
-- a way to escape a report: an author can rewrite the text after it is flagged, so
-- the admin decision has to be made on what was actually reported.
--
-- Keep BOTH: if the live text now differs, that difference is itself a signal —
-- editing straight after a report is usually damage control. The admin panel
-- renders "reported as: … / now reads: …" when they diverge.
--
-- `reports.kind` already carries 'comment'. Spoiler reports use the separate kind
-- 'comment_spoiler' so the two counts never mix: ⚠️ if spoiler reports counted
-- toward REPORT_AUTOHIDE, "report as spoiler" becomes a censorship lever and three
-- people who dislike an opinion make it vanish. Abuse reports hide; spoiler
-- reports blur, at a threshold of 2 rather than 3 because the consequence is mild
-- and reversible.
ALTER TABLE reports ADD COLUMN body_snapshot TEXT;

-- Auto-hide counting is "how many OPEN reports name this target", and restoring a
-- comment marks its reports `dismissed`. Without that, an admin who clears a
-- comment while its three reports stay open lets the next single report re-trip
-- the threshold — one person overturning the moderator. Only open reports count,
-- so a restored comment needs three NEW ones.
CREATE INDEX IF NOT EXISTS idx_reports_target_kind
  ON reports(target_id, kind, state);
