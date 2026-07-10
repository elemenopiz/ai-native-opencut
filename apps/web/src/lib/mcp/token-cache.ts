/**
 * Verification cache for MCP project tokens.
 *
 * `verifyProjectToken` otherwise hits Postgres on EVERY MCP request (a select
 * plus a best-effort `lastUsedAt` write). External agents call the endpoint in
 * tight loops, so this caches the resolved `hash → grant` mapping for a short
 * TTL and lets repeat calls skip the database.
 *
 * One interface, two implementations, selected automatically:
 *  - {@link RedisTokenCache} — Upstash/Redis when configured. Shared across
 *    server instances, same client style as `rate-limit.ts` and the better-auth
 *    `secondaryStorage`.
 *  - {@link InMemoryTokenCache} — a TTL Map fallback when Upstash is
 *    unconfigured (single instance: dev / self-hosted). Nothing to set up.
 *
 * CORRECTNESS / SECURITY:
 *  - Only POSITIVE grants are cached, and only for {@link TTL_SECONDS}. A token
 *    that is revoked out-of-band keeps verifying for at most that window; the
 *    revoke route (`/api/mcp/tokens` DELETE) also evicts the key via
 *    {@link TokenCache.delete}, making revocation effectively immediate.
 *  - Revoked/unknown tokens are never cached (the DB path returns before `set`).
 *  - Every cache op is best-effort: a Redis error resolves to a miss / no-op so
 *    the request falls through to the DB instead of failing.
 */

import { Redis } from "@upstash/redis";
import type { VerifiedToken } from "./auth";

/** How long a verified grant stays cached. Short: bounds post-revocation reuse. */
export const TTL_SECONDS = 30;
const TTL_MS = TTL_SECONDS * 1000;
/** Key namespace in Redis (and the in-memory map is process-local anyway). */
const KEY_PREFIX = "mcp-token:";
/** Soft cap on the in-memory map so a burst of distinct tokens can't grow it unbounded. */
const IN_MEMORY_MAX_ENTRIES = 1024;

/** Placeholder env defaults from `@byorn/env/web` — treated as "not configured". */
const PLACEHOLDER_URL = "http://localhost:8079";
const PLACEHOLDER_TOKEN = "example_token";

/**
 * Upstash credentials, read straight from `process.env` (Next.js populates it
 * from `.env*`). We intentionally do NOT import the validated `webEnv` here: it
 * validates the app's full env at import time, which would couple this module —
 * and its unit tests — to unrelated vars like `DATABASE_URL`.
 */
function upstashEnv(): { url?: string; token?: string } {
	return {
		url: process.env.UPSTASH_REDIS_REST_URL,
		token: process.env.UPSTASH_REDIS_REST_TOKEN,
	};
}

/**
 * True when real Upstash credentials are present (set and not the env-schema
 * placeholders). Drives the in-memory fallback.
 */
export function isUpstashConfigured(): boolean {
	const { url, token } = upstashEnv();
	return (
		!!url && !!token && url !== PLACEHOLDER_URL && token !== PLACEHOLDER_TOKEN
	);
}

/** Swap-in surface: `verifyProjectToken` depends only on this, not on Redis. */
export interface TokenCache {
	/** A cached grant for this token hash, or null on miss/error. */
	get(hash: string): Promise<VerifiedToken | null>;
	/** Cache a verified grant for {@link TTL_SECONDS}. Best-effort. */
	set(hash: string, grant: VerifiedToken): Promise<void>;
	/** Evict a token hash immediately (called on revoke). Best-effort. */
	delete(hash: string): Promise<void>;
}

/** Process-local TTL map. Used when Upstash is unconfigured. */
export class InMemoryTokenCache implements TokenCache {
	private store = new Map<
		string,
		{ grant: VerifiedToken; expiresAt: number }
	>();

	async get(hash: string): Promise<VerifiedToken | null> {
		const entry = this.store.get(hash);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.store.delete(hash);
			return null;
		}
		return entry.grant;
	}

	async set(hash: string, grant: VerifiedToken): Promise<void> {
		if (this.store.size >= IN_MEMORY_MAX_ENTRIES) this.prune();
		this.store.set(hash, { grant, expiresAt: Date.now() + TTL_MS });
	}

	async delete(hash: string): Promise<void> {
		this.store.delete(hash);
	}

	/** Drop expired entries; if still at cap, evict the oldest insertion. */
	private prune(): void {
		const now = Date.now();
		for (const [key, entry] of this.store) {
			if (entry.expiresAt <= now) this.store.delete(key);
		}
		while (this.store.size >= IN_MEMORY_MAX_ENTRIES) {
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) break;
			this.store.delete(oldest);
		}
	}
}

/** Upstash/Redis-backed cache. Shared across instances; all ops fail soft. */
export class RedisTokenCache implements TokenCache {
	constructor(private readonly redis: Redis) {}

	private key(hash: string): string {
		return `${KEY_PREFIX}${hash}`;
	}

	async get(hash: string): Promise<VerifiedToken | null> {
		try {
			// @upstash/redis JSON-parses stored objects on read.
			const value = await this.redis.get<VerifiedToken>(this.key(hash));
			return value ?? null;
		} catch {
			return null; // treat as a miss → caller hits the DB
		}
	}

	async set(hash: string, grant: VerifiedToken): Promise<void> {
		try {
			await this.redis.set(this.key(hash), grant, { ex: TTL_SECONDS });
		} catch {
			/* non-fatal: verification still succeeded without caching */
		}
	}

	async delete(hash: string): Promise<void> {
		try {
			await this.redis.del(this.key(hash));
		} catch {
			/* non-fatal: entry expires on its own within TTL_SECONDS */
		}
	}
}

/** Build the implementation appropriate for the current environment. */
export function createTokenCache(): TokenCache {
	const { url, token } = upstashEnv();
	// Inlined (rather than `isUpstashConfigured()`) so TS narrows url/token to
	// `string` for the Redis constructor.
	if (url && token && url !== PLACEHOLDER_URL && token !== PLACEHOLDER_TOKEN) {
		return new RedisTokenCache(new Redis({ url, token }));
	}
	return new InMemoryTokenCache();
}

/**
 * Process-wide singleton, cached on `globalThis` so Next.js dev HMR doesn't
 * orphan the in-memory map (mirrors `editor-bridge.ts` / `mcp-session-store.ts`).
 */
const globalStore = globalThis as unknown as {
	__byornMcpTokenCache?: TokenCache;
};

export function getTokenCache(): TokenCache {
	globalStore.__byornMcpTokenCache ??= createTokenCache();
	return globalStore.__byornMcpTokenCache;
}
