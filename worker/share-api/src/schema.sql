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
