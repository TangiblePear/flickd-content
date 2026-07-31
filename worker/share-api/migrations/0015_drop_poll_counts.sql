-- Poll totals and per-option shares are now derived from episode_votes on read
-- (see loadPoll), protected by the 60s edge cache. Add a subject index so the
-- aggregate scan is bounded, then drop the two materialised counter tables.
CREATE INDEX IF NOT EXISTS idx_votes_subject
  ON episode_votes (tmdb_id, media_type, season, episode);

DROP TABLE IF EXISTS episode_vote_counts;
DROP TABLE IF EXISTS episode_option_counts;
