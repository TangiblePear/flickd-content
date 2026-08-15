-- Public lists: a directory of lists people chose to publish.
--
-- ⚠️ THREE things already carry the word "shared" or "public" here and none of them
-- is this:
--   • `shared_lists` (0002) — a directed message from one friend to another.
--   • the R2 share link — a frozen, anonymous snapshot for people with no account.
--   • `profiles.shared_list_ids` (0037) — lists pinned to one's own profile.
-- This is a browsable directory of lists by strangers, ranked and tagged.
--
-- ── Why this table stores almost nothing ─────────────────────────────────────
--
-- The obvious shape copies name, description and titles in at publish time. 0037
-- already worked out why that is wrong and the reasoning is unchanged: a copy is
-- correct at publish and drifts from that moment on, silently, and worse the more
-- the feature is used. So a row here is a POINTER at `lists (user_id, id)` plus the
-- few facts that exist nowhere else. Everything a reader sees is materialised from
-- `lists` / `list_items` at read time.
--
-- That is also what makes "follow" work. A follower is not sent a copy, so an
-- author's edit is live for every follower with no propagation step at all.
--
-- ── Only MANUAL lists ────────────────────────────────────────────────────────
--
-- Not enforced here, because `lists.kind` is deliberately unvalidated text (0026:
-- the client owns that vocabulary). It is enforced in publicLists.ts against the
-- row being published. A directory of generated content is not worth browsing:
-- AI_GENERATED is nobody's taste, AWARDS and COLLECTION_* are the same list for
-- every user, SMART has no rows in `list_items` at all and would publish as a name
-- with no titles, and BUILTIN_WATCHLIST is a private queue that carries the same id
-- on every account.
CREATE TABLE IF NOT EXISTS public_lists (
  owner_id     TEXT    NOT NULL,
  list_id      TEXT    NOT NULL,
  -- JSON array of curated slugs. Duplicated as rows in `public_list_tags` — see
  -- that table for why both exist.
  tags         TEXT    NOT NULL DEFAULT '[]',
  -- ⚠️ A RANKING CACHE, NOT A COUNT. `3 × follows + 1 × likes`, undecayed,
  -- recomputed for THIS ONE list in the same batch as any follow or like.
  --
  -- 0013, 0014 and 0015 each dropped a materialised counter table, and this is not
  -- a reversal of that: no number a user reads comes from here. Every displayed
  -- count is COUNT(*) over the covering indexes below, so a displayed count cannot
  -- be wrong. This column exists only because a sort key has to be in the ORDER BY.
  -- If it drifts, the order is slightly off and nothing else.
  --
  -- Age decay is applied in the QUERY, not stored, because a list nobody has
  -- touched must still fall — and there is no cron budget to sweep it. This worker
  -- has no scheduled() handler at all; see index.ts:756.
  engagement   INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  -- Set by the report threshold or an admin. Leaves the directory; followers see
  -- exactly what an unpublish looks like and are NOT told it was reported.
  hidden_at    INTEGER,
  PRIMARY KEY (owner_id, list_id)
) WITHOUT ROWID;

-- The default browse read: newest-first and trending-first both start here.
CREATE INDEX IF NOT EXISTS idx_public_lists_live
  ON public_lists(hidden_at, published_at);

-- ── Tag index ────────────────────────────────────────────────────────────────
--
-- The same tags are already on `public_lists.tags` as JSON, and this is not
-- redundancy for its own sake: the JSON column renders the chips in the one read
-- that fetched the row, and this table makes `tag = ?` an indexed lookup.
--
-- The alternative — `WHERE tags LIKE '%horror%'` — is wrong twice. It scans every
-- published row, and it matches `horror-comedy`.
--
-- Both are written in the same batch, so they cannot disagree.
CREATE TABLE IF NOT EXISTS public_list_tags (
  tag      TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  list_id  TEXT NOT NULL,
  PRIMARY KEY (tag, owner_id, list_id)
) WITHOUT ROWID;

-- ── Follows and likes ────────────────────────────────────────────────────────
--
-- Two tables rather than one with a `kind`, because they are not two flavours of
-- the same act. A like is a signal. A follow is a subscription that puts the list
-- on the follower's shelf and keeps it updating — it is read by
-- `GET /api/me/follows`, which a like must never appear in.
--
-- These rows are the TRUTH for both counts. Covering indexes on (owner_id,
-- list_id) make the aggregate an index-only scan, which is what 0014 established
-- when it dropped the reaction counter table.
CREATE TABLE IF NOT EXISTS list_follows (
  user_id    TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  list_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, owner_id, list_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_list_follows_target
  ON list_follows(owner_id, list_id);

CREATE TABLE IF NOT EXISTS public_list_likes (
  user_id    TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  list_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, owner_id, list_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_public_list_likes_target
  ON public_list_likes(owner_id, list_id);
