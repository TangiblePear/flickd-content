-- Step 3 of the friendId retirement: repoint stored picture URLs at the
-- account-keyed route.
--
-- `profiles.picture_url` is a STORED absolute URL, not a template, so moving the
-- endpoint is a data migration rather than a route change. Friends read this column
-- directly (comments.ts joins it into every author header), so a row left on the old
-- form keeps working only for as long as the legacy route survives.
--
-- ⚠️ ORDER MATTERS. The R2 objects must be copied to `accounts/{userId}/picture.jpg`
-- BEFORE this runs. Rewriting the URL first points every reader at a key that does not
-- exist yet, and the symptom is a broken avatar with a 404 nothing logs. Measured
-- before writing this: exactly one row is affected.
--
-- Only rows in the exact old shape are touched — `?v=` is required, since the version
-- query string is what busts Coil's immutable cache when a picture changes, and a URL
-- rewritten without it would serve the previous image from cache forever.
UPDATE profiles
   SET picture_url = 'https://flickto.app/api/profile/' || user_id || '/picture?v=' ||
                     substr(picture_url, instr(picture_url, '?v=') + 3)
 WHERE picture_url LIKE 'https://flickto.app/api/user/%/picture?v=%';
