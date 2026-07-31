-- Reaction counts are now derived from comment_reactions via COUNT + GROUP BY
-- (see loadReactionCounts / notifyReaction). Add a covering index so the aggregate
-- is an index-only scan, then drop the materialised counter table.
CREATE INDEX IF NOT EXISTS idx_reactions_count
  ON comment_reactions (comment_id, emoji);

DROP TABLE IF EXISTS comment_reaction_counts;
