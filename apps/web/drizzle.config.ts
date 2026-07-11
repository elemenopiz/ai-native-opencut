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
