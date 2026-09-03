-- The daily game becomes a SUITE: Flickdl, Reel, Chronology, The Grid, Flicklink.
--
-- Every table from 0032 was keyed as though there would only ever be one game. This adds
-- the game dimension to all three and moves it into each primary key.
--
-- ══════════════════════════════════════════════════════════════════════════════════════
-- ⚠️ THIS IS A TABLE REBUILD, NOT AN ALTER. Read this before editing it.
-- ══════════════════════════════════════════════════════════════════════════════════════
--
-- SQLite cannot add a column to a PRIMARY KEY. `ALTER TABLE ... ADD COLUMN game` would
-- succeed and leave the PK as (user_id, date) -- at which point the FIRST game a player
-- finishes on a given day wins the row and every other game that day is silently dropped
-- by the ON CONFLICT DO NOTHING in handlePostResult. It would look like it worked.
--
-- So each table is created new, copied, dropped and renamed. Three things that must hold:
--
--   1. `DEFAULT 'flickdl'` on the new column, and the copy hard-codes 'flickdl'. Every
--      existing row was Flickdl by definition -- it was the only game -- so the backfill
--      is a literal, not a guess.
--   2. The INSERTs name their columns explicitly. `INSERT INTO x SELECT * FROM y` depends
--      on column ORDER matching, and daily_game_results has had columns appended since
--      0032 (guesses, guess_types in 0033). A future append would silently shift the copy.
--   3. Indexes are recreated AFTER the rename. Dropping a table drops its indexes with it,
--      and losing idx_daily_game_results_date turns the weekly leaderboard and the
--      friends-for-a-day read into full table scans of the largest table in the database
--      -- which is slow rather than broken, so nothing would fail and nobody would notice.

-- ── daily_game_results ────────────────────────────────────────────────────────────────
CREATE TABLE daily_game_results_new (
  user_id       TEXT    NOT NULL,
  game          TEXT    NOT NULL DEFAULT 'flickdl',
  date          TEXT    NOT NULL,
  puzzle_number INTEGER NOT NULL,
  guess_count   INTEGER NOT NULL,
  solved        INTEGER NOT NULL,
  score         INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  guesses       TEXT    NOT NULL DEFAULT '[]',
  guess_types   TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, game, date)
);

INSERT INTO daily_game_results_new
  (user_id, game, date, puzzle_number, guess_count, solved, score, created_at, guesses, guess_types)
SELECT
  user_id, 'flickdl', date, puzzle_number, guess_count, solved, score, created_at, guesses, guess_types
FROM daily_game_results;

DROP TABLE daily_game_results;
ALTER TABLE daily_game_results_new RENAME TO daily_game_results;

-- Serves the friends-for-a-day read and the rolling 7-day leaderboard, both of which now
-- start from (game, date) rather than from date alone.
CREATE INDEX IF NOT EXISTS idx_daily_game_results_date ON daily_game_results(game, date);

-- ── daily_game_stats ──────────────────────────────────────────────────────────────────
--
-- One rollup per player PER GAME. The alternative -- one row per player with five sets of
-- columns -- makes adding a sixth game a migration instead of an INSERT, and makes the
-- per-game leaderboard a scan over columns rather than an indexed read.
--
-- The suite-wide streak is deliberately NOT a column here. It is derivable from these rows
-- (a day counts if ANY game was played), and a stored copy would be a second source of
-- truth that recomputeStats would have to keep in step across five games.
CREATE TABLE daily_game_stats_new (
  user_id          TEXT    NOT NULL,
  game             TEXT    NOT NULL DEFAULT 'flickdl',
  played           INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  current_streak   INTEGER NOT NULL DEFAULT 0,
  best_streak      INTEGER NOT NULL DEFAULT 0,
  total_score      INTEGER NOT NULL DEFAULT 0,
  guess_histogram  TEXT    NOT NULL DEFAULT '{}',
  last_played_date TEXT,
  updated_at       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game)
);

INSERT INTO daily_game_stats_new
  (user_id, game, played, wins, current_streak, best_streak, total_score, guess_histogram, last_played_date, updated_at)
SELECT
  user_id, 'flickdl', played, wins, current_streak, best_streak, total_score, guess_histogram, last_played_date, updated_at
FROM daily_game_stats;

DROP TABLE daily_game_stats;
ALTER TABLE daily_game_stats_new RENAME TO daily_game_stats;

-- Leads on `game`: every leaderboard read is "the top N at ONE game", so a bare
-- total_score index would have to scan across all five and filter.
CREATE INDEX IF NOT EXISTS idx_daily_game_stats_score ON daily_game_stats(game, total_score DESC);

-- ── daily_game_anon_distribution ──────────────────────────────────────────────────────
--
-- Still holds no user id and nothing attributable to anybody, so it stays absent from
-- eraseAccount for exactly the reasons 0032 set out. The game dimension does not change
-- that -- it makes the counters narrower, not more personal.
CREATE TABLE daily_game_anon_distribution_new (
  game        TEXT    NOT NULL DEFAULT 'flickdl',
  date        TEXT    NOT NULL,
  guess_count INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game, date, guess_count)
);

INSERT INTO daily_game_anon_distribution_new (game, date, guess_count, count)
SELECT 'flickdl', date, guess_count, count FROM daily_game_anon_distribution;

DROP TABLE daily_game_anon_distribution;
ALTER TABLE daily_game_anon_distribution_new RENAME TO daily_game_anon_distribution;
