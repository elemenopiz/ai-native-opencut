import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Route-level credit metering for the paid video routes (audit findings #1,
 * #1b, #2, #4):
 *
 *   - generate POST  — reserves the server-computed video cost BEFORE the
 *     provider call, keyed by a PER-JOB charge id (the take id, #1b); releases
 *     on dispatch failure; settles inline on sync completion. The persona
 *     "high"-consistency fallback still (a paid image call) is metered with its
 *     own charge id BEFORE rendering (#2).
 *   - promote POST   — previously fired a 1080p generation with ZERO metering
 *     (#1); now mirrors generate's reserve→provider→settle/release cycle, keyed
 *     by the NEW take's id so it can never touch the draft's hold (#1b).
 *   - poll GET       — settles/releases by the take-id hold key (legacy setId
 *     holds honored only for non-promoted takes, #1b) and only reports a
 *     terminal status AFTER settlement commits; on a settlement error it
 *     reports "processing" so the client polls again and the idempotent
 *     settle/release is retried (#4).
 *
 * Style follows studio-idor.test.ts: the routes bind db/auth/metering at import
 * time, so mocks are registered BEFORE the handlers are dynamically imported,
 * driven by a mutable `state` reset in beforeEach. The ledger/metering fakes
 * record an ordered event log so reserve-before-provider ordering is asserted,
 * not assumed. cost-table is REAL — the asserted amounts are the shipped SALE
 * rates (byteplus-seedance video 34 cr/s at 720p — the generate route's
 * default resolution — or 60 cr/s at 1080p for promote's fixed re-fire;
 * google-nano-banana still 35 cr flat; openai-gpt-image still 10 cr flat).
 */

interface MeterEvent {
	op:
		| "reserve"
		| "settle"
		| "release"
		| "submit"
		| "generateVideo"
		| "renderStill";
	refId?: string;
	credits?: number;
}

interface Fixtures {
	session: { user: { id: string } } | null;
	events: MeterEvent[];
	/** Spendable balance the metering fake enforces (Infinity = always afford). */
	spendable: number;
	/** Routed backend submit result / failure (generate route). */
	submitResult: {
		jobId?: string;
		status: "completed" | "processing" | "pending" | "failed";
		mediaUrl?: string;
		seed?: number;
		error?: string;
	};
	/** generateVideo result / failure (promote route). */
	generateVideoResult: {
		jobId?: string;
		status: string;
		videoUrl?: string;
	};
	generateVideoError: Error | null;
	renderStillError: Error | null;
	/** pollVideo result (poll route). */
	pollResult: {
		status: string;
		videoUrl?: string;
		error?: string;
		seed?: number;
	};
	/** Open holds the ledger fake exposes via holdFor. */
	holds: Map<string, number>;
	settleError: Error | null;
	releaseError: Error | null;
	take: Record<string, unknown> | null;
	set: Record<string, unknown> | null;
	persona: Record<string, unknown> | null;
	inserts: Array<{ values: Record<string, unknown> }>;
	updates: number;
}

const state: Fixtures = {
	session: { user: { id: "owner-1" } },
	events: [],
	spendable: Number.POSITIVE_INFINITY,
	submitResult: { jobId: "job-1", status: "processing" },
	generateVideoResult: { jobId: "pjob-1", status: "processing" },
	generateVideoError: null,
	renderStillError: null,
	pollResult: { status: "processing" },
	holds: new Map(),
	settleError: null,
	releaseError: null,
	take: null,
	set: null,
	persona: null,
	inserts: [],
	updates: 0,
};

class FakeInsufficientCredits extends Error {
	readonly needed: number;
	readonly spendable: number;
	constructor(needed: number, spendable: number) {
		super(`Insufficient credits: need ${needed}, have ${spendable}`);
		this.name = "InsufficientCredits";
		this.needed = needed;
		this.spendable = spendable;
	}
}

mock.module("@/lib/db", () => ({
	db: {
		query: {
			takes: { findFirst: async () => state.take },
			generationSets: { findFirst: async () => state.set },
			personas: { findFirst: async () => state.persona },
		},
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				state.inserts.push({ values });
			},
		}),
		update: () => ({
			set: () => ({
				where: async () => {
					state.updates += 1;
				},
			}),
		}),
	},
}));

mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
// Snapshot the REAL rate-limit exports (the spread copies current function
// values) before the no-op mock replaces the module, and restore them in
// afterAll — bun's mock.module live-overwrites the module registry
// process-wide, so without the restore every test file that runs after this
// one sees a rate limiter that never limits (order-dependent 429 failures).
const realRateLimit = { ...(await import("@/lib/rate-limit")) };
mock.module("@/lib/rate-limit", () => ({
	enforceRateLimit: async () => null,
}));
afterAll(() => {
	mock.module("@/lib/rate-limit", () => realRateLimit);
});

mock.module("@/lib/credits/ledger", () => ({
	InsufficientCredits: FakeInsufficientCredits,
	holdFor: async (_userId: string, refId: string) =>
		state.holds.get(refId) ?? null,
	settle: async (_userId: string, credits: number, opts: { refId: string }) => {
		state.events.push({ op: "settle", refId: opts.refId, credits });
		if (state.settleError) throw state.settleError;
		state.holds.delete(opts.refId);
	},
	release: async (
		_userId: string,
		credits: number,
		opts: { refId: string },
	) => {
		state.events.push({ op: "release", refId: opts.refId, credits });
		if (state.releaseError) throw state.releaseError;
		state.holds.delete(opts.refId);
	},
}));

mock.module("@/lib/credits/metering", () => ({
	STUDIO_REF_TYPE: "studio_job",
	creditsEnforced: () => true,
	meteredReserve: async (
		_userId: string,
		credits: number,
		opts: { refId: string },
	) => {
		if (credits > state.spendable) {
			throw new FakeInsufficientCredits(credits, state.spendable);
		}
		state.events.push({ op: "reserve", refId: opts.refId, credits });
		state.holds.set(opts.refId, credits);
		return null;
	},
	meteredSettle: async (
		_userId: string,
		credits: number,
		opts: { refId: string },
	) => {
		state.events.push({ op: "settle", refId: opts.refId, credits });
		state.holds.delete(opts.refId);
		return null;
	},
	meteredRelease: async (
		_userId: string,
		credits: number,
		opts: { refId: string },
	) => {
		state.events.push({ op: "release", refId: opts.refId, credits });
		state.holds.delete(opts.refId);
		return null;
	},
	insufficientCreditsResponse: (err: FakeInsufficientCredits) =>
		Response.json(
			{
				error: "insufficient_credits",
				needed: err.needed,
				spendable: err.spendable,
			},
			{ status: 402 },
		),
}));

// Snapshot the REAL backends barrel and restore it in afterAll — other test
// files (e.g. the audio route's own credit-metering test) import getBackend/
// registerBackend/etc. from this same barrel; without the restore, whichever
// test file runs after this one in the shared bun process gets this
// routeSlot-only stub and breaks. Same gotcha as the rate-limit restore above.
const realBackends = { ...(await import("@/lib/studio/backends")) };
mock.module("@/lib/studio/backends", () => ({
	ensureBackendsRegistered: () => {},
	normalizeSeedLock: (request: unknown) => ({
		request,
		mechanism: "seed-param",
	}),
	toTakeCost: () => ({ credits: 1, estimated: false }),
	routeSlot: () => ({
		routedBy: "auto",
		intent: "video-default",
		backend: {
			id: "byteplus-seedance",
			label: "Seedance",
			vendor: "byteplus",
			safetyTier: "standard",
			requiredEnv: [],
			modality: "video",
			isAvailable: () => true,
			estimateCost: () => ({ credits: 1 }),
			submit: async () => {
				state.events.push({ op: "submit" });
				return state.submitResult;
			},
		},
	}),
}));
afterAll(() => {
	mock.module("@/lib/studio/backends", () => realBackends);
});

mock.module("@/lib/studio/persona-still", () => ({
	renderPersonaStill: async () => {
		state.events.push({ op: "renderStill" });
		if (state.renderStillError) throw state.renderStillError;
		return {
			imageUrl: "https://cdn.example/still.png",
			backendId: "openai-gpt-image",
		};
	},
}));

mock.module("@/lib/studio/provider-adapter", () => ({
	generateVideo: async () => {
		state.events.push({ op: "generateVideo" });
		if (state.generateVideoError) throw state.generateVideoError;
		return state.generateVideoResult;
	},
	pollVideo: async () => state.pollResult,
}));

mock.module("@/lib/studio/media-storage", () => ({
	canRehost: () => false,
	isRehostedUrl: () => false,
	rehostToR2: async () => "https://r2.example/x",
	fetchBytes: async () => new Uint8Array(),
}));

const { POST: generatePOST } = await import("../generate/route");
const { POST: promotePOST } = await import("../takes/[takeId]/promote/route");
const { GET: pollGET } = await import("../generate/[jobId]/route");

function jsonRequest(body: unknown, url = "http://localhost/x") {
	return {
		url,
		json: async () => body,
		headers: new Headers(),
	} as unknown as Request;
}

const ops = () => state.events.map((e) => e.op);
const eventsOf = (op: MeterEvent["op"]) =>
	state.events.filter((e) => e.op === op);
/** The inserted takes row (has setId), as opposed to the generation-set row. */
const insertedTake = () =>
	state.inserts.map((i) => i.values).find((v) => "setId" in v);
const insertedSet = () =>
	state.inserts.map((i) => i.values).find((v) => "prompt" in v);

beforeEach(() => {
	state.session = { user: { id: "owner-1" } };
	state.events = [];
	state.spendable = Number.POSITIVE_INFINITY;
	state.submitResult = { jobId: "job-1", status: "processing" };
	state.generateVideoResult = { jobId: "pjob-1", status: "processing" };
	state.generateVideoError = null;
	state.renderStillError = null;
	state.pollResult = { status: "processing" };
	state.holds = new Map();
	state.settleError = null;
	state.releaseError = null;
	state.take = null;
	state.set = null;
	state.persona = null;
	state.inserts = [];
	state.updates = 0;
});

// ── generate POST ──────────────────────────────────────────────────────────

describe("generate POST — reserve before dispatch, per-job hold key (#1b)", () => {
	it("reserves the server-computed cost BEFORE submit, keyed by the take id", async () => {
		const res = await generatePOST(
			jsonRequest({ prompt: "a cat", duration: 5 }),
		);
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "submit"]);
		const [reserve] = eventsOf("reserve");
		expect(reserve.credits).toBe(170); // byteplus-seedance @720p: 34/s × 5s

		// Hold is keyed by the PER-JOB take id, not the set id.
		const take = insertedTake();
		const set = insertedSet();
		expect(take).toBeDefined();
		expect(reserve.refId).toBe(take?.id as string);
		expect(reserve.refId).not.toBe(set?.id as string);

		// Async job — nothing settled yet; the poll route owns settlement.
		expect(eventsOf("settle")).toHaveLength(0);
	});

	it("releases the SAME hold and 500s when the provider dispatch fails", async () => {
		state.submitResult = { status: "failed", error: "boom" };
		const res = await generatePOST(jsonRequest({ prompt: "a cat" }));
		expect(res.status).toBe(500);

		expect(ops()).toEqual(["reserve", "submit", "release"]);
		const [reserve] = eventsOf("reserve");
		const [release] = eventsOf("release");
		expect(release.refId).toBe(reserve.refId);
		expect(release.credits).toBe(reserve.credits);
	});

	it("402s before ANY provider call when the video can't be afforded", async () => {
		state.spendable = 10; // video needs 170
		const res = await generatePOST(jsonRequest({ prompt: "a cat" }));
		expect(res.status).toBe(402);
		expect(eventsOf("submit")).toHaveLength(0);
		expect(await res.json()).toMatchObject({ error: "insufficient_credits" });
	});

	it("settles inline (same take-id key) when the backend completes synchronously", async () => {
		state.submitResult = {
			jobId: "job-sync",
			status: "completed",
			mediaUrl: "https://v.example/v.mp4",
		};
		const res = await generatePOST(jsonRequest({ prompt: "a cat" }));
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "submit", "settle"]);
		const [reserve] = eventsOf("reserve");
		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe(reserve.refId);
		expect(settle.credits).toBe(170);
	});
});

describe("generate POST — persona still is metered (#2)", () => {
	const persona = {
		id: "p1",
		userId: "owner-1",
		descriptor: "a red-haired explorer",
		anchorImageUrl: "https://cdn.example/anchor.png",
		refImageUrls: null,
	};

	it("reserves the still cost BEFORE rendering, settles it, then reserves the video separately", async () => {
		state.persona = persona;
		const res = await generatePOST(
			jsonRequest({ prompt: "a cat", personaId: "p1", duration: 5 }),
		);
		expect(res.status).toBe(200);

		// still reserve → render → still settle → release the over-hold diff
		// (reserve is sized to the DEFAULT image backend's sale rate,
		// nano-banana-pro @ 35; this mock's still renders on openai-gpt-image
		// @ 10, so the 25-credit difference is released) → video reserve → submit
		expect(ops()).toEqual([
			"reserve",
			"renderStill",
			"settle",
			"release",
			"reserve",
			"submit",
		]);
		const [stillReserve, videoReserve] = eventsOf("reserve");
		const [stillSettle] = eventsOf("settle");
		const [stillReleaseDiff] = eventsOf("release");
		expect(stillReserve.credits).toBe(35); // google-nano-banana (default image backend) sale rate
		expect(stillSettle.credits).toBe(10); // openai-gpt-image (actual routed backend) sale rate
		expect(stillSettle.refId).toBe(stillReserve.refId);
		expect(stillReleaseDiff.credits).toBe(25); // 35 reserved - 10 actually spent
		expect(stillReleaseDiff.refId).toBe(stillReserve.refId);
		expect(videoReserve.credits).toBe(170); // byteplus-seedance @720p: 34/s × 5s
		// Independent charge ids — the still can never consume the video hold.
		expect(videoReserve.refId).not.toBe(stillReserve.refId);
	});

	it("releases the still hold and 500s when the still render fails (video never dispatched)", async () => {
		state.persona = persona;
		state.renderStillError = new Error("image provider down");
		const res = await generatePOST(
			jsonRequest({ prompt: "a cat", personaId: "p1" }),
		);
		expect(res.status).toBe(500);

		expect(ops()).toEqual(["reserve", "renderStill", "release"]);
		const [stillReserve] = eventsOf("reserve");
		const [release] = eventsOf("release");
		expect(release.refId).toBe(stillReserve.refId);
		expect(eventsOf("submit")).toHaveLength(0);
	});

	it("402s BEFORE rendering when the still can't be afforded (no free image gen at 0 balance)", async () => {
		state.persona = persona;
		state.spendable = 0;
		const res = await generatePOST(
			jsonRequest({ prompt: "a cat", personaId: "p1" }),
		);
		expect(res.status).toBe(402);
		expect(eventsOf("renderStill")).toHaveLength(0);
		expect(eventsOf("submit")).toHaveLength(0);
	});

	it("skips still metering when the client pre-rendered the reference still", async () => {
		state.persona = persona;
		const res = await generatePOST(
			jsonRequest({
				prompt: "a cat",
				personaId: "p1",
				referenceImageUrl: "https://cdn.example/batch-still.png",
			}),
		);
		expect(res.status).toBe(200);
		// Only the video hold — no still render, no still charge.
		expect(ops()).toEqual(["reserve", "submit"]);
		expect(eventsOf("renderStill")).toHaveLength(0);
	});
});

// ── promote POST ───────────────────────────────────────────────────────────

describe("promote POST — 1080p re-fire is metered (#1) on its own hold key (#1b)", () => {
	const draft = { id: "t-draft", setId: "s1", seed: 7 };
	const set = {
		id: "s1",
		userId: "owner-1",
		prompt: "a cat",
		referenceImageUrl: null,
		orientation: "landscape",
		duration: 5,
		mode: "text-to-video",
	};
	const promoteParams = { params: Promise.resolve({ takeId: "t-draft" }) };

	it("reserves the video cost BEFORE generateVideo, keyed by the NEW take id (not the set, not the draft)", async () => {
		state.take = draft;
		state.set = set;
		const res = await promotePOST(jsonRequest({}), promoteParams);
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "generateVideo"]);
		const [reserve] = eventsOf("reserve");
		expect(reserve.credits).toBe(300); // 1080p: 60/s × set.duration(5)

		const promoted = insertedTake();
		expect(promoted?.id as string).toBe(reserve.refId as string);
		expect(reserve.refId).not.toBe("s1"); // never the shared set id (#1b)
		expect(reserve.refId).not.toBe("t-draft"); // never the draft's id

		// Async 1080p job — stays reserved for the poll route.
		expect(eventsOf("settle")).toHaveLength(0);
	});

	it("releases the hold and 500s when the 1080p dispatch fails", async () => {
		state.take = draft;
		state.set = set;
		state.generateVideoError = new Error("provider down");
		const res = await promotePOST(jsonRequest({}), promoteParams);
		expect(res.status).toBe(500);

		expect(ops()).toEqual(["reserve", "generateVideo", "release"]);
		const [reserve] = eventsOf("reserve");
		const [release] = eventsOf("release");
		expect(release.refId).toBe(reserve.refId);
	});

	it("402s before the provider call when the promotion can't be afforded", async () => {
		state.take = draft;
		state.set = set;
		state.spendable = 10;
		const res = await promotePOST(jsonRequest({}), promoteParams);
		expect(res.status).toBe(402);
		expect(eventsOf("generateVideo")).toHaveLength(0);
	});

	it("settles inline when the promotion completes synchronously", async () => {
		state.take = draft;
		state.set = set;
		state.generateVideoResult = {
			jobId: "pjob-sync",
			status: "completed",
			videoUrl: "https://v.example/hd.mp4",
		};
		const res = await promotePOST(jsonRequest({}), promoteParams);
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "generateVideo", "settle"]);
		const [reserve] = eventsOf("reserve");
		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe(reserve.refId);
	});
});

// ── poll GET ───────────────────────────────────────────────────────────────

describe("poll GET — settlement commits before terminal status (#4), take-id hold key (#1b)", () => {
	const pollParams = { params: Promise.resolve({ jobId: "job-1" }) };
	const pollTake = {
		id: "t9",
		setId: "s9",
		status: "drafting",
		videoUrl: null,
		providerJobId: "job-1",
	};
	const pollSet = { id: "s9", userId: "owner-1" };

	it("settles the take-id hold on completion, then reports completed", async () => {
		state.take = pollTake;
		state.set = pollSet;
		state.holds.set("t9", 50);
		state.pollResult = { status: "completed", videoUrl: "https://v/v.mp4" };

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "completed" });

		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe("t9");
		expect(settle.credits).toBe(50);
	});

	it("reports 'processing' (NOT completed) when the settle fails, so the client retries", async () => {
		state.take = pollTake;
		state.set = pollSet;
		state.holds.set("t9", 50);
		state.pollResult = { status: "completed", videoUrl: "https://v/v.mp4" };
		state.settleError = new Error("db blip");

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "processing" });

		// The hold survives for the retry; the take was not finalized.
		expect(state.holds.get("t9")).toBe(50);
		expect(state.updates).toBe(0);
	});

	it("retry after a failed settle succeeds and completes (settle is idempotent)", async () => {
		state.take = pollTake;
		state.set = pollSet;
		state.holds.set("t9", 50);
		state.pollResult = { status: "completed", videoUrl: "https://v/v.mp4" };

		state.settleError = new Error("db blip");
		await pollGET(jsonRequest({}), pollParams);
		state.settleError = null; // next client poll — the blip is over
		const res = await pollGET(jsonRequest({}), pollParams);

		expect(await res.json()).toMatchObject({ status: "completed" });
		expect(state.holds.has("t9")).toBe(false);
		expect(eventsOf("settle")).toHaveLength(2); // attempted, then retried
	});

	it("releases the hold on provider failure, then reports failed", async () => {
		state.take = pollTake;
		state.set = pollSet;
		state.holds.set("t9", 50);
		state.pollResult = { status: "failed", error: "nsfw" };

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(await res.json()).toMatchObject({ status: "failed" });
		const [release] = eventsOf("release");
		expect(release.refId).toBe("t9");
	});

	it("reports 'processing' when the release fails, so the refund is retried", async () => {
		state.take = pollTake;
		state.set = pollSet;
		state.holds.set("t9", 50);
		state.pollResult = { status: "failed", error: "nsfw" };
		state.releaseError = new Error("db blip");

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(await res.json()).toEqual({ status: "processing" });
		expect(state.holds.get("t9")).toBe(50);
	});

	it("falls back to a legacy setId hold for a non-promoted take", async () => {
		state.take = pollTake; // status "drafting", no take-id hold
		state.set = pollSet;
		state.holds.set("s9", 50); // hold reserved by the pre-change generate route
		state.pollResult = { status: "completed", videoUrl: "https://v/v.mp4" };

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(await res.json()).toMatchObject({ status: "completed" });
		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe("s9");
	});

	it("NEVER lets a promoted take consume the draft's setId hold (#1b isolation)", async () => {
		state.take = { ...pollTake, id: "t-promoted", status: "promoted" };
		state.set = pollSet;
		state.holds.set("s9", 50); // the DRAFT's still-open hold in the same set
		state.pollResult = { status: "failed", error: "1080p failed" };

		const res = await pollGET(jsonRequest({}), pollParams);
		expect(await res.json()).toMatchObject({ status: "failed" });

		// No settle/release fired — the draft's hold is untouched.
		expect(eventsOf("settle")).toHaveLength(0);
		expect(eventsOf("release")).toHaveLength(0);
		expect(state.holds.get("s9")).toBe(50);
	});
});
