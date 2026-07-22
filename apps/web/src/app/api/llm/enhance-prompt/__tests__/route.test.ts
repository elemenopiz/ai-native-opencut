/**
 * Unit coverage for POST /api/llm/enhance-prompt — the one-shot prompt rewriter.
 *
 * Drives the REAL `POST` handler with a fake Anthropic SDK, a fake auth session,
 * and the REAL rate-limit module. Asserts the five gates: 503 (no key), 401
 * (unauthenticated), 429 (past the burst cap), 4xx (oversized / invalid body),
 * and the happy path (returns the model's text).
 *
 * NON-LEAKING by construction (see apps/web/docs/PROD-READINESS.md caveats on
 * bun's process-global `mock.module` registry):
 *  - We do NOT no-op `@/lib/rate-limit`. Instead we load the REAL module via a
 *    query-suffixed specifier (immune to any no-op another test file leaked in),
 *    re-pin the alias to that real implementation (pass-through), and reset the
 *    process-wide limiter singleton before each test. So this file both sees real
 *    rate limiting AND leaves the registry pinned to the real module — it can't
 *    break neighbors like arrangements/__tests__/route.test.ts.
 *  - `@anthropic-ai/sdk`, `@/lib/auth/server`, and `next/headers` are mocked
 *    before the handler imports them.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { webEnv } from "@byorn/env/web";

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeAPIError extends Error {
	status?: number;
}

/** Records the last create params so a test can assert what the route sent. */
const lastCreate: { params: unknown } = { params: null };

/** Toggleable stop_reason so a test can drive the truncation-guard path. */
const fakeAnthropicReply: { stopReason: string } = { stopReason: "end_turn" };

class FakeAnthropic {
	static APIError = FakeAPIError;
	messages = {
		create: async (params: unknown) => {
			lastCreate.params = params;
			return {
				content: [
					{ type: "text", text: "  a lush, cinematic enhanced prompt  " },
				],
				stop_reason: fakeAnthropicReply.stopReason,
				model: "fake",
				usage: {},
			};
		},
	};
	constructor(_opts: unknown) {}
}

mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));

// Toggleable session: null ⇒ unauthenticated (drives the 401 test).
const authState: {
	user: { id: string; createdAt?: Date } | null;
} = {
	user: {
		id: "u1",
		// Well before the AI-access cutoff — the default fixture represents a
		// grandfathered existing user, since this route bills our provider key
		// and hasAiAccess must pass for the "signed-in user" happy paths below.
		createdAt: new Date("2020-01-01T00:00:00.000Z"),
	},
};
mock.module("@/lib/auth/server", () => ({
	auth: {
		api: { getSession: async () => (authState.user ? authState : null) },
	},
}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

// Load the REAL rate-limit implementation, immune to cross-file mock leakage —
// the query string resolves to a DISTINCT module entry that bypasses the mock
// registry while loading the same real source (same trick as arrangements).
const realRateLimit = (await import(
	"../../../../../lib/rate-limit.ts?real" as string
)) as typeof import("@/lib/rate-limit");
// Re-pin the alias to real, so the route sees real limiting even if a no-op leaked.
mock.module("@/lib/rate-limit", () => ({ ...realRateLimit }));

const { InMemoryRateLimiter, RATE_LIMITS } = realRateLimit;
const ENHANCE_BURST = RATE_LIMITS["llm:enhance"].perMinute;

const { POST } = await import("../route");

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown, ip = "203.0.113.9"): Request {
	return new Request("http://localhost/api/llm/enhance-prompt", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": ip,
		},
	});
}

const savedAnthropicKey = webEnv.ANTHROPIC_API_KEY;
const savedMoonshotKey = webEnv.MOONSHOT_API_KEY;
const savedGeminiKey = webEnv.GEMINI_API_KEY;
const savedDirectorModel = webEnv.DIRECTOR_MODEL;
// Save/RESTORE the global fetch by assignment — mock.restore() does NOT undo a
// property assignment (the agent-streaming leak, fixed @44b4e1ca).
const savedFetch = globalThis.fetch;

beforeEach(() => {
	// Fresh limiter per test: reset the process-wide singleton enforceRateLimit reads.
	(
		globalThis as {
			__byornRateLimiter?: InstanceType<typeof InMemoryRateLimiter>;
		}
	).__byornRateLimiter = new InMemoryRateLimiter();
	authState.user = {
		id: "u1",
		createdAt: new Date("2020-01-01T00:00:00.000Z"),
	};
	webEnv.ANTHROPIC_API_KEY = "test-key";
	webEnv.MOONSHOT_API_KEY = "";
	// Gemini off by default so the legacy-provider tests keep exercising the
	// Anthropic path; the Gemini tests opt in explicitly.
	webEnv.GEMINI_API_KEY = "";
	webEnv.DIRECTOR_MODEL = "";
	lastCreate.params = null;
	fakeAnthropicReply.stopReason = "end_turn";
});

afterEach(() => {
	webEnv.ANTHROPIC_API_KEY = savedAnthropicKey;
	webEnv.MOONSHOT_API_KEY = savedMoonshotKey;
	webEnv.GEMINI_API_KEY = savedGeminiKey;
	webEnv.DIRECTOR_MODEL = savedDirectorModel;
	globalThis.fetch = savedFetch;
});

/** Install a fake global fetch for the Gemini upstream; records the last call. */
function stubGeminiUpstream(
	reply: { status?: number; text?: string; rawBody?: string } = {},
) {
	const seen: { url: string; init: RequestInit | undefined }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({ url: String(input), init });
		if (reply.status && reply.status >= 400) {
			return new Response(reply.rawBody ?? "upstream error", {
				status: reply.status,
			});
		}
		return new Response(
			reply.rawBody ??
				JSON.stringify({
					candidates: [
						{
							content: {
								parts: [{ text: reply.text ?? "a gemini-enhanced prompt" }],
							},
						},
					],
				}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	return seen;
}

// ── tests ────────────────────────────────────────────────────────────────────

test("503 with a machine-readable code when no provider key is configured", async () => {
	webEnv.ANTHROPIC_API_KEY = "";
	webEnv.MOONSHOT_API_KEY = "";

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(503);
	const json = (await res.json()) as { error?: string };
	expect(json.error).toBe("enhance_not_configured");
});

test("401 when there is no signed-in user", async () => {
	authState.user = null;

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(401);
});

test("happy path returns the model's enhanced text, trimmed", async () => {
	const res = await POST(
		makeReq({
			prompt: "a cat on a couch",
			mode: "video",
			context: { styleBible: "warm, grainy 16mm", persona: "Mittens: a tabby" },
		}),
	);

	expect(res.status).toBe(200);
	const json = (await res.json()) as { enhanced?: string };
	expect(json.enhanced).toBe("a lush, cinematic enhanced prompt");
});

test("429 once the per-minute burst cap is exhausted", async () => {
	// Burn exactly the burst budget — all should pass.
	for (let i = 0; i < ENHANCE_BURST; i++) {
		const ok = await POST(makeReq({ prompt: "a cat", mode: "image" }));
		expect(ok.status).toBe(200);
	}
	// The next one is over the cap.
	const limited = await POST(makeReq({ prompt: "a cat", mode: "image" }));
	expect(limited.status).toBe(429);
});

test("400 on an invalid body (bad mode / missing prompt)", async () => {
	const badMode = await POST(makeReq({ prompt: "hi", mode: "audio" }));
	expect(badMode.status).toBe(400);

	const noPrompt = await POST(makeReq({ mode: "image" }));
	expect(noPrompt.status).toBe(400);

	const notJson = await POST(makeReq("this is not json{"));
	expect(notJson.status).toBe(400);
});

test("413 when the body exceeds the size cap", async () => {
	const huge = "x".repeat(33 * 1024);
	const res = await POST(makeReq({ prompt: huge, mode: "image" }));

	// Rejected before the (also-failing) 8000-char prompt validation.
	expect(res.status).toBe(413);
});

test("a prompt over 2000 but under the 8000-char cap now passes validation", async () => {
	// Long, detailed drafts are exactly what this route must stop reducing —
	// the input schema must accept them (previously capped at 2000 chars).
	const long = "a very detailed cinematic description, ".repeat(150); // ~6000 chars
	expect(long.length).toBeGreaterThan(2000);
	expect(long.length).toBeLessThan(8000);

	const res = await POST(makeReq({ prompt: long, mode: "video" }));

	expect(res.status).toBe(200);
});

test("a prompt over the 8000-char cap is still rejected as a bad request", async () => {
	const tooLong = "x".repeat(8001);
	const res = await POST(makeReq({ prompt: tooLong, mode: "image" }));

	expect(res.status).toBe(400);
});

test("system prompt instructs the model to preserve every user-specified detail", async () => {
	await POST(makeReq({ prompt: "a cat on a couch", mode: "image" }));

	const system = (lastCreate.params as { system?: string } | null)?.system;
	expect(system).toContain(
		"EVERY concrete element the user specified — subjects, actions, settings, styles, constraints, names, numbers, ordering — MUST survive into the rewrite",
	);
});

// ── truncation guard ─────────────────────────────────────────────────────────

test("Gemini MAX_TOKENS finishReason surfaces as a 502 truncated_completion, not partial text", async () => {
	webEnv.GEMINI_API_KEY = "gem-key";
	stubGeminiUpstream({
		rawBody: JSON.stringify({
			candidates: [
				{
					content: { parts: [{ text: "an enhanced prompt that got cut" }] },
					finishReason: "MAX_TOKENS",
				},
			],
		}),
	});

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(502);
	const json = (await res.json()) as { error?: string; message?: string };
	expect(json.error).toBe("truncated_completion");
	expect(json.message).toBeTruthy();
});

test("Anthropic/Kimi stop_reason max_tokens surfaces as a 502 truncated_completion", async () => {
	fakeAnthropicReply.stopReason = "max_tokens";

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(502);
	const json = (await res.json()) as { error?: string };
	expect(json.error).toBe("truncated_completion");
});

// ── Gemini-first provider selection ──────────────────────────────────────────

test("GEMINI_API_KEY wins over the other providers and returns Gemini's text", async () => {
	webEnv.GEMINI_API_KEY = "gem-key";
	webEnv.MOONSHOT_API_KEY = "kimi-key"; // present but must lose to Gemini
	const seen = stubGeminiUpstream({ text: "  a gemini-enhanced prompt  " });

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(200);
	expect(((await res.json()) as { enhanced?: string }).enhanced).toBe(
		"a gemini-enhanced prompt",
	);
	// One native generateContent call, key in the header (never the URL),
	// default gemini model, and the Anthropic fake untouched.
	expect(seen).toHaveLength(1);
	expect(seen[0].url).toContain("/models/gemini-3.5-flash:generateContent");
	expect(seen[0].url).not.toContain("gem-key");
	expect(
		new Headers(seen[0].init?.headers as HeadersInit).get("x-goog-api-key"),
	).toBe("gem-key");
	expect(lastCreate.params).toBeNull();
});

test("a non-gemini DIRECTOR_MODEL never reaches the Gemini URL", async () => {
	webEnv.GEMINI_API_KEY = "gem-key";
	webEnv.DIRECTOR_MODEL = "claude-opus-4-8";
	const seen = stubGeminiUpstream();

	const res = await POST(makeReq({ prompt: "a cat", mode: "video" }));

	expect(res.status).toBe(200);
	expect(seen[0].url).toContain("gemini-3.5-flash");
	expect(seen[0].url).not.toContain("claude");
});

test("a Gemini upstream error surfaces as provider_api_error with its status", async () => {
	webEnv.GEMINI_API_KEY = "gem-key";
	stubGeminiUpstream({ status: 429, rawBody: "quota exceeded" });

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(429);
	const json = (await res.json()) as { error?: string; message?: string };
	expect(json.error).toBe("provider_api_error");
	expect(json.message).toContain("quota exceeded");
});

test("no Gemini key falls back to the Anthropic-dialect path (fake SDK answers)", async () => {
	webEnv.GEMINI_API_KEY = "";
	const seen = stubGeminiUpstream(); // must stay unused

	const res = await POST(makeReq({ prompt: "a cat", mode: "image" }));

	expect(res.status).toBe(200);
	expect(((await res.json()) as { enhanced?: string }).enhanced).toBe(
		"a lush, cinematic enhanced prompt",
	);
	expect(seen).toHaveLength(0);
});
