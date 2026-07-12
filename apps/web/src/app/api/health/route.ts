/**
 * GET /api/health — unauthenticated deploy/liveness probe.
 *
 * Returns `{ ok, db, redis, version, sha? }`:
 *  - `db`     — a cheap `SELECT 1` through the app's drizzle client, time-boxed
 *               to {@link DB_CHECK_TIMEOUT_MS} so the route can never hang on a
 *               wedged pool.
 *  - `redis`  — Upstash reachability, one of `true` / `false` /
 *               `"not-configured"`. In production `next start`, better-auth
 *               rate limiting is FAIL-CLOSED on Redis: if Upstash is
 *               unreachable, every `/api/auth/*` POST throws ECONNREFUSED → 500
 *               and nobody can sign in. So an unreachable Redis (`false`) is a
 *               user-facing outage and drives `ok:false` / 503, exactly like a
 *               dead DB. When Upstash is unconfigured (env unset or still the
 *               `@byorn/env/web` placeholder), better-auth is effectively using
 *               its in-memory limiter — that is the dev/fallback posture, not an
 *               outage, so `redis` reports `"not-configured"` and does NOT fail
 *               `ok`.
 *  - `version`— apps/web/package.json version.
 *  - `sha`    — VERCEL_GIT_COMMIT_SHA (Vercel-injected) or GIT_SHA, when set.
 *
 * 200 when the DB answers and Redis is reachable-or-unconfigured; 503
 * `{ ok: false }` when either the DB is down or a configured Redis is
 * unreachable. Never throws and never leaks connection strings, tokens, or
 * driver error internals — the db module is imported lazily inside a try/catch
 * so even a broken env (schema parse failure) degrades to a 503 instead of a
 * 500 HTML page, and the Redis probe returns only a coarse status.
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import pkg from "../../../../package.json";

// Must never be statically pre-rendered at build time (the default for
// zero-input GET routes) — the DB check has to run on every request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DB_CHECK_TIMEOUT_MS = 2000;
const REDIS_CHECK_TIMEOUT_MS = 3000;

/**
 * Placeholder Upstash defaults from `@byorn/env/web`. When the live env still
 * carries these, no real Redis is wired — treated as "not configured", mirroring
 * the same guard in `lib/rate-limit.ts` / `lib/mcp/token-cache.ts`. We read
 * `process.env` directly (not the validated `webEnv`) to avoid coupling this
 * liveness route to unrelated env validation.
 */
const PLACEHOLDER_UPSTASH_URL = "http://localhost:8079";
const PLACEHOLDER_UPSTASH_TOKEN = "example_token";

/** One of the three redis states surfaced in the health payload. */
type RedisStatus = true | false | "not-configured";

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

/**
 * Cheap authenticated Upstash REST `PING`, time-boxed with an AbortSignal so the
 * probe can never hang the health route on a wedged network. Returns:
 *  - `"not-configured"` — no real Upstash wired (env unset or placeholder).
 *  - `true`             — Upstash answered `PONG`.
 *  - `false`            — configured but unreachable / erroring.
 *
 * No secrets ever leave this function: the token is only ever sent in the
 * Authorization header, and failures log a coarse reason (error name), never the
 * URL, token, or raw driver message.
 */
async function checkRedis(): Promise<RedisStatus> {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (
		!url ||
		!token ||
		url === PLACEHOLDER_UPSTASH_URL ||
		token === PLACEHOLDER_UPSTASH_TOKEN
	) {
		return "not-configured";
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REDIS_CHECK_TIMEOUT_MS);
	try {
		// Upstash REST: `GET {url}/ping` → `{ "result": "PONG" }` on success.
		const res = await fetch(`${url.replace(/\/$/, "")}/ping`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
			cache: "no-store",
		});
		if (!res.ok) {
			logger.warn("health: redis ping returned non-2xx", {
				status: res.status,
			});
			return false;
		}
		const body = (await res.json()) as { result?: unknown };
		if (body?.result === "PONG") return true;
		logger.warn("health: redis ping unexpected body");
		return false;
	} catch (err) {
		// Log only the coarse error name (e.g. "AbortError", "TypeError") — never
		// the message, which for ECONNREFUSED embeds the host:port.
		logger.warn("health: redis ping failed", {
			reason: err instanceof Error ? err.name : "unknown",
		});
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function GET() {
	const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
	const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_SHA;
	// A configured-but-unreachable Redis (`false`) is a user-facing auth outage
	// in production (better-auth rate limiting is fail-closed on Redis), so it
	// fails `ok`. `"not-configured"` is the dev/fallback posture and does not.
	const ok = db && redis !== false;
	return NextResponse.json(
		{
			ok,
			db,
			redis,
			version: pkg.version,
			...(sha ? { sha } : {}),
		},
		{ status: ok ? 200 : 503 },
	);
}
