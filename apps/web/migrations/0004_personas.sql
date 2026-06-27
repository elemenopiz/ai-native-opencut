-- Personas: reusable character identity (reference-conditioned, no training).
-- The anchor image + locked descriptor thread through every shot so the same
-- character recurs across generations. generation_sets gains a nullable
-- persona_id (SET NULL on delete so historical takes survive).
-- Run after 0003_studio_orientation.sql

CREATE TABLE IF NOT EXISTS "personas" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "descriptor" text NOT NULL,
  "anchor_image_url" text NOT NULL,
  "ref_image_urls" text,
  "seed" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "generation_sets" ADD COLUMN IF NOT EXISTS "persona_id" text REFERENCES "personas"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "personas_user_id_idx" ON "personas" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generation_sets_persona_id_idx" ON "generation_sets" ("persona_id");
