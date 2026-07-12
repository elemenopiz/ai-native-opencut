/**
 * Unit coverage for POST /api/tts — the cloud text-to-speech route.
 *
 * Drives the REAL `POST` handler with a fake auth session, a stubbed global
 * `fetch` (the route reaches OpenAI through `fetchWithTimeout`, which wraps
 * global fetch), and the REAL rate-limit module. Asserts the gates: 503 (no
 * key), 401 (unauthenticated), 429 (past the burst cap), 400 (bad voice /
 * over-length text / not JSON), 413 (oversized body), 502 (provider error),
 * and the happy path (mp3 bytes back as `audio/mpeg`, correct OpenAI call
 * shape).
 *
 * NON-LEAKING by construction (see apps/web/docs/PROD-READINESS.md caveats on
 * bun's process-global `mock.module` registry):
 *  - We do NOT no-op `@/lib/rate-limit`. We load the REAL module via a
 *    query-suffixed specifier, re-pin the alias to it, and reset the
 *    process-wide limiter singleton before each test — same trick as
 *    llm/enhance-prompt's tests.
 *  - Global `fetch` is stubbed per-test and restored in `afterEach`, so no
 *    module-registry entry is touched for the provider call.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { webEnv } from "@byorn/env/web";

// ── fakes ────────────────────────────────────────────────────────────────────

// Toggleable session: null ⇒ unauthenticated (drives the 401 test).
const authState: { user: { id: string } | null } = { user: { id: "u1" } };
mock.module("@/lib/auth/server", () => ({
	auth: {
		api: { getSession: async () => (authState.user ? authState : null) },
	},
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Load the REAL rate-limit implementation, immune to cross-file mock leakage —
// the query string resolves to a DISTINCT module entry that bypasses the mock
// registry while loading the same real source.
const realRateLimit = (await import(
	"../../../../lib/rate-limit.ts?real" as string
)) as typeof import("@/lib/rate-limit");
// Re-pin the alias to real, so the route sees real limiting even if a no-op leaked.
mock.module("@/lib/rate-limit", () => ({ ...realRateLimit }));

const { InMemoryRateLimiter, RATE_LIMITS } = realRateLimit;
const TTS_BURST = RATE_LIMITS["tts:generate"].perMinute;

const { POST } = await import("../route");

// ── helpers ──────────────────────────────────────────────────────────────────

const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3" header-ish

/** Records the last outbound fetch so tests can assert the OpenAI call shape. */
const lastFetch: { url: string | null; init: RequestInit | null } = {
	url: null,
	init: null,
};

function stubFetch(
	impl: () => Response | Promise<Response> = () =>
		new Response(FAKE_MP3, {
			status: 200,
			headers: { "content-type": "audio/mpeg" },
		}),
): void {
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		lastFetch.url = String(input);
		lastFetch.init = init ?? null;
		return impl();
	}) as typeof fetch;
}

function makeReq(body: unknown, ip = "203.0.113.9"): Request {
	return new Request("http://localhost/api/tts", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": ip,
		},
	});
}

const realFetch = globalThis.fetch;
const savedOpenAiKey = webEnv.OPENAI_API_KEY;

beforeEach(() => {
	// Fresh limiter per test: reset the process-wide singleton enforceRateLimit reads.
	(
		globalThis as {
			__byornRateLimiter?: InstanceType<typeof InMemoryRateLimiter>;
		}
	).__byornRateLimiter = new InMemoryRateLimiter();
	authState.user = { id: "u1" };
	webEnv.OPENAI_API_KEY = "test-openai-key";
	lastFetch.url = null;
	lastFetch.init = null;
	stubFetch();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	webEnv.OPENAI_API_KEY = savedOpenAiKey;
});

// ── tests ────────────────────────────────────────────────────────────────────

test("503 with a machine-readable code when OPENAI_API_KEY is not configured", async () => {
	webEnv.OPENAI_API_KEY = "";

	const res = await POST(makeReq({ text: "hello world" }));

	expect(res.status).toBe(503);
	const json = (await res.json()) as { error?: string };
	expect(json.error).toBe("tts_not_configured");
	// No provider call may have been attempted.
	expect(lastFetch.url).toBeNull();
});

test("401 when there is no signed-in user", async () => {
	authState.user = null;

	const res = await POST(makeReq({ text: "hello world" }));

	expect(res.status).toBe(401);
	expect(lastFetch.url).toBeNull();
});

test("429 once the per-minute burst cap is exhausted", async () => {
	// Burn exactly the burst budget — all should pass.
	for (let i = 0; i < TTS_BURST; i++) {
		const ok = await POST(makeReq({ text: "hello world" }));
		expect(ok.status).toBe(200);
	}
	// The next one is over the cap.
	const limited = await POST(makeReq({ text: "hello world" }));
	expect(limited.status).toBe(429);
});

test("400 on an unknown voice", async () => {
	const res = await POST(makeReq({ text: "hi", voice: "bob" }));
	expect(res.status).toBe(400);
	expect(lastFetch.url).toBeNull();
});

test("400 on over-length text, missing text, and non-JSON bodies", async () => {
	const tooLong = await POST(makeReq({ text: "x".repeat(4001) }));
	expect(tooLong.status).toBe(400);

	const empty = await POST(makeReq({ text: "" }));
	expect(empty.status).toBe(400);

	const missing = await POST(makeReq({ voice: "alloy" }));
	expect(missing.status).toBe(400);

	const notJson = await POST(makeReq("this is not json{"));
	expect(notJson.status).toBe(400);
});

test("400 on an out-of-range speed", async () => {
	const res = await POST(makeReq({ text: "hi", speed: 3 }));
	expect(res.status).toBe(400);
});

test("413 when the body exceeds the size cap", async () => {
	const huge = "x".repeat(33 * 1024);
	const res = await POST(makeReq({ text: huge }));

	// Rejected before the (also-failing) 4000-char text validation.
	expect(res.status).toBe(413);
});

test("happy path returns mp3 bytes as audio/mpeg and sends the right OpenAI call", async () => {
	const res = await POST(
		makeReq({ text: "hello world", voice: "nova", speed: 1.25 }),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toBe("audio/mpeg");
	const bytes = new Uint8Array(await res.arrayBuffer());
	expect(bytes).toEqual(FAKE_MP3);

	// The OpenAI call shape.
	expect(lastFetch.url).toBe("https://api.openai.com/v1/audio/speech");
	expect(lastFetch.init?.method).toBe("POST");
	const headers = new Headers(lastFetch.init?.headers);
	expect(headers.get("authorization")).toBe("Bearer test-openai-key");
	const sent = JSON.parse(String(lastFetch.init?.body)) as Record<
		string,
		unknown
	>;
	expect(sent.model).toBe("gpt-4o-mini-tts");
	expect(sent.voice).toBe("nova");
	expect(sent.input).toBe("hello world");
	expect(sent.response_format).toBe("mp3");
	expect(sent.speed).toBe(1.25);
});

test("language is accepted but NOT forwarded to OpenAI", async () => {
	// gpt-4o-mini-tts has no language parameter (it follows the input text) —
	// the field exists only for client forward-compat, so it must be validated
	// here and then dropped, never sent upstream.
	const res = await POST(makeReq({ text: "hola mundo", language: "es" }));

	expect(res.status).toBe(200);
	const sent = JSON.parse(String(lastFetch.init?.body)) as Record<
		string,
		unknown
	>;
	expect("language" in sent).toBe(false);
});

test("voice defaults to alloy and speed is omitted when not provided", async () => {
	const res = await POST(makeReq({ text: "hello world" }));

	expect(res.status).toBe(200);
	const sent = JSON.parse(String(lastFetch.init?.body)) as Record<
		string,
		unknown
	>;
	expect(sent.voice).toBe("alloy");
	expect("speed" in sent).toBe(false);
});

test("502 with a sanitized message on a provider error (no provider body leaked)", async () => {
	stubFetch(
		() =>
			new Response(
				JSON.stringify({
					error: { message: "Incorrect API key provided: test-openai-key" },
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
	);

	const res = await POST(makeReq({ text: "hello world" }));

	expect(res.status).toBe(502);
	const json = (await res.json()) as { error?: string; message?: string };
	expect(json.error).toBe("provider_api_error");
	// Sanitized: neither the key nor the raw provider body may leak through.
	const text = JSON.stringify(json);
	expect(text).not.toContain("test-openai-key");
	expect(text).not.toContain("Incorrect API key");
});

test("502 when the provider fetch throws (timeout / network)", async () => {
	stubFetch(() => {
		throw new Error("fetch timed out after 55000ms");
	});

	const res = await POST(makeReq({ text: "hello world" }));

	expect(res.status).toBe(502);
	const json = (await res.json()) as { error?: string };
	expect(json.error).toBe("tts_error");
});
