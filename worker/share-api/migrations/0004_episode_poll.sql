-- Episode community poll: an app-wide average rating, plus the share of voters who
-- picked each emotion and each character.
--
-- Subject identity is the SAME key comments uses -- (tmdb_id, media_type, season,
-- episode) with -1 sentinels -- so the two features agree on what an episode is.
--
-- Why -1 and not NULL: SQLite permits NULL in composite PRIMARY KEY columns, a
-- documented deviation from the standard. A nullable key would not enforce
-- uniqueness, and the counter tables below would silently fork into duplicate rows.

-- One row per user per episode. This is what makes a vote changeable and
-- one-per-user enforceable. It is NEVER read by the poll display.
CREATE TABLE IF NOT EXISTS episode_votes (
  user_id             TEXT NOT NULL REFERENCES users(id),
  tmdb_id             INTEGER NOT NULL,
  media_type          TEXT NOT NULL,
  season              INTEGER NOT NULL,
  episode             INTEGER NOT NULL,
  rating              INTEGER,                  -- 1..10, NULL = did not rate
  emotions            TEXT NOT NULL DEFAULT '', -- comma-separated emotion ids
  favourite_person_id INTEGER,                  -- NULL = no pick
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, tmdb_id, media_type, season, episode)
);

-- Subject totals. One row, read on every episode page open.
--
-- n_ratings is separate from n_voters and that is load-bearing: someone can pick an
-- emotion without rating, so dividing rating_sum by n_voters would silently deflate
-- every average.
CREATE TABLE IF NOT EXISTS episode_vote_counts (
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  season     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  n_voters   INTEGER NOT NULL DEFAULT 0,
  n_ratings  INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tmdb_id, media_type, season, episode)
);

-- One row per option that has at least one vote. Emotions are multi-select, so the
-- percentages derived from this can total more than 100% -- that is correct for
-- select-all-that-apply, and the client must not render it as a partition.
CREATE TABLE IF NOT EXISTS episode_option_counts (
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  season     INTEGER NOT NULL,
  episode    INTEGER NOT NULL,
  kind       TEXT NOT NULL,   -- 'emotion' | 'person'
  option_id  TEXT NOT NULL,   -- emotion id, or person id as text
  n          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tmdb_id, media_type, season, episode, kind, option_id)
);

-- The poll read fetches every option row for one subject, so the PK prefix already
-- serves it. No extra index: it would be write cost for a query that never runs.
