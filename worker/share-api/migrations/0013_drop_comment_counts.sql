-- comment_counts was write-only (never read by the worker or any client). Every
-- comment post/edit/delete/hide and account deletion wrote to it, but nothing ever
-- SELECTed it. Safe to drop entirely.
DROP TABLE IF EXISTS comment_counts;
