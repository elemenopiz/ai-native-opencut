-- Project collaboration: shared projects (members + invitations) on top of the
-- cloud version-control layer.
--
-- IMPORTANT: this migration ALSO creates the version-control tables themselves
-- (project_repositories, vc_*). Their drizzle schema (schema-version-control.ts)
-- and API routes have been on main for a while, but no migration ever created
-- the tables — "Set up cloud sync" 500s on a fresh database. Sharing rides on
-- that layer, so it lands here, guarded with IF NOT EXISTS for databases where
-- the tables were hand-pushed.
--
-- Run after 0007_studio_tenancy.sql

-- ── Version-control backbone (previously schema-only, never migrated) ──────

CREATE TABLE IF NOT EXISTS "project_repositories" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "default_branch" text NOT NULL DEFAULT 'main',
  "is_public" boolean NOT NULL DEFAULT false,
  "forked_from_id" text,
  "forked_from_commit_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "repo_project_id_idx" ON "project_repositories" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_user_id_idx" ON "project_repositories" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_commits" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "parent_id" text,
  "merge_parent_id" text,
  "hash" text NOT NULL,
  "message" text NOT NULL,
  "author_id" text REFERENCES "users"("id"),
  "author_name" text,
  "author_avatar" text,
  "is_keyframe" boolean NOT NULL DEFAULT false,
  "snapshot_data" jsonb,
  "delta_data" jsonb,
  "keyframe_ancestor_id" text,
  "thumbnail_url" text,
  "duration" real NOT NULL DEFAULT 0,
  "track_count" integer NOT NULL DEFAULT 0,
  "element_count" integer NOT NULL DEFAULT 0,
  "change_summary" jsonb,
  "is_auto_commit" boolean DEFAULT false,
  "merge_source_branch" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "commits_repo_id_idx" ON "vc_commits" ("repo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commits_created_at_idx" ON "vc_commits" ("repo_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commits_hash_idx" ON "vc_commits" ("hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commits_parent_idx" ON "vc_commits" ("parent_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_branches" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "head_commit_id" text NOT NULL REFERENCES "vc_commits"("id"),
  "description" text,
  "color" text,
  "created_from_branch" text,
  "created_from_commit_id" text,
  "is_protected" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "branch_repo_name_unique" UNIQUE ("repo_id", "name")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "branches_repo_id_idx" ON "vc_branches" ("repo_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_tags" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "commit_id" text NOT NULL REFERENCES "vc_commits"("id"),
  "name" text NOT NULL,
  "type" text NOT NULL DEFAULT 'custom',
  "note" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "tag_repo_name_unique" UNIQUE ("repo_id", "name")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tags_repo_id_idx" ON "vc_tags" ("repo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tags_commit_id_idx" ON "vc_tags" ("commit_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_stashes" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "branch_id" text NOT NULL REFERENCES "vc_branches"("id"),
  "snapshot_data" jsonb NOT NULL,
  "message" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "stashes_repo_id_idx" ON "vc_stashes" ("repo_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_media_objects" (
  "hash" text PRIMARY KEY NOT NULL,
  "size" bigint NOT NULL,
  "mime_type" text NOT NULL,
  "storage_url" text NOT NULL,
  "width" integer,
  "height" integer,
  "duration" real,
  "uploaded_by" text REFERENCES "users"("id"),
  "uploaded_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_commit_media_refs" (
  "commit_id" text NOT NULL REFERENCES "vc_commits"("id") ON DELETE CASCADE,
  "media_hash" text NOT NULL REFERENCES "vc_media_objects"("hash"),
  "media_id" text NOT NULL,
  "name" text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_refs_commit_idx" ON "vc_commit_media_refs" ("commit_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_refs_hash_idx" ON "vc_commit_media_refs" ("media_hash");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vc_branch_permissions" (
  "id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL REFERENCES "vc_branches"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permission" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "branch_perm_unique" UNIQUE ("branch_id", "user_id")
);
--> statement-breakpoint

-- ── Collaboration: members + invitations ───────────────────────────────────

-- A member row grants a non-owner user access to a repo. The repo owner is
-- project_repositories.user_id and never has a member row — access checks
-- treat ownership as the implicit top role.
CREATE TABLE IF NOT EXISTS "project_members" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'editor',
  "invited_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "member_repo_user_unique" UNIQUE ("repo_id", "user_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "members_repo_id_idx" ON "project_members" ("repo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_user_id_idx" ON "project_members" ("user_id");
--> statement-breakpoint

-- Invitations are keyed by lowercased email so a teammate who has never signed
-- up still gets the invite the first time they log in. One live row per
-- (repo, email): re-inviting updates the existing row back to 'pending'.
CREATE TABLE IF NOT EXISTS "project_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "repo_id" text NOT NULL REFERENCES "project_repositories"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'editor',
  "status" text NOT NULL DEFAULT 'pending',
  "invited_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "responded_at" timestamp,
  CONSTRAINT "invite_repo_email_unique" UNIQUE ("repo_id", "email")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "invites_email_idx" ON "project_invitations" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invites_repo_id_idx" ON "project_invitations" ("repo_id");
