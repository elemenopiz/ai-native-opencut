/**
 * Unit coverage for POST /api/transcribe — the request SHAPE we send to
 * MAI-Transcribe-2.
 *
 * WHY THIS FILE EXISTS: on 2026-09-20 this route asked for word timestamps via
 * `modelOptions.timestamps` and got none back — the enhanced path ignores that
 * key and returns HTTP 200 with no error, no warning, and no `words` array.
 * Measured against api-version 2025-10-15 on identical audio: nested inside
 * `enhancedMode` → 15 words; in `modelOptions` → 0. Captions split on word
 * boundaries and the filler-word cut reads word timings, so the failure was
 * silent and downstream. Nothing pinned the outbound shape, so nothing caught
 * it.
 *
 * Drives the REAL `POST` with a fake session and a stubbed global `fetch` (the
 * route reaches the provider through `fetchWithTimeout`, which wraps global
 * fetch), then reads the multipart `definition` back off the captured request.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { webEnv } from "@byorn/env/web";

const authState: { user: { id: string; createdAt?: Date } | null } = {
	user: { id: "u1", createdAt: new Date("2020-01-01T00:00:00.000Z") },
};
mock.module("@/lib/auth/server", () => ({
	auth: {
		api: { getSession: async () => (authState.user ? authState : null) },
	},
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

const { POST } = await import("../route");

/** A minimal provider reply: one phrase carrying one word. */
const PROVIDER_OK = {
	durationMilliseconds: 1000,
	combinedPhrases: [{ text: "hello" }],
	phrases: [
		{
			offsetMilliseconds: 0,
			durationMilliseconds: 1000,
			text: "hello",
			locale: "en-US",
			confidence: 0.9,
			words: [{ text: "hello", offsetMilliseconds: 80, durationMilliseconds: 99 }],
		},
	],
};

const lastFetch: { url: string | null; init: RequestInit | null } = {
	url: null,
	init: null,
};

const realFetch = globalThis.fetch;
const savedKey = webEnv.AZURE_SPEECH_KEY;
const savedEndpoint = webEnv.AZURE_SPEECH_ENDPOINT;

beforeEach(() => {
	authState.user = { id: "u1", createdAt: new Date("2020-01-01T00:00:00.000Z") };
	webEnv.AZURE_SPEECH_KEY = "test-key";
	webEnv.AZURE_SPEECH_ENDPOINT = "https://example.cognitiveservices.azure.com";
	lastFetch.url = null;
	lastFetch.init = null;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		lastFetch.url = String(input);
		lastFetch.init = init ?? null;
		return new Response(JSON.stringify(PROVIDER_OK), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	webEnv.AZURE_SPEECH_KEY = savedKey;
	webEnv.AZURE_SPEECH_ENDPOINT = savedEndpoint;
});

function makeReq(extra: Record<string, string> = {}): Request {
	const form = new FormData();
	form.append("audio", new Blob([new Uint8Array([1, 2, 3])]), "clip.ogg");
	for (const [k, v] of Object.entries(extra)) form.append(k, v);
	return new Request("http://localhost/api/transcribe", {
		method: "POST",
		body: form,
		headers: { "x-forwarded-for": "203.0.113.9" },
	});
}

/** Pull the `definition` JSON back out of the captured multipart body. */
async function capturedDefinition(): Promise<Record<string, unknown>> {
	const body = lastFetch.init?.body as FormData | undefined;
	if (!body) throw new Error("no outbound fetch captured");
	const raw = body.get("definition");
	if (typeof raw !== "string") throw new Error("definition is not a string");
	return JSON.parse(raw) as Record<string, unknown>;
}

test("asks for word timestamps INSIDE enhancedMode, not modelOptions", async () => {
	const res = await POST(makeReq({ language: "en-US" }));
	expect(res.status).toBe(200);

	const def = await capturedDefinition();
	const enhanced = def.enhancedMode as Record<string, unknown>;

	// The whole point: nested, where the enhanced path actually reads it.
	expect(enhanced.timestamps).toBe("word");
	expect(enhanced.enabled).toBe(true);

	// And NOT in modelOptions, where it is silently dropped.
	const modelOptions = (def.modelOptions ?? {}) as Record<string, unknown>;
	expect(modelOptions.timestamps).toBeUndefined();
});

test("word timings survive into the response body", async () => {
	const res = await POST(makeReq());
	const json = (await res.json()) as {
		segments: { words: { word: string; start: number; end: number }[] }[];
	};
	expect(json.segments[0].words).toHaveLength(1);
	expect(json.segments[0].words[0].word).toBe("hello");
	// 80ms offset → 0.08s, +99ms duration → 0.179s.
	expect(json.segments[0].words[0].start).toBeCloseTo(0.08, 3);
	expect(json.segments[0].words[0].end).toBeCloseTo(0.179, 3);
});
