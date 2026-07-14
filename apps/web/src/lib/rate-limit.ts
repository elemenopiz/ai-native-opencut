/**
 * Per-account rate limiting for paid / cost-bearing API routes.
 *
 * Every route that spends a provider key (video/image generation, the LLM relay,
 * polling, promotion) keys its limit on the signed-in user; genuinely anonymous
 * routes fall back to the caller IP. Two windows are enforced per rule — a
 * per-minute burst cap and a per-day volume cap — and BOTH must pass.
 *
 * The DAY window is consumed only when the MINUTE window passes: a request that
 * is already rejected by the burst cap must not also spend a day token (that
 * would let a short burst exhaust the daily budget and lock a user out for the
 * rest of the day).
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
 * Env-configurable daily cap on free Director LLM turns (both `/api/llm/agent`
 * and `/api/llm/gemini`, see {@link DIRECTOR_DAILY_CAP_NAMES}). Read directly
 * from `process.env` (not the validated `webEnv`) for the same reason as
 * {@link upstashEnv} below: this module must stay decoupled from the app's
 * full env schema so its unit tests don't need to satisfy unrelated required
 * vars. Invalid/unset values fall back to a default generous enough for a
 * real multi-hour editing session while still bounding a runaway tool loop on
 * a route with no credit metering.
 *
 * Called PER-REQUEST inside {@link enforceRateLimit} rather than baked into
 * {@link RATE_LIMITS} at module-load time — same lazy-eval convention as
 * `upstashEnv()`/`trustedProxyHops()` below, so the cap can change without a
 * process restart and so tests can flip `process.env` per-case.
 */
function directorFreeTurnsPerDay(): number {
	const raw = Number.parseInt(
		process.env.DIRECTOR_FREE_TURNS_PER_DAY ?? "",
		10,
	);
	return Number.isInteger(raw) && raw > 0 ? raw : 150;
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
	// Media proxy for importing finished takes. Generous like poll — a project
	// can import many clips in quick succession — it exists to bound abuse of the
	// (SSRF-guarded) relay, not to throttle normal imports.
	"studio:proxy": { perMinute: 90, perDay: 5000 },
	"studio:image": { perMinute: 12, perDay: 300 },
	// Audio generation (score / music). Same burst profile as image — one
	// paid provider call per click.
	"studio:audio": { perMinute: 12, perDay: 300 },
	// Audio job poll (MMAudio's async fal.ai queue). Generous like studio:poll —
	// the client polls a job in a tight loop.
	"studio:audio-poll": { perMinute: 90, perDay: 5000 },
	// Rehost of user-uploaded reference media to R2. Not a paid model call, but an
	// open write path to our object storage — cap it to bound cost/abuse while
	// staying generous enough for a real multi-file reference upload.
	"studio:upload": { perMinute: 30, perDay: 500 },
	"studio:persona-still": { perMinute: 12, perDay: 300 },
	"studio:promote": { perMinute: 6, perDay: 120 },
	// Director chat is FREE (no credit metering) but bills OUR provider key per
	// turn, so this pair is the only cost floor. perMinute dropped 30 → 10: a
	// human chatting has no reason to fire more than ~1 turn every few seconds,
	// and 10/min still comfortably covers rapid back-and-forth without being a
	// useful burst-abuse lever. The perDay literal below (150) is only the
	// documented DEFAULT — `enforceRateLimit` overrides it per-call with
	// {@link directorFreeTurnsPerDay} (env-configurable via
	// DIRECTOR_FREE_TURNS_PER_DAY) for the names in
	// {@link DIRECTOR_DAILY_CAP_NAMES}. Owner accounts (see `isOwnerEmail`) are
	// exempted from this cap at the call site.
	"llm:agent": { perMinute: 10, perDay: 150 },
	// Native Gemini Director relay (POST /api/llm/gemini) — same loop profile as
	// llm:agent (one call per model turn of the same agent loop), so same caps.
	"llm:gemini": { perMinute: 10, perDay: 150 },
	// One-shot prompt rewriter (POST /api/llm/enhance-prompt). Un-metered for
	// beta (free but rate-limited) — a human clicking "Enhance" a handful of
	// times per prompt, so the burst cap is tight and the daily cap generous.
	"llm:enhance": { perMinute: 10, perDay: 300 },
	// Cloud text-to-speech (POST /api/tts). Un-metered for beta (free but
	// rate-limited) — a human generates a handful of voiceover lines per
	// session, so the burst cap is tight and the daily cap generous.
	"tts:generate": { perMinute: 10, perDay: 300 },
	"sounds:search": { perMinute: 60, perDay: 3000 },
	// Client-error intake. Unauthenticated by design (errors happen logged-out),
	// so the burst cap is tight; the client also self-caps per page load.
	"telemetry:error": { perMinute: 10, perDay: 300 },
	// Closed-beta access-code check (POST /api/beta-gate). A 4-digit code has
	// only 10k combinations — the tight per-IP caps are what make brute force
	// impractical (~months of continuous guessing per IP).
	"beta:gate": { perMinute: 5, perDay: 60 },
	// Anonymous arrangement publish (no-login-to-try posture). Every call inserts
	// a Postgres row, and publishing is a rare, deliberate human action — keep the
	// per-IP caps tight.
	"arrangements:publish": { perMinute: 5, perDay: 50 },
	// Anonymous remix-counter bump on the /t/[id] landing. More lenient than
	// publish (a shared link can spread fast); when it trips, the READ still
	// succeeds — only the counter write is skipped.
	"arrangements:remix": { perMinute: 30, perDay: 2000 },
	// Anonymous Pexels search proxy. The server-side PEXELS_API_KEY has a hard
	// 200 req/hr upstream quota shared by ALL users, so the per-IP caps stay
	// tight — one abusive IP must not burn the whole shared budget.
	"images:search": { perMinute: 10, perDay: 200 },
	// Version-control WRITE paths (all keyed on the signed-in user).
	// Commit pushes can arrive in bursts from auto-commit while editing — keep
	// them generous; each push is also batch-capped in the route itself.
	"vc:commits": { perMinute: 30, perDay: 2000 },
	// Bulk sync pushes+pulls in one call; same editing-loop profile as commits.
	"vc:sync": { perMinute: 30, perDay: 2000 },
	// Forking copies an entire repo history (commits+branches+tags) — a rare,
	// deliberate human action that is expensive per call. Very tight.
	"vc:fork": { perMinute: 3, perDay: 30 },
	// Media upload buffers the whole file in memory before R2 (up to the route's
	// 200 MB cap) — bound how often one account can do that.
	"vc:media": { perMinute: 20, perDay: 300 },
	// Inviting teammates sends an email per call — keep it human-paced so one
	// account can't turn the inviter into a spam cannon.
	"vc:invite": { perMinute: 5, perDay: 100 },
	// MCP transport envelope (`/api/mcp`, any JSON-RPC method: initialize,
	// tools/list, ping, the standalone GET SSE stream, DELETE session
	// teardown). Deliberately generous and NOT verb-aware — it is a blanket
	// safety net against session/protocol churn (e.g. a misbehaving client
	// re-initializing in a loop), keyed on the token's userId. The verb-aware
	// caps that matter for cost/DB load live below and are enforced per
	// `tools/call` in build-mcp-server.ts, where the tool name is known.
	"mcp:transport": { perMinute: 300, perDay: 20_000 },
	// Read-only Director verbs called over MCP (getReel, searchMedia, …). A
	// runaway agent loop can otherwise hammer Postgres/embedding search
	// unbounded — see build-mcp-server.ts's `tools/call` handler, which picks
	// this bucket via the catalog's `mutating` flag.
	"mcp:read": { perMinute: 120, perDay: 6000 },
	// Mutating Director verbs called over MCP (generate, trim, remove, …).
	// Tighter than read — these write to the timeline and some spend a
	// provider credit.
	"mcp:write": { perMinute: 30, perDay: 1500 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitResult {
	success: boolean;
	limited: boolean;
	/**
	 * Which window rejected the request, when `limited` is true — lets callers
	 * (e.g. `enforceRateLimit`'s `dailyMessage`/`minuteMessage` overrides) give
	 * different copy for "you're going too fast" vs. "you're out for today".
	 * Undefined when `limited` is false.
	 */
	window?: "minute" | "day";
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
		// Check the minute burst cap FIRST. If it fails, return without touching
		// the day window — a request the burst cap already rejected must not also
		// spend a day token (otherwise a burst could exhaust the daily budget and
		// lock the user out for the rest of the day).
		const okMinute = this.hit(`${bucket}:m:${key}`, rule.perMinute, MINUTE_MS);
		if (!okMinute) return { success: false, limited: true, window: "minute" };
		const okDay = this.hit(`${bucket}:d:${key}`, rule.perDay, DAY_MS);
		return {
			success: okDay,
			limited: !okDay,
			window: okDay ? undefined : "day",
		};
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
			// Check the minute burst cap FIRST, and consume the day window only if
			// it passes. A request the burst cap already rejected must not spend a
			// day token too (that would let a short burst exhaust the daily budget
			// and lock the user out for the rest of the day). This makes the day
			// call conditional, so it can no longer run in parallel with the minute
			// call — correctness wins over the lost parallelism.
			const minute = await this.limiterFor(rule, bucket, "minute").limit(key);
			if (!minute.success) {
				return { success: false, limited: true, window: "minute" };
			}
			const day = await this.limiterFor(rule, bucket, "day").limit(key);
			return {
				success: day.success,
				limited: !day.success,
				window: day.success ? undefined : "day",
			};
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

/**
 * Client IP from `x-forwarded-for`, or "anonymous" when absent.
 *
 * `x-forwarded-for` is a comma-separated chain `client, proxy1, proxy2, ...`
 * where entries are APPENDED as the request passes through each proxy. The
 * LEFTMOST entry is fully attacker-controlled — a client can prefill the header
 * with any value, so keying a limit on it lets an abuser rotate the header to
 * mint unlimited distinct keys and bypass the limit entirely.
 *
 * Only the hops appended by infrastructure WE trust are reliable. Reading from
 * the RIGHT, the last entry is the address our own edge proxy observed, the
 * second-to-last is what the proxy in front of that saw, and so on. With
 * `TRUSTED_PROXY_HOPS = N` trusted reverse proxies between us and the client,
 * the real client address is the Nth entry from the end. We default to 1 to
 * preserve the historical single-proxy behavior when the env is unset, and
 * never hard-break: if the chain is shorter than expected we fall back to the
 * leftmost available entry.
 */
function trustedProxyHops(): number {
	const raw = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
	return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

function ipFrom(request: Request): string {
	const xff = request.headers.get("x-forwarded-for");
	if (!xff) return "anonymous";
	const hops = xff
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
	if (hops.length === 0) return "anonymous";
	// Select the Nth-from-last entry (the address the innermost trusted proxy
	// actually saw). Clamp to the chain length so a shorter-than-expected chain
	// degrades to the leftmost entry rather than throwing away the key.
	const idx = Math.max(0, hops.length - trustedProxyHops());
	return hops[idx] || "anonymous";
}

const DEFAULT_LIMIT_MESSAGE =
	"Rate limit exceeded. Please slow down and try again shortly.";

/**
 * Buckets whose `perDay` is resolved per-request from
 * {@link directorFreeTurnsPerDay} instead of the {@link RATE_LIMITS} literal —
 * currently just the two Director LLM relays, which share one env-configurable
 * free-tier cap (`DIRECTOR_FREE_TURNS_PER_DAY`).
 */
const DIRECTOR_DAILY_CAP_NAMES: ReadonlySet<RateLimitName> = new Set([
	"llm:agent",
	"llm:gemini",
]);

/**
 * Enforce the named rate limit. Keys on `userId` when present, else the caller
 * IP. Returns a ready-to-return 429 `NextResponse` when the caller is over the
 * limit, or `null` when the request may proceed:
 *
 *   const limited = await enforceRateLimit({ name: "studio:generate", request, userId });
 *   if (limited) return limited;
 *
 * `dailyMessage`/`minuteMessage` let a caller give window-specific copy (e.g.
 * the Director relays distinguish "you're going too fast" from "your free
 * daily allowance is used up") — both fall back to the generic message when
 * omitted, so existing callers are unaffected.
 */
export async function enforceRateLimit({
	name,
	request,
	userId,
	dailyMessage,
	minuteMessage,
}: {
	name: RateLimitName;
	request: Request;
	userId?: string | null;
	dailyMessage?: string;
	minuteMessage?: string;
}): Promise<NextResponse | null> {
	const key = userId ? `user:${userId}` : `ip:${ipFrom(request)}`;
	const rule = DIRECTOR_DAILY_CAP_NAMES.has(name)
		? { ...RATE_LIMITS[name], perDay: directorFreeTurnsPerDay() }
		: RATE_LIMITS[name];
	const result = await getRateLimiter().check(rule, name, key);
	if (result.limited) {
		const message =
			result.window === "day"
				? (dailyMessage ?? DEFAULT_LIMIT_MESSAGE)
				: (minuteMessage ?? DEFAULT_LIMIT_MESSAGE);
		return NextResponse.json(
			{ error: message },
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
