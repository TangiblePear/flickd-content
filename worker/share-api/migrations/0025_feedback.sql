-- In-app feedback: the first channel that actually reaches us.
--
-- Until now "Submit Feedback" was a debug-only `mailto:` intent, so a release user had
-- no way to say anything at all and nothing was ever recorded. This is the store behind
-- the form in Settings › About & Help and the queue in the admin panel.
--
-- D1 rather than R2, and this is NOT the case the "D1 is not for bulk per-entity user
-- data" rule is about: that rule is about per-watch-event volume. Feedback is a handful
-- of small rows a day, every one of them read by a human, filtered and sorted by state
-- and topic — which is a database, not an object store.

CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  -- NULL when the sender was signed out, which is allowed on purpose: the people most
  -- likely to have something to say about onboarding are the ones who never finished it.
  -- No REFERENCES users(id) for the same reason — there may be no row to point at.
  user_id      TEXT,
  topic        TEXT NOT NULL,             -- bug | idea | content | sync | account | other
  message      TEXT NOT NULL,             -- truncated to 2000 chars server-side
  contact      TEXT,                      -- optional reply address, truncated to 200

  -- Device context, sent only when the user leaves "Include app details" on. All
  -- nullable, and the form shows exactly these fields before it sends them.
  platform     TEXT,
  app_version  TEXT,
  version_code INTEGER,
  device       TEXT,
  os_version   TEXT,
  locale       TEXT,

  state        TEXT NOT NULL DEFAULT 'new',   -- new | triaged | closed
  admin_note   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER
);

-- The queue: one state at a time, newest first.
CREATE INDEX IF NOT EXISTS idx_feedback_state ON feedback(state, created_at DESC);
-- Account erasure deletes by sender (see handleDeleteAccount in src/friends.ts).
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id);
