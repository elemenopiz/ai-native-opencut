/**
 * Higgsfield adapter tests — mirrors `kling.test.ts`'s structure: mock
 * `global.fetch` only (restored in `afterEach`, since `mock.restore()` does
 * NOT undo a direct property assignment — same gotcha documented there and in
 * `google-veo.test.ts`), toggle `webEnv` keys directly, and never make a real
 * network call (this environment's egress proxy blocks `api.higgsfield.ai`
 * anyway).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import type { JobStatus } from "@/lib/studio/backends/types";
import { higgsfieldBackend } from "../higgsfield";

const originalFetch = globalThis.fetch;
const originalCredentials = webEnv.HIGGSFIELD_CREDENTIALS;
const originalBaseUrl = webEnv.HIGGSFIELD_BASE_URL;
const originalModel = webEnv.HIGGSFIELD_MODEL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.HIGGSFIELD_CREDENTIALS = originalCredentials;
	webEnv.HIGGSFIELD_BASE_URL = originalBaseUrl;
	webEnv.HIGGSFIELD_MODEL = originalModel;
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

describe("higgsfieldBackend.isAvailable", () => {
	it("is false with no credentials", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "";
		expect(higgsfieldBackend.isAvailable()).toBe(false);
	});

	it("is false with malformed credentials (no colon)", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "not-a-valid-credential";
		expect(higgsfieldBackend.isAvailable()).toBe(false);
	});

	it("is false with malformed credentials (more than one colon)", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "a:b:c";
		expect(higgsfieldBackend.isAvailable()).toBe(false);
	});

	it("is true with well-formed 'id:secret' credentials", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		expect(higgsfieldBackend.isAvailable()).toBe(true);
	});
});

describe("higgsfieldBackend.submit", () => {
	it("sends 'Key id:secret' as the exact Authorization header", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		let authHeader: string | undefined;
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			authHeader = headers.Authorization;
		});
		await higgsfieldBackend.submit({ modality: "video", prompt: "x" });
		expect(authHeader).toBe("Key key-id:key-secret");
	});

	it("returns a pending job on a queued response", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		stubFetch({ status: "queued", request_id: "req-1" });
		const result = await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("pending");
		expect(result.jobId).toBe("req-1");
	});

	it("never throws — returns status:'failed' with no credentials configured", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "";
		const result = await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
	});

	it("never throws — returns status:'failed' on an HTTP error (e.g. 401)", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		stubFetch({ error: "invalid key" }, 401);
		const result = await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/401/);
	});

	// VERIFIED shape: this endpoint's own validation errors answer 400 with
	// `{"detail": "a sentence"}` (JSON-schema style), not `{error}`/`{message}`.
	it("surfaces the 400 'detail' string shape this endpoint actually returns", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		stubFetch(
			{ detail: "resolution: '1080p' is not one of ['480p', '720p']" },
			400,
		);
		const result = await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/400/);
		expect(result.error).toMatch(/resolution/);
	});

	it("clamps a sub-4s duration up to 4s in the submitted body", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		let body: Record<string, unknown> = {};
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			body = JSON.parse((init?.body as string) ?? "{}");
		});
		await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
			duration: 2,
		});
		expect(body.duration).toBe(4);
	});

	it("clamps an over-30s duration down to 30s in the submitted body", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		let body: Record<string, unknown> = {};
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			body = JSON.parse((init?.body as string) ?? "{}");
		});
		await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
			duration: 45,
		});
		expect(body.duration).toBe(30);
	});
});

describe("higgsfieldBackend.poll — status mapping", () => {
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
			webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
			stubFetch({
				status: apiStatus,
				request_id: "req-1",
				video: { url: "https://example.com/video.mp4" },
			});
			const result = await higgsfieldBackend.poll("req-1");
			expect(result.status).toBe(expected);
		});
	}

	it("returns mediaUrl from video.url on completed", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		stubFetch({
			status: "completed",
			request_id: "req-1",
			video: { url: "https://example.com/video.mp4" },
		});
		const result = await higgsfieldBackend.poll("req-1");
		expect(result.mediaUrl).toBe("https://example.com/video.mp4");
	});

	it("never throws — returns status:'failed' on an HTTP error", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		stubFetch({ error: "not found" }, 404);
		const result = await higgsfieldBackend.poll("req-1");
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
	});
});

describe("higgsfieldBackend.estimateCost — clamps the same duration it submits", () => {
	it("bills a sub-4s request as the clamped 4s", () => {
		const est = higgsfieldBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 1,
		});
		expect(est.basis).toMatch(/× 4s/);
	});

	it("bills an over-30s request as the clamped 30s", () => {
		const est = higgsfieldBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 60,
		});
		expect(est.basis).toMatch(/× 30s/);
	});
});

describe("higgsfieldBackend — resolution is capped at 480p/720p (VERIFIED: 1080p returns HTTP 400)", () => {
	// Pins the corrected capability list so the earlier "480p"/"720p"/"1080p"
	// lie (extrapolated from the seedance_2_0 CLI doc, never true of the 2.5
	// REST endpoint) cannot silently come back.
	it("advertises only 480p and 720p in capabilities.resolutions", () => {
		expect(higgsfieldBackend.capabilities.resolutions).toEqual([
			"480p",
			"720p",
		]);
	});

	it("submits the caller's resolution verbatim when it's 480p or 720p", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		let body: Record<string, unknown> = {};
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			body = JSON.parse((init?.body as string) ?? "{}");
		});
		await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
			resolution: "480p",
		});
		expect(body.resolution).toBe("480p");
	});

	it("falls back to 720p in the submitted body for an unsupported resolution (e.g. a caller-pinned 1080p) rather than forwarding a request that will 400", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "key-id:key-secret";
		let body: Record<string, unknown> = {};
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			body = JSON.parse((init?.body as string) ?? "{}");
		});
		await higgsfieldBackend.submit({
			modality: "video",
			prompt: "x",
			// VideoResolution is a shared cross-vendor union that still includes
			// "1080p" (other backends, e.g. Veo/Kling, do support it); this
			// adapter must clamp it defensively since Higgsfield's own 2.5
			// endpoint 400s on it.
			resolution: "1080p",
		});
		expect(body.resolution).toBe("720p");
	});

	it("quotes the same clamped 720p in estimateCost's basis for an unsupported resolution, so the display never promises a resolution the submit body won't send", () => {
		const est = higgsfieldBackend.estimateCost({
			modality: "video",
			prompt: "x",
			resolution: "1080p",
		});
		expect(est.basis).toMatch(/720p/);
		expect(est.basis).not.toMatch(/1080p/);
	});
});
