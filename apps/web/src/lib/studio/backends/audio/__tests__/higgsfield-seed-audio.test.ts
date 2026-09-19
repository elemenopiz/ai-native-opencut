/**
 * Higgsfield Seed Audio (text-to-SPEECH) adapter tests.
 *
 * Same idiom as the sibling Higgsfield tests: stub `global.fetch` only
 * (restored in `afterEach` — `mock.restore()` does not undo a direct property
 * assignment), toggle `webEnv` keys directly, never touch the network. There is
 * no money on the Higgsfield key; nothing here makes a live call.
 *
 * Two behaviours are load-bearing enough to be pinned rather than assumed:
 *   1. the voice PAIR (`voice_type` + `voice_id`) is all-or-nothing — the
 *      provider rejects one without the other;
 *   2. `intents: []` — narration has no `SlotIntent`, and the adapter must not
 *      quietly advertise itself as a music model.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import type { JobStatus } from "@/lib/studio/backends/types";
import {
	higgsfieldSeedAudioBackend,
	speechSeconds,
} from "../higgsfield-seed-audio";

const CREDS = "key-id:key-secret";
const ENDPOINT = "bytedance/seed-audio/text-to-speech";

const originalFetch = globalThis.fetch;
const originalCredentials = webEnv.HIGGSFIELD_CREDENTIALS;
const originalBaseUrl = webEnv.HIGGSFIELD_BASE_URL;
const originalEndpoint = webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT;
const originalVoiceType = webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE;
const originalVoiceId = webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.HIGGSFIELD_CREDENTIALS = originalCredentials;
	webEnv.HIGGSFIELD_BASE_URL = originalBaseUrl;
	webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = originalEndpoint;
	webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE = originalVoiceType;
	webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID = originalVoiceId;
});

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

function configure() {
	webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
	webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = ENDPOINT;
	webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE = "";
	webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID = "";
}

async function capturedBody(
	req: Parameters<typeof higgsfieldSeedAudioBackend.submit>[0],
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
		body = JSON.parse((init?.body as string) ?? "{}");
	});
	await higgsfieldSeedAudioBackend.submit(req);
	return body;
}

describe("higgsfieldSeedAudioBackend.isAvailable — doubly gated", () => {
	it("is false with no credentials", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "";
		webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = ENDPOINT;
		expect(higgsfieldSeedAudioBackend.isAvailable()).toBe(false);
	});

	it("is false with a valid credential but no confirmed endpoint", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
		webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = "";
		expect(higgsfieldSeedAudioBackend.isAvailable()).toBe(false);
	});

	it("is false with malformed credentials", () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "a:b:c";
		webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = ENDPOINT;
		expect(higgsfieldSeedAudioBackend.isAvailable()).toBe(false);
	});

	it("is true with both a well-formed credential and an endpoint", () => {
		configure();
		expect(higgsfieldSeedAudioBackend.isAvailable()).toBe(true);
	});

	it("does NOT require the optional voice pair", () => {
		configure();
		expect(webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID).toBe("");
		expect(higgsfieldSeedAudioBackend.isAvailable()).toBe(true);
		expect(higgsfieldSeedAudioBackend.requiredEnv).toEqual([
			"HIGGSFIELD_CREDENTIALS",
			"HIGGSFIELD_SEED_AUDIO_ENDPOINT",
		]);
	});
});

describe("higgsfieldSeedAudioBackend — inert when unconfigured", () => {
	it("submit never throws and never calls fetch with no credentials", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = "";
		webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = ENDPOINT;
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}");
		}) as unknown as typeof fetch;

		const result = await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "Welcome to the show",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
		expect(called).toBe(false);
	});

	it("names the endpoint env var when only the path is missing", async () => {
		webEnv.HIGGSFIELD_CREDENTIALS = CREDS;
		webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT = "";
		const result = await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "hi",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/HIGGSFIELD_SEED_AUDIO_ENDPOINT/);
	});
});

describe("higgsfieldSeedAudioBackend — submit body", () => {
	it("sends the prompt plus an explicit format and sample rate", async () => {
		configure();
		const body = await capturedBody({
			modality: "audio",
			prompt: "Welcome to the show",
		});
		expect(body).toMatchObject({
			prompt: "Welcome to the show",
			format: "mp3",
			sample_rate: 24_000,
		});
	});

	it("omits the voice entirely when neither half is configured", async () => {
		configure();
		const body = await capturedBody({ modality: "audio", prompt: "hi" });
		expect(body.voice_id).toBeUndefined();
		expect(body.voice_type).toBeUndefined();
	});

	it("omits the voice when only voice_id is set (the pair is all-or-nothing)", async () => {
		configure();
		webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID = "voice-123";
		const body = await capturedBody({ modality: "audio", prompt: "hi" });
		expect(body.voice_id).toBeUndefined();
		expect(body.voice_type).toBeUndefined();
	});

	it("omits the voice when only voice_type is set", async () => {
		configure();
		webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE = "preset";
		const body = await capturedBody({ modality: "audio", prompt: "hi" });
		expect(body.voice_id).toBeUndefined();
		expect(body.voice_type).toBeUndefined();
	});

	it("sends both halves together when both are configured", async () => {
		configure();
		webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE = "preset";
		webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID = "voice-123";
		const body = await capturedBody({ modality: "audio", prompt: "hi" });
		expect(body).toMatchObject({
			voice_type: "preset",
			voice_id: "voice-123",
		});
	});

	it("never sends image_references or audio_references (mutually exclusive, and a voice forbids an image ref)", async () => {
		configure();
		const body = await capturedBody({
			modality: "audio",
			prompt: "hi",
			referenceImages: ["https://example.com/a.png"],
			referenceVideos: ["https://example.com/a.mp4"],
		});
		expect(body.image_references).toBeUndefined();
		expect(body.audio_references).toBeUndefined();
	});

	it("omits the prosody deltas whose provider default is already 0", async () => {
		configure();
		const body = await capturedBody({ modality: "audio", prompt: "hi" });
		expect(body.speech_rate).toBeUndefined();
		expect(body.pitch_rate).toBeUndefined();
		expect(body.loudness_rate).toBeUndefined();
	});
});

describe("higgsfieldSeedAudioBackend — transport", () => {
	it("sends 'Key id:secret' as the exact Authorization header", async () => {
		configure();
		let authHeader: string | undefined;
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			authHeader = headers.Authorization;
		});
		await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "hi",
		});
		expect(authHeader).toBe("Key key-id:key-secret");
	});

	it("POSTs to the configured endpoint path", async () => {
		configure();
		let seenUrl = "";
		stubFetch({ status: "queued", request_id: "req-1" }, 200, (url) => {
			seenUrl = url;
		});
		await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "hi",
		});
		expect(seenUrl).toBe(`https://api.higgsfield.ai/${ENDPOINT}`);
	});

	it("returns a pending job on a queued response", async () => {
		configure();
		stubFetch({ status: "queued", request_id: "req-1" });
		const result = await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "hi",
		});
		expect(result.status).toBe("pending");
		expect(result.jobId).toBe("req-1");
	});

	it("never throws — returns status:'failed' on an HTTP error (e.g. 403 no credits)", async () => {
		configure();
		stubFetch({ error: "insufficient credits" }, 403);
		const result = await higgsfieldSeedAudioBackend.submit({
			modality: "audio",
			prompt: "hi",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/403/);
	});
});

describe("higgsfieldSeedAudioBackend — poll", () => {
	const cases: [string, JobStatus][] = [
		["queued", "pending"],
		["in_progress", "processing"],
		["completed", "completed"],
		["failed", "failed"],
		["nsfw", "failed"],
		["cancelled", "failed"],
	];

	for (const [apiStatus, expected] of cases) {
		it(`maps '${apiStatus}' → '${expected}'`, async () => {
			configure();
			stubFetch({ status: apiStatus, request_id: "req-1" });
			const result = await higgsfieldSeedAudioBackend.poll("req-1");
			expect(result.status).toBe(expected);
		});
	}

	// The audio result field is UNVERIFIED — the adapter reads several shapes
	// defensively so one field-name guess can't throw away a finished render.
	it("reads a completed result from audio.url", async () => {
		configure();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			audio: { url: "https://example.com/vo.mp3" },
		});
		const result = await higgsfieldSeedAudioBackend.poll("req-1");
		expect(result.mediaUrl).toBe("https://example.com/vo.mp3");
	});

	it("reads a completed result from audios[0].url", async () => {
		configure();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			audios: [{ url: "https://example.com/vo.mp3" }],
		});
		expect((await higgsfieldSeedAudioBackend.poll("req-1")).mediaUrl).toBe(
			"https://example.com/vo.mp3",
		);
	});

	it("reads a completed result from results[0].url", async () => {
		configure();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			results: [{ url: "https://example.com/vo.mp3" }],
		});
		expect((await higgsfieldSeedAudioBackend.poll("req-1")).mediaUrl).toBe(
			"https://example.com/vo.mp3",
		);
	});

	it("reports completed with no mediaUrl rather than crashing on an unknown result shape", async () => {
		configure();
		stubFetch({
			status: "completed",
			request_id: "req-1",
			somethingElse: { url: "https://example.com/vo.mp3" },
		});
		const result = await higgsfieldSeedAudioBackend.poll("req-1");
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBeUndefined();
	});

	it("never throws — returns status:'failed' on an HTTP error", async () => {
		configure();
		stubFetch({ error: "not found" }, 404);
		const result = await higgsfieldSeedAudioBackend.poll("req-1");
		expect(result.status).toBe("failed");
		expect(result.error).toBeTruthy();
	});
});

describe("speechSeconds — TTS length is an output, so it is estimated", () => {
	it("honours an explicit duration when the caller supplies one", () => {
		expect(
			speechSeconds({ modality: "audio", prompt: "hi", duration: 42 }),
		).toBe(42);
	});

	it("estimates from word count at 150 wpm when no duration is given", () => {
		// 150 words at 150 wpm = 60s.
		const prompt = Array.from({ length: 150 }, () => "word").join(" ");
		expect(speechSeconds({ modality: "audio", prompt })).toBe(60);
	});

	it("never returns zero for a short script", () => {
		expect(speechSeconds({ modality: "audio", prompt: "Hi" })).toBe(1);
	});

	it("never returns zero for an empty script", () => {
		expect(speechSeconds({ modality: "audio", prompt: "   " })).toBe(1);
	});

	it("clamps a caller-supplied duration into the advertised range", () => {
		expect(
			speechSeconds({ modality: "audio", prompt: "hi", duration: 9_999 }),
		).toBe(600);
	});

	it("ignores a non-finite duration rather than propagating NaN into billing", () => {
		expect(
			speechSeconds({ modality: "audio", prompt: "hi", duration: Number.NaN }),
		).toBe(1);
	});
});

describe("higgsfieldSeedAudioBackend — cost estimate", () => {
	it("is finite and non-zero even with no duration supplied", () => {
		const est = higgsfieldSeedAudioBackend.estimateCost({
			modality: "audio",
			prompt: "Hi",
		});
		expect(Number.isFinite(est.credits)).toBe(true);
		expect(est.credits).toBeGreaterThan(0);
	});

	it("says so when the seconds are an estimate rather than a caller's figure", () => {
		expect(
			higgsfieldSeedAudioBackend.estimateCost({
				modality: "audio",
				prompt: "Hi",
			}).basis,
		).toMatch(/estimated from script length/);
		expect(
			higgsfieldSeedAudioBackend.estimateCost({
				modality: "audio",
				prompt: "Hi",
				duration: 30,
			}).basis,
		).not.toMatch(/estimated from script length/);
	});

	it("scales with the estimated length (0.375 cr/sec sale rate, ceiled)", () => {
		// 150 words → 60s → ceil(0.15 × 2.5 × 60) = 23.
		const prompt = Array.from({ length: 150 }, () => "word").join(" ");
		expect(
			higgsfieldSeedAudioBackend.estimateCost({ modality: "audio", prompt })
				.credits,
		).toBe(23);
	});

	it("does NOT implement resolveDurationSec — a word-count guess must not be reported as an exact snapped length", () => {
		expect(higgsfieldSeedAudioBackend.resolveDurationSec).toBeUndefined();
	});
});

describe("higgsfieldSeedAudioBackend — routing surface", () => {
	it("declares NO intents: narration has no SlotIntent, and it must not pose as a music model", () => {
		expect(higgsfieldSeedAudioBackend.capabilities.intents).toEqual([]);
	});

	it("does not require a source video (it is not a score model)", () => {
		expect(higgsfieldSeedAudioBackend.capabilities.requiresVideoRef).toBe(
			false,
		);
	});
});
