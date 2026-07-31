-- Product telemetry: what the fleet is actually running, and what it uses.
--
-- Nothing recorded any of this before. D1 knew accounts, profiles, friendships,
-- comments and reports — but nothing about the app on the device, so questions like
-- "who is still below MIN_SOCIAL_VERSION", "is anyone using Simkl" and "can minSdk
-- rise" had no answer at all. A signal not collected cannot be backfilled, which is
-- why this lands before the panel that reads it.
--
-- Two tables, because they answer two different questions and age differently:
-- `user_telemetry` is current state (one row per device, overwritten daily) and
-- `telemetry_daily` is the trend series (one row per day, immutable once computed).

CREATE TABLE IF NOT EXISTS user_telemetry (
  user_id      TEXT NOT NULL REFERENCES users(id),
  -- Random UUID minted at install and kept in DataStore. NOT a hardware id, NOT an
  -- advertising id, NOT derived from anything — it exists only to keep one account's
  -- two devices from overwriting each other's row.
  --
  -- '' for any client that predates the telemetry block. That is load-bearing: the
  -- header-only write path (below) lands on `(user_id, '')` and therefore can never
  -- collide with, or be suppressed by, a real device's richer row.
  device_id    TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT 'android',

  -- ── Server-derived. Populated even for clients that send no block at all, which
  -- is what makes version and activity data start flowing the moment this deploys
  -- rather than once the next APK has rolled out.
  version_code INTEGER NOT NULL,          -- the `X-App-Version` header; 0 when absent
  country      TEXT,                      -- request.cf.country
  last_seen_at INTEGER NOT NULL,
  -- UTC 'YYYY-MM-DD', computed on the SERVER — a device with a wrong clock must not
  -- be able to skew the day buckets. This is also the once-per-day write guard:
  --   ON CONFLICT(...) DO UPDATE SET ... WHERE user_telemetry.reported_on <> excluded.reported_on
  -- writes zero rows for the rest of the day, so the hottest path in the Worker costs
  -- one write per device per day with no extra read and no cron.
  reported_on  TEXT NOT NULL,

  -- ── Client-sent. All NULL until a build that sends the block reports in, which
  -- makes a non-NULL `version_name` the adoption marker for this whole feature. Do
  -- NOT measure adoption by row count: header-only rows inflate it.
  version_name TEXT,
  build_type   TEXT,
  os_api       INTEGER,                   -- Build.VERSION.SDK_INT
  manufacturer TEXT,
  model        TEXT,
  language     TEXT,                      -- the in-app language setting, not the system locale
  installer    TEXT,                      -- play | sideload | other
  premium      INTEGER,
  gate_outcome TEXT,                      -- consented | paid | refused | not_applicable
  ads_consent  TEXT,                      -- obtained | required | not_required | unknown

  -- JSON, and deliberately not a column per flag. The argument is ordering, not
  -- scale: a column per integration means a migration must be applied BEFORE the
  -- client that sends it ships, and getting that order wrong drops the field
  -- silently. A JSON blob lets the client add a key and the panel add a
  -- json_extract, with no migration between them and no wrong order to get.
  --
  -- json_extract cannot use an index, so the panel's GROUP BYs are full scans. At
  -- this row count that is nothing; revisit somewhere north of ~50k devices.
  --
  -- integrations: {"plex":true,"trakt":true,...,"aiProvider":"gemini"}
  --   Whether a thing is CONFIGURED. Never the token, URL, username or key.
  -- features:     {"used":["discover","catchup",...],"counts":{"watched":412,...}}
  --   `used` is a set of surfaces touched at least once — one write the first time
  --   each is opened and nothing after, which is the cheapest instrumentation that
  --   answers "what can I cut". `counts` are LIFETIME totals, never deltas, so a
  --   lost report costs nothing and the panel diffs consecutive days itself.
  integrations TEXT,
  features     TEXT,

  PRIMARY KEY (user_id, device_id)
);

-- The daily rollup reads one day at a time.
CREATE INDEX IF NOT EXISTS idx_telemetry_day ON user_telemetry(reported_on);
-- Version histogram and the "below MIN_SOCIAL_VERSION" count, which is the number
-- the legacy-relay purge decision actually rests on.
CREATE INDEX IF NOT EXISTS idx_telemetry_version ON user_telemetry(version_code);


-- Trend series. ~365 rows a year, so it is never pruned.
--
-- Holds NO user ids. It is aggregate and non-identifying, which is why account
-- deletion deliberately does not touch it — and why the privacy policy can describe
-- it as retained indefinitely while the per-device rows above are erased.
CREATE TABLE IF NOT EXISTS telemetry_daily (
  day         TEXT PRIMARY KEY,           -- UTC 'YYYY-MM-DD'
  active      INTEGER NOT NULL,           -- COUNT(DISTINCT user_id) that reported
  devices     INTEGER NOT NULL,
  new_users   INTEGER NOT NULL,           -- users.created_at falling inside the day
  -- JSON histograms: version, os_api, country, language, integrations, features,
  -- premium, gate outcomes. One blob for the same reason as above — the panel gains
  -- a series without a migration.
  snapshot    TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
