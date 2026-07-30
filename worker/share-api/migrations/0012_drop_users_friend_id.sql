-- Step 8c-3 of the friendId retirement: drop the device friendId from `users`.
--
-- The column bridged two id spaces while pairing, pictures, push and friend codes all
-- addressed a device rather than an account. Every one of those has moved:
--   * push topics are columns on this table (step 2)
--   * pictures are keyed on `users.id` (step 3)
--   * friend codes are `users.friend_code` (step 4)
--   * pairing, blocks and the graph are D1 rows keyed on `users.id`
--   * `social_friends` is keyed on `users.id` client-side (step 8b)
--
-- ⚠️ A PLAIN `ALTER TABLE users DROP COLUMN friend_id` DOES NOT WORK, and the first
-- version of this migration tried it. SQLite refuses with
-- `cannot drop UNIQUE column: "friend_id"` because the constraint is declared INLINE
-- (`friend_id TEXT UNIQUE`), not as a separate index — dropping an index first does
-- not help, and there was no separate index to drop. So this is a table rebuild.
--
-- ⚠️ EIGHT TABLES CARRY `REFERENCES users(id)`: identities, sessions, profiles,
-- profile_stats, feed_events, comments, comment_reactions, episode_votes. None uses
-- ON DELETE CASCADE — checked, so there is no cascade-delete risk.
--
-- ⚠️ `defer_foreign_keys` IS NOT ENOUGH, and the second attempt failed on that. It
-- postpones ROW-level checks to commit; dropping a parent table that eight tables
-- reference is a SCHEMA violation deferral does not cover, so the commit reported
-- "the application left the database in a state where constraints were violated".
-- Reproduced in a local SQLite loaded with this exact schema, where all three were
-- tried: `defer_foreign_keys` FAILS, `foreign_keys=OFF` re-asserted per statement
-- FAILS, and `foreign_keys=OFF` held across the whole file SUCCEEDS with the column
-- gone, zero `foreign_key_check` violations and the UNIQUE index intact.
--
-- ⚠️ WHAT DROPPING THE COLUMN COSTS, recorded because it is a real trade.
--
-- `handleGetFriendCards` compared the friend card's self-declared `friendId` against
-- this column before returning it. The card blob is CLIENT-WRITTEN, so that
-- comparison was the only thing stopping a client publishing a card that asserts
-- somebody else's friendId. Nothing verifies it now.
--
-- Bounded: `social_friends.friendId` carries a UNIQUE index since 8b, so a spoofed
-- duplicate fails an insert on the victim's device rather than impersonating anyone.
-- It needs a hostile client, and it closes when the client stops trusting the card's
-- friendId at all — the friendId→userId migration now underway (M1, M2 landed).
--
-- NB the behavioural half of 8c-3 is already live without this: no deployed code
-- reads `friend_id`. This migration only reclaims the column.
PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  posting_suspended_until INTEGER,
  push_self_topic TEXT,
  push_friend_topic TEXT,
  friend_code TEXT
);

INSERT INTO users_new (id, created_at, status, posting_suspended_until,
                       push_self_topic, push_friend_topic, friend_code)
SELECT id, created_at, status, posting_suspended_until,
       push_self_topic, push_friend_topic, friend_code
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Recreate what the old table carried. ⚠️ `idx_users_friend_code` is UNIQUE and MUST
-- be recreated that way: a plain index here would silently let two accounts hold the
-- same friend code, and the first symptom would be a shared code resolving to the
-- wrong person. `friend_id`'s UNIQUE auto-index (sqlite_autoindex_users_2) goes with
-- the column, which is the point of the rebuild.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code);
