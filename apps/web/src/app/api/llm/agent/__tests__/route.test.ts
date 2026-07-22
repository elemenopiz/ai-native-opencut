/**
 * Cancel must stop the SERVER bill, not just the client's reading. When the
 * browser aborts the request (user hits Stop), the relay's streaming path used
 * to keep `client.messages.stream` running to completion on our provider key —
 * paying for tokens no one reads. The fix funnels the request's abort into the
 * upstream Anthropic call and tears the stream down.
 *
 * This drives the REAL `POST` handler with a fake Anthropic SDK whose stream
 * captures the `signal` it was handed and never resolves on its own, so aborting
 * the client request is the ONLY thing that can end it. We assert the upstream
 * signal fired (billing halted) and that the teardown emits no spurious `error`
 * frame to the gone connection.
 *
 * Modules are mocked BEFORE the handler is imported (it binds `auth`,
 * `rate-limit`, `next/headers`, and the Anthropic client at module load).
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { webEnv } from "@byorn/env/web";

interface State {
	/** The AbortSignal the route passed into `client.messages.stream`. */
	streamSignal: AbortSignal | null;
	/** Resolvers so a test can complete a stream deliberately (unused here). */
	streamCreated: number;
}
const state: State = { streamSignal: null, streamCreated: 0 };

class FakeAPIError extends Error {}

/** A fake MessageStream: records the signal, and only ever settles on abort. */
function fakeStream(signal: AbortSignal | undefined) {
	state.streamSignal = signal ?? null;
	state.streamCreated++;
	return {
		on() {
			return this;
		},
		finalMessage() {
			return new Promise((_resolve, reject) => {
				if (signal?.aborted) return reject(new FakeAPIError("aborted"));
				signal?.addEventListener("abort", () =>
					reject(new FakeAPIError("aborted")),
				);
				// No resolve otherwise — mimics an in-flight upstream stream.
			});
		},
	};
}

class FakeAnthropic {
	static APIError = FakeAPIError;
	messages = {
		stream: (_params: unknown, options?: { signal?: AbortSignal }) =>
			fakeStream(options?.signal),
		create: async () => ({
			content: [],
			stop_reason: "end_turn",
			model: "x",
			usage: {},
		}),
	};
	constructor(_opts: unknown) {}
}

/** Mutable session the auth mock returns — tests flip it per case. */
let currentSession: {
	user: { id: string; name: string; email?: string; createdAt?: Date };
} = {
	user: {
		id: "u1",
		name: "U",
		// Well before the AI-access cutoff, so this default fixture represents a
		// grandfathered existing user — the routes under test bill our provider
		// key, so hasAiAccess must pass for the "signed-in user" happy paths below.
		createdAt: new Date("2020-01-01T00:00:00.000Z"),
	},
};
/** How many times the (mocked) enforceRateLimit was invoked this test — lets
 *  owner-exemption tests assert the check was SKIPPED, not just "not limited". */
let enforceRateLimitCalls = 0;

mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
mock.module("@/lib/auth/server", () => ({
	auth: {
		api: { getSession: async () => currentSession },
	},
}));
// Snapshot the REAL rate-limit exports (the spread copies current function
// values) before the no-op mock replaces the module, and restore them in
// afterAll — bun's mock.module live-overwrites the module registry
// process-wide, so without the restore every test file that runs after this
// one sees a rate limiter that never limits (order-dependent 429 failures).
const realRateLimit = { ...(await import("@/lib/rate-limit")) };
mock.module("@/lib/rate-limit", () => ({
	enforceRateLimit: async () => {
		enforceRateLimitCalls++;
		return undefined;
	},
}));
afterAll(() => {
	mock.module("@/lib/rate-limit", () => realRateLimit);
});
mock.module("next/headers", () => ({ headers: async () => new Headers() }));

const { POST } = await import("../route");

/** Minimal Request stand-in: the handler reads `.json()`, `.headers`, `.signal`. */
function makeReq(body: unknown, signal: AbortSignal): Request {
	return {
		url: "http://localhost/api/llm/agent",
		json: async () => body,
		headers: new Headers(),
		signal,
	} as unknown as Request;
}

/** Drain an SSE Response body to a string (returns once the stream closes). */
async function drain(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out;
}

// The route reads keys from the validated `webEnv` object (a module
// singleton), so tests configure the brain by mutating that object rather
// than `process.env` (which is only parsed once, at env-module import).
const savedAnthropicKey = webEnv.ANTHROPIC_API_KEY;
const savedMoonshotKey = webEnv.MOONSHOT_API_KEY;

beforeEach(() => {
	state.streamSignal = null;
	state.streamCreated = 0;
	currentSession = {
		user: {
			id: "u1",
			name: "U",
			createdAt: new Date("2020-01-01T00:00:00.000Z"),
		},
	};
	enforceRateLimitCalls = 0;
	webEnv.ANTHROPIC_API_KEY = "test-key";
	webEnv.MOONSHOT_API_KEY = "";
});

afterEach(() => {
	webEnv.ANTHROPIC_API_KEY = savedAnthropicKey;
	webEnv.MOONSHOT_API_KEY = savedMoonshotKey;
});

test("aborting the client request aborts the upstream stream and tears it down", async () => {
	const controller = new AbortController();
	const req = makeReq(
		{ messages: [{ role: "user", content: "hi" }], stream: true },
		controller.signal,
	);

	const res = await POST(req);
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	// The stream was created and handed a signal to abort on (not left un-cancelable).
	expect(state.streamCreated).toBe(1);
	expect(state.streamSignal).not.toBeNull();
	expect(state.streamSignal!.aborted).toBe(false);

	// User hits Stop: abort the request, then drain the response to completion.
	controller.abort();
	const body = await drain(res);

	// Billing halted: the upstream Anthropic request was aborted server-side.
	expect(state.streamSignal!.aborted).toBe(true);
	// Clean teardown: no error frame flushed to the gone connection, stream ended.
	expect(body).not.toContain("event: error");
	expect(body).not.toContain("event: final");
});

test("a regular signed-in user goes through the rate limiter", async () => {
	currentSession = {
		user: {
			id: "u1",
			name: "U",
			email: "not-owner@example.com",
			createdAt: new Date("2020-01-01T00:00:00.000Z"),
		},
	};
	const req = makeReq(
		{ messages: [{ role: "user", content: "hi" }] },
		new AbortController().signal,
	);
	const res = await POST(req);
	expect(res.status).toBe(200);
	expect(enforceRateLimitCalls).toBe(1);
});

test("an owner account (OWNER_EMAILS) skips the rate limiter entirely", async () => {
	currentSession = {
		user: { id: "owner1", name: "Owner", email: "zsrumishaikh@gmail.com" },
	};
	const req = makeReq(
		{ messages: [{ role: "user", content: "hi" }] },
		new AbortController().signal,
	);
	const res = await POST(req);
	expect(res.status).toBe(200);
	expect(enforceRateLimitCalls).toBe(0);
});
