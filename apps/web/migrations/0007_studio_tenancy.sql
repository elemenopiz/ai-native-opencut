-- Studio tenancy: per-user ownership for takes + board_items.
--
-- Before this migration the visionboard was single-tenant: board_items had no
-- owner column, so every signed-in user read/wrote the same rows. takes were
-- owned only transitively (take -> generation_sets.user_id). This adds a
-- denormalized owner_id to both tables so every query can scope directly.
--
-- Backfill story (nullable -> backfill -> NOT NULL later):
--   1. Columns are added NULLABLE so this migration is safe on a live table
--      (no table rewrite, no lock spike, no failing NOT NULL on legacy rows).
--   2. Owners are derived from lineage, never guessed:
--        takes.owner_id       <- parent generation_sets.user_id
--        board_items.owner_id <- pinned take's set owner, or image_stills.user_id
--   3. Rows with no derivable owner (anonymous-era sets with NULL user_id)
--      stay NULL. All queries filter owner_id = <session user>, so NULL rows
--      are invisible to everyone — the system FAILS CLOSED rather than handing
--      orphaned rows to a designated/default owner (which could grant one
--      account another person's generations).
--   4. A follow-up migration flips owner_id to NOT NULL once production
--      backfill is verified (SELECT count(*) ... WHERE owner_id IS NULL).
--
-- Run after 0006_credits.sql

ALTER TABLE "takes" ADD COLUMN IF NOT EXISTS "owner_id" text REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "board_items" ADD COLUMN IF NOT EXISTS "owner_id" text REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Backfill: takes inherit their parent set's owner.
UPDATE "takes" t
SET "owner_id" = gs."user_id"
FROM "generation_sets" gs
WHERE t."set_id" = gs."id"
  AND t."owner_id" IS NULL
  AND gs."user_id" IS NOT NULL;
--> statement-breakpoint

-- Backfill: board items pinned from a take inherit the take's set owner.
UPDATE "board_items" b
SET "owner_id" = gs."user_id"
FROM "takes" t
JOIN "generation_sets" gs ON gs."id" = t."set_id"
WHERE b."take_id" = t."id"
  AND b."owner_id" IS NULL
  AND gs."user_id" IS NOT NULL;
--> statement-breakpoint

-- Backfill: board items pinned from an image still inherit the still's owner.
UPDATE "board_items" b
SET "owner_id" = i."user_id"
FROM "image_stills" i
WHERE b."image_still_id" = i."id"
  AND b."owner_id" IS NULL
  AND i."user_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "takes_owner_id_idx" ON "takes" ("owner_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "board_items_owner_id_idx" ON "board_items" ("owner_id");

-- ── Revert (down migration) ────────────────────────────────────────────────
-- drizzle-kit has no native down files; to roll back, run:
--
--   DROP INDEX IF EXISTS "board_items_owner_id_idx";
--   DROP INDEX IF EXISTS "takes_owner_id_idx";
--   ALTER TABLE "board_items" DROP COLUMN IF EXISTS "owner_id";
--   ALTER TABLE "takes" DROP COLUMN IF EXISTS "owner_id";
--
-- Dropping the columns loses only derived/stamped ownership data; the lineage
-- (set_id / take_id / image_still_id) it was derived from is untouched, so the
-- backfill above can be re-run at any time.
