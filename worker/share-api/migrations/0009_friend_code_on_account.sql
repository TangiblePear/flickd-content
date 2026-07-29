-- Step 4 of the friendId retirement: the friend code's owner pointer moves to D1.
--
-- Two objects, and only ONE of them is moving. The public card stays at
-- `fc/{code}.json`, keyed on the code — that is what a scanner holds, and printed QR
-- codes, shared links and codes people have written down must keep resolving. What
-- moves is the reverse pointer, `{friendId}/friendcode.json` → `{c: code}`, which is
-- the only reason looking up an account's own code needs a friendId at all.
--
-- ⚠️ The CODE VALUE IS PRESERVED. Nothing here mints a new one. `handlePublishFriendCode`
-- backfills this column from the legacy R2 pointer the first time an account republishes,
-- so an existing code is adopted rather than replaced. Minting a fresh code for someone
-- who already has one would silently break every link and QR code they have shared.
ALTER TABLE users ADD COLUMN friend_code TEXT;

-- Unique because two accounts resolving from one code is a pairing sent to the wrong
-- person. SQLite permits many NULLs under a unique index, which is what the not-yet-
-- published case needs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_code ON users(friend_code);
