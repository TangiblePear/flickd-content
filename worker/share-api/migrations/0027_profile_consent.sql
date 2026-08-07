-- Consent moves server-side.
--
-- ProfileSyncRepository reads two DataStore settings — socialProfileConsentAt
-- and publicSensitiveConsentAt — and applies them ON THE DEVICE at publish.
-- Filtering happens here now, so the server needs them. Until this migration
-- the web had to INFER them from what was already published, which is a guess
-- dressed as a value.
--
-- NOT in user_settings.payload: that column is documented as client-owned
-- preference keys, and a privacy decision must not depend on a key a client
-- might omit.
ALTER TABLE profiles ADD COLUMN friend_sensitive_consent_at INTEGER;
ALTER TABLE profiles ADD COLUMN public_sensitive_consent_at INTEGER;

-- Back-fill from the evidence already in the row. This is the same inference
-- the web shipped on 2026-08-07, and against stored data it is exact rather
-- than approximate:
--
--   friend consent  <= friend_layout contains a SENSITIVE block
--                      (currently_watching, top_rated, recent_activity)
--   public consent  <= public_layout contains a block that is not publicVisible
--                      (stat_mosaic, genre_dna, wrapped, streak, and the three
--                       sensitive ones)
--
-- A false negative only withholds; it can never publish more than is already
-- published. 1 is a truthy sentinel — the real grant time is unknown and must
-- not be invented. The app overwrites it with the true timestamp on its next
-- publish, which is also how you tell the two apart.
UPDATE profiles SET friend_sensitive_consent_at = 1
WHERE friend_sensitive_consent_at IS NULL
  AND friend_layout IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(profiles.friend_layout)
    WHERE json_extract(value, '$.type') IN ('currently_watching','top_rated','recent_activity')
  );

UPDATE profiles SET public_sensitive_consent_at = 1
WHERE public_sensitive_consent_at IS NULL
  AND public_layout IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(profiles.public_layout)
    WHERE json_extract(value, '$.type') IN (
      'stat_mosaic','genre_dna','wrapped','streak',
      'currently_watching','top_rated','recent_activity'
    )
  );
