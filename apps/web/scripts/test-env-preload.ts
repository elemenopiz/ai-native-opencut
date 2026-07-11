/**
 * bun test preload — load apps/web/.env.local into process.env.
 *
 * Bun (like Next.js / Vite) deliberately SKIPS `.env.local` when NODE_ENV=test,
 * which `bun test` sets. Our DB-backed credit-ledger tests need DATABASE_URL
 * (and friends) from `.env.local`, so we load it here before any test module
 * imports `@byorn/env` (which parses process.env at import time). Wired via
 * `bunfig.toml` → [test].preload.
 *
 * Only sets a var when it isn't already present, so a real env always wins.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
	const envPath = join(import.meta.dir, "..", ".env.local");
	const content = readFileSync(envPath, "utf8");
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([\w.]+)\s*=\s*(.*)$/);
		if (!match) continue;
		const key = match[1];
		let value = match[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
} catch {
	// No .env.local (e.g. CI without one) — tests that require it will fail with
	// a clear env-validation error, which is the right signal.
}

// Payments (Phase 2) test fixtures. The webhook signature tests need a NON-empty
// POLAR_WEBHOOK_SECRET so real signature verification runs (standardwebhooks
// refuses an empty secret). We deliberately leave POLAR_ACCESS_TOKEN unset so
// `isPaymentsConfigured()` stays false — the "unconfigured/inert" tests assert
// that state. Only set when a real env hasn't provided one — an EMPTY string
// counts as "not provided" (a `.env.local` copied from `.env.example` has
// `POLAR_WEBHOOK_SECRET=` blank, which must not defeat this fixture).
if (!process.env.POLAR_WEBHOOK_SECRET) {
	process.env.POLAR_WEBHOOK_SECRET = "whsec_test_secret_do_not_use_in_prod";
}
