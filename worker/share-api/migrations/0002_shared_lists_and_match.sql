-- Shared lists and Friend Match, moved off the E2EE inbox and into D1.
--
-- These are the last two directed-message types on the relay that have no
-- server-side home (friend handshakes are already duplicated by /api/friends/*,
-- and opinions history is covered separately). Once both live here and sign-in is
-- enforced, the inbox has no users — and the inbox is where every remaining
-- chargeable request lives, because its cost is on the WRITE side (ack,
-- publishAccess, the relay profile PUT) rather than the reads that already fold
-- into POST /api/sync.
--
-- In D1 there is no ack at all: the row's `state` column IS the convergence, read
-- idempotently by every device on the next sync. That whole request class goes.
--
-- Conventions follow 0001: opaque Crockford ids, `user_id` foreign keys that are
-- never Firebase uids, `created_at` in epoch ms.

-- ── Shared lists ────────────────────────────────────────────────────────────
-- Server-readable, unlike the sealed inbox message this replaces. The promise
-- becomes "only your friends can see this", enforced by a friendship check, not
-- "not even we can" — the same trade already accepted for comments. A list is
-- tmdbIds plus a title, so low sensitivity, but it is content the user authored
-- and it is therefore reportable, which E2EE cannot support.
--
-- `id` is minted by the SENDER, not here. Both the D1 row and the inbox message
-- carry the same id while the dual path is live, so the client's existing upsert
-- de-dupes an item that arrives on both transports for free. Minting a server id
-- would produce two rows and render the share twice.
CREATE TABLE IF NOT EXISTS shared_lists (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'manual',   -- manual | smart
  item_count   INTEGER NOT NULL DEFAULT 0,
  payload      TEXT NOT NULL,            -- JSON [{tmdbId, mediaType}] or a smart filter blob, capped
  created_at   INTEGER NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending'   -- pending | accepted | declined
);
-- The only read: "what has been shared with me", newest first.
CREATE INDEX IF NOT EXISTS idx_shared_lists_recipient
  ON shared_lists(recipient_id, state, created_at DESC);


-- ── Friend Match ────────────────────────────────────────────────────────────
-- The handshake is plaintext; the taste vector is NOT (see match_payloads). The
-- server gains who asked whom, when, and in what state — the friend graph it
-- already holds, plus an edge type — and nothing else.
CREATE TABLE IF NOT EXISTS match_requests (
  id           TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  state        TEXT NOT NULL,                    -- pending | accepted | declined | revoked
  -- 'friend' | 'scan'. A scan match is between two people who are NOT friends —
  -- someone scanned a code in a pub and wants to compare taste without either
  -- committing to a friendship. It forces retention='once'.
  origin       TEXT NOT NULL DEFAULT 'friend',
  retention    TEXT NOT NULL DEFAULT 'keep',     -- once | keep
  -- The requester's PUBLIC keyset, so the target can seal their half back.
  --
  -- Not derivable server-side for a scan match: the target has no friend row for a
  -- stranger, so nothing on their device holds the key to seal to. Safe to store —
  -- it is the same public keyset already published under the shareable friend code,
  -- and it is a sealing key, never an opening one.
  requester_keyset TEXT NOT NULL DEFAULT '',
  anchor_at    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- One row per direction makes re-requesting idempotent — the same property that
-- made `friendships` a primary-key hit rather than a scan. Today a duplicate
-- request is possible and only the client de-dupes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_pair
  ON match_requests(requester_id, target_id);
CREATE INDEX IF NOT EXISTS idx_match_target
  ON match_requests(target_id, state);
-- The requester's own "what did I ask for" read; without it that is a table scan.
CREATE INDEX IF NOT EXISTS idx_match_requester
  ON match_requests(requester_id, state);

-- Taste vectors, SEALED. The server stores and deletes these but can never read
-- them: each row is `SocialCrypto.seal`ed to exactly one recipient's public
-- keyset. Two rows per accepted match, one per direction.
--
-- E2EE was rejected for comments because encrypting to a MUTABLE audience drags
-- along the key-rotation machinery that caused the first-pairing bootstrap
-- deadlock. A match is exactly two people, fixed at accept time — no audience to
-- rotate, so that objection does not apply, and taste vectors are the most
-- revealing thing in the app.
--
-- A separate table rather than a column on match_requests for two reasons: the
-- handshake is read on every sync and the blob is not, and retention='once'
-- deletes the payload while the handshake row survives as the record that a match
-- happened.
CREATE TABLE IF NOT EXISTS match_payloads (
  request_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,            -- who sealed it
  sealed      TEXT NOT NULL,            -- ciphertext, capped
  created_at  INTEGER NOT NULL,
  fetched_at  INTEGER NOT NULL DEFAULT 0,   -- 0 = not yet collected by the other side
  PRIMARY KEY (request_id, sender_id)
);
