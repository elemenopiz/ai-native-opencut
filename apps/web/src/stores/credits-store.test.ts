import { describe, expect, it } from "bun:test";
import { pacingNudgeChunk } from "@/stores/credits-store";
import {
	OWNER_GRANT_CREDITS,
	SIGNUP_GRANT_CREDITS,
} from "@/lib/credits/signup-grant";

describe("pacingNudgeChunk — the beta 'pace yourself' trigger", () => {
	it("stays quiet while the allowance lasts", () => {
		// Fresh account: granted 650, spent nothing.
		expect(pacingNudgeChunk(SIGNUP_GRANT_CREDITS, SIGNUP_GRANT_CREDITS)).toBe(
			null,
		);
		// Spent 649 of 650.
		expect(pacingNudgeChunk(SIGNUP_GRANT_CREDITS, 1)).toBe(null);
	});

	it("fires chunk 1 exactly when the full allowance is spent", () => {
		expect(pacingNudgeChunk(SIGNUP_GRANT_CREDITS, 0)).toBe(1);
		// Courtesy-extended: granted 1300, spent 650, 650 fresh in the tank.
		expect(
			pacingNudgeChunk(2 * SIGNUP_GRANT_CREDITS, SIGNUP_GRANT_CREDITS),
		).toBe(1);
	});

	it("advances a chunk per allowance spent — one nudge per extension", () => {
		// granted 1300, spent 1300.
		expect(pacingNudgeChunk(2 * SIGNUP_GRANT_CREDITS, 0)).toBe(2);
		// granted 1950, spent 1400.
		expect(pacingNudgeChunk(3 * SIGNUP_GRANT_CREDITS, 550)).toBe(2);
	});

	it("exempts owner-scale accounts and empty/weird states", () => {
		// The 1M owner grant never nags, no matter the spend.
		expect(pacingNudgeChunk(OWNER_GRANT_CREDITS, 0)).toBe(null);
		// Never granted anything.
		expect(pacingNudgeChunk(0, 0)).toBe(null);
		// Balance above granted (admin oddity) clamps to zero spend.
		expect(pacingNudgeChunk(SIGNUP_GRANT_CREDITS, 9_999)).toBe(null);
	});
});
