-- Flickology's stored score is SIX STARS, not a percentage.
--
-- `orderScore` answered `round(100 * (1 - places / 12))`, which for the seven reachable
-- boards gives 100/83/67/50/33/17/0. Those numbers are arithmetically right and read as
-- arbitrary: 67 gives a player no way to tell it is the third rung of seven rather than a
-- fraction of something. The game now scores 6..0 stars, one per rung.
--
-- ## Why the rows have to move too
--
-- `score` is not display-only. It is SUMmed into daily_game_stats.total_score and it is
-- what the per-game leaderboard orders by (see boardQuery). Leaving the old rows alone
-- would put every player who played before this deploy on a 0..100 scale and everyone
-- after on a 0..6 one, in the same all-time column -- so three early days would outrank
-- any amount of later play, permanently, and nothing would look broken enough to notice.
--
-- ## The rescale is exact, not approximate
--
-- guess_count holds PLACES OUT for this game (see verifyOrder), places out is always even,
-- and the mapping is stars = (12 - places) / 2 for a five-card board. Every stored value
-- is therefore recoverable from guess_count alone -- the old score is not read at all, so
-- this is idempotent and safe to re-run.
--
-- ⚠️ Bounded to five-card boards. Every published Flickology has been five cards and
-- MAX_PICKS caps it there, but a row from a longer board would have a different worst
-- case and the arithmetic below would not describe it. Those rows are left as they are
-- rather than silently rescaled on the wrong denominator.
UPDATE daily_game_results
   SET score = MAX(0, (12 - guess_count) / 2)
 WHERE game = 'flickology'
   AND guess_count BETWEEN 0 AND 12;

-- daily_game_stats is a rollup of the rows above, so it has to be rebuilt from them
-- rather than rescaled on its own. recomputeStats would do this per player on their next
-- submission, but a player who never comes back would keep a total from the old scale for
-- as long as the all-time board exists.
UPDATE daily_game_stats
   SET total_score = (
         SELECT COALESCE(SUM(r.score), 0)
           FROM daily_game_results r
          WHERE r.user_id = daily_game_stats.user_id
            AND r.game = 'flickology'
       )
 WHERE game = 'flickology';
