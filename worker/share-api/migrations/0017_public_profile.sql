-- The public profile layout and stats — what a NON-FRIEND sees.
--
-- A third layout column, for the same reason 0010 split `friend_layout` off `layout`:
-- one column cannot honestly serve two audiences. `friend_layout` was filtered under a
-- consent the user gave for FRIENDS. Serving it to strangers would reuse that consent for
-- a wider audience, which is precisely the bug 0010 exists to prevent.
--
-- NULL means "this client predates the field", NOT "no blocks". A public profile with a
-- NULL public_layout renders identity-only. It must NEVER fall back to friend_layout —
-- that would show strangers the friend-scoped set, which is the whole point of the split.
ALTER TABLE profiles ADD COLUMN public_layout TEXT;

-- The stats a NON-FRIEND sees. Layout-scoped exactly like `stats`, but built from the
-- public block set, so the behavioural rails are absent rather than present-and-unrendered.
--
-- This column is why the layout split is not sufficient on its own. `handleGetProfile`
-- returned `stats` to anyone who passed canView, so a stranger's client would have received
-- topRated / currentlyWatching / recentWatches in the JSON even though its layout hid them.
-- Security would then rest on the viewer's renderer, which is the fail-open shape authz.ts
-- is written to avoid.
ALTER TABLE profile_stats ADD COLUMN public_stats TEXT;
