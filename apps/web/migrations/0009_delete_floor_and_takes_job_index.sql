-- Deletion floor (delete-account FK fix) + takes poll-route index.
--
-- Folds two independently-reviewed backlog items (PROD-READINESS #12/#15) into
-- one gated migration so they ride a single review.
--
-- ── 1. Delete-account FK fix (headline) ─────────────────────────────────────
-- Any user who has ever authored a version-control commit (or tag, media
-- upload, member/invitation) currently CANNOT delete their account: those FK
-- columns reference users(id) with the default ON DELETE NO ACTION, so deleting
-- the users row raises FK 23503 and /api/auth/delete-user 500s.
--
-- Fix: flip each of these author/actor FKs to ON DELETE SET NULL. All five
-- columns are ALREADY NULLABLE in the schema (schema-version-control.ts) and in
-- the 0008 CREATE TABLEs, so no column-nullability change is needed — only the
-- FK delete action changes. Author display survives because vc_commits keeps
-- denormalized author_name / author_avatar columns (untouched here); the only
-- thing that nulls on account-deletion is the *linkage* author_id, not the
-- shown name. The remaining columns feed no user-facing name render.
--   vc_commits.author_id
--   vc_tags.created_by
--   vc_media_objects.uploaded_by
--   project_members.invited_by
--   project_invitations.invited_by
--
-- Why DO blocks instead of a flat ALTER: 0008 created these FKs via inline
-- column REFERENCES, so Postgres auto-named them "<table>_<column>_fkey". That
-- name is stable across the fresh-prod path and the at-0008 dev path, but we
-- locate the constraint dynamically (by table + column + referenced table =
-- users) so the migration is robust to any naming variance and is idempotent:
-- if the FK already has ON DELETE SET NULL it is a no-op.
--
-- ── 2. takes.provider_job_id index (backlog #15) ────────────────────────────
-- The generation poll route filters takes by provider_job_id on every poll
-- tick; it was unindexed. Add a plain btree index.
--
-- Forward-only-safe on a FRESH database (prod applies 0001-0009 in order) AND
-- on a database currently at 0008 (dev). No table rewrite, no data change.
--
-- Run after 0008_project_collaboration.sql

-- ── 1a. vc_commits.author_id -> ON DELETE SET NULL ──────────────────────────
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND c.conrelid = 'vc_commits'::regclass
    AND a.attname = 'author_id'
    AND c.confrelid = 'users'::regclass
    AND c.confdeltype <> 'n';  -- 'n' = SET NULL; skip if already fixed
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "vc_commits" DROP CONSTRAINT %I', con_name);
    ALTER TABLE "vc_commits"
      ADD CONSTRAINT "vc_commits_author_id_users_id_fk"
      FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ── 1b. vc_tags.created_by -> ON DELETE SET NULL ────────────────────────────
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND c.conrelid = 'vc_tags'::regclass
    AND a.attname = 'created_by'
    AND c.confrelid = 'users'::regclass
    AND c.confdeltype <> 'n';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "vc_tags" DROP CONSTRAINT %I', con_name);
    ALTER TABLE "vc_tags"
      ADD CONSTRAINT "vc_tags_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ── 1c. vc_media_objects.uploaded_by -> ON DELETE SET NULL ──────────────────
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND c.conrelid = 'vc_media_objects'::regclass
    AND a.attname = 'uploaded_by'
    AND c.confrelid = 'users'::regclass
    AND c.confdeltype <> 'n';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "vc_media_objects" DROP CONSTRAINT %I', con_name);
    ALTER TABLE "vc_media_objects"
      ADD CONSTRAINT "vc_media_objects_uploaded_by_users_id_fk"
      FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ── 1d. project_members.invited_by -> ON DELETE SET NULL ────────────────────
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND c.conrelid = 'project_members'::regclass
    AND a.attname = 'invited_by'
    AND c.confrelid = 'users'::regclass
    AND c.confdeltype <> 'n';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "project_members" DROP CONSTRAINT %I', con_name);
    ALTER TABLE "project_members"
      ADD CONSTRAINT "project_members_invited_by_users_id_fk"
      FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ── 1e. project_invitations.invited_by -> ON DELETE SET NULL ────────────────
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  JOIN unnest(c.conkey) AS ck(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
  WHERE c.contype = 'f'
    AND c.conrelid = 'project_invitations'::regclass
    AND a.attname = 'invited_by'
    AND c.confrelid = 'users'::regclass
    AND c.confdeltype <> 'n';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "project_invitations" DROP CONSTRAINT %I', con_name);
    ALTER TABLE "project_invitations"
      ADD CONSTRAINT "project_invitations_invited_by_users_id_fk"
      FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ── 2. takes.provider_job_id index (backlog #15) ────────────────────────────
CREATE INDEX IF NOT EXISTS "takes_provider_job_id_idx" ON "takes" ("provider_job_id");

-- ── Revert (down migration) ─────────────────────────────────────────────────
-- drizzle-kit has no native down files; to roll back, run:
--
--   DROP INDEX IF EXISTS "takes_provider_job_id_idx";
--
--   -- Restore ON DELETE NO ACTION on each actor FK. (Re-adding without an
--   -- ON DELETE clause restores the pre-0009 default; account-deletion for a
--   -- user with commits/tags/uploads/invites will 500 again as before.)
--   ALTER TABLE "project_invitations" DROP CONSTRAINT IF EXISTS "project_invitations_invited_by_users_id_fk";
--   ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_invited_by_fkey"
--     FOREIGN KEY ("invited_by") REFERENCES "users"("id");
--   ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_invited_by_users_id_fk";
--   ALTER TABLE "project_members" ADD CONSTRAINT "project_members_invited_by_fkey"
--     FOREIGN KEY ("invited_by") REFERENCES "users"("id");
--   ALTER TABLE "vc_media_objects" DROP CONSTRAINT IF EXISTS "vc_media_objects_uploaded_by_users_id_fk";
--   ALTER TABLE "vc_media_objects" ADD CONSTRAINT "vc_media_objects_uploaded_by_fkey"
--     FOREIGN KEY ("uploaded_by") REFERENCES "users"("id");
--   ALTER TABLE "vc_tags" DROP CONSTRAINT IF EXISTS "vc_tags_created_by_users_id_fk";
--   ALTER TABLE "vc_tags" ADD CONSTRAINT "vc_tags_created_by_fkey"
--     FOREIGN KEY ("created_by") REFERENCES "users"("id");
--   ALTER TABLE "vc_commits" DROP CONSTRAINT IF EXISTS "vc_commits_author_id_users_id_fk";
--   ALTER TABLE "vc_commits" ADD CONSTRAINT "vc_commits_author_id_fkey"
--     FOREIGN KEY ("author_id") REFERENCES "users"("id");
--
-- The FK flip is data-lossless in both directions: no author_id/created_by/
-- uploaded_by/invited_by values change during 0009 (SET NULL only fires on a
-- FUTURE user delete). Denormalized author_name/author_avatar are never touched.
