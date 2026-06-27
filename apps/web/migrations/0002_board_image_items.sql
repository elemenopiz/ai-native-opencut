-- Allow the visionboard to hold generated image stills, not just video takes.
-- A board item is now either a take or an image still (discriminated by "kind").
-- Run after 0001_studio_tables.sql

ALTER TABLE "board_items" ALTER COLUMN "take_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_items" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'take';
--> statement-breakpoint
ALTER TABLE "board_items" ADD COLUMN IF NOT EXISTS "image_still_id" text REFERENCES "image_stills"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_items_image_still_id_idx" ON "board_items" ("image_still_id");
