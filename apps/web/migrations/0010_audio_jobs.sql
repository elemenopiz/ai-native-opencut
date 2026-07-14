-- Audio generation jobs: video-conditioned "score" (MMAudio) + text-to-music
-- (ElevenLabs Music) backends. New table only — no changes to existing tables.
--
-- Deliberately separate from `takes`: audio isn't a Seedance-style
-- video draft/promote flow, and a dedicated table avoids widening `takes`'
-- video-shaped columns (resolution, seed-lock, etc.) for a modality that
-- doesn't use most of them. `owner_id` is NOT NULL from day one (unlike the
-- legacy-backfilled `takes.owner_id`) — this table starts post-auth, so the
-- poll route's ownership check can always rely on it.
--
-- Run after 0009_delete_floor_and_takes_job_index.sql

CREATE TABLE IF NOT EXISTS "audio_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"action" text NOT NULL,
	"backend_id" text NOT NULL,
	"prompt" text,
	"source_video_url" text,
	"duration" integer,
	"instrumental" boolean,
	"lyrics" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_job_id" text,
	"result_url" text,
	"error_message" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "audio_jobs" ADD CONSTRAINT "audio_jobs_owner_id_users_id_fk"
		FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audio_jobs_owner_id_idx" ON "audio_jobs" ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_jobs_provider_job_id_idx" ON "audio_jobs" ("provider_job_id");

-- ── Revert (down migration) ─────────────────────────────────────────────────
-- drizzle-kit has no native down files; to roll back, run:
--
--   DROP TABLE IF EXISTS "audio_jobs";
--
-- Data-lossless to roll back ONLY if no audio jobs have been created yet —
-- otherwise this drops those rows. No other table is touched by this
-- migration in either direction.
