/**
 * ElevenLabs Music adapter — mocks only `global.fetch` (the real `/v1/music`
 * endpoint is synchronous and returns raw audio bytes) and toggles
 * `webEnv.ELEVENLABS_API_KEY` directly. `global.fetch` is captured/restored in
 * `afterEach` to avoid the known bun-test cross-file leak (mock.restore()
 * does not undo a direct property assignment — see agent-streaming.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { elevenlabsMusicBackend } from "../elevenlabs-music";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.ELEVENLABS_API_KEY;
const originalBase = webEnv.ELEVENLABS_BASE_URL;
const originalModel = webEnv.ELEVENLABS_MUSIC_MODEL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.ELEVENLABS_API_KEY = originalKey;
	webEnv.ELEVENLABS_BASE_URL = originalBase;
	webEnv.ELEVENLABS_MUSIC_MODEL = originalModel;
});

describe("elevenlabsMusicBackend — availability", () => {
	it("is inert without ELEVENLABS_API_KEY", () => {
		webEnv.ELEVENLABS_API_KEY = "";
		expect(elevenlabsMusicBackend.isAvailable()).toBe(false);
	});

	it("is available once ELEVENLABS_API_KEY is set", () => {
		webEnv.ELEVENLABS_API_KEY = "test-eleven-key";
		expect(elevenlabsMusicBackend.isAvailable()).toBe(true);
	});
});

describe("elevenlabsMusicBackend — capabilities", () => {
	it("declares text-music intent and does not require a video ref", () => {
		expect(elevenlabsMusicBackend.capabilities.intents).toEqual(["text-music"]);
		expect(elevenlabsMusicBackend.capabilities.requiresVideoRef).toBe(false);
		expect(elevenlabsMusicBackend.capabilities.durationRangeSec).toEqual({
			min: 3,
			max: 600,
		});
	});
});

describe("elevenlabsMusicBackend.submit", () => {
	beforeEach(() => {
		webEnv.ELEVENLABS_API_KEY = "test-eleven-key";
	});

	it("posts prompt/model_id/music_length_ms/force_instrumental with the xi-api-key header, returns a completed data: URL", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};
		let capturedKeyHeader = "";
		const audioBytes = new TextEncoder().encode("fake-mp3-bytes");
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init?.body as string);
			capturedKeyHeader = (init?.headers as Record<string, string>)[
				"xi-api-key"
			];
			return new Response(audioBytes, {
				status: 200,
				headers: { "content-type": "audio/mpeg" },
			});
		}) as unknown as typeof fetch;

		const result = await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "upbeat lofi hip-hop",
			duration: 45,
		});

		expect(capturedUrl).toBe("https://api.elevenlabs.io/v1/music");
		expect(capturedKeyHeader).toBe("test-eleven-key");
		expect(capturedBody).toMatchObject({
			prompt: "upbeat lofi hip-hop",
			model_id: "music_v2",
			music_length_ms: 45_000,
			force_instrumental: false,
		});
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toMatch(/^data:audio\/mpeg;base64,/);
	});

	it("clamps music_length_ms into the documented 3s–600s range", async () => {
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(new Uint8Array(), { status: 200 });
		}) as unknown as typeof fetch;

		await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "x",
			duration: 0.1,
		});
		expect(capturedBody.music_length_ms).toBe(3_000);

		await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "x",
			duration: 6000,
		});
		expect(capturedBody.music_length_ms).toBe(600_000);
	});

	it("appends lyrics to the prompt when not instrumental", async () => {
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(new Uint8Array(), { status: 200 });
		}) as unknown as typeof fetch;

		await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "wistful acoustic ballad",
			lyrics: "walking home in the rain",
			instrumental: false,
		});

		expect(capturedBody.prompt).toBe(
			"wistful acoustic ballad\n\nLyrics:\nwalking home in the rain",
		);
		expect(capturedBody.force_instrumental).toBe(false);
	});

	it("drops lyrics from the prompt when instrumental is forced", async () => {
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(new Uint8Array(), { status: 200 });
		}) as unknown as typeof fetch;

		await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "wistful acoustic ballad",
			lyrics: "walking home in the rain",
			instrumental: true,
		});

		expect(capturedBody.prompt).toBe("wistful acoustic ballad");
		expect(capturedBody.force_instrumental).toBe(true);
	});

	it("returns a failed SubmitResult (never throws) on a provider error", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 402 })) as unknown as typeof fetch;

		const result = await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "x",
		});

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/402/);
	});

	it("returns failed with a clear message when ELEVENLABS_API_KEY is unset", async () => {
		webEnv.ELEVENLABS_API_KEY = "";
		const result = await elevenlabsMusicBackend.submit({
			modality: "audio",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/ELEVENLABS_API_KEY/);
	});
});

describe("elevenlabsMusicBackend.poll", () => {
	it("is a terminal no-op (synchronous backend)", async () => {
		const result = await elevenlabsMusicBackend.poll("any-id");
		expect(result).toEqual({ jobId: "any-id", status: "completed" });
	});
});
