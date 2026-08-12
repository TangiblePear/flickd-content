-- Keep the guess LIST, not just how many there were.
--
-- Without it a second device can be told "you played, solved in 3, 60 points" but cannot
-- draw the board: the grid is rebuilt from tmdbIds, and those were being verified on the
-- way in and then thrown away. Every submission already carries them, so this stores what
-- the request was already sending.
--
-- JSON array of TMDB ids in the order they were guessed, e.g. "[603,1396,95]". Same shape
-- the Android client keeps in Room, so a restored row and a locally-played one take the
-- same code path.
--
-- ⚠️ Ids only, never titles. The grid is re-derived from the title index on the client;
-- storing titles here would fork the catalogue and put answer text in a table that gets
-- read by other people's leaderboard queries.
--
-- Rows written before this migration keep '[]' and simply restore without a grid — the
-- score and verdict still come back, which is what stops a replay.

-- ⚠️ TWO arrays, because a TMDB id is not unique on its own. TMDB numbers films and shows
-- in SEPARATE namespaces, so id 550 is both a film and a show, and a grid rebuilt from ids
-- alone would show the wrong title for any guess whose id exists in both. `guess_types`
-- runs parallel to `guesses` (0 = film, 1 = show) and is empty for clients that do not
-- send it — those rows restore with the verdict and score but no grid, which is correct
-- rather than confidently wrong.

ALTER TABLE daily_game_results ADD COLUMN guesses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE daily_game_results ADD COLUMN guess_types TEXT NOT NULL DEFAULT '[]';
