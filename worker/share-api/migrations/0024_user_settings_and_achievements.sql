-- Portable preferences and portable achievements.
--
-- Signing in on a new device restored the profile, the friend graph and the watch
-- history, but nothing the user had actually SET UP: theme, accent, language, media
-- filter, anime toggle, release-year floor, excluded genres, selected networks, region
-- and gender were all local-only. So a second phone landed on the default theme with no
-- networks, and onboarding had to ask for every one of them again. Achievements were
-- worse than absent — `achievement_unlocks` is device-local and STICKY, so a new device
-- recomputed from scratch and showed FEWER badges than the old one (measured: 41 on the
-- phone, 33 on the tablet).
--
-- ── Why two tables and not columns on `profiles` ────────────────────────────────
--
-- `profiles` is served to non-owners through `toWireForeign`. Anything added there is one
-- forgotten filter away from leaking to a friend or a stranger. Neither table below has a
-- `canView` path at all — the only route to either row is the owner's own session — which
-- makes the privacy boundary structural rather than remembered.
--
-- Gender is the reason this matters concretely. It is not a social field and must never
-- sit on a row that friend-facing code reads.
--
-- ── Why JSON blobs and not columns ─────────────────────────────────────────────
--
-- Neither payload is ever filtered or queried on, so one row read serves the whole thing
-- and adding a preference later is a client-only change with no migration. That is the
-- OPPOSITE of `profiles`, whose columns exist precisely because different audiences read
-- different subsets of them.
--
-- One small row per user each. This is not the bulk per-entity shape that D1 is the wrong
-- store for — that lesson produced the R2 history document, and it still holds: if either
-- payload ever grows per-event, it belongs in R2, not here.
--
-- ── Why two tables and not one ─────────────────────────────────────────────────
--
-- Settings are written whenever a preference changes; achievements whenever a badge is
-- earned. Sharing a row would mean changing the theme re-uploads the badge list.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  payload    TEXT NOT NULL,                 -- JSON object of client-owned preference keys
  -- Optimistic concurrency, identical to profiles.version: a PUT sends If-Match and gets
  -- 409 + the current version if it lost the race. This is the ENTIRE concurrency story.
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  payload       TEXT NOT NULL,              -- JSON [{id, tier, unlockedAt}]
  -- Which rule set produced `payload`, from AchievementCatalog.RULES_VERSION.
  --
  -- ⚠️ This column is what stops the sync UNDOING a correction. The client holds three
  -- one-shot fixes for badges granted under rules that later changed
  -- (wipeRewatchAchievementsOnce, wipeShareMetricAchievementsOnce,
  -- reconcileRebalancedTiersOnce), each guarded by a PER-DEVICE flag. Without a rules
  -- stamp, a device that had already run a wipe would re-pull the wiped rows from here
  -- and silently reinstate them. A client seeing a stale value must reconcile against
  -- current thresholds and push the corrected set back, so the fix propagates instead.
  rules_version INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);
