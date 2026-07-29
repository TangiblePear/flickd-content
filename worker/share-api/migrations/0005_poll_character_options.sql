-- Make the poll's favourite-character option CHARACTER-level, not person-level.
--
-- 0004 stored the favourite as a bare person id. Two things were wrong with that:
--
--   1. One performer voices several characters. Every vote for any of them landed in
--      one bucket keyed on the person, so "three characters, one voice actor" could
--      not be scored separately -- and the client, having to pick a label for that
--      bucket, named it after whichever character happened to sort first in the cast
--      list. You could vote for Nelson and be shown "Bart Simpson - 100%".
--
--   2. The id was not source-qualified. Episode cast comes from Trakt (which relays a
--      TMDB person id) for live action, and from TVMaze (its own person ids) for
--      animated shows, chosen at load time by whether character images exist. Two
--      namespaces in one column, indistinguishable after the fact.
--
-- The replacement is one opaque, source-qualified text key per option:
--
--   TVMAZE:c14839   a TVMaze CHARACTER id -- available exactly where it is needed
--   TMDB:p9999      a TMDB person id, where no character id exists (live action, 1:1)
--
-- The client validates and mints these; see `pollOptionId()`. `episode_option_counts`
-- already stores `option_id` as TEXT, so only the vote row's column changes.
--
-- EXISTING FAVOURITE DATA IS DISCARDED, deliberately. A stored integer carries no
-- record of which namespace produced it, so it cannot be rewritten correctly -- and a
-- wrong guess would attribute a vote to the wrong performer permanently, with nothing
-- to detect it by. Ratings and emotions are untouched: they were never ambiguous.
--
-- Owner decision, 2026-07-29: the feature had not reached a device, so the only rows
-- this can affect are test votes.

-- Retire the person-level column. SQLite 3.35+ (D1 is well past it) supports DROP
-- COLUMN; the column is not in the primary key and carries no index, so this is a
-- plain rewrite.
ALTER TABLE episode_votes DROP COLUMN favourite_person_id;

-- Opaque and source-qualified. NULL still means "no pick" -- unchanged.
ALTER TABLE episode_votes ADD COLUMN favourite_option_id TEXT;

-- The counters derived from the discarded column have to go with it, or every
-- percentage would be divided into a denominator that still counts votes no vote row
-- claims. Emotion counts are keyed on their own ids and stay.
DELETE FROM episode_option_counts WHERE kind = 'person';

-- n_voters is deliberately NOT adjusted. A voter who picked only a favourite is still
-- a voter -- they voted, the pick was simply recorded in a form we can no longer read.
-- Decrementing here would desync the totals from the vote rows that are still present.
