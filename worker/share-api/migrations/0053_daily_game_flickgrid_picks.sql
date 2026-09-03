-- FlickGrid: what everyone picked, so a pick can be scored by how rare it was.
--
-- ── Why a counter table here, when poll totals are derived on read ─────────────────────
--
-- Every other total in this schema is a GROUP BY over the rows it describes, deliberately:
-- erasing an account then removes its contribution automatically, with no counter to
-- unpick. That works because those rows are keyed on a user.
--
-- These are not. A rarity figure has to count ANONYMOUS players too -- the Grid is
-- ungated and most of the traffic never signs in -- and an anonymous pick has no row to
-- group. The same reasoning that put daily_game_anon_distribution in 0032 puts this here,
-- and it inherits that table's erasure position exactly: it holds no user id and nothing
-- attributable to anyone, so there is nothing in it to erase, and subtracting from a
-- historical total would corrupt the series rather than protect anybody. It is absent
-- from eraseAccount ON PURPOSE.
--
-- ── The key is (date, cell, title) ────────────────────────────────────────────────────
--
-- `cell` is 0..8 in reading order, and it is part of the key because the same title in a
-- different square is a different answer: naming an obvious film for a hard cell is not
-- the same move as naming it for an easy one, and collapsing the two would make every
-- rarity figure a average across squares that have nothing to do with each other.
--
-- `type` is in the key alongside `tmdb_id` because TMDB numbers films and shows
-- separately, so an id alone is not a title.

CREATE TABLE IF NOT EXISTS daily_game_flickgrid_picks (
  date    TEXT    NOT NULL,   -- YYYY-MM-DD, UTC, matches the published puzzle
  cell    INTEGER NOT NULL,   -- 0..8, reading order
  tmdb_id INTEGER NOT NULL,
  type    INTEGER NOT NULL,   -- 0 = film, 1 = show
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, cell, tmdb_id, type)
);

-- Rarity is `this title's count / everything played in this cell today`, so every read
-- starts from (date, cell) and sums. Without this it scans the whole table.
CREATE INDEX IF NOT EXISTS idx_flickgrid_picks_cell ON daily_game_flickgrid_picks(date, cell);
