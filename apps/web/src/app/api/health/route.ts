/**
 * GET /api/health — unauthenticated deploy/liveness probe.
 *
 * Returns `{ ok, db, version, sha? }`:
 *  - `db`     — a cheap `SELECT 1` through the app's drizzle client, time-boxed
 *               to {@link DB_CHECK_TIMEOUT_MS} so the route can never hang on a
 *               wedged pool.
 *  - `version`— apps/web/package.json version.
 *  - `sha`    — VERCEL_GIT_COMMIT_SHA (Vercel-injected) or GIT_SHA, when set.
 *
 * 200 when the DB answers, 503 `{ ok: false, db: false }` when it doesn't.
 * Never throws and never leaks connection strings or driver error internals —
 * the db module is imported lazily inside a try/catch so even a broken env
 * (schema parse failure) degrades to a 503 instead of a 500 HTML page.
 */

import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

// Must never be statically pre-rendered at build time (the default for
// zero-input GET routes) — the DB check has to run on every request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DB_CHECK_TIMEOUT_MS = 2000;

async function checkDb(): Promise<boolean> {
	try {
		// Lazy import: keeps env validation + pool creation out of module scope,
		// so a misconfigured deployment still gets a JSON 503 from this route.
		const [{ db }, { sql }] = await Promise.all([
			import("@/lib/db"),
			import("drizzle-orm"),
		]);
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("db health check timed out")),
				DB_CHECK_TIMEOUT_MS,
			);
		});
		await Promise.race([db.execute(sql`select 1`), timeout]);
		return true;
	} catch {
		// Deliberately swallowed: error internals can carry hosts/credentials.
		return false;
	}
}

export async function GET() {
	const db = await checkDb();
	const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_SHA;
	return NextResponse.json(
		{
			ok: db,
			db,
			version: pkg.version,
			...(sha ? { sha } : {}),
		},
		{ status: db ? 200 : 503 },
	);
}
