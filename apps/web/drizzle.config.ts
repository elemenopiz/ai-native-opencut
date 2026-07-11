import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";

// Tooling config — runs OUTSIDE the Next.js server (drizzle-kit CLI), so it
// deliberately does NOT import `@byorn/env/web`: ESM imports hoist, which made
// the schema parse `process.env` BEFORE dotenv had loaded the target env file
// (the previous version of this file had exactly that bug — `.env.production`
// was loaded too late to ever be seen). Load the env file first, then read
// `process.env` directly.
if (process.env.NODE_ENV === "production") {
	dotenv.config({ path: ".env.production" });
} else {
	dotenv.config({ path: ".env.local" });
}

// TODO(2026-07-11): `drizzle-kit generate` is broken by snapshot drift and has
// been since 0001 — migrations/meta/ holds only 0000_snapshot.json because
// 0001–0007 were hand-written (house style) and journaled by hand (0006/0007
// re-journaled 2026-07-11). `drizzle-kit migrate` is unaffected: it reads only
// meta/_journal.json + the .sql files, never snapshots. Reconciling would mean
// hand-authoring seven snapshot JSONs (fragile) or letting `generate` emit a
// catch-all migration (rejected — no new migrations). Until fixed: write new
// migrations by hand, append a journal entry with a strictly increasing
// `when`, and never trust `bun run db:generate` output without diffing it
// against the live schema.
const url = process.env.DATABASE_URL;
if (!url) {
	throw new Error(
		"DATABASE_URL is not set. Export it (or put it in .env.local / " +
			".env.production for NODE_ENV=production) before running drizzle-kit.",
	);
}

export default {
	schema: "./src/schema.ts",
	dialect: "postgresql",
	migrations: {
		table: "drizzle_migrations",
	},
	dbCredentials: {
		url,
	},
	out: "./migrations",
	strict: process.env.NODE_ENV === "production",
} satisfies Config;
