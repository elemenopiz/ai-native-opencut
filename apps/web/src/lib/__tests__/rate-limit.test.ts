import { afterEach, describe, expect, test } from "bun:test";
import {
	InMemoryRateLimiter,
	enforceRateLimit,
	getRateLimiter,
	type RateLimitRule,
} from "../rate-limit";

const rule: RateLimitRule = { perMinute: 3, perDay: 100 };

describe("InMemoryRateLimiter", () => {
	const realNow = Date.now;
	afterEach(() => {
		Date.now = realNow;
	});

	test("rejects the Nth+1 request within the minute window", async () => {
		const limiter = new InMemoryRateLimiter();
		// The first `perMinute` requests pass...
		for (let i = 0; i < rule.perMinute; i++) {
			const { success } = await limiter.check(rule, "bucket", "user:a");
			expect(success).toBe(true);
		}
		// ...and the next one is rejected.
		const overflow = await limiter.check(rule, "bucket", "user:a");
		expect(overflow.success).toBe(false);
		expect(overflow.limited).toBe(true);
	});

	test("keys are isolated: one user's spend doesn't limit another", async () => {
		const limiter = new InMemoryRateLimiter();
		for (let i = 0; i < rule.perMinute; i++) {
			await limiter.check(rule, "bucket", "user:a");
		}
		// user:a is now exhausted, but user:b starts fresh.
		expect((await limiter.check(rule, "bucket", "user:a")).success).toBe(false);
		expect((await limiter.check(rule, "bucket", "user:b")).success).toBe(true);
	});

	test("buckets are isolated: different routes count separately", async () => {
		const limiter = new InMemoryRateLimiter();
		for (let i = 0; i < rule.perMinute; i++) {
			await limiter.check(rule, "route:x", "user:a");
		}
		expect((await limiter.check(rule, "route:x", "user:a")).success).toBe(
			false,
		);
		expect((await limiter.check(rule, "route:y", "user:a")).success).toBe(true);
	});

	test("the window resets after it elapses", async () => {
		const limiter = new InMemoryRateLimiter();
		let clock = 1_000_000;
		Date.now = () => clock;

		for (let i = 0; i < rule.perMinute; i++) {
			await limiter.check(rule, "bucket", "user:a");
		}
		expect((await limiter.check(rule, "bucket", "user:a")).success).toBe(false);

		// Advance past the 1-minute window; the counter resets.
		clock += 60_000 + 1;
		expect((await limiter.check(rule, "bucket", "user:a")).success).toBe(true);
	});

	test("the per-day cap still bites within a single minute", async () => {
		const limiter = new InMemoryRateLimiter();
		// perMinute high enough not to interfere; perDay is the binding cap.
		const dayRule: RateLimitRule = { perMinute: 1000, perDay: 5 };
		for (let i = 0; i < dayRule.perDay; i++) {
			expect((await limiter.check(dayRule, "bucket", "u")).success).toBe(true);
		}
		expect((await limiter.check(dayRule, "bucket", "u")).success).toBe(false);
	});

	test("a request rejected by the minute cap does NOT consume the day budget", async () => {
		const limiter = new InMemoryRateLimiter();
		let clock = 1_000_000;
		Date.now = () => clock;
		// 2/min burst, 3/day volume. A 4-request burst in one minute would, if the
		// day window were consumed even on minute-rejected requests, spend all 3
		// day tokens after only 2 ever passed — locking the user out for the day.
		const r: RateLimitRule = { perMinute: 2, perDay: 3 };

		// First two pass (both windows consumed). The next two are rejected by the
		// burst cap and must NOT touch the day window.
		expect((await limiter.check(r, "bucket", "u")).success).toBe(true);
		expect((await limiter.check(r, "bucket", "u")).success).toBe(true);
		expect((await limiter.check(r, "bucket", "u")).success).toBe(false);
		expect((await limiter.check(r, "bucket", "u")).success).toBe(false);

		// Advance past the 1-minute window so the burst cap resets; the day window
		// (24h) is still open with only 2 tokens spent (not 4). One more request
		// must therefore pass — proving the rejected burst didn't drain the day
		// budget. Under the old always-consume behavior this would already be over.
		clock += 60_000 + 1;
		expect((await limiter.check(r, "bucket", "u")).success).toBe(true);

		// Now the day cap (3) is genuinely reached: the next request clears the
		// fresh minute window but is rejected by the day window.
		expect((await limiter.check(r, "bucket", "u")).success).toBe(false);
	});
});

describe("enforceRateLimit", () => {
	test("returns a 429 NextResponse once the named limit is exceeded", async () => {
		// The default env (no real Upstash creds) selects the in-memory limiter,
		// so this exercises the real end-to-end path a route would hit.
		expect(getRateLimiter()).toBeInstanceOf(InMemoryRateLimiter);

		const request = new Request("http://localhost/api/studio/promote", {
			headers: { "x-forwarded-for": "203.0.113.7" },
		});
		const userId = `promote-user-${Math.random()}`;

		// `studio:promote` allows 6/min. Exhaust the burst window.
		for (let i = 0; i < 6; i++) {
			const res = await enforceRateLimit({
				name: "studio:promote",
				request,
				userId,
			});
			expect(res).toBeNull();
		}

		// The 7th request is rejected with a ready-to-return 429.
		const limited = await enforceRateLimit({
			name: "studio:promote",
			request,
			userId,
		});
		expect(limited).not.toBeNull();
		expect(limited?.status).toBe(429);
		expect(limited?.headers.get("Retry-After")).toBe("60");
	});
});
