-- Push topics on the account, replacing the friendId-keyed `{friendId}/push.json`
-- R2 object (step 2 of the friendId retirement).
--
-- Columns on `users` rather than an R2 object keyed on `users.id`, because
-- `notifyAccount` — the path EVERY directed push takes — already reads this row to
-- resolve `friend_id`. Putting the topics here makes the push lookup part of a query
-- that was happening anyway: it deletes the friendId hop AND an R2 read from every
-- friend request, match, share, comment and poll notification. Worker subrequests are
-- the binding constraint on the free plan, so that is the whole point.
--
-- NULL = this account has never published push topics. That is normal for a brand-new
-- account and for any device still on the relay path, so readers MUST fall back to the
-- R2 record rather than treating null as "unreachable".
ALTER TABLE users ADD COLUMN push_self_topic TEXT;
ALTER TABLE users ADD COLUMN push_friend_topic TEXT;
