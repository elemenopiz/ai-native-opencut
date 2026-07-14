import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Route-level auth + credit metering for the audio generation routes
 * (`POST /api/studio/audio`, `GET /api/studio/audio/[jobId]`) — mirrors
 * `credit-metering.test.ts`'s style for the video routes: mocks are
 * registered BEFORE the handlers are dynamically imported, driven by a
 * mutable `state` reset in `beforeEach`. The ledger/metering fakes record an
 * ordered event log so reserve-before-submit ordering is asserted, not
 * assumed. `cost-table` is REAL — asserted amounts are the shipped rates
 * (fal-mmaudio 0.1 credit/sec, elevenlabs-music 0.25 credit/sec).
 */

interface MeterEvent {
	op: "reserve" | "settle" | "release" | "submit" | "poll";
	refId?: string;
	credits?: number;
}

interface FakeBackend {
	id: string;
	label: string;
	vendor: string;
	modality: string;
	safetyTier: string;
	requiredEnv: string[];
	capabilities: {
		durationRangeSec: { min: number; max: number };
		supportsSeedLock: boolean;
		requiresVideoRef: boolean;
		intents: string[];
	};
	isAvailable: () => boolean;
	estimateCost: () => { credits: number; basis: string };
	submit: (req: unknown) => Promise<{
		jobId: string;
		status: string;
		mediaUrl?: string;
		error?: string;
	}>;
	poll: (jobId: string) => Promise<{
		jobId: string;
		status: string;
		mediaUrl?: string;
		error?: string;
	}>;
}

interface JobRow {
	id: string;
	ownerId: string;
	action: string;
	backendId: string;
	status: string;
	providerJobId: string | null;
	resultUrl: string | null;
	errorMessage: string | null;
}

interface Fixtures {
	session: { user: { id: string } } | null;
	events: MeterEvent[];
	spendable: number;
	submitResult: {
		jobId?: string;
		status: "completed" | "processing" | "pending" | "failed";
		mediaUrl?: string;
		error?: string;
	};
	pollResult: {
		status: string;
		mediaUrl?: string;
		error?: string;
	};
	backendAvailable: boolean;
	holds: Map<string, number>;
	settleError: Error | null;
	releaseError: Error | null;
	inserts: Array<{ values: Record<string, unknown> }>;
	updates: Array<Record<string, unknown>>;
	job: JobRow | null;
}

const state: Fixtures = {
	session: { user: { id: "owner-1" } },
	events: [],
	spendable: Number.POSITIVE_INFINITY,
	submitResult: { jobId: "job-1", status: "processing" },
	pollResult: { status: "processing" },
	backendAvailable: true,
	holds: new Map(),
	settleError: null,
	releaseError: null,
	inserts: [],
	updates: [],
	job: null,
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

function fakeBackend(overrides: Partial<FakeBackend> = {}): FakeBackend {
	return {
		id: "fal-mmaudio",
		label: "MMAudio V2",
		vendor: "fal.ai",
		modality: "audio",
		safetyTier: "partner",
		requiredEnv: ["FAL_KEY"],
		capabilities: {
			durationRangeSec: { min: 1, max: 30 },
			supportsSeedLock: true,
			requiresVideoRef: true,
			intents: ["video-score"],
		},
		isAvailable: () => state.backendAvailable,
		estimateCost: () => ({ credits: 1, basis: "test" }),
		submit: async (req: unknown) => {
			state.events.push({ op: "submit" });
			return { ...state.submitResult, req } as unknown as Awaited<
				ReturnType<FakeBackend["submit"]>
			>;
		},
		poll: async () => {
			state.events.push({ op: "poll" });
			return { jobId: "req-1", ...state.pollResult };
		},
		...overrides,
	};
}

function fakeMusicBackend(): FakeBackend {
	return fakeBackend({
		id: "elevenlabs-music",
		label: "ElevenLabs Music",
		vendor: "ElevenLabs",
		requiredEnv: ["ELEVENLABS_API_KEY"],
		capabilities: {
			durationRangeSec: { min: 3, max: 600 },
			supportsSeedLock: true,
			requiresVideoRef: false,
			intents: ["text-music"],
		},
	});
}

const backends: Record<string, FakeBackend> = {
	"fal-mmaudio": fakeBackend(),
	"elevenlabs-music": fakeMusicBackend(),
};

mock.module("@/lib/db", () => ({
	db: {
		query: {
			audioJobs: { findFirst: async () => state.job },
		},
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				state.inserts.push({ values });
			},
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					state.updates.push(values);
				},
			}),
		}),
	},
}));

mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => state.session } },
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Snapshot the REAL rate-limit exports and restore in afterAll — bun's
// mock.module live-overwrites the module registry process-wide, so without
// the restore every test file that runs after this one sees a rate limiter
// that never limits (order-dependent 429 failures). Same gotcha documented in
// credit-metering.test.ts.
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
// files (e.g. studio-idor.test.ts, credit-metering.test.ts) import
// routeSlot/normalizeSeedLock/DEFAULT_BACKEND_ID etc. from this same barrel
// via generate/route.ts and image/route.ts; without the restore, whichever
// test file runs after this one in the shared bun process gets our
// getBackend-only stub and breaks. Same gotcha as the rate-limit restore above.
const realBackends = { ...(await import("@/lib/studio/backends")) };
mock.module("@/lib/studio/backends", () => ({
	ensureBackendsRegistered: () => {},
	getBackend: (id: string) => backends[id],
	toTakeCost: (estimate: { credits: number }) => ({
		credits: estimate.credits,
		estimated: false,
	}),
}));
afterAll(() => {
	mock.module("@/lib/studio/backends", () => realBackends);
});

mock.module("@/lib/studio/media-storage", () => ({
	canRehost: () => false,
	rehostToR2: async () => "https://r2.example/x",
	fetchBytes: async () => new Uint8Array(),
}));

const { POST } = await import("../route");
const { GET } = await import("../[jobId]/route");

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
const insertedJob = () => state.inserts[0]?.values as Record<string, unknown>;

beforeEach(() => {
	state.session = { user: { id: "owner-1" } };
	state.events = [];
	state.spendable = Number.POSITIVE_INFINITY;
	state.submitResult = { jobId: "job-1", status: "processing" };
	state.pollResult = { status: "processing" };
	state.backendAvailable = true;
	state.holds = new Map();
	state.settleError = null;
	state.releaseError = null;
	state.inserts = [];
	state.updates = [];
	state.job = null;
});

// ── POST /api/studio/audio ──────────────────────────────────────────────────

describe("POST /api/studio/audio — auth + validation", () => {
	it("401s when signed out", async () => {
		state.session = null;
		const res = await POST(jsonRequest({ action: "music", prompt: "x" }));
		expect(res.status).toBe(401);
	});

	it("400s on an unknown action", async () => {
		const res = await POST(jsonRequest({ action: "sfx", prompt: "x" }));
		expect(res.status).toBe(400);
	});

	it("400s when prompt is missing", async () => {
		const res = await POST(jsonRequest({ action: "music" }));
		expect(res.status).toBe(400);
	});

	it("400s for score without videoUrl (MMAudio requires a source video)", async () => {
		const res = await POST(jsonRequest({ action: "score", prompt: "x" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/videoUrl/);
	});

	it("400s when the resolved backend isn't configured", async () => {
		state.backendAvailable = false;
		const res = await POST(jsonRequest({ action: "music", prompt: "x" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/not configured/);
	});
});

// A malformed `duration` used to become NaN downstream (`Math.round(NaN)` /
// `clamp(NaN, …)`), which silently defeated ledger.reserve()'s insufficient-
// funds gate (NaN comparisons are always false) and then crashed the integer
// `duration` column write as an uncaught 500. These assert the route now
// rejects with a clean 400 BEFORE any credit-reservation logic runs — no
// reserve/submit event should ever fire.
describe("POST /api/studio/audio — malformed input rejected before credit logic", () => {
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		-5,
		0,
	])(
		"400s on a non-finite/non-positive duration (%p) — no reserve fires",
		async (duration) => {
			const res = await POST(
				jsonRequest({ action: "music", prompt: "x", duration }),
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toMatch(/duration/);
			expect(ops()).toEqual([]);
		},
	);

	it("400s when duration is a non-numeric type (string)", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", duration: "60" }),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/duration/);
		expect(ops()).toEqual([]);
	});

	it("400s when instrumental is not a boolean", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", instrumental: "yes" }),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/instrumental/);
		expect(ops()).toEqual([]);
	});

	it("400s when lyrics is not a string", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", lyrics: 12345 }),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/lyrics/);
		expect(ops()).toEqual([]);
	});

	it("400s when seed is not a finite number", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", seed: Number.NaN }),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/seed/);
		expect(ops()).toEqual([]);
	});

	it("still accepts a valid, in-range duration (unaffected by the new checks)", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", duration: 60 }),
		);
		expect(res.status).toBe(200);
		expect(ops()).toEqual(["reserve", "submit"]);
	});
});

describe("POST /api/studio/audio — reserve before dispatch", () => {
	it("reserves the server-computed cost BEFORE submit, keyed by the job id", async () => {
		const res = await POST(
			jsonRequest({ action: "music", prompt: "a song", duration: 60 }),
		);
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "submit"]);
		const [reserve] = eventsOf("reserve");
		expect(reserve.credits).toBe(38); // elevenlabs-music: 0.625/s (COGS 0.25 × 2.5) × 60s = 37.5 → ceil

		const job = insertedJob();
		expect(job).toBeDefined();
		expect(reserve.refId).toBe(job.id as string);
	});

	it("releases the hold and 500s when the provider dispatch fails", async () => {
		state.submitResult = { status: "failed", error: "boom" };
		const res = await POST(jsonRequest({ action: "music", prompt: "x" }));
		expect(res.status).toBe(500);

		expect(ops()).toEqual(["reserve", "submit", "release"]);
		const [reserve] = eventsOf("reserve");
		const [release] = eventsOf("release");
		expect(release.refId).toBe(reserve.refId);
		expect(release.credits).toBe(reserve.credits);
	});

	it("402s before ANY provider call when the job can't be afforded", async () => {
		state.spendable = 1; // 60s music needs 38
		const res = await POST(
			jsonRequest({ action: "music", prompt: "x", duration: 60 }),
		);
		expect(res.status).toBe(402);
		expect(eventsOf("submit")).toHaveLength(0);
		expect(await res.json()).toMatchObject({ error: "insufficient_credits" });
	});

	it("settles inline when the backend completes synchronously (music)", async () => {
		state.submitResult = {
			jobId: "job-sync",
			status: "completed",
			mediaUrl: "data:audio/mpeg;base64,abc",
		};
		const res = await POST(jsonRequest({ action: "music", prompt: "x" }));
		expect(res.status).toBe(200);

		expect(ops()).toEqual(["reserve", "submit", "settle"]);
		const [reserve] = eventsOf("reserve");
		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe(reserve.refId);
	});

	it("stays reserved (no settle) for an async job (score)", async () => {
		state.submitResult = { jobId: "req-1", status: "pending" };
		const res = await POST(
			jsonRequest({
				action: "score",
				prompt: "rain",
				videoUrl: "https://cdn.example/span.mp4",
			}),
		);
		expect(res.status).toBe(200);
		expect(ops()).toEqual(["reserve", "submit"]);
		expect(eventsOf("settle")).toHaveLength(0);
	});
});

// ── GET /api/studio/audio/[jobId] ───────────────────────────────────────────

describe("GET /api/studio/audio/[jobId] — ownership + settlement", () => {
	const params = (jobId = "req-1") => ({ params: Promise.resolve({ jobId }) });

	it("401s when signed out", async () => {
		state.session = null;
		const res = await GET(jsonRequest({}), params());
		expect(res.status).toBe(401);
	});

	it("404s when no job matches the provider job id", async () => {
		state.job = null;
		const res = await GET(jsonRequest({}), params());
		expect(res.status).toBe(404);
	});

	it("404s (never 403) when the job belongs to a different owner (IDOR)", async () => {
		state.job = {
			id: "aj-1",
			ownerId: "someone-else",
			action: "score",
			backendId: "fal-mmaudio",
			status: "processing",
			providerJobId: "req-1",
			resultUrl: null,
			errorMessage: null,
		};
		const res = await GET(jsonRequest({}), params());
		expect(res.status).toBe(404);
	});

	it("returns the cached row without calling the backend when already terminal", async () => {
		state.job = {
			id: "aj-1",
			ownerId: "owner-1",
			action: "music",
			backendId: "elevenlabs-music",
			status: "completed",
			providerJobId: "req-1",
			resultUrl: "https://r2.example/done.mp3",
			errorMessage: null,
		};
		const res = await GET(jsonRequest({}), params());
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			status: "completed",
			resultUrl: "https://r2.example/done.mp3",
		});
		expect(eventsOf("poll")).toHaveLength(0);
	});

	it("settles the job-id hold on completion, then reports completed", async () => {
		state.job = {
			id: "aj-1",
			ownerId: "owner-1",
			action: "score",
			backendId: "fal-mmaudio",
			status: "processing",
			providerJobId: "req-1",
			resultUrl: null,
			errorMessage: null,
		};
		state.holds.set("aj-1", 3);
		state.pollResult = {
			status: "completed",
			mediaUrl: "https://fal.example/scored.mp4",
		};

		const res = await GET(jsonRequest({}), params());
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "completed" });

		const [settle] = eventsOf("settle");
		expect(settle.refId).toBe("aj-1");
		expect(settle.credits).toBe(3);
	});

	it("releases the hold on provider failure, then reports failed", async () => {
		state.job = {
			id: "aj-1",
			ownerId: "owner-1",
			action: "score",
			backendId: "fal-mmaudio",
			status: "processing",
			providerJobId: "req-1",
			resultUrl: null,
			errorMessage: null,
		};
		state.holds.set("aj-1", 3);
		state.pollResult = { status: "failed", error: "nsfw" };

		const res = await GET(jsonRequest({}), params());
		expect(await res.json()).toMatchObject({ status: "failed" });
		const [release] = eventsOf("release");
		expect(release.refId).toBe("aj-1");
	});

	it("reports 'processing' (not completed) when settle fails, so the client retries", async () => {
		state.job = {
			id: "aj-1",
			ownerId: "owner-1",
			action: "score",
			backendId: "fal-mmaudio",
			status: "processing",
			providerJobId: "req-1",
			resultUrl: null,
			errorMessage: null,
		};
		state.holds.set("aj-1", 3);
		state.pollResult = {
			status: "completed",
			mediaUrl: "https://fal.example/scored.mp4",
		};
		state.settleError = new Error("db blip");

		const res = await GET(jsonRequest({}), params());
		expect(await res.json()).toEqual({ status: "processing" });
		expect(state.holds.get("aj-1")).toBe(3);
	});
});
