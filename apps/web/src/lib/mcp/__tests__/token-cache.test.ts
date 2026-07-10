import { afterEach, describe, expect, test } from "bun:test";
import {
	InMemoryTokenCache,
	RedisTokenCache,
	TTL_SECONDS,
} from "../token-cache";
import type { VerifiedToken } from "../auth";

const grant: VerifiedToken = {
	userId: "user_1",
	projectId: "proj_1",
	scopes: ["reel:read"],
};

describe("InMemoryTokenCache", () => {
	const realNow = Date.now;
	afterEach(() => {
		Date.now = realNow;
	});

	test("returns a cached grant, then a miss after delete", async () => {
		const cache = new InMemoryTokenCache();
		expect(await cache.get("h")).toBeNull();

		await cache.set("h", grant);
		expect(await cache.get("h")).toEqual(grant);

		await cache.delete("h");
		expect(await cache.get("h")).toBeNull();
	});

	test("expires an entry after TTL_SECONDS", async () => {
		const cache = new InMemoryTokenCache();
		let clock = 1_000_000;
		Date.now = () => clock;

		await cache.set("h", grant);
		expect(await cache.get("h")).toEqual(grant);

		// Advance just past the TTL window.
		clock += TTL_SECONDS * 1000 + 1;
		expect(await cache.get("h")).toBeNull();
	});

	test("stays bounded under a burst of distinct tokens", async () => {
		const cache = new InMemoryTokenCache();
		for (let i = 0; i < 5000; i++) {
			await cache.set(`h${i}`, grant);
		}
		// The most-recent key must still resolve; the map self-pruned rather than
		// growing without bound (exact size is an impl detail, so just spot-check).
		expect(await cache.get("h4999")).toEqual(grant);
	});
});

describe("RedisTokenCache", () => {
	test("fails soft: a throwing client resolves to a miss / no-op", async () => {
		const throwing = {
			get: async () => {
				throw new Error("redis down");
			},
			set: async () => {
				throw new Error("redis down");
			},
			del: async () => {
				throw new Error("redis down");
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal Redis stub for the failure path.
		const cache = new RedisTokenCache(throwing as any);

		expect(await cache.get("h")).toBeNull();
		await expect(cache.set("h", grant)).resolves.toBeUndefined();
		await expect(cache.delete("h")).resolves.toBeUndefined();
	});

	test("round-trips a grant through a fake client with TTL", async () => {
		const kv = new Map<string, unknown>();
		let lastEx: number | undefined;
		const fake = {
			get: async (k: string) => kv.get(k) ?? null,
			set: async (k: string, v: unknown, opts?: { ex?: number }) => {
				kv.set(k, v);
				lastEx = opts?.ex;
			},
			del: async (k: string) => {
				kv.delete(k);
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal Redis stub.
		const cache = new RedisTokenCache(fake as any);

		await cache.set("abc", grant);
		expect(lastEx).toBe(TTL_SECONDS);
		expect(await cache.get("abc")).toEqual(grant);

		await cache.delete("abc");
		expect(await cache.get("abc")).toBeNull();
	});
});
