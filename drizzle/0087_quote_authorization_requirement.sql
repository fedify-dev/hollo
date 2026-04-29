-- An earlier draft of 0086 added "quote_approval_policy" as
-- DEFAULT 'public' NOT NULL, then this migration dropped NOT NULL and rewrote
-- cached remote public rows to NULL.  That was too expensive on large "posts"
-- tables and still could not distinguish old legacy remote posts from cached
-- FEP-044f posts that really advertised a public quote policy.
--
-- Since 0086 and 0087 are unreleased and will be applied together, 0086 now
-- creates the final nullable column shape directly, backfills only local posts,
-- and leaves existing remote rows NULL.  Keep this cheap DROP NOT NULL for
-- databases that already applied the earlier 0086 draft but not 0087, so they
-- can still accept NULL for newly persisted legacy remote posts.
ALTER TABLE "posts"
ALTER COLUMN "quote_approval_policy" DROP NOT NULL;
