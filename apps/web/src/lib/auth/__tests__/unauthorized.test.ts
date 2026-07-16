/**
 * Unit tests for apps/web/src/lib/auth/unauthorized.ts (BUG12: an anon-session
 * 401 from a background hydration call must not evict the editor).
 *
 * ENVIRONMENT NOTES (see repo-known bug classes in the campaign brief):
 *  - This repo's `bun test` has no DOM registrator, so `window` is `undefined`
 *    by default. Tests that need it stub a minimal `globalThis.window` (just
 *    `dispatchEvent`/`addEventListener`, the only members `unauthorized.ts`
 *    touches) and restore the exact prior value afterward.
 *  - `mock.module` is process-global in bun and leaks past this file if not
 *    undone, and static ESM imports are hoisted before any of this file's own
 *    statements run — so the module under test must be imported *after*
 *    `mock.module("sonner", ...)` is installed (dynamic `import()`), and the
 *    real `sonner` module is captured up front and restored in `afterAll`.
 *  - The pure `shouldPromptFor401` helper needs neither of the above, and is
 *    exercised directly for the debounce/loop-guard/mode decision matrix so
 *    those cases don't depend on wall-clock timing or module-level state.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// Must run before the dynamic import below so the mocked "sonner" is what
// unauthorized.ts resolves against.
const realSonner = await import("sonner");

const toastCalls: Array<{ message: string; description?: string }> = [];
mock.module("sonner", () => ({
	toast: (message: string, opts?: { description?: string }) => {
		toastCalls.push({ message, description: opts?.description });
		return 0;
	},
}));

const { apiFetch, handleUnauthorized, shouldPromptFor401, UNAUTHORIZED_EVENT } =
	await import("../unauthorized");

afterAll(() => {
	// Undo the process-global mock so any test file that runs later in this
	// same `bun test` process sees the real "sonner" module again.
	mock.module("sonner", () => realSonner);
});

/** Minimal EventTarget-shaped stand-in for `window`, just what unauthorized.ts touches. */
class FakeWindow {
	dispatched: CustomEvent[] = [];
	private listeners = new Map<string, Set<(e: Event) => void>>();

	addEventListener(type: string, cb: (e: Event) => void): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)?.add(cb);
	}

	removeEventListener(type: string, cb: (e: Event) => void): void {
		this.listeners.get(type)?.delete(cb);
	}

	dispatchEvent(event: Event): boolean {
		this.dispatched.push(event as CustomEvent);
		for (const cb of this.listeners.get(event.type) ?? []) cb(event);
		return true;
	}
}

describe("shouldPromptFor401 (pure decision helper)", () => {
	const NOW = 1_000_000;

	it("is false in silent mode, regardless of URL or debounce state", () => {
		expect(
			shouldPromptFor401("/api/studio/sets", { on401: "silent" }, NOW, 0),
		).toBe(false);
		expect(
			shouldPromptFor401("/api/auth/sign-in", { on401: "silent" }, NOW, 0),
		).toBe(false);
	});

	it("is false for /api/auth/* URLs in prompt mode (loop guard)", () => {
		expect(
			shouldPromptFor401("/api/auth/sign-in/email", undefined, NOW, 0),
		).toBe(false);
		expect(
			shouldPromptFor401(
				"/api/auth/sign-in/email",
				{ on401: "prompt" },
				NOW,
				0,
			),
		).toBe(false);
	});

	it("is false in prompt mode inside the debounce window on a non-auth URL", () => {
		// Last prompt 3s ago; DEBOUNCE_MS is 10s.
		expect(
			shouldPromptFor401("/api/studio/sets", undefined, NOW, NOW - 3_000),
		).toBe(false);
	});

	it("is true in prompt mode outside the debounce window on a non-auth URL", () => {
		// Last prompt 11s ago.
		expect(
			shouldPromptFor401("/api/studio/sets", undefined, NOW, NOW - 11_000),
		).toBe(true);
		// Never prompted (module-fresh state) behaves the same way.
		expect(shouldPromptFor401("/api/studio/sets", undefined, NOW, 0)).toBe(
			true,
		);
	});

	it("defaults to prompt mode when opts is omitted", () => {
		expect(shouldPromptFor401("/api/studio/sets", {}, NOW, 0)).toBe(true);
		expect(shouldPromptFor401("/api/studio/sets", undefined, NOW, 0)).toBe(
			true,
		);
	});
});

describe("handleUnauthorized — non-401 and serverless pass-through", () => {
	it("returns false for a non-401 response, with no side effects", () => {
		const res = new Response(null, { status: 200 });
		expect(handleUnauthorized(res, "/api/studio/sets")).toBe(false);
		expect(toastCalls).toHaveLength(0);
	});

	it("returns true for a 401 with no window (server-side no-op)", () => {
		// `window` is undefined by default in this test environment (no DOM
		// registrator), so this exercises the real "no window" branch.
		expect(typeof window).toBe("undefined");
		const res = new Response(null, { status: 401 });
		expect(handleUnauthorized(res, "/api/studio/sets")).toBe(true);
	});
});

describe("handleUnauthorized / apiFetch — browser 401 handling", () => {
	const hadWindow = "window" in globalThis;
	const originalWindow = (globalThis as Record<string, unknown>).window;
	let fakeWindow: FakeWindow;

	beforeEach(() => {
		fakeWindow = new FakeWindow();
		(globalThis as Record<string, unknown>).window = fakeWindow;
		toastCalls.length = 0;
	});

	afterAll(() => {
		if (hadWindow) {
			(globalThis as Record<string, unknown>).window = originalWindow;
		} else {
			delete (globalThis as Record<string, unknown>).window;
		}
	});

	// Deliberately a single sequential test: `lastPromptAt` is private
	// module-level state with no reset hook, so chaining these steps (rather
	// than splitting into independent `it()`s that would race the 10s
	// debounce window against real wall-clock time) is what makes "silent
	// mode never stamps the debounce clock" actually verifiable — step 3
	// would fail if step 2 had touched it.
	it("loop guard, silent mode, and prompt-mode debounce compose correctly", () => {
		// 1) Loop guard: a 401 from the auth endpoints themselves never prompts.
		expect(
			handleUnauthorized(
				new Response(null, { status: 401 }),
				"/api/auth/sign-in/email",
			),
		).toBe(true);
		expect(toastCalls).toHaveLength(0);
		expect(fakeWindow.dispatched).toHaveLength(0);

		// 2) Silent mode: a background-hydration 401 never prompts, and must
		// not stamp the debounce clock either.
		expect(
			handleUnauthorized(
				new Response(null, { status: 401 }),
				"/api/studio/sets",
				{
					on401: "silent",
				},
			),
		).toBe(true);
		expect(toastCalls).toHaveLength(0);
		expect(fakeWindow.dispatched).toHaveLength(0);

		// 3) Prompt mode (default), non-auth URL: fires immediately. If step 2
		// had stamped `lastPromptAt`, this would be swallowed by the debounce
		// window and fail.
		expect(
			handleUnauthorized(
				new Response(null, { status: 401 }),
				"/api/studio/sets",
			),
		).toBe(true);
		expect(toastCalls).toHaveLength(1);
		expect(toastCalls[0]?.message).toBe("Sign up to use AI features");
		expect(fakeWindow.dispatched).toHaveLength(1);
		expect(fakeWindow.dispatched[0]?.type).toBe(UNAUTHORIZED_EVENT);

		// 4) A second prompt-mode 401 immediately after (any URL) lands inside
		// the debounce window and must not re-prompt.
		expect(
			handleUnauthorized(
				new Response(null, { status: 401 }),
				"/api/studio/board",
			),
		).toBe(true);
		expect(toastCalls).toHaveLength(1);
		expect(fakeWindow.dispatched).toHaveLength(1);
	});

	describe("apiFetch", () => {
		const originalFetch = globalThis.fetch;

		afterAll(() => {
			globalThis.fetch = originalFetch;
		});

		it("returns the untouched Response for a non-401 and calls fetch with the given args", async () => {
			const mockResponse = new Response(JSON.stringify({ ok: true }), {
				status: 200,
			});
			let calledWith: [unknown, RequestInit | undefined] | undefined;
			globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
				calledWith = [input, init];
				return mockResponse;
			}) as typeof fetch;

			const init = { method: "GET" };
			const res = await apiFetch("/api/studio/sets", init);

			expect(res).toBe(mockResponse);
			expect(calledWith?.[0]).toBe("/api/studio/sets");
			expect(calledWith?.[1]).toBe(init);
			expect(toastCalls).toHaveLength(0);
			expect(fakeWindow.dispatched).toHaveLength(0);
		});

		it("silent mode: a 401 is returned as-is and never reaches the prompt path", async () => {
			const mockResponse = new Response(null, { status: 401 });
			globalThis.fetch = (async () => mockResponse) as unknown as typeof fetch;

			const res = await apiFetch("/api/studio/board", undefined, {
				on401: "silent",
			});

			expect(res).toBe(mockResponse);
			expect(res.status).toBe(401);
			expect(toastCalls).toHaveLength(0);
			expect(fakeWindow.dispatched).toHaveLength(0);
		});
	});
});
