-- One Take: the daily film puzzle.
--
-- Three tables, and the split between them is the whole design.
--
-- ── daily_game_results: one row per person per day ──
--
-- What a signed-in player scored. `score` is DERIVED BY THE SERVER from the submitted
-- guess list and never taken from the request — see dailyGame.ts. That is what makes
-- these rows worth ranking, and it is why they can be trusted retroactively: a
-- sign-in backfill re-verifies each day against its archived answer, so results a
-- person accumulated anonymously arrive under the same guarantee as today's.
--
-- The PK is (user_id, date) and inserts are INSERT OR IGNORE, so the first submission
-- for a day wins. Re-submitting cannot improve a score.
--
-- ⚠️ GROWTH. One row per user per day is the bulk-per-entity shape that does not
-- belong in D1 indefinitely: ~290 MB/year at 10k DAU, ~2.9 GB/year at 100k against a
-- fixed 10 GB ceiling. `daily_game_stats` below exists so these rows are TRIMMABLE to
-- a rolling window when that day comes. Any trim must stay comfortably above 7 days,
-- because the weekly leaderboard reads this table directly.
--
-- ── daily_game_stats: the lifetime rollup ──
--
-- Recomputed from the rows above on every submit. It exists for two reasons: it makes
-- the all-time leaderboard one indexed SELECT rather than an aggregation over every
-- daily row ever written, and it is what lets the daily rows be trimmed later without
-- a backfill. Adding it after launch would have meant recomputing over millions of
-- rows; adding it now costs fifteen lines in a handler that was being written anyway.
--
-- ── daily_game_anon_distribution: ANONYMOUS submissions only ──
--
-- The game is fully playable signed out, and on the web most players never sign in. A
-- "you beat 78% of players" figure that silently excluded the majority of them would
-- be worse than useless, so anonymous results count too. They cannot become rows in
-- `daily_game_results` -- there is no user to key them on -- so they land here as
-- counters.
--
-- ⚠️ Read this table TOGETHER with a GROUP BY over daily_game_results. Signed-in
-- contributions are deliberately NOT counted here. That follows the pattern poll
-- totals already use: derived from rows on read, so erasing an account removes its
-- contribution from every total automatically, with no counter to unpick and no way
-- for one to drift negative.
--
-- Which also settles the erasure question: this table holds no user id and nothing
-- attributable to anyone, exactly like `telemetry_daily`. There is nothing in it to
-- erase, and subtracting from a historical total would corrupt the series rather than
-- protect anybody. It is absent from eraseAccount ON PURPOSE.

CREATE TABLE IF NOT EXISTS daily_game_results (
  user_id      TEXT    NOT NULL,
  date         TEXT    NOT NULL,   -- YYYY-MM-DD, UTC, matches the published puzzle
  puzzle_number INTEGER NOT NULL,
  guess_count  INTEGER NOT NULL,   -- guesses spent, 1..6, whether or not it was solved
  solved       INTEGER NOT NULL,   -- 0 | 1
  score        INTEGER NOT NULL,   -- server-derived; 0 when unsolved
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- Serves both the friends-for-a-day read and the rolling 7-day leaderboard, which are
-- the only two queries that start from a date rather than a user. The PK already covers
-- everything that starts from a user.
CREATE INDEX IF NOT EXISTS idx_daily_game_results_date ON daily_game_results(date);

CREATE TABLE IF NOT EXISTS daily_game_stats (
  user_id          TEXT    NOT NULL PRIMARY KEY,
  played           INTEGER NOT NULL DEFAULT 0,
  wins             INTEGER NOT NULL DEFAULT 0,
  current_streak   INTEGER NOT NULL DEFAULT 0,
  best_streak      INTEGER NOT NULL DEFAULT 0,
  total_score      INTEGER NOT NULL DEFAULT 0,
  -- JSON {"0":n,"1":n,...,"6":n}. Bucket 0 is "did not solve"; 1..6 is "solved on N".
  guess_histogram  TEXT    NOT NULL DEFAULT '{}',
  -- The streak is only CURRENT relative to this. A reader comparing it against today is
  -- what decides whether to show the number or a zero; the column is not self-expiring.
  last_played_date TEXT,
  updated_at       INTEGER NOT NULL DEFAULT 0
);

-- Ordering the all-time leaderboard. Without it, ranking scans every player.
CREATE INDEX IF NOT EXISTS idx_daily_game_stats_score ON daily_game_stats(total_score DESC);

CREATE TABLE IF NOT EXISTS daily_game_anon_distribution (
  date        TEXT    NOT NULL,
  guess_count INTEGER NOT NULL,   -- 0 = did not solve, 1..6 = solved on N
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, guess_count)
);
