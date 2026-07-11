import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
import { generationSets, takes } from "@/lib/db/schema-studio";
import { getAccount, grant, reserve } from "@/lib/credits/ledger";
import { sweepStaleHolds, type SweepPollResult } from "@/lib/credits/sweep";

/**
 * Settle-aware stale-hold sweep (finding #5) + the settle/sweep race (#3),
 * against the real local Postgres — same style as ledger.test.ts. The provider
 * poll is injected, so no provider env/keys are touched.
 *
 * The old sweep blindly RELEASED every stale hold, refunding videos that
 * completed after the user closed the tab. The sweep must now: settle holds
 * whose job verifiably completed (locally recorded videoUrl, or the provider
 * says completed), release verifiably-failed/unverifiable holds, and skip
 * still-live jobs.
 */

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = `credtest-${crypto.randomUUID()}`;
	await db.insert(users).values({
		id,
		name: "Sweep Test",
		email: `${id}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	createdUserIds.push(id);
	return id;
}

async function makeSet(userId: string): Promise<string> {
	const id = `credtest-set-${nanoid()}`;
	await db.insert(generationSets).values({
		id,
		userId,
		prompt: "sweep test",
		resolution: "720p",
		orientation: "landscape",
		duration: 5,
		mode: "text-to-video",
	});
	return id;
}

async function makeTake(
	setId: string,
	fields: Partial<typeof takes.$inferInsert> = {},
): Promise<string> {
	const id = fields.id ?? `credtest-take-${nanoid()}`;
	await db.insert(takes).values({
		id,
		setId,
		resolution: "720p",
		status: "drafting",
		...fields,
	});
	return id;
}

/** Place a hold and backdate its reserve marker past any sweep cutoff. */
async function staleHold(userId: string, refId: string, credits: number) {
	await reserve(userId, credits, {
		refType: "studio_job",
		refId,
		idempotencyKey: `${refId}:reserve`,
	});
	await db
		.update(creditLedger)
		.set({ createdAt: new Date(Date.now() - 6 * 60 * 60_000) })
		.where(eq(creditLedger.idempotencyKey, `${refId}:reserve`));
}

const neverPoll = async (): Promise<SweepPollResult> => {
	throw new Error("poll must not be called for locally-decided holds");
};

async function cleanup(ids: string[]) {
	if (ids.length === 0) return;
	const sets = await db
		.select({ id: generationSets.id })
		.from(generationSets)
		.where(inArray(generationSets.userId, ids));
	const setIds = sets.map((s) => s.id);
	if (setIds.length > 0) {
		await db.delete(takes).where(inArray(takes.setId, setIds));
		await db.delete(generationSets).where(inArray(generationSets.id, setIds));
	}
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
	const strays = await db
		.select({ id: users.id })
		.from(users)
		.where(like(users.id, "credtest-%"));
	await cleanup(strays.map((s) => s.id));
});

describe("sweep — settle-aware reconciliation (#5)", () => {
	it("SETTLES (not refunds) a hold whose take has a delivered video", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, {
			status: "kept",
			videoUrl: "https://r2.example/video.mp4",
		});
		await staleHold(userId, takeId, 50);

		const stats = await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		expect(stats.settled).toBe(1);
		expect(stats.released).toBe(0);
		const acct = await getAccount(userId);
		expect(acct.balance).toBe(50); // CHARGED — the video was delivered
		expect(acct.reserved).toBe(0);
	});

	it("releases a hold whose take recorded a failure", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, {
			errorMessage: "provider exploded",
		});
		await staleHold(userId, takeId, 50);

		const stats = await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		expect(stats.released).toBe(1);
		expect(stats.settled).toBe(0);
		const acct = await getAccount(userId);
		expect(acct.balance).toBe(100); // never charged for a failure
		expect(acct.reserved).toBe(0);
	});

	it("asks the provider when the local outcome is unknown: completed → settle", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, { providerJobId: "job-abc" });
		await staleHold(userId, takeId, 50);

		const polled: string[] = [];
		const stats = await sweepStaleHolds({
			minutes: 120,
			poll: async (jobId) => {
				polled.push(jobId);
				return { status: "completed" };
			},
		});

		expect(polled).toEqual(["job-abc"]);
		expect(stats.settled).toBe(1);
		expect((await getAccount(userId)).balance).toBe(50);
	});

	it("SKIPS a job the provider says is still running (never race a live job)", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, { providerJobId: "job-live" });
		await staleHold(userId, takeId, 50);

		const stats = await sweepStaleHolds({
			minutes: 120,
			poll: async () => ({ status: "processing" }),
		});

		expect(stats.skipped).toBe(1);
		expect(stats.settled).toBe(0);
		expect(stats.released).toBe(0);
		const acct = await getAccount(userId);
		expect(acct.reserved).toBe(50); // hold left open for a later run
	});

	it("releases when the provider can't verify the job (expired/unknown)", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, { providerJobId: "job-gone" });
		await staleHold(userId, takeId, 50);

		const stats = await sweepStaleHolds({
			minutes: 120,
			poll: async () => {
				throw new Error("task not found");
			},
		});

		expect(stats.released).toBe(1);
		expect((await getAccount(userId)).balance).toBe(100);
		expect((await getAccount(userId)).reserved).toBe(0);
	});

	it("releases a hold with no take at all (crashed request / image charge id)", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		await staleHold(userId, `credtest-charge-${nanoid()}`, 4);

		const stats = await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		expect(stats.released).toBe(1);
		const acct = await getAccount(userId);
		expect(acct.balance).toBe(100);
		expect(acct.reserved).toBe(0);
	});

	it("legacy setId hold resolves to the set's FIRST take (draft), not promote's later insert", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		// Draft (first insert) completed & delivered; promoted 1080p take failed
		// later in the same set. The setId hold belongs to the DRAFT → settle.
		await makeTake(setId, {
			status: "kept",
			videoUrl: "https://r2.example/draft.mp4",
			createdAt: new Date(Date.now() - 60_000),
		});
		await makeTake(setId, {
			status: "promoted",
			errorMessage: "1080p failed",
			createdAt: new Date(),
		});
		await staleHold(userId, setId, 50);

		const stats = await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		expect(stats.settled).toBe(1);
		expect(stats.released).toBe(0);
		expect((await getAccount(userId)).balance).toBe(50);
	});

	it("leaves holds newer than the cutoff untouched", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, { errorMessage: "failed" });
		// Fresh hold — NOT backdated.
		await reserve(userId, 50, {
			refType: "studio_job",
			refId: takeId,
			idempotencyKey: `${takeId}:reserve`,
		});

		const stats = await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		expect(stats.settled).toBe(0);
		expect(stats.released).toBe(0);
		expect((await getAccount(userId)).reserved).toBe(50);
	});

	it("sweep settle is idempotent with the poll route's settle key", async () => {
		const userId = await makeUser();
		await grant(userId, 100, { reason: "test" });
		const setId = await makeSet(userId);
		const takeId = await makeTake(setId, {
			status: "kept",
			videoUrl: "https://r2.example/video.mp4",
		});
		await staleHold(userId, takeId, 50);

		// Run the sweep twice — and note `${takeId}:settle` is exactly the key the
		// poll route would use, so a poll landing later is also a no-op.
		await sweepStaleHolds({ minutes: 120, poll: neverPoll });
		await sweepStaleHolds({ minutes: 120, poll: neverPoll });

		const acct = await getAccount(userId);
		expect(acct.balance).toBe(50); // charged exactly once
		expect(acct.reserved).toBe(0);
	});
});
