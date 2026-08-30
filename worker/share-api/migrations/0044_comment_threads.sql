-- Replies. `0003_comments.sql` opened with "Flat, no threads" and gave the reason:
-- "replies multiply the moderation surface and can be added later; un-threading
-- later means discarding user content." This is that later.
--
-- The shape is copied from the commsuni.tv archive **field for field**, not
-- invented, because the merged feed renders both layers through ONE renderer. A
-- native model that differed by even a field name would force that renderer to
-- branch on source, which the partner guide explicitly warns against.
--
-- Two parent columns, and they are NOT redundant:
--   `parent_id`      — structural placement. What the thread groups by.
--   `in_reply_to_id` — who was actually answered. Differs from `parent_id` exactly
--                      when a deeper reply is flattened up into the display level,
--                      and it is what "replying to X" labels, mentions,
--                      notifications and jump-to-target all read.
-- Storing only one loses information that cannot be recovered.
--
-- Depth is capped at 2 and flattened SERVER-side: a reply to a depth-2 comment is
-- stored at depth 2 under the same `parent_id`, with `in_reply_to_id` naming what
-- the user actually tapped. Clients post to whatever was tapped and render what
-- comes back.
ALTER TABLE comments ADD COLUMN parent_id      TEXT;
ALTER TABLE comments ADD COLUMN in_reply_to_id TEXT;
ALTER TABLE comments ADD COLUMN root_id        TEXT;
ALTER TABLE comments ADD COLUMN depth          INTEGER NOT NULL DEFAULT 0;

-- ⚠️ A MAINTAINED column, never a correlated subquery. Counting replies per row on
-- every page read would multiply the cost of the hottest query in the product —
-- the same reasoning that made `comment_counts` exist before it was dropped in
-- 0013, except this one is genuinely read.
ALTER TABLE comments ADD COLUMN reply_count    INTEGER NOT NULL DEFAULT 0;

-- Structured `{authorId, start, end, text}` spans, capped at 3. Rendering reads
-- the spans — NEVER a regex over the body. Without them our mirrored replies reach
-- other partner apps as plain "@name" text they will render as ordinary prose.
ALTER TABLE comments ADD COLUMN mentions_json  TEXT;

-- Serves the replies endpoint: children of one parent, oldest first (a thread
-- reads in the order it was written, unlike the top-level list).
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id, created_at);

-- Every pre-existing comment is a top-level comment whose root is itself. Set
-- explicitly rather than left NULL so `root_id` can be relied on without a
-- COALESCE at every read site.
UPDATE comments SET root_id = id WHERE root_id IS NULL;
