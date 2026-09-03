-- The Grid became FlickGrid, so its picks table follows.
--
-- ## Why this is a new migration and not an edit to 0053
--
-- 0053 was renamed in place first, on the belief that it had never been applied. That
-- belief came from a note, not from `wrangler d1 migrations list --remote`, and it was
-- wrong to act on: D1 records applied migrations BY FILENAME and never re-runs one, so
-- renaming an applied migration does two bad things at once. The old name stays recorded,
-- and the new filename looks like a fresh migration — which would have run
-- `CREATE TABLE IF NOT EXISTS daily_game_flickgrid_picks` against a database that already
-- had the data under the old name, quietly leaving an empty table beside a populated one
-- and no error anywhere.
--
-- ## This file is correct whichever is true
--
-- Already applied: 0053 is skipped, and this renames the existing table in place, keeping
-- whatever rows are in it.
-- Never applied:   0053 runs first (same invocation, filename order), creating the table
--                  under the old name, and this immediately renames it.
--
-- ⚠️ SQLite carries a table's indexes through a RENAME but keeps their old NAMES, so the
-- index is dropped and recreated rather than left as idx_grid_picks_cell on a table that
-- no longer goes by that name.
ALTER TABLE daily_game_grid_picks RENAME TO daily_game_flickgrid_picks;

DROP INDEX IF EXISTS idx_grid_picks_cell;
CREATE INDEX IF NOT EXISTS idx_flickgrid_picks_cell ON daily_game_flickgrid_picks(date, cell);
