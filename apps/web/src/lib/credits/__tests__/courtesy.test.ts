import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
import {
	InsufficientCredits,
	getAccount,
	grant,
	lifetimeGranted,
	reserve,
	settle,
} from "@/lib/credits/ledger";
import { meteredReserve } from "@/lib/credits/metering";
import {
	BETA_COURTESY_BACKSTOP_CREDITS,
	SIGNUP_GRANT_CREDITS,
} from "@/lib/credits/signup-grant";

/**
 * Beta courtesy auto-extension (soft allowance) — MONEY-ADJACENT, so this runs
 * against the real local Postgres in the ledger.test.ts style: fresh
 * throwaway users, cleaned up after every test. Requires CREDITS_ENFORCED
 * (the schema default) — with metering off, meteredReserve is a no-op and the
 * courtesy path never runs.
 */

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = `courtesytest-${crypto.randomUUID()}`;
	await db.insert(users).values({
		id,
		name: "Courtesy Test",
		email: `${id}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	createdUserIds.push(id);
	return id;
}

async function cleanup(ids: string[]) {
	if (ids.length === 0) return;
	await db.delete(creditLedger).where(inArray(creditLedger.userId, ids));
	await db.delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
	await db.delete(users).where(inArray(users.id, ids));
}

afterEach(async () => {
	const ids = [...createdUserIds];
	createdUserIds.length = 0;
	await cleanup(ids);
});

afterAll(async () => {
	await db
		.delete(creditLedger)
		.where(like(creditLedger.userId, "courtesytest-%"));
	await db
		.delete(creditAccounts)
		.where(like(creditAccounts.userId, "courtesytest-%"));
	await db.delete(users).where(like(users.id, "courtesytest-%"));
});

async function courtesyGrants(userId: string): Promise<number[]> {
	const rows = await db
		.select({ delta: creditLedger.delta })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.reason, "beta_courtesy"),
			),
		);
	return rows.map((r) => r.delta);
}

describe("meteredReserve — beta courtesy extension (soft allowance)", () => {
	it("extends by one allowance chunk instead of blocking when the balance runs dry", async () => {
		const userId = await makeUser();
		await grant(userId, SIGNUP_GRANT_CREDITS, { reason: "signup_grant" });

		// Burn the whole allowance the honest way: reserve + settle.
		await reserve(userId, SIGNUP_GRANT_CREDITS, {
			refType: "studio_job",
			refId: "burn",
			idempotencyKey: "burn:reserve",
		});
		await settle(userId, SIGNUP_GRANT_CREDITS, {
			refType: "studio_job",
			refId: "burn",
			idempotencyKey: "burn:settle",
		});
		expect((await getAccount(userId)).spendable).toBe(0);

		// The next paid action does NOT 402 — a courtesy chunk covers it.
		const state = await meteredReserve(userId, 50, {
			refType: "studio_job",
			refId: "after-allowance",
			idempotencyKey: "after-allowance:reserve",
		});
		expect(state?.reserved).toBe(50);

		expect(await courtesyGrants(userId)).toEqual([SIGNUP_GRANT_CREDITS]);
		expect(await lifetimeGranted(userId)).toBe(2 * SIGNUP_GRANT_CREDITS);
	});

	it("grants enough chunks to cover an ask larger than one allowance", async () => {
		const userId = await makeUser();
		await grant(userId, SIGNUP_GRANT_CREDITS, { reason: "signup_grant" });

		// Ask for 1400 with 650 spendable: shortfall 750 ⇒ two 650 chunks.
		const state = await meteredReserve(userId, 1400, {
			refType: "studio_job",
			refId: "big-ask",
			idempotencyKey: "big-ask:reserve",
		});
		expect(state?.reserved).toBe(1400);
		expect(await courtesyGrants(userId)).toEqual([2 * SIGNUP_GRANT_CREDITS]);
	});

	it("stops extending at the lifetime backstop — the hard 402 wall returns", async () => {
		const userId = await makeUser();
		await grant(userId, BETA_COURTESY_BACKSTOP_CREDITS, {
			reason: "signup_grant",
		});
		await reserve(userId, BETA_COURTESY_BACKSTOP_CREDITS, {
			refType: "studio_job",
			refId: "burn-all",
			idempotencyKey: "burn-all:reserve",
		});
		await settle(userId, BETA_COURTESY_BACKSTOP_CREDITS, {
			refType: "studio_job",
			refId: "burn-all",
			idempotencyKey: "burn-all:settle",
		});

		let thrown: unknown;
		try {
			await meteredReserve(userId, 50, {
				refType: "studio_job",
				refId: "past-backstop",
				idempotencyKey: "past-backstop:reserve",
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(InsufficientCredits);
		expect(await courtesyGrants(userId)).toEqual([]);
	});

	it("is idempotent on the lifetime-granted watermark — a raced retry can't stack extensions", async () => {
		const userId = await makeUser();
		await grant(userId, SIGNUP_GRANT_CREDITS, { reason: "signup_grant" });
		await reserve(userId, SIGNUP_GRANT_CREDITS, {
			refType: "studio_job",
			refId: "burn2",
			idempotencyKey: "burn2:reserve",
		});
		await settle(userId, SIGNUP_GRANT_CREDITS, {
			refType: "studio_job",
			refId: "burn2",
			idempotencyKey: "burn2:settle",
		});

		// Two concurrent dry-balance reserves: both see the same watermark, so
		// the courtesy grant applies ONCE; both asks fit inside the single
		// 650-credit extension.
		const results = await Promise.allSettled([
			meteredReserve(userId, 50, {
				refType: "studio_job",
				refId: "race-1",
				idempotencyKey: "race-1:reserve",
			}),
			meteredReserve(userId, 50, {
				refType: "studio_job",
				refId: "race-2",
				idempotencyKey: "race-2:reserve",
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		expect(await courtesyGrants(userId)).toEqual([SIGNUP_GRANT_CREDITS]);
	});

	it("still charges normally while the allowance lasts — no premature extension", async () => {
		const userId = await makeUser();
		await grant(userId, SIGNUP_GRANT_CREDITS, { reason: "signup_grant" });

		const state = await meteredReserve(userId, 500, {
			refType: "studio_job",
			refId: "within",
			idempotencyKey: "within:reserve",
		});
		expect(state?.reserved).toBe(500);
		expect(await courtesyGrants(userId)).toEqual([]);
		expect(await lifetimeGranted(userId)).toBe(SIGNUP_GRANT_CREDITS);
	});
});
