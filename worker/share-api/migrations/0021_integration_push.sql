-- Phase 3: server-COORDINATED, device-EXECUTED push to Trakt / SIMKL.
--
-- ## The property this buys, and the one thing it must not break
--
-- Today every device pushes its own writes to Trakt directly. With one device that is
-- fine; with two it is a duplicate-generator, because both push the same watch and Trakt
-- records it twice. The server cannot push on its own behalf — that would mean holding a
-- user's Trakt OAuth token, which is exactly what this design refuses — so instead the
-- server decides WHAT needs pushing and WHICH device is doing it, and the device performs
-- the call with the token it already has locally.
--
-- **No third-party credential ever reaches this Worker.** If a future change makes it
-- convenient to store one here, that is a redesign, not an optimisation.

-- ── Which integrations an account has connected ─────────────────────────────
--
-- The server needs this to know whether a push is owed at all; it cannot see the device's
-- settings. Registered by the client when the user connects or disconnects, so a stale
-- row means at worst a job nobody claims (harmless — it expires and is swept).
CREATE TABLE IF NOT EXISTS user_integrations (
    user_id    TEXT    NOT NULL REFERENCES users(id),
    target     TEXT    NOT NULL,               -- 'TRAKT' | 'SIMKL'
    connected  INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, target)
) WITHOUT ROWID;


-- ── The work queue ──────────────────────────────────────────────────────────
--
-- One row per SYNC BATCH per connected target — never one per event. A 20,000-event
-- import at the 5,000-event batch cap produces four rows, not twenty thousand.
--
-- `event_ids` is a JSON array of canonical client ids. The ids alone are enough: every
-- device holds the full history in Room, and the id encodes the title, season, episode
-- and watch second. Carrying the payload would duplicate data the executing device
-- already has, and would go stale if the event changed before the push ran.
CREATE TABLE IF NOT EXISTS pending_integration_push (
    id         TEXT    NOT NULL,
    user_id    TEXT    NOT NULL REFERENCES users(id),
    target     TEXT    NOT NULL,
    action     TEXT    NOT NULL DEFAULT 'ADD', -- 'ADD' | 'REMOVE'
    event_ids  TEXT    NOT NULL,
    -- The device that took the job, and when. A claim EXPIRES: a device that goes offline
    -- mid-push must not strand the work forever, so after the timeout another device may
    -- take it. That is also why the executing device confirms rather than the server
    -- assuming success.
    claimed_by TEXT,
    claimed_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
) WITHOUT ROWID;

-- The only query this table serves: "what is owed for this account, oldest first".
-- Claim state is filtered in the WHERE clause rather than indexed — the row count per
-- user is tiny, and a second index would be a write on every queued job for a scan of
-- single figures.
CREATE INDEX IF NOT EXISTS idx_pip_user_created ON pending_integration_push(user_id, created_at);
