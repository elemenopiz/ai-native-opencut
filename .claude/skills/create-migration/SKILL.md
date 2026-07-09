---
name: create-migration
description: >-
  Create and apply a Drizzle database migration for Byorn's Postgres schema.
  Use when changing apps/web/src/schema.ts (adding/altering tables or columns)
  and you need the correct generate → review → apply sequence. Guards against
  the destructive prod-push footgun.
disable-model-invocation: true
---

# Create a Drizzle migration

Byorn uses Drizzle ORM against Postgres. Schema lives in
[`apps/web/src/schema.ts`](apps/web/src/schema.ts). All commands run from
`apps/web` (or via `bun run --filter=@byorn/web <script>`).

The four scripts (see `apps/web/package.json`) and what they actually do:

| Script | Command | Use |
| --- | --- | --- |
| `db:generate` | `drizzle-kit generate` | Diff `schema.ts` → write a versioned SQL migration file. **Non-destructive.** |
| `db:migrate` | `drizzle-kit migrate` | Apply pending migration files in order. This is the way to change a real DB. |
| `db:push:local` | `NODE_ENV=development drizzle-kit push` | Push schema straight to the **local** dev DB, no migration file. Dev iteration only. |
| `db:push:prod` | `NODE_ENV=production drizzle-kit push` | ⛔ Pushes straight to **prod** with no migration/review. Can drop columns/data. |

## Standard workflow (use this)

1. **Edit** `apps/web/src/schema.ts`.
2. **Generate** the migration:
   ```bash
   cd apps/web && bun run db:generate
   ```
3. **Review the generated SQL** before applying — open the new file in
   `apps/web/drizzle/` (or the configured `out` dir). Confirm it's additive.
   Watch for `DROP COLUMN` / `DROP TABLE` / type narrowing that can lose data;
   if present, stop and confirm with the user, and write a data-preserving
   migration by hand if needed.
4. **Apply** to the local DB:
   ```bash
   cd apps/web && bun run db:migrate
   ```
5. **Verify** — connect and check the schema (the `postgres` MCP server can
   introspect it read-only), or run the app and exercise the affected feature.
6. **Commit** `schema.ts` and the new migration file together.

## For fast local iteration

`bun run db:push:local` skips the migration file and syncs the local DB
directly — fine while prototyping a shape. Once settled, still run
`db:generate` so a reviewed migration exists for other environments.

## Hard rules

- **Never run `db:push:prod`** as part of this workflow. Production changes go
  through generated, reviewed migration files applied by `db:migrate` in the
  deploy pipeline — not an ad-hoc push. If the user explicitly asks for a prod
  push, confirm it in a separate, deliberate step and warn about data loss.
- **Never edit an already-applied migration file.** Generate a new one.
- Local DB default: `postgresql://opencut:opencut@localhost:5432/opencut`
  (brew Postgres, per project setup).
