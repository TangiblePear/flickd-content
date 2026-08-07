-- Personal lists and the watchlist.
--
-- ⚠️ NOT `shared_lists` (migration 0002). That table is a directed message from
-- one friend to another — "send this list to Alex". These are the lists a user
-- owns and comes back to, which have never existed server-side at all: on
-- Android they live only in Room, so a reinstall or a second device starts
-- empty and the browser could not see them.
--
-- ── Why D1 and not an R2 document ──────────────────────────────────────────
--
-- Watch history moved OUT of D1 in migration 0020 because one bulk import
-- (Trakt/SIMKL/TV Time) produces tens of thousands of events at a measured
-- 362 bytes per row, against 6.1 bytes gzipped in R2 — and D1's 10 GB ceiling
-- cannot be raised. Lists have neither property: they arrive one tap at a time,
-- a heavy user has hundreds of items rather than tens of thousands, and every
-- real query is relational ("items in this list, in order", "is this title
-- saved", "how many of this list have I watched"). Those are joins, not a blob
-- to ship whole to every device on every open.

-- ── Lists ────────────────────────────────────────────────────────────────────
--
-- PRIMARY KEY IS (user_id, id) AND MUST STAY THAT WAY. The built-in watchlist
-- uses the literal client id "watchlist" on EVERY account (WatchlistRepository
-- mints it as a constant), so a key on `id` alone would give the entire user
-- base one shared row. Same failure class as the deterministic-client-id bug in
-- migration 0018.
CREATE TABLE IF NOT EXISTS lists (
  user_id              TEXT    NOT NULL,
  id                   TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  -- MANUAL | SMART | COLLECTION_TMDB | COLLECTION_AI | AWARDS | AI_GENERATED |
  -- BUILTIN_WATCHLIST. Stored as text, unvalidated: the client owns this
  -- vocabulary and a newer app must be able to introduce a kind without a
  -- migration. Only SMART is treated specially (it carries filters, not items).
  kind                 TEXT    NOT NULL,
  description          TEXT,
  source_collection_id TEXT,
  auto_updated         INTEGER NOT NULL DEFAULT 0,
  media_filter         TEXT,
  manual_sort_mode     TEXT,
  is_pinned_to_home    INTEGER NOT NULL DEFAULT 0,
  display_order        INTEGER NOT NULL DEFAULT 0,
  home_order           INTEGER NOT NULL DEFAULT 0,
  -- Optimistic concurrency for the HEADER ONLY (name, description, pin, order,
  -- filters). Items deliberately do not use it — see list_items.
  version              INTEGER NOT NULL DEFAULT 1,
  -- Tombstone rather than a hard delete, so a device that has been offline
  -- learns the list is gone instead of re-uploading it as new.
  deleted_at           INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

-- ── Smart-list filters ───────────────────────────────────────────────────────
--
-- 1:1 with a SMART list. A smart list has NO rows in list_items — the filter IS
-- its content, and every client re-evaluates it locally. The server never runs
-- a filter; doing so would make this a TMDB Discover proxy with its own
-- staleness and rate-limit story, which is a different feature from sync.
--
-- Columns mirror Android's SmartListFiltersEntity one-for-one.
CREATE TABLE IF NOT EXISTS list_filters (
  user_id                 TEXT    NOT NULL,
  list_id                 TEXT    NOT NULL,
  sort_by                 TEXT,
  include_genres          TEXT,   -- JSON array of TMDB genre ids
  exclude_genres          TEXT,   -- JSON array of TMDB genre ids
  year_from               INTEGER,
  year_to                 INTEGER,
  rating_min              REAL,
  rating_max              REAL,
  vote_count_min          INTEGER,
  vote_count_max          INTEGER,
  language                TEXT,
  include_unreleased      INTEGER,
  media_types             TEXT,   -- JSON array of MediaTypeFlag names
  relative_release_window TEXT,   -- THIS_WEEK | THIS_MONTH | THIS_YEAR
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_id)
) WITHOUT ROWID;

-- ── Items ────────────────────────────────────────────────────────────────────
--
-- Deliberately NOT versioned. Adding and removing distinct items are
-- commutative operations, so two devices editing different items of the same
-- list have no conflict to detect — the natural composite key gives each item
-- its own identity, and `updated_at` settles the rare case where both edit the
-- same item's position. Sharing the header's version here would manufacture
-- 409s between edits that never actually collide.
CREATE TABLE IF NOT EXISTS list_items (
  user_id          TEXT    NOT NULL,
  list_id          TEXT    NOT NULL,
  tmdb_id          INTEGER NOT NULL,
  type             TEXT    NOT NULL,   -- MOVIE | SHOW
  position         INTEGER NOT NULL DEFAULT 0,
  match_percentage INTEGER,
  ai_note          TEXT,
  added_at         INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_id, tmdb_id, type)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(user_id, list_id);
CREATE INDEX IF NOT EXISTS idx_lists_updated   ON lists(user_id, updated_at);

-- ── Pointer row ──────────────────────────────────────────────────────────────
--
-- Mirrors history_meta: lets a client ask "is anything new?" with one indexed
-- read and no snapshot assembly. It is a freshness gate, NOT a write guard —
-- safety comes from lists.version and the item table's natural key.
CREATE TABLE IF NOT EXISTS lists_meta (
  user_id    TEXT    NOT NULL PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  list_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
