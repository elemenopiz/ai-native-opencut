/**
 * Higgsfield IMAGE adapter tests — the three models plus the shared transport
 * in `../../higgsfield-client.ts` (hoisted out of this directory so the VIDEO
 * adapter can use the same copy — see that file's header).
 *
 * Same idiom as `video/__tests__/higgsfield.test.ts`: mock `global.fetch` only
 * (restored in `afterEach`, since `mock.restore()` does NOT undo a direct
 * property assignment — the gotcha documented there and in
 * `google-veo.test.ts`), toggle `webEnv` keys directly, and never make a real
 * network call. There is no money on the Higgsfield key and no live call is
 * made anywhere in this file — every assertion runs against a stub.
 *
 * The availability tests are the load-bearing ones: these adapters share
 * `HIGGSFIELD_CREDENTIALS` with the already-shipping VIDEO backend, so "a
 * credential alone must NOT switch them on" is a real regression guard, not a
 * formality. See `../../higgsfield-client.ts` for why.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import type { JobStatus } from "@/lib/studio/backends/types";
import { higgsfieldGptImageBackend } from "../higgsfield-gpt-image";
import { higgsfieldNanoBananaBackend } from "../higgsfield-nano-banana";
import { higgsfieldSoulBackend } from "../higgsfield-soul";

const CREDS = "key-id:key-secret";

const originalFetch = globalThis.fetch;
const originalCredentials = webEnv.HIGGSFIELD_CREDENTIALS;
const originalBaseUrl = webEnv.HIGGSFIELD_BASE_URL;
const originalGptEndpoint = webEnv.HIGGSFIELD_GPT_IMAGE_ENDPOINT;
const originalNanoEndpoint = webEnv.HIGGSFIELD_NANO_BANANA_ENDPOINT;
const originalSoulEndpoint = webEnv.HIGGSFIELD_SOUL_ENDPOINT;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.HIGGSFIELD_CREDENTIALS = originalCredentials;
	webEnv.HIGGSFIELD_BASE_URL = originalBaseUrl;
	webEnv.HIGGSFIELD_GPT_IMAGE_ENDPOINT = originalGptEndpoint;
	webEnv.HIGGSFIELD_NANO_BANANA_ENDPOINT = originalNanoEndpoint;
	webEnv.HIGGSFIELD_SOUL_ENDPOINT = originalSoulEndpoint;
});

/** Stub Higgsfield's endpoint, capturing the request URL/init for assertions
 *  and returning `response` as the JSON body. */
function stubFetch(
	response: unknown,
	status = 200,
	onCall?: (url: string, init?: RequestInit) => void,
) {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		onCall?.(String(url), init);
		return new Response(JSON.stringify(response), { status });
	}) as unknown as typeof fetch;
}

/** Configure every image adapter's endpoint at once. */
function configureAll(endpoint = "vendor/model/text-to-image") {
	webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
	webEnv.HIGGSFIELD_GPT_IMAGE_ENDPOINT = endpoint;
	webEnv.HIGGSFIELD_NANO_BANANA_ENDPOINT = endpoint;
	webEnv.HIGGSFIELD_SOUL_ENDPOINT = endpoint;
}

const ADAPTERS = [
	{
		name: "gpt-image",
		backend: higgsfieldGptImageBackend,
		endpointKey: "HIGGSFIELD_GPT_IMAGE_ENDPOINT",
	},
	{
		name: "nano-banana",
		backend: higgsfieldNanoBananaBackend,
		endpointKey: "HIGGSFIELD_NANO_BANANA_ENDPOINT",
	},
	{
		name: "soul",
		backend: higgsfieldSoulBackend,
		endpointKey: "HIGGSFIELD_SOUL_ENDPOINT",
	},
] as const;

describe("higgsfield image adapters — availability is doubly gated", () => {
	for (const { name, backend, endpointKey } of ADAPTERS) {
		it(`${name}: false with no credentials and no endpoint`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "";
			webEnv[endpointKey] = "";
			expect(backend.isAvailable()).toBe(false);
		});

		it(`${name}: false with a VALID credential but no confirmed endpoint (the regression that matters — configuring Higgsfield video must not enlist image backends)`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
			webEnv[endpointKey] = "";
			expect(backend.isAvailable()).toBe(false);
		});

		it(`${name}: false with an endpoint but no credentials`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "";
			webEnv[endpointKey] = "vendor/model/text-to-image";
			expect(backend.isAvailable()).toBe(false);
		});

		it(`${name}: false with malformed credentials (no colon)`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "not-a-valid-credential";
			webEnv[endpointKey] = "vendor/model/text-to-image";
			expect(backend.isAvailable()).toBe(false);
		});

		it(`${name}: false with malformed credentials (more than one colon)`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "a:b:c";
			webEnv[endpointKey] = "vendor/model/text-to-image";
			expect(backend.isAvailable()).toBe(false);
		});

		it(`${name}: true only with BOTH a well-formed credential and an endpoint`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
			webEnv[endpointKey] = "vendor/model/text-to-image";
			expect(backend.isAvailable()).toBe(true);
		});

		it(`${name}: requiredEnv names both gates so the UI can tell an operator what to set`, () => {
			expect(backend.requiredEnv).toEqual([
				"HIGGSFIELD_CREDENTIALS",
				endpointKey,
			]);
		});
	}
});

describe("higgsfield image adapters — inert when unconfigured", () => {
	for (const { name, backend } of ADAPTERS) {
		it(`${name}: submit never throws and never calls fetch with no credentials`, async () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "";
			let called = false;
			globalThis.fetch = (async () => {
				called = true;
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch;

			const result = await backend.submit({ modality: "image", prompt: "x" });
			expect(result.status).toBe("failed");
			expect(result.error).toBeTruthy();
			expect(called).toBe(false);
		});

		it(`${name}: the not-configured error names the endpoint env var to set`, async () => {
			webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
			webEnv.HIGGSFIELD_GPT_IMAGE_ENDPOINT = "";
			webEnv.HIGGSFIELD_NANO_BANANA_ENDPOINT = "";
			webEnv.HIGGSFIELD_SOUL_ENDPOINT = "";
			const result = await backend.submit({ modality: "image", prompt: "x" });
			expect(result.status).toBe("failed");
			expect(result.error).toMatch(/HIGGSFIELD_\w+_ENDPOINT is not configured/);
		});
	}
});

describe("higgsfield image adapters — transport", () => {
	it("sends 'Key id:secret' as the exact Authorization header", async () => {
		configureAll();
		let authHeader: string | undefined;
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			authHeader = headers.Authorization;
		});
		await higgsfieldGptImageBackend.submit({ modality: "image", prompt: "x" });
		expect(authHeader).toBe("Key key-id:key-secret");
	});

	it("POSTs to the configured endpoint path, adding the leading slash", async () => {
		configureAll("openai/gpt-image-2.5/text-to-image");
		let seenUrl = "";
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (url) => {
			seenUrl = url;
		});
		await higgsfieldGptImageBackend.submit({ modality: "image", prompt: "x" });
		expect(seenUrl).toBe(
			"https://api.higgsfield.ai/openai/gpt-image-2.5/text-to-image",
		);
	});

	it("does not double the leading slash when the operator includes one", async () => {
		configureAll("/openai/gpt-image-2.5/text-to-image");
		let seenUrl = "";
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (url) => {
			seenUrl = url;
		});
		await higgsfieldGptImageBackend.submit({ modality: "image", prompt: "x" });
		expect(seenUrl).toBe(
			"https://api.higgsfield.ai/openai/gpt-image-2.5/text-to-image",
		);
	});

	it("honours HIGGSFIELD_BASE_URL", async () => {
		configureAll("m/t");
		webEnv.HIGGSFIELD_BASE_URL = "https://example.test";
		let seenUrl = "";
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (url) => {
			seenUrl = url;
		});
		await higgsfieldGptImageBackend.submit({ modality: "image", prompt: "x" });
		expect(seenUrl).toBe("https://example.test/m/t");
	});

	it("returns a pending job on a queued response", async () => {
		configureAll();
		stubFetch({ status: "queued", request_id: "req-1" });
		const result = await higgsfieldGptImageBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.status).toBe("pending");
		expect(result.jobId).toBe("req-1");
	});

	it("carries an inline result through when the POST already completed", async () => {
		configureAll();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			images: [{ url: "https://example.com/a.png" }],
		});
		const result = await higgsfieldGptImageBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://example.com/a.png");
	});

	it("never throws — returns status:'failed' on an HTTP error (e.g. 401)", async () => {
		configureAll();
		stubFetch({ error: "invalid key" }, 401);
		const result = await higgsfieldGptImageBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/401/);
	});

	// VERIFIED shape: `higgsfield-ai/soul/v2/standard` answers 422 with a BARE
	// ARRAY at the response root (FastAPI style), e.g.
	// `[{"type":"missing","loc":["body","prompt"]}]` — not `{error}`/`{message}`
	// and not even wrapped in an object. Before the shared client's error
	// handling learned this shape, a Soul validation failure surfaced as a bare
	// "Higgsfield validation error (422)" with no indication of what was wrong.
	it("surfaces a helpful message for Soul's 422 FastAPI-array validation shape instead of a bare '(422)'", async () => {
		configureAll();
		stubFetch([{ type: "missing", loc: ["body", "prompt"] }], 422);
		const result = await higgsfieldSoulBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/422/);
		expect(result.error).toMatch(/prompt/);
	});

	it("never leaks the raw loc/type validation JSON into the returned error string", async () => {
		configureAll();
		stubFetch([{ type: "missing", loc: ["body", "prompt"] }], 422);
		const result = await higgsfieldSoulBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.error).not.toMatch(/"loc"/);
		expect(result.error).not.toMatch(/"type"/);
	});

	it("reports a missing request_id as a failure rather than an empty pending job", async () => {
		configureAll();
		stubFetch({ status: "queued" });
		const result = await higgsfieldNanoBananaBackend.submit({
			modality: "image",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/request_id/);
	});
});

describe("higgsfield image adapters — poll", () => {
	const cases: [string, JobStatus][] = [
		["queued", "pending"],
		["in_progress", "processing"],
		["completed", "completed"],
		["failed", "failed"],
		["nsfw", "failed"],
		["canceled", "failed"],
		["cancelled", "failed"],
	];

	for (const [apiStatus, expected] of cases) {
		it(`maps '${apiStatus}' → '${expected}'`, async () => {
			configureAll();
			stubFetch({ status: apiStatus, request_id: "req-1" });
			const result = await higgsfieldGptImageBackend.poll("req-1");
			expect(result.status).toBe(expected);
		});
	}

	it("polls GET /requests/{id}/status", async () => {
		configureAll();
		let seenUrl = "";
		let seenMethod: string | undefined;
		stubFetch(
			{ status: "completed", request_id: "req-1" },
			200,
			(url, init) => {
				seenUrl = url;
				seenMethod = init?.method;
			},
		);
		await higgsfieldSoulBackend.poll("req-1");
		expect(seenUrl).toBe("https://api.higgsfield.ai/requests/req-1/status");
		expect(seenMethod).toBe("GET");
	});

	it("returns mediaUrl from images[0].url on completed", async () => {
		configureAll();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			images: [{ url: "https://example.com/a.png" }],
		});
		const result = await higgsfieldNanoBananaBackend.poll("req-1");
		expect(result.mediaUrl).toBe("https://example.com/a.png");
	});

	it("never throws — returns status:'failed' on an HTTP error", async () => {
		configureAll();
		stubFetch({ error: "not found" }, 404);
		const result = await higgsfieldGptImageBackend.poll("req-1");
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
	});
});

/** Capture the JSON body one adapter would submit. */
async function capturedBody(
	backend: (typeof ADAPTERS)[number]["backend"],
	req: Parameters<(typeof ADAPTERS)[number]["backend"]["submit"]>[0],
): Promise<Record<string, unknown>> {
	configureAll();
	let body: Record<string, unknown> = {};
	stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
		body = JSON.parse((init?.body as string) ?? "{}");
	});
	await backend.submit(req);
	return body;
}

describe("higgsfield-gpt-image — submit body", () => {
	it("sends the prompt and maps ImageSize to a documented aspect ratio", async () => {
		expect(
			await capturedBody(higgsfieldGptImageBackend, {
				modality: "image",
				prompt: "a poster",
				size: "1536x1024",
			}),
		).toMatchObject({ prompt: "a poster", aspect_ratio: "3:2" });

		expect(
			(
				await capturedBody(higgsfieldGptImageBackend, {
					modality: "image",
					prompt: "x",
					size: "1024x1536",
				})
			).aspect_ratio,
		).toBe("2:3");

		expect(
			(
				await capturedBody(higgsfieldGptImageBackend, {
					modality: "image",
					prompt: "x",
				})
			).aspect_ratio,
		).toBe("1:1");
	});

	it("keeps quality and resolution in lockstep, and never asks for the withheld 4k tier", async () => {
		const high = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
			quality: "high",
		});
		expect(high).toMatchObject({ quality: "high", resolution: "2k" });

		const medium = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
			quality: "medium",
		});
		expect(medium).toMatchObject({ quality: "medium", resolution: "1k" });

		const low = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
		});
		expect(low).toMatchObject({ quality: "low", resolution: "1k" });
	});

	it("omits image_references entirely when no reference is supplied", async () => {
		const body = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
		});
		expect(body.image_references).toBeUndefined();
	});

	it("merges referenceImageUrl ahead of referenceImages and caps at the documented 16", async () => {
		const body = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
			referenceImageUrl: "https://example.com/anchor.png",
			referenceImages: Array.from(
				{ length: 20 },
				(_, i) => `https://example.com/${i}.png`,
			),
		});
		const refs = body.image_references as string[];
		expect(refs).toHaveLength(16);
		expect(refs[0]).toBe("https://example.com/anchor.png");
	});

	it("omits background and variant (no BackendRequest field expresses either)", async () => {
		const body = await capturedBody(higgsfieldGptImageBackend, {
			modality: "image",
			prompt: "x",
		});
		expect(body.background).toBeUndefined();
		expect(body.variant).toBeUndefined();
	});
});

describe("higgsfield-nano-banana — submit body", () => {
	it("sends resolution as the 1k/2k tier, never the withheld 4k", async () => {
		expect(
			(
				await capturedBody(higgsfieldNanoBananaBackend, {
					modality: "image",
					prompt: "x",
					quality: "high",
				})
			).resolution,
		).toBe("2k");
		expect(
			(
				await capturedBody(higgsfieldNanoBananaBackend, {
					modality: "image",
					prompt: "x",
					quality: "low",
				})
			).resolution,
		).toBe("1k");
	});

	it("caps image references at the documented 14", async () => {
		const body = await capturedBody(higgsfieldNanoBananaBackend, {
			modality: "image",
			prompt: "x",
			referenceImages: Array.from(
				{ length: 20 },
				(_, i) => `https://example.com/${i}.png`,
			),
		});
		expect(body.image_references as string[]).toHaveLength(14);
	});
});

describe("higgsfield-soul — submit body", () => {
	it("sends the 1.5k/2k quality tier (a resolution enum, not low/medium/high)", async () => {
		expect(
			(
				await capturedBody(higgsfieldSoulBackend, {
					modality: "image",
					prompt: "x",
					quality: "high",
				})
			).quality,
		).toBe("2k");
		expect(
			(
				await capturedBody(higgsfieldSoulBackend, {
					modality: "image",
					prompt: "x",
					quality: "medium",
				})
			).quality,
		).toBe("1.5k");
	});

	it("sends AT MOST ONE image reference — the documented constraint", async () => {
		const body = await capturedBody(higgsfieldSoulBackend, {
			modality: "image",
			prompt: "x",
			referenceImageUrl: "https://example.com/anchor.png",
			referenceImages: [
				"https://example.com/b.png",
				"https://example.com/c.png",
			],
		});
		expect(body.image_references).toEqual(["https://example.com/anchor.png"]);
	});

	it("falls back to the first referenceImages entry when there is no anchor", async () => {
		const body = await capturedBody(higgsfieldSoulBackend, {
			modality: "image",
			prompt: "x",
			referenceImages: [
				"https://example.com/b.png",
				"https://example.com/c.png",
			],
		});
		expect(body.image_references).toEqual(["https://example.com/b.png"]);
	});

	it("never sends soul_id (no BackendRequest field carries a persona id yet)", async () => {
		const body = await capturedBody(higgsfieldSoulBackend, {
			modality: "image",
			prompt: "x",
		});
		expect(body.soul_id).toBeUndefined();
	});
});

describe("higgsfield image adapters — cost estimates are finite and non-zero", () => {
	for (const { name, backend } of ADAPTERS) {
		it(`${name}: charges a positive, finite credit amount`, () => {
			const est = backend.estimateCost({ modality: "image", prompt: "x" });
			expect(Number.isFinite(est.credits)).toBe(true);
			expect(est.credits).toBeGreaterThan(0);
			expect(est.basis).toBeTruthy();
		});

		it(`${name}: estimating costs nothing and calls no provider (safe on an unfunded key)`, () => {
			webEnv.HIGGSFIELD_CREDENTIALS = "";
			let called = false;
			globalThis.fetch = (async () => {
				called = true;
				return new Response("{}");
			}) as unknown as typeof fetch;
			backend.estimateCost({ modality: "image", prompt: "x" });
			expect(called).toBe(false);
		});
	}

	it("prices the Higgsfield Nano Banana route at the same rate as the direct Google route (same model, same tier)", () => {
		expect(
			higgsfieldNanoBananaBackend.estimateCost({
				modality: "image",
				prompt: "x",
			}).credits,
		).toBe(35);
	});
});

describe("higgsfield image adapters — routing surface", () => {
	it("only Nano Banana 2 claims character-still (it is the character model)", () => {
		expect(
			higgsfieldNanoBananaBackend.capabilities.intents.includes(
				"character-still",
			),
		).toBe(true);
		expect(
			higgsfieldGptImageBackend.capabilities.intents.includes(
				"character-still",
			),
		).toBe(false);
		expect(
			higgsfieldSoulBackend.capabilities.intents.includes("character-still"),
		).toBe(false);
	});

	it("GPT Image 2.5 is the text-in-image route", () => {
		expect(
			higgsfieldGptImageBackend.capabilities.intents.includes("text-in-image"),
		).toBe(true);
	});

	it("Soul advertises single-reference only (not omni-reference)", () => {
		expect(higgsfieldSoulBackend.capabilities.supportsOmniReference).toBe(
			false,
		);
		expect(higgsfieldNanoBananaBackend.capabilities.supportsOmniReference).toBe(
			true,
		);
	});
});
