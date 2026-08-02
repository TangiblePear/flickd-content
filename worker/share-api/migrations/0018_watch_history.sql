-- Server-side watch history: the append-only event log, explicit ratings, and the
-- per-device sync cursor. See docs/Current Plans/ServerHistory.md.
--
-- ## The one rule this schema exists to enforce: 1 D1 write per watch event
--
-- There are NO materialised counter tables here — no `show_progress`, no
-- `episode_counts`. Every total the app shows is derived from `watch_history` on
-- read with COUNT/GROUP BY over an index, and the result is cached in KV for five
-- minutes. This is the same argument `0013`–`0015` made when they dropped the
-- comment/reaction/poll counters: watching is the hottest write in the app, and a
-- counter row per watch multiplies the write volume by however many counters exist
-- while adding a set of "the counter drifted" bugs that derivation cannot have.
--
-- `user_ratings` and `episode_ratings` are the exception, and deliberately so: they
-- are written on an EXPLICIT user action (rate, change status, leave feedback), not
-- on every watch. A watch does not touch them.

-- ── watch_history ───────────────────────────────────────────────────────────
--
-- ⚠️ The primary key is `(user_id, id)`, NOT `id` alone.
--
-- `id` is the client's canonical watch-event id, built by
-- `HistoryRepository.buildWatchedItemId` as e.g. `watch-EPISODE-1396-s2e5-1753027200`
-- or `watch-MOVIE-550-1753027200`. That id is DETERMINISTIC — deriving it from the
-- title, episode and watch second is precisely what stops the same watch counting
-- twice when it arrives once from the device and once from Trakt, and it is what
-- makes multi-device sync idempotent: two devices that recorded the same watch send
-- the same id and collapse into one row.
--
-- But a deterministic id derived from public facts is NOT unique across users. Two
-- people who finish the same film in the same second produce the same string. With
-- `id` as a bare PRIMARY KEY the second one's INSERT fails with a UNIQUE violation
-- against a row belonging to somebody else — a cross-user collision that would be
-- rare enough to survive every test and to look like a random 500 in production.
-- Scoping the key to the account removes the whole class.
--
-- There is deliberately no second unique index on
-- `(user_id, tmdb_id, media_type, season, episode, watched_at)`. SQLite's
-- `ON CONFLICT(...)` targets exactly ONE index; a row that satisfies the upsert's
-- conflict target while violating a different unique constraint aborts the statement
-- rather than taking the DO UPDATE branch. Two dedup keys therefore cannot both be
-- enforced by a single write, and rule 2 (one write per event) says there is only
-- one write. The client id is the dedup key, because it is the one the client can
-- also compute — which is what lets a delete address a row.
CREATE TABLE IF NOT EXISTS watch_history (
    user_id        TEXT    NOT NULL REFERENCES users(id),
    id             TEXT    NOT NULL,
    media_type     TEXT    NOT NULL,              -- 'MOVIE' | 'SHOW'
    tmdb_id        INTEGER NOT NULL,
    tvdb_id        INTEGER,
    -- For a SHOW this equals `tmdb_id`: the Android `WatchEventEntity` has no
    -- separate show column, the show's TMDB id IS the row's tmdb_id, and the
    -- episode is identified by (season_number, episode_number). Carried as its own
    -- column anyway so the per-show GROUP BY below is an index scan rather than a
    -- filter on media_type, and so a future episode-keyed client can populate it
    -- without a migration. NULL for movies.
    show_tmdb_id   INTEGER,
    season_number  INTEGER,                       -- NULL for movies
    episode_number INTEGER,                       -- NULL for movies
    watched_at     INTEGER NOT NULL,              -- Unix epoch MILLIS
    source         TEXT    NOT NULL DEFAULT 'INTERNAL',
    progress_pct   INTEGER NOT NULL DEFAULT 100,
    -- The reporting device's install-scoped random id (the same one `user_telemetry`
    -- uses). Lets the sync delta skip handing a device back its own writes. NULL for
    -- any client that predates the field — see the COALESCE in the delta query, which
    -- is why a NULL here means "return it to everyone" and never "return it to nobody".
    device_id      TEXT,
    -- Tombstone. A delete is a soft delete so the deletion itself can SYNC: a device
    -- that was offline when the row was deleted has to be told it is gone, and a row
    -- that had simply vanished is indistinguishable from one that never arrived.
    deleted_at     INTEGER,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);

-- The history page: newest first, per user. Also serves the keyset pagination in
-- `GET /api/history`, whose cursor is `(watched_at, id)` — not `watched_at` alone,
-- because a Trakt import can mark a whole season watched at one identical timestamp
-- and a single-column cursor would step straight over the rest of the tie.
CREATE INDEX IF NOT EXISTS idx_wh_user_time ON watch_history(user_id, watched_at DESC, id DESC);

-- The sync delta: everything this account changed since the caller's cursor,
-- tombstones included. This is the index the hot path rides.
CREATE INDEX IF NOT EXISTS idx_wh_user_updated ON watch_history(user_id, updated_at);

-- Per-show episode counts for the stats derivation.
CREATE INDEX IF NOT EXISTS idx_wh_user_show ON watch_history(user_id, show_tmdb_id)
    WHERE show_tmdb_id IS NOT NULL;

-- "Everything that came from Trakt", for the integration migration and for the
-- source breakdown on the stats page.
CREATE INDEX IF NOT EXISTS idx_wh_user_source ON watch_history(user_id, source);

-- Movie-vs-episode totals, and the `?type=` filter on the history page.
CREATE INDEX IF NOT EXISTS idx_wh_user_type ON watch_history(user_id, media_type);

-- Tombstone sweep (Phase 4). Partial, so it indexes only the handful of deleted
-- rows rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_wh_deleted ON watch_history(deleted_at)
    WHERE deleted_at IS NOT NULL;


-- ── user_ratings ────────────────────────────────────────────────────────────
-- Title-level rating, watch status and free-text feedback. Written ONLY on an
-- explicit user action. `updated_at` is the conflict resolver: the upsert takes the
-- newer side, so two devices editing offline converge without a merge dialog.
CREATE TABLE IF NOT EXISTS user_ratings (
    user_id      TEXT    NOT NULL REFERENCES users(id),
    media_type   TEXT    NOT NULL,
    tmdb_id      INTEGER NOT NULL,
    watch_status TEXT,
    rating       REAL,
    feedback     TEXT,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, media_type, tmdb_id)
);

-- "Everything I marked Dropped / On Hold" — the show-status surface.
CREATE INDEX IF NOT EXISTS idx_ur_status ON user_ratings(user_id, watch_status);

-- The sync delta reads by recency, same shape as watch_history's.
CREATE INDEX IF NOT EXISTS idx_ur_user_updated ON user_ratings(user_id, updated_at);


-- ── episode_ratings ─────────────────────────────────────────────────────────
-- The per-episode half of the same idea. Separate table rather than a nullable
-- season/episode pair on `user_ratings`, because that would make the primary key
-- nullable and every title-level read would have to filter the episodes back out.
--
-- ⚠️ NOT the same thing as `episode_votes` (migration 0004). That is the PUBLIC
-- community poll, aggregated across everyone and served to strangers. This is the
-- user's own private record, and the two must never be conflated: publishing this
-- would publish a rating the user gave under no expectation of an audience.
CREATE TABLE IF NOT EXISTS episode_ratings (
    user_id        TEXT    NOT NULL REFERENCES users(id),
    show_tmdb_id   INTEGER NOT NULL,
    season_number  INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    rating         REAL,
    emotions_csv   TEXT,
    fav_actor      TEXT,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, show_tmdb_id, season_number, episode_number)
);

CREATE INDEX IF NOT EXISTS idx_er_user_updated ON episode_ratings(user_id, updated_at);


-- ── sync_cursors ────────────────────────────────────────────────────────────
-- Where each device got to, per source.
--
-- ⚠️ `device_id` is NOT NULL with a sentinel default, and the primary key is the
-- three plain columns. The plan specified
--   PRIMARY KEY (user_id, source, COALESCE(device_id, '__global__'))
-- which SQLite cannot parse at all — a table-level PRIMARY KEY takes column names,
-- not expressions, so that migration would have failed on apply. The sentinel gives
-- the same "one global row when no device is named" behaviour with a key SQLite can
-- actually index, and it makes the matching `ON CONFLICT(user_id, source, device_id)`
-- in the upsert a plain column list too.
CREATE TABLE IF NOT EXISTS sync_cursors (
    user_id    TEXT NOT NULL REFERENCES users(id),
    source     TEXT NOT NULL,
    device_id  TEXT NOT NULL DEFAULT '__global__',
    cursor_val TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source, device_id)
);
