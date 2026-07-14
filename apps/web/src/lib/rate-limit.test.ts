/**
 * Coverage for the Director free-tier daily cap and window-specific 429 copy
 * added to `enforceRateLimit`. Existing callers that don't pass
 * `dailyMessage`/`minuteMessage` are unaffected (the generic message still
 * applies) — that contract is exercised by the existing `llm:agent`/
 * `llm:gemini` route tests, which mock this whole module.
 *
 * This file drives `InMemoryRateLimiter` and `enforceRateLimit` directly
 * (no Upstash env set → `getRateLimiter()` picks the in-memory backend), so
 * every test uses a fresh `userId` to avoid cross-test window pollution on
 * the process-wide singleton.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { InMemoryRateLimiter, enforceRateLimit } from "./rate-limit";
import type { RateLimitRule } from "./rate-limit";

const savedDirectorCap = process.env.DIRECTOR_FREE_TURNS_PER_DAY;
afterEach(() => {
	if (savedDirectorCap === undefined) {
		delete process.env.DIRECTOR_FREE_TURNS_PER_DAY;
	} else {
		process.env.DIRECTOR_FREE_TURNS_PER_DAY = savedDirectorCap;
	}
});

let counter = 0;
/** A fresh key per test so counters from earlier tests never bleed in. */
function uniqueUserId(): string {
	counter += 1;
	return `rate-limit-test-user-${Date.now()}-${counter}`;
}

function makeReq(): Request {
	return new Request("http://localhost/api/test", { headers: new Headers() });
}

// ── InMemoryRateLimiter: window reporting ───────────────────────────────────

test("InMemoryRateLimiter reports window:'minute' when the burst cap trips", async () => {
	const limiter = new InMemoryRateLimiter();
	const rule: RateLimitRule = { perMinute: 2, perDay: 100 };
	const key = uniqueUserId();

	expect((await limiter.check(rule, "test-bucket", key)).limited).toBe(false);
	expect((await limiter.check(rule, "test-bucket", key)).limited).toBe(false);
	const third = await limiter.check(rule, "test-bucket", key);
	expect(third.limited).toBe(true);
	expect(third.window).toBe("minute");
});

test("InMemoryRateLimiter reports window:'day' when the daily cap trips (burst cap not tripped)", async () => {
	const limiter = new InMemoryRateLimiter();
	// perMinute generous, perDay tight — the day window trips first.
	const rule: RateLimitRule = { perMinute: 100, perDay: 2 };
	const key = uniqueUserId();

	expect((await limiter.check(rule, "test-bucket", key)).limited).toBe(false);
	expect((await limiter.check(rule, "test-bucket", key)).limited).toBe(false);
	const third = await limiter.check(rule, "test-bucket", key);
	expect(third.limited).toBe(true);
	expect(third.window).toBe("day");
});

test("a request rejected by the minute cap does not also consume a day token", async () => {
	const limiter = new InMemoryRateLimiter();
	const rule: RateLimitRule = { perMinute: 1, perDay: 5 };
	const key = uniqueUserId();

	await limiter.check(rule, "test-bucket", key); // consumes the only minute + day token
	// Every subsequent call this "minute" is rejected by the burst cap, so the
	// day window (5 allowed) must still have 4 left — never falls to window:"day".
	for (let i = 0; i < 4; i++) {
		const result = await limiter.check(rule, "test-bucket", key);
		expect(result.limited).toBe(true);
		expect(result.window).toBe("minute");
	}
});

// ── enforceRateLimit: window-specific copy + DIRECTOR_FREE_TURNS_PER_DAY ────

test("enforceRateLimit falls back to the generic message when no overrides are given", async () => {
	const userId = uniqueUserId();
	process.env.DIRECTOR_FREE_TURNS_PER_DAY = "1";
	await enforceRateLimit({ name: "llm:agent", request: makeReq(), userId });
	const limited = await enforceRateLimit({
		name: "llm:agent",
		request: makeReq(),
		userId,
	});
	expect(limited).not.toBeNull();
	const body = (await limited!.json()) as { error: string };
	expect(body.error).toBe(
		"Rate limit exceeded. Please slow down and try again shortly.",
	);
});

test("enforceRateLimit uses dailyMessage once DIRECTOR_FREE_TURNS_PER_DAY is exhausted", async () => {
	const userId = uniqueUserId();
	process.env.DIRECTOR_FREE_TURNS_PER_DAY = "1";
	await enforceRateLimit({
		name: "llm:agent",
		request: makeReq(),
		userId,
		dailyMessage: "DAILY_CAP_HIT",
		minuteMessage: "BURST_CAP_HIT",
	});
	const limited = await enforceRateLimit({
		name: "llm:agent",
		request: makeReq(),
		userId,
		dailyMessage: "DAILY_CAP_HIT",
		minuteMessage: "BURST_CAP_HIT",
	});
	expect(limited).not.toBeNull();
	expect(limited!.status).toBe(429);
	const body = (await limited!.json()) as { error: string };
	expect(body.error).toBe("DAILY_CAP_HIT");
});

test("enforceRateLimit uses minuteMessage when the burst cap (not the daily cap) trips", async () => {
	const userId = uniqueUserId();
	// Daily cap generous, so 11 rapid calls trip only the fixed 10/min burst cap.
	process.env.DIRECTOR_FREE_TURNS_PER_DAY = "1000";
	let limited: Awaited<ReturnType<typeof enforceRateLimit>> = null;
	for (let i = 0; i < 11; i++) {
		limited = await enforceRateLimit({
			name: "llm:agent",
			request: makeReq(),
			userId,
			dailyMessage: "DAILY_CAP_HIT",
			minuteMessage: "BURST_CAP_HIT",
		});
	}
	expect(limited).not.toBeNull();
	const body = (await limited!.json()) as { error: string };
	expect(body.error).toBe("BURST_CAP_HIT");
});

test("DIRECTOR_FREE_TURNS_PER_DAY governs both llm:agent and llm:gemini independently per user+bucket", async () => {
	const userId = uniqueUserId();
	process.env.DIRECTOR_FREE_TURNS_PER_DAY = "1";
	// Exhaust llm:agent's daily cap.
	await enforceRateLimit({ name: "llm:agent", request: makeReq(), userId });
	const agentLimited = await enforceRateLimit({
		name: "llm:agent",
		request: makeReq(),
		userId,
	});
	expect(agentLimited).not.toBeNull();
	// llm:gemini is a distinct bucket for the same user — still has its 1 free turn.
	const geminiFirst = await enforceRateLimit({
		name: "llm:gemini",
		request: makeReq(),
		userId,
	});
	expect(geminiFirst).toBeNull();
});

test("invalid DIRECTOR_FREE_TURNS_PER_DAY does not collapse the daily cap to 0/NaN", async () => {
	const userId = uniqueUserId();
	process.env.DIRECTOR_FREE_TURNS_PER_DAY = "not-a-number";
	// A NaN/0 limit would reject the FIRST call (count 1 > NaN or > 0 is always
	// true-ish for the failure branch) — a few calls well under both the 10/min
	// burst cap and the 150/day default should all succeed.
	for (let i = 0; i < 3; i++) {
		const limited = await enforceRateLimit({
			name: "llm:agent",
			request: makeReq(),
			userId,
		});
		expect(limited).toBeNull();
	}
});
