import { afterAll, describe, expect, it, mock } from "bun:test";
import { webEnv as realWebEnv } from "@byorn/env/web";

/**
 * Metering-layer behavior on top of the pure ledger:
 *  1. The `CREDITS_ENFORCED=false` kill-switch → metered wrappers are no-ops
 *     (no hold, no charge, no throw): paid generation runs free.
 *  2. The "reserve worst-case → settle exact → release the difference" pattern
 *     the persona-still route uses when the image router's chosen backend costs
 *     less than the reservation — the user is charged EXACTLY the routed cost.
 *
 * Runs against the real local Postgres (bun loads .env.local). The env module is
 * mocked to disable enforcement, spreading the REAL parsed env so every other
 * key (DATABASE_URL included) keeps its true value.
 */

// `mock.module` is GLOBAL to the whole `bun test` run (it leaks into every
// other test file), so the mock must preserve the real parsed env's full shape
// — a slimmed-down object breaks unrelated tests that read other webEnv keys
// (e.g. the llm/agent route reading DIRECTOR_MODEL). Spread the real module
// and override only the flag under test.
mock.module("@byorn/env/web", () => ({
	webEnv: {
		...realWebEnv,
		CREDITS_ENFORCED: false,
	},
}));

const { creditsEnforced, meteredRelease, meteredReserve, meteredSettle } =
	await import("@/lib/credits/metering");
// Raw ledger — these never consult the flag, so they exercise real DB behavior
// regardless of the mock above.
const { getAccount, grant, release, reserve, settle } = await import(
	"@/lib/credits/ledger"
);
const { db } = await import("@/lib/db");
const { users } = await import("@/lib/db/schema");
const { creditAccounts, creditLedger } = await import(
	"@/lib/db/schema-credits"
);
const { and, eq, inArray, lt, like } = await import("drizzle-orm");

const createdUserIds: string[] = [];
async function makeUser(): Promise<string> {
	const id = `credtest-${crypto.randomUUID()}`;
	await db.insert(users).values({
		id,
		name: "Metering Test",
		email: `${id}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	createdUserIds.push(id);
	return id;
}
async function debitCount(userId: string): Promise<number> {
	const rows = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(and(eq(creditLedger.userId, userId), lt(creditLedger.delta, 0)));
	return rows.length;
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await db
			.delete(creditLedger)
			.where(inArray(creditLedger.userId, createdUserIds));
		await db
			.delete(creditAccounts)
			.where(inArray(creditAccounts.userId, createdUserIds));
		await db.delete(users).where(inArray(users.id, createdUserIds));
	}
	await db.delete(creditLedger).where(like(creditLedger.userId, "credtest-%"));
	await db
		.delete(creditAccounts)
		.where(like(creditAccounts.userId, "credtest-%"));
	await db.delete(users).where(like(users.id, "credtest-%"));
});

describe("metering — CREDITS_ENFORCED=false kill-switch", () => {
	it("reports enforcement OFF", () => {
		expect(creditsEnforced()).toBe(false);
	});

	it("meteredReserve is a no-op: no hold, no throw even at zero balance", async () => {
		const user = await makeUser(); // zero balance
		const res = await meteredReserve(user, 50, {
			refType: "studio_job",
			refId: "job-free",
			idempotencyKey: "job-free:reserve",
		});
		expect(res).toBeNull(); // wrapper signals "not metered"
		const acct = await getAccount(user);
		expect(acct.reserved).toBe(0); // nothing held
		expect(acct.balance).toBe(0);
	});

	it("meteredSettle/meteredRelease are no-ops: no debit rows written", async () => {
		const user = await makeUser();
		await meteredSettle(user, 40, {
			refType: "studio_job",
			refId: "job-free",
			idempotencyKey: "job-free:settle",
		});
		await meteredRelease(user, 40, {
			refType: "studio_job",
			refId: "job-free",
			idempotencyKey: "job-free:release",
		});
		expect(await debitCount(user)).toBe(0);
	});
});

describe("metering — reserve worst-case, settle exact, release the difference", () => {
	it("charges exactly the routed cost and leaves reserved at zero", async () => {
		const user = await makeUser();
		await grant(user, 100, { reason: "test_seed" });

		// Persona-still pattern: reserve the default/max image cost (4), then the
		// router picks a cheaper backend so we settle 3 and release the 1 over-hold.
		const chargeId = "still-abc";
		await reserve(user, 4, {
			refType: "studio_job",
			refId: chargeId,
			idempotencyKey: `${chargeId}:reserve`,
		});
		let acct = await getAccount(user);
		expect(acct.reserved).toBe(4);
		expect(acct.spendable).toBe(96);

		await settle(user, 3, {
			refType: "studio_job",
			refId: chargeId,
			idempotencyKey: `${chargeId}:settle`,
		});
		await release(user, 1, {
			refType: "studio_job",
			refId: chargeId,
			idempotencyKey: `${chargeId}:release-diff`,
		});

		acct = await getAccount(user);
		expect(acct.balance).toBe(97); // charged exactly 3
		expect(acct.reserved).toBe(0); // over-hold fully freed
		expect(acct.spendable).toBe(97);
		expect(await debitCount(user)).toBe(1); // one charge, not two
	});
});
