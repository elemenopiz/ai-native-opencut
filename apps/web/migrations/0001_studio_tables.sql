-- Studio tables: generation_sets, takes, board_items, image_stills
-- Run after 0000_brainy_saracen.sql

CREATE TABLE IF NOT EXISTS "generation_sets" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "prompt" text NOT NULL,
  "reference_image_url" text,
  "base_seed" integer,
  "resolution" text NOT NULL DEFAULT '720p',
  "duration" integer NOT NULL DEFAULT 5,
  "provider" text NOT NULL DEFAULT 'byteplus',
  "mode" text NOT NULL DEFAULT 'text-to-video',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "takes" (
  "id" text PRIMARY KEY NOT NULL,
  "set_id" text NOT NULL REFERENCES "generation_sets"("id") ON DELETE CASCADE,
  "seed" integer,
  "resolution" text NOT NULL,
  "thumbnail_url" text,
  "video_url" text,
  "status" text NOT NULL DEFAULT 'drafting',
  "starred" boolean NOT NULL DEFAULT false,
  "provider_job_id" text,
  "error_message" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "board_items" (
  "id" text PRIMARY KEY NOT NULL,
  "take_id" text NOT NULL REFERENCES "takes"("id") ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "image_stills" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "prompt" text NOT NULL,
  "image_url" text,
  "revised_prompt" text,
  "size" text NOT NULL DEFAULT '1024x1024',
  "quality" text NOT NULL DEFAULT 'high',
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "generation_sets_user_id_idx" ON "generation_sets" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "takes_set_id_idx" ON "takes" ("set_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_items_take_id_idx" ON "board_items" ("take_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "image_stills_user_id_idx" ON "image_stills" ("user_id");
