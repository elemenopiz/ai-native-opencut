import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { and, eq, inArray, like, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
import {
	InsufficientCredits,
	getAccount,
	grant,
	release,
	reserve,
	settle,
} from "@/lib/credits/ledger";
import { insufficientCreditsResponse } from "@/lib/credits/metering";

/**
 * MONEY-ADJACENT correctness. Runs against the real local Postgres (bun loads
 * apps/web/.env.local): the concurrency + transaction/idempotency behavior we
 * care about only exists at the DB, so mocking the db here would test nothing.
 *
 * Each test uses a FRESH throwaway user; all of them are cleaned up in afterAll.
 */

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = `credtest-${crypto.randomUUID()}`;
	await db.insert(users).values({
		id,
		name: "Credit Test",
		email: `${id}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	createdUserIds.push(id);
	return id;
}

/** Count the actual charge (debit) rows for a user — proves "no debit". */
async function debitCount(userId: string): Promise<number> {
	const rows = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(and(eq(creditLedger.userId, userId), lt(creditLedger.delta, 0)));
	return rows.length;
}

async function cleanup(ids: string[]) {
	if (ids.length === 0) return;
	await db.delete(creditLedger).where(inArray(creditLedger.userId, ids));
	await db.delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
	await db.delete(users).where(inArray(users.id, ids));
}

// Clean up each test's throwaway users right after it runs, so re-running the
// suite (shared local DB) always starts from a clean slate.
afterEach(async () => {
	const ids = [...createdUserIds];
	createdUserIds.length = 0;
	await cleanup(ids);
});

// Belt-and-suspenders: sweep any stragglers from a previously crashed run.
afterAll(async () => {
	await db.delete(creditLedger).where(like(creditLedger.userId, "credtest-%"));
	await db
		.delete(creditAccounts)
		.where(like(creditAccounts.userId, "credtest-%"));
	await db.delete(users).where(like(users.id, "credtest-%"));
});

describe("ledger — reserve", () => {
	it("(d) throws InsufficientCredits when spendable < cost", async () => {
		const userId = await makeUser();
		await grant(userId, 10, { reason: "test" });

		let thrown: unknown;
		try {
			await reserve(userId, 20, {
				refType: "test",
				refId: "job-d",
				idempotencyKey: "job-d:reserve",
			});
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(InsufficientCredits);
		expect((thrown as InsufficientCredits).needed).toBe(20);
		expect((thrown as InsufficientCredits).spendable).toBe(10);

		// The failed reserve left nothing behind — no hold, no marker row.
		const acct = await getAccount(userId);
		expect(acct.reserved).toBe(0);
		expect(acct.spendable).toBe(10);
	});

	it("(a) two concurrent reserves can't oversell", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });

		// Both ask for 60 against a 100 balance — exactly one can win.
		const results = await Promise.allSettled([
			reserve(userId, 60, {
				refType: "test",
				refId: "job-a1",
				idempotencyKey: "job-a1:reserve",
			}),
			reserve(userId, 60, {
				refType: "test",
				refId: "job-a2",
				idempotencyKey: "job-a2:reserve",
			}),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			InsufficientCredits,
		);

		// Only one hold stuck: reserved 60, spendable 40 — never oversold.
		const acct = await getAccount(userId);
		expect(acct.reserved).toBe(60);
		expect(acct.spendable).toBe(40);
	});
});

describe("ledger — settle", () => {
	it("(b) settle is idempotent (double-call charges once)", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		await reserve(userId, 30, {
			refType: "test",
			refId: "job-b",
			idempotencyKey: "job-b:reserve",
		});

		const opts = {
			refType: "test",
			refId: "job-b",
			idempotencyKey: "job-b:settle",
		};
		await settle(userId, 30, opts);
		await settle(userId, 30, opts); // retried completion callback

		const acct = await getAccount(userId);
		expect(acct.balance).toBe(70); // charged exactly once
		expect(acct.reserved).toBe(0);
		expect(acct.spendable).toBe(70);
		expect(await debitCount(userId)).toBe(1); // one debit row, not two
	});
});

describe("ledger — release", () => {
	it("(c) release refunds a hold without a debit", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		await reserve(userId, 40, {
			refType: "test",
			refId: "job-c",
			idempotencyKey: "job-c:reserve",
		});

		let acct = await getAccount(userId);
		expect(acct.reserved).toBe(40);
		expect(acct.spendable).toBe(60);

		await release(userId, 40, {
			refType: "test",
			refId: "job-c",
			idempotencyKey: "job-c:release",
		});

		acct = await getAccount(userId);
		expect(acct.balance).toBe(100); // balance untouched
		expect(acct.reserved).toBe(0); // hold freed
		expect(acct.spendable).toBe(100); // fully refunded
		expect(await debitCount(userId)).toBe(0); // never charged for the failure
	});

	it("release is idempotent across repeated calls (can't free extra)", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		// Two independent holds so a double-release could wrongly free the second.
		await reserve(userId, 30, {
			refType: "test",
			refId: "job-c1",
			idempotencyKey: "job-c1:reserve",
		});
		await reserve(userId, 30, {
			refType: "test",
			refId: "job-c2",
			idempotencyKey: "job-c2:reserve",
		});

		const rel = {
			refType: "test",
			refId: "job-c1",
			idempotencyKey: "job-c1:release",
		};
		await release(userId, 30, rel);
		await release(userId, 30, rel); // re-poll of the same failed job

		const acct = await getAccount(userId);
		// Only job-c1's hold was freed; job-c2 stays reserved.
		expect(acct.reserved).toBe(30);
		expect(acct.spendable).toBe(70);
	});
});

describe("ledger — grant", () => {
	it("is idempotent on its derived key", async () => {
		const userId = await makeUser();
		await grant(userId, 50, { reason: "test", refType: "seed", refId: "one" });
		await grant(userId, 50, { reason: "test", refType: "seed", refId: "one" });

		const acct = await getAccount(userId);
		expect(acct.balance).toBe(50); // applied once
	});
});

describe("402 gate", () => {
	it("insufficient credits → HTTP 402 with { needed, spendable }", async () => {
		const userId = await makeUser(); // zero balance

		let res: Response | undefined;
		try {
			await reserve(userId, 5, {
				refType: "studio_job",
				refId: "job-402",
				idempotencyKey: "job-402:reserve",
			});
		} catch (err) {
			expect(err).toBeInstanceOf(InsufficientCredits);
			res = insufficientCreditsResponse(err as InsufficientCredits);
		}

		expect(res).toBeDefined();
		expect(res?.status).toBe(402);
		const body = await res?.json();
		expect(body).toEqual({
			error: "insufficient_credits",
			needed: 5,
			spendable: 0,
		});
	});
});
