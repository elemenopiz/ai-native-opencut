/**
 * Contract coverage for the native Gemini relay (`POST /api/llm/gemini`).
 *
 * This drives the REAL `POST` handler with mocked auth/rate-limit modules and a
 * stubbed `global.fetch`, asserting the relay's whole surface: the
 * machine-readable no-key 503 (fired BEFORE auth, mirroring the agent relay's
 * fallback contract), the signed-in requirement once a key exists, rate-limit
 * short-circuiting, native passthrough (body fields forwarded untranslated,
 * relay-only fields stripped, output budget clamped), model resolution
 * (body > gemini-flavored DIRECTOR_MODEL > default), upstream error mapping,
 * and verbatim SSE passthrough for `stream: true`.
 *
 * Modules are mocked BEFORE the handler is imported (it binds `auth`,
 * `rate-limit`, and `next/headers` at module load). `global.fetch` is replaced
 * by direct assignment, which `mock.restore()` does NOT undo — it is captured
 * and restored in `afterEach` so the stub can't leak to later test files.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { webEnv } from "@byorn/env/web";

/** Mutable session the auth mock returns — tests flip it per case. */
let currentSession: { user: { id: string } } | null = {
	user: { id: "u1" },
};
/** When set, the rate-limit mock returns this response (limited). */
let limitedResponse: Response | undefined;

mock.module("@/lib/auth/server", () => ({
	auth: { api: { getSession: async () => currentSession } },
}));
// Snapshot the REAL rate-limit exports before the controllable mock replaces
// the module, and restore them in afterAll — bun's mock.module live-overwrites
// the module registry process-wide (see the agent relay's test for the full
// order-dependence story).
const realRateLimit = { ...(await import("@/lib/rate-limit")) };
mock.module("@/lib/rate-limit", () => ({
	enforceRateLimit: async () => limitedResponse,
}));
afterAll(() => {
	mock.module("@/lib/rate-limit", () => realRateLimit);
});
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

const { POST } = await import("../route");

/** The upstream request the fetch stub captured. */
interface Captured {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}
let captured: Captured | null = null;
/** The canned upstream Response the fetch stub serves. */
let upstreamResponse: () => Response = () =>
	new Response(JSON.stringify({ candidates: [] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const originalFetch = globalThis.fetch;

function stubFetch(): void {
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		captured = {
			url: String(input),
			headers: Object.fromEntries(
				new Headers(init?.headers as HeadersInit).entries(),
			),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		};
		return upstreamResponse();
	}) as unknown as typeof fetch;
}

/** Minimal Request stand-in: the handler reads `.json()`, `.headers`, `.signal`. */
function makeReq(body: unknown): Request {
	return {
		url: "http://localhost/api/llm/gemini",
		json: async () => body,
		headers: new Headers(),
		signal: new AbortController().signal,
	} as unknown as Request;
}

const validBody = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

const savedGeminiKey = webEnv.GEMINI_API_KEY;
const savedBaseUrl = webEnv.GEMINI_BASE_URL;
const savedDirectorModel = webEnv.DIRECTOR_MODEL;

beforeEach(() => {
	captured = null;
	currentSession = { user: { id: "u1" } };
	limitedResponse = undefined;
	webEnv.GEMINI_API_KEY = "test-gemini-key";
	webEnv.GEMINI_BASE_URL = "";
	webEnv.DIRECTOR_MODEL = "";
	stubFetch();
});

afterEach(() => {
	webEnv.GEMINI_API_KEY = savedGeminiKey;
	webEnv.GEMINI_BASE_URL = savedBaseUrl;
	webEnv.DIRECTOR_MODEL = savedDirectorModel;
	globalThis.fetch = originalFetch;
});

test("no key → machine-readable 503 before auth (client fallback contract)", async () => {
	webEnv.GEMINI_API_KEY = "";
	currentSession = null; // even anonymous callers must get the 503, not a 401
	const res = await POST(makeReq(validBody));
	expect(res.status).toBe(503);
	const body = (await res.json()) as { error: string };
	expect(body.error).toBe("gemini_not_configured");
	expect(captured).toBeNull(); // nothing left the server
});

test("key set + anonymous → 401 (the relay bills our key)", async () => {
	currentSession = null;
	const res = await POST(makeReq(validBody));
	expect(res.status).toBe(401);
	expect(captured).toBeNull();
});

test("rate-limited → the limiter's response is returned as-is", async () => {
	limitedResponse = new Response("slow down", { status: 429 });
	const res = await POST(makeReq(validBody));
	expect(res.status).toBe(429);
	expect(captured).toBeNull();
});

test("empty/missing contents → 400", async () => {
	const res = await POST(makeReq({ contents: [] }));
	expect(res.status).toBe(400);
	expect(captured).toBeNull();
});

test("native passthrough: fields forwarded untranslated, relay-only fields stripped, budget clamped", async () => {
	const res = await POST(
		makeReq({
			...validBody,
			systemInstruction: { parts: [{ text: "be the director" }] },
			tools: [{ functionDeclarations: [{ name: "getReel" }] }],
			toolConfig: { functionCallingConfig: { mode: "NONE" } },
			generationConfig: { temperature: 0.7, maxOutputTokens: 999999 },
			model: "gemini-custom",
			stream: false,
		}),
	);
	expect(res.status).toBe(200);
	expect(captured).not.toBeNull();
	// Explicit model wins; non-streaming hits :generateContent.
	expect(captured?.url).toBe(
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-custom:generateContent",
	);
	// Key rides in the header, never the URL.
	expect(captured?.headers["x-goog-api-key"]).toBe("test-gemini-key");
	expect(captured?.url).not.toContain("test-gemini-key");
	// Native fields pass through byte-identical; relay-only fields don't.
	expect(captured?.body.contents).toEqual(validBody.contents);
	expect(captured?.body.systemInstruction).toEqual({
		parts: [{ text: "be the director" }],
	});
	expect(captured?.body.tools).toEqual([
		{ functionDeclarations: [{ name: "getReel" }] },
	]);
	expect(captured?.body.toolConfig).toEqual({
		functionCallingConfig: { mode: "NONE" },
	});
	expect(captured?.body.model).toBeUndefined();
	expect(captured?.body.stream).toBeUndefined();
	// Caller's generationConfig survives, but the output budget is clamped.
	expect(captured?.body.generationConfig).toEqual({
		temperature: 0.7,
		maxOutputTokens: 32000,
	});
	// Upstream JSON is returned verbatim.
	expect(await res.json()).toEqual({ candidates: [] });
});

test("model resolution: gemini-flavored DIRECTOR_MODEL is honored, other ids are not", async () => {
	webEnv.DIRECTOR_MODEL = "gemini-4-ultra";
	await POST(makeReq(validBody));
	expect(captured?.url).toContain("/models/gemini-4-ultra:");

	webEnv.DIRECTOR_MODEL = "kimi-k2.6"; // the SIBLING relay's model — not ours
	await POST(makeReq(validBody));
	expect(captured?.url).toContain("/models/gemini-3.5-flash:");
});

test("default generationConfig applies the standard output budget", async () => {
	await POST(makeReq(validBody));
	expect(captured?.body.generationConfig).toEqual({ maxOutputTokens: 16000 });
});

test("upstream error → gemini_api_error with the upstream status", async () => {
	upstreamResponse = () =>
		new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});
	const res = await POST(makeReq(validBody));
	expect(res.status).toBe(429);
	const body = (await res.json()) as { error: string; message: string };
	expect(body.error).toBe("gemini_api_error");
	expect(body.message).toContain("quota exceeded");
	expect(body.message).not.toContain("test-gemini-key");
});

test("stream: true → :streamGenerateContent?alt=sse, SSE body passed through verbatim", async () => {
	const sse =
		'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n';
	upstreamResponse = () =>
		new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	const res = await POST(makeReq({ ...validBody, stream: true }));
	expect(captured?.url).toContain(":streamGenerateContent?alt=sse");
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	expect(await res.text()).toBe(sse);
});

test("GEMINI_BASE_URL override is used verbatim (same convention as the Veo adapter)", async () => {
	webEnv.GEMINI_BASE_URL = "https://proxy.example.com/v1beta";
	await POST(makeReq(validBody));
	expect(captured?.url).toBe(
		"https://proxy.example.com/v1beta/models/gemini-3.5-flash:generateContent",
	);
});
