-- The admin Users panel: a comped entitlement, and a record of who did what.
--
-- ── premiere_comp_until ──
--
-- A SECOND entitlement column, deliberately not a write to `premiere_until`.
--
-- `premiere_until` belongs to `handleVerifyPremiere` (premiere.ts), which is its only
-- writer and which stores whatever the Play Developer API reports — INCLUDING 0, on a
-- refund, a cancellation, or a token Play has never heard of. An admin grant written
-- there is not merely at risk of being overwritten; it is overwritten by design, because
-- the whole point of that handler is that Google's answer wins.
--
-- ⚠️ What makes this worth a column rather than a comment is that the failure is
-- SELECTIVE, so testing would not have found it. `PremiereVerifier.reconcile` on Android
-- returns early when the device holds no purchase token, so a comp written to
-- `premiere_until` survives indefinitely for someone who has never subscribed — which is
-- exactly who you comp — and is wiped for anyone who has. It would have worked on the
-- test account and failed in the wild. The `forget()` path makes it worse: it clears the
-- local marker the moment Play reports no active subscription, forcing a verify that
-- writes 0 over the grant.
--
-- Read through `isPremiere`, which now takes the MAX of the two columns. An expiry rather
-- than a boolean for the same reason as 0028: it expires itself, so there is no cron to
-- forget to run and no second state to reconcile. Permanent is expressed as
-- PERMANENT_UNTIL (4102444800000), the same sentinel the posting suspension uses.
--
-- ⚠️ A comp NEVER stamps `premiere_since`. That column's `CASE WHEN premiere_since = 0`
-- guard fires exactly once and is unrecoverable afterwards — once a subscription lapses
-- there is no way to learn when it began. A comp that stamped it would permanently
-- destroy the answer for a later real purchase, recording the date we gave someone a
-- freebie as the date they started paying.
ALTER TABLE users ADD COLUMN premiere_comp_until INTEGER NOT NULL DEFAULT 0;


-- ── admin_actions ──
--
-- Nothing recorded any admin action before this. Moderation has been able to hide
-- comments, take down pictures and suspend posting since 0006, and every one of those
-- decisions vanished the moment it was made: the panel could show that someone WAS
-- suspended, never that anyone suspended them, when, for how long, or why. A signal not
-- collected cannot be backfilled, which is why this lands with the panel that writes it
-- rather than after.
--
-- ⚠️ `actor` is SELF-DECLARED and is not proof of identity. The admin surface is one
-- shared password (`ADMIN_PASSWORD`, checked in flickto-web's functions/admin/_middleware.ts,
-- which ignores the username entirely), so anyone holding it can type any name they like.
-- What this column buys is DISTINGUISHING one operator from another when they use
-- different names — useful, and honest about being useful only by convention. Treating it
-- as authentication would be a mistake; it is a label, not a credential. '' or 'unknown'
-- when the header is absent.
--
-- `target_id` is a `users.id` and is deliberately NOT a foreign key. The `delete` action
-- erases the row it names, and a record that disappears with its subject is not a record
-- of the deletion — it is the deletion happening twice. Same reasoning as `reports`, which
-- retains dangling ids for the same reason.
--
-- Erasure: `handleDeleteAccount` does NOT clear this table, and that is the point. See the
-- note in the batch in friends.ts.
CREATE TABLE IF NOT EXISTS admin_actions (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  -- ban | unban | signout | suspend | unsuspend | comp_grant | comp_revoke |
  -- beta_grant | delete | device_delete
  --
  -- Free text, unvalidated, like `lists.kind`: the panel owns this vocabulary, and a new
  -- control must be able to record itself without a migration first. An unknown verb in
  -- the history reads as itself, which is strictly better than a control that acts
  -- without leaving a trace because nobody added an enum value.
  action     TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  -- JSON. Whatever the action needs to be reconstructible after the fact:
  -- {durationMs, until} for a suspension, {deviceId, lastSeenAt} for a device delete,
  -- {reason} whenever one was given. Not columns, for 0016's reason — the panel gains a
  -- field without a migration, and none of this is ever filtered on.
  detail     TEXT,
  created_at INTEGER NOT NULL
);

-- The detail pane reads one target's history, newest first. This is the only access
-- pattern, and the table is append-only and small.
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_id, created_at DESC);
