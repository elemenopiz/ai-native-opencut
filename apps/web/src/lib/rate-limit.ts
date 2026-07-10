/**
 * Per-account rate limiting for paid / cost-bearing API routes.
 *
 * Every route that spends a provider key (video/image generation, the LLM relay,
 * polling, promotion) keys its limit on the signed-in user; genuinely anonymous
 * routes fall back to the caller IP. Two windows are enforced per rule — a
 * per-minute burst cap and a per-day volume cap — and BOTH must pass.
 *
 * One interface, two implementations, selected automatically (mirrors
 * `mcp/token-cache.ts`):
 *  - {@link RedisRateLimiter} — Upstash/Redis sliding windows when configured.
 *    Shared across server instances, same client style as the better-auth
 *    `secondaryStorage` and the MCP token cache.
 *  - {@link InMemoryRateLimiter} — process-local fixed-window counters when
 *    Upstash is unconfigured (single instance: dev / self-hosted). Nothing to
 *    set up.
 *
 * FAIL-OPEN: if the Redis limiter throws (infra blip), the request is allowed
 * rather than denied — auth is the primary gate, and a rate-limiter outage must
 * not lock out paying users. The failure is logged.
 *
 * TUNING: all caps live in {@link RATE_LIMITS} so they can be adjusted in one
 * place without touching any route.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

/** A per-minute burst cap and a per-day volume cap. Both must pass. */
export interface RateLimitRule {
	/** Max requests allowed in a rolling 1-minute window. */
	perMinute: number;
	/** Max requests allowed in a rolling 1-day window. */
	perDay: number;
}

/**
 * Central table of caps, keyed by a stable route name. Tune here — routes only
 * reference the name. Poll (`studio:poll`) is intentionally generous because the
 * client polls a job in a tight loop; the true cost gates are the generation
 * routes below it.
 */
export const RATE_LIMITS = {
	"studio:generate": { perMinute: 12, perDay: 300 },
	"studio:poll": { perMinute: 90, perDay: 5000 },
	"studio:image": { perMinute: 12, perDay: 300 },
	"studio:persona-still": { perMinute: 12, perDay: 300 },
	"studio:promote": { perMinute: 6, perDay: 120 },
	"llm:agent": { perMinute: 30, perDay: 1500 },
	"sounds:search": { perMinute: 60, perDay: 3000 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
	success: boolean;
	limited: boolean;
}

/** Swap-in surface: routes depend only on this, not on Redis. */
export interface RateLimiter {
	/**
	 * Consume one request against `rule` for `key`, namespaced by `bucket` (the
	 * route name). Returns whether the request is within BOTH windows.
	 */
	check(
		rule: RateLimitRule,
		bucket: string,
		key: string,
	): Promise<RateLimitResult>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Soft cap on the in-memory map so a burst of distinct keys can't grow it unbounded. */
const IN_MEMORY_MAX_ENTRIES = 4096;

/** Process-local fixed-window counters. Used when Upstash is unconfigured. */
export class InMemoryRateLimiter implements RateLimiter {
	private store = new Map<string, { count: number; resetAt: number }>();

	async check(
		rule: RateLimitRule,
		bucket: string,
		key: string,
	): Promise<RateLimitResult> {
		if (this.store.size >= IN_MEMORY_MAX_ENTRIES) this.prune();
		// Consume both windows independently (matches the two-limiter Redis path).
		const okMinute = this.hit(`${bucket}:m:${key}`, rule.perMinute, MINUTE_MS);
		const okDay = this.hit(`${bucket}:d:${key}`, rule.perDay, DAY_MS);
		const success = okMinute && okDay;
		return { success, limited: !success };
	}

	/** Increment the fixed window for `bucketKey`; true while at/under `limit`. */
	private hit(bucketKey: string, limit: number, windowMs: number): boolean {
		const now = Date.now();
		let entry = this.store.get(bucketKey);
		if (!entry || entry.resetAt <= now) {
			entry = { count: 0, resetAt: now + windowMs };
			this.store.set(bucketKey, entry);
		}
		entry.count += 1;
		return entry.count <= limit;
	}

	/** Drop expired windows; if still at cap, evict oldest insertions. */
	private prune(): void {
		const now = Date.now();
		for (const [key, entry] of this.store) {
			if (entry.resetAt <= now) this.store.delete(key);
		}
		while (this.store.size >= IN_MEMORY_MAX_ENTRIES) {
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) break;
			this.store.delete(oldest);
		}
	}
}

/**
 * Upstash/Redis-backed sliding-window limiter, shared across instances. Builds
 * one {@link Ratelimit} per (bucket, window) lazily and caches it. Fails OPEN:
 * on a Redis error the request is allowed (see file header).
 */
export class RedisRateLimiter implements RateLimiter {
	private minute = new Map<string, Ratelimit>();
	private day = new Map<string, Ratelimit>();

	constructor(private readonly redis: Redis) {}

	private limiterFor(
		rule: RateLimitRule,
		bucket: string,
		window: "minute" | "day",
	): Ratelimit {
		const cache = window === "minute" ? this.minute : this.day;
		let limiter = cache.get(bucket);
		if (!limiter) {
			limiter = new Ratelimit({
				redis: this.redis,
				limiter:
					window === "minute"
						? Ratelimit.slidingWindow(rule.perMinute, "1 m")
						: Ratelimit.slidingWindow(rule.perDay, "1 d"),
				prefix: `rate-limit:${bucket}:${window === "minute" ? "m" : "d"}`,
				analytics: false,
			});
			cache.set(bucket, limiter);
		}
		return limiter;
	}

	async check(
		rule: RateLimitRule,
		bucket: string,
		key: string,
	): Promise<RateLimitResult> {
		try {
			const [minute, day] = await Promise.all([
				this.limiterFor(rule, bucket, "minute").limit(key),
				this.limiterFor(rule, bucket, "day").limit(key),
			]);
			const success = minute.success && day.success;
			return { success, limited: !success };
		} catch (err) {
			// Fail open: a limiter outage must not deny paying users. Auth still gates.
			console.error("Rate limiter error (allowing request):", err);
			return { success: true, limited: false };
		}
	}
}

/** Placeholder env defaults from `@byorn/env/web` — treated as "not configured". */
const PLACEHOLDER_URL = "http://localhost:8079";
const PLACEHOLDER_TOKEN = "example_token";

/**
 * Upstash credentials from `process.env` (Next.js populates it from `.env*`). We
 * deliberately do NOT import the validated `webEnv` here — it validates the app's
 * full env at import time, coupling this module (and its unit tests) to unrelated
 * vars. Same rationale as `mcp/token-cache.ts`.
 */
function upstashEnv(): { url?: string; token?: string } {
	return {
		url: process.env.UPSTASH_REDIS_REST_URL,
		token: process.env.UPSTASH_REDIS_REST_TOKEN,
	};
}

/** Build the implementation appropriate for the current environment. */
export function createRateLimiter(): RateLimiter {
	const { url, token } = upstashEnv();
	if (url && token && url !== PLACEHOLDER_URL && token !== PLACEHOLDER_TOKEN) {
		return new RedisRateLimiter(new Redis({ url, token }));
	}
	return new InMemoryRateLimiter();
}

/**
 * Process-wide singleton, cached on `globalThis` so Next.js dev HMR doesn't
 * orphan the in-memory counters (mirrors `mcp/token-cache.ts`).
 */
const globalStore = globalThis as unknown as {
	__byornRateLimiter?: RateLimiter;
};

export function getRateLimiter(): RateLimiter {
	globalStore.__byornRateLimiter ??= createRateLimiter();
	return globalStore.__byornRateLimiter;
}

/** First hop in `x-forwarded-for`, or "anonymous" when absent. */
function ipFrom(request: Request): string {
	const xff = request.headers.get("x-forwarded-for");
	return xff?.split(",")[0]?.trim() || "anonymous";
}

/**
 * Enforce the named rate limit. Keys on `userId` when present, else the caller
 * IP. Returns a ready-to-return 429 `NextResponse` when the caller is over the
 * limit, or `null` when the request may proceed:
 *
 *   const limited = await enforceRateLimit({ name: "studio:generate", request, userId });
 *   if (limited) return limited;
 */
export async function enforceRateLimit({
	name,
	request,
	userId,
}: {
	name: RateLimitName;
	request: Request;
	userId?: string | null;
}): Promise<NextResponse | null> {
	const key = userId ? `user:${userId}` : `ip:${ipFrom(request)}`;
	const { limited } = await getRateLimiter().check(
		RATE_LIMITS[name],
		name,
		key,
	);
	if (limited) {
		return NextResponse.json(
			{
				error: "Rate limit exceeded. Please slow down and try again shortly.",
			},
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}
	return null;
}

/**
 * Back-compat wrapper for the anonymous sounds-search route (its only caller).
 * Keys on IP under the `sounds:search` limit.
 */
export async function checkRateLimit({
	request,
}: {
	request: Request;
}): Promise<RateLimitResult> {
	const key = `ip:${ipFrom(request)}`;
	return getRateLimiter().check(
		RATE_LIMITS["sounds:search"],
		"sounds:search",
		key,
	);
}
