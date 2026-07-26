-- FlickTo accounts — D1 schema (Phase 1: auth + sessions).
--
-- Applied MANUALLY, from worker/share-api/:
--   wrangler d1 execute flickto-accounts --remote --file=src/schema.sql
--
-- There is no migration runner here; later phases append to this file and the
-- command is re-run. Every statement is IF NOT EXISTS so a re-run is a no-op.
--
-- `users.id` is our own opaque id, NEVER the Firebase uid. The uid is a linked
-- attribute in `identities`, which is what keeps the auth provider swappable.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,                 -- opaque 128-bit Crockford base32. NOT the Firebase uid.
  friend_id  TEXT UNIQUE,                      -- existing device friendId; bridges old pairings
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'    -- active | suspended | deleted
);

CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,                    -- 'firebase'
  subject    TEXT NOT NULL,                    -- Firebase uid
  user_id    TEXT NOT NULL REFERENCES users(id),
  email      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                 -- sha256(token) hex. NEVER store the raw token.
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                 -- epoch ms, FIXED 90d. NOT sliding — sliding is a write per request.
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);


-- ── Phase 2: profiles ───────────────────────────────────────────────────────
-- List-shaped fields are JSON. They are never filtered on, and keeping them
-- inline holds a profile fetch to a single row read.
CREATE TABLE IF NOT EXISTS profiles (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  display_name          TEXT,
  avatar_id             TEXT,
  border_id             TEXT,
  picture_url           TEXT,
  header_color          TEXT,
  header_backdrop_url   TEXT,
  layout                TEXT,     -- JSON [{type, config}]
  bio                   TEXT,
  favourite_movies      TEXT,     -- JSON [tmdbId]
  favourite_shows       TEXT,     -- JSON [tmdbId]
  favourite_people      TEXT,     -- JSON [{id, name, profilePath}]
  featured_achievements TEXT,     -- JSON [{id, tier}]
  personality_id        TEXT,
  visibility            TEXT NOT NULL DEFAULT 'friends',  -- private | friends | public
  -- Optimistic concurrency. This is the ENTIRE concurrency story — it replaces
  -- the client's per-field last-write-wins layer. A PUT sends If-Match: <version>
  -- and gets 409 + the current version if it lost the race.
  version               INTEGER NOT NULL DEFAULT 1,
  updated_at            INTEGER NOT NULL
);

-- Split from `profiles` deliberately: derived data, by far the largest field, and
-- rewritten on a different cadence to the user's own edits. Keeps the profile row
-- small for the common read.
CREATE TABLE IF NOT EXISTS profile_stats (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  stats      TEXT,                -- JSON ProfileStatsSnapshot
  updated_at INTEGER NOT NULL
);


-- ── Created in Phase 2, written in Phase 3/4 ────────────────────────────────
-- These exist early on purpose: `canView()` reads them on every foreign profile
-- read, and authorization here FAILS OPEN if a handler forgets to consult it.
-- Writing the check once against real (empty) tables is safer than a Phase 2 stub
-- that has to be swapped out later.
CREATE TABLE IF NOT EXISTS friendships (
  user_a       TEXT NOT NULL,     -- canonical ordering: user_a < user_b (lexicographic)
  user_b       TEXT NOT NULL,
  state        TEXT NOT NULL,     -- pending | accepted
  requested_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
-- The PK covers lookups from the user_a side; this covers the other direction.
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b, state);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
