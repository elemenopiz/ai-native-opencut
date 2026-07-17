import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	useGenerationStatusStore,
	waitForJobTerminal,
} from "@/stores/generation-status-store";
import { UNAUTHORIZED_EVENT } from "@/lib/auth/unauthorized";

/**
 * Regression coverage for the shared poll-dedup store that backs
 * `useStudioGeneration`'s `waitForJobTerminal` (see
 * `apps/web/src/hooks/use-studio-generation.ts`). Two invariants matter for the
 * takes/board routing wave: a completed/failed poll must propagate the right
 * fields to every caller, and two callers waiting on the same jobId must not
 * stack duplicate fetch loops (`startPolling`'s dedup by jobId).
 *
 * `global.fetch` is replaced by direct property assignment (createJobStatusPollFn
 * calls the real `fetch` via `apiFetch`), which `mock.restore()` does NOT undo —
 * see the agent-streaming leak fixed at 44b4e1ca. Capture and restore it here so
 * this file never leaks a stub fetch to any test file that runs after it in the
 * same `bun test` process.
 */

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Install a fetch stub that only answers `/api/studio/generate/<jobId>` polls
 *  (the one endpoint this store's pollFn hits), counting calls. */
function installPollFetch(
	handler: (jobId: string, callIndex: number) => Response | Promise<Response>,
): { calls: () => number } {
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const match = url.match(/\/api\/studio\/generate\/([^/?]+)/);
		if (!match) {
			throw new Error(`Unexpected fetch in test: ${url}`);
		}
		const jobId = match[1];
		calls += 1;
		return handler(jobId, calls);
	}) as typeof fetch;
	return { calls: () => calls };
}

beforeEach(() => {
	useGenerationStatusStore.getState().reset();
});

afterEach(() => {
	useGenerationStatusStore.getState().reset();
	globalThis.fetch = originalFetch;
});

describe("waitForJobTerminal", () => {
	test("completed outcome propagates videoUrl and seed", async () => {
		installPollFetch(() =>
			jsonResponse({
				status: "completed",
				videoUrl: "https://mock.byorn.local/take.mp4",
				seed: 424242,
			}),
		);

		const outcome = await waitForJobTerminal("job-completed");

		expect(outcome).not.toBe("timeout");
		if (outcome === "timeout") return;
		expect(outcome.status).toBe("completed");
		expect(outcome.videoUrl).toBe("https://mock.byorn.local/take.mp4");
		expect(outcome.seed).toBe(424242);
	});

	test("failed outcome propagates the error message", async () => {
		installPollFetch(() =>
			jsonResponse({ status: "failed", error: "Provider rejected the prompt" }),
		);

		const outcome = await waitForJobTerminal("job-failed");

		expect(outcome).not.toBe("timeout");
		if (outcome === "timeout") return;
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toBe("Provider rejected the prompt");
	});

	test("times out when the job never reaches a terminal state", async () => {
		installPollFetch(() => jsonResponse({ status: "processing" }));

		const outcome = await waitForJobTerminal("job-stuck", { timeoutMs: 30 });

		expect(outcome).toBe("timeout");
	});

	test("two concurrent waiters on the same jobId share one poll loop", async () => {
		const fetchStub = installPollFetch(() =>
			jsonResponse({
				status: "completed",
				videoUrl: "https://mock.byorn.local/shared.mp4",
				seed: 7,
			}),
		);

		// Both calls run synchronously up through `startPolling`'s dedup check
		// (the fetch itself is async), so the second `waitForJobTerminal` must
		// see the interval already registered for this jobId and skip its own
		// pollFn entirely — one fetch total, not two.
		const [outcomeA, outcomeB] = await Promise.all([
			waitForJobTerminal("job-shared"),
			waitForJobTerminal("job-shared"),
		]);

		expect(outcomeA).not.toBe("timeout");
		expect(outcomeB).not.toBe("timeout");
		expect(fetchStub.calls()).toBe(1);
	});

	test("state cleans up after terminal: startPolling no-ops for an already-resolved job", async () => {
		const fetchStub = installPollFetch(() =>
			jsonResponse({
				status: "completed",
				videoUrl: "https://mock.byorn.local/done.mp4",
				seed: 1,
			}),
		);

		const outcome = await waitForJobTerminal("job-cleanup");
		expect(outcome).not.toBe("timeout");
		const callsAtTerminal = fetchStub.calls();

		// A later startPolling for the same (now-terminal) jobId must be a no-op:
		// no new interval, no re-invoked pollFn. This is the observable proof that
		// the terminal poll's interval was torn down rather than left running.
		let pollFnInvoked = false;
		useGenerationStatusStore
			.getState()
			.startPolling("job-cleanup", async () => {
				pollFnInvoked = true;
			});
		await Promise.resolve();

		expect(pollFnInvoked).toBe(false);
		expect(fetchStub.calls()).toBe(callsAtTerminal);
	});

	test("a timed-out job's interval is torn down so the same jobId can be polled again", async () => {
		installPollFetch(() => jsonResponse({ status: "processing" }));

		const outcome = await waitForJobTerminal("job-timeout-cleanup", {
			timeoutMs: 30,
		});
		expect(outcome).toBe("timeout");

		// If the timeout path left the dedup entry in place, this second
		// startPolling would be silently swallowed forever (the same jobId could
		// never be repolled). Assert the fresh pollFn actually runs.
		let pollFnInvoked = false;
		useGenerationStatusStore
			.getState()
			.startPolling("job-timeout-cleanup", async () => {
				pollFnInvoked = true;
			});
		await Promise.resolve();

		expect(pollFnInvoked).toBe(true);
	});
});

/**
 * BUG15: `createJobStatusPollFn` is the last background-poll `apiFetch` call
 * site that hadn't been converted to `on401: "silent"` (BUG12's fix). An
 * anon/expired session with a persisted in-flight job would otherwise get
 * hard-redirected to /signup by this poll — the same failure mode BUG12
 * fixed for hydration calls, just reached via the poll interval instead of
 * mount. Mirrors the FakeWindow idiom from
 * `apps/web/src/lib/auth/__tests__/unauthorized.test.ts`: this repo's
 * `bun test` has no DOM registrator, so `window` is stubbed with just the
 * `dispatchEvent`/`addEventListener` surface `unauthorized.ts` touches, and
 * restored exactly afterward so this file doesn't leak `window` to tests
 * that run later in the same `bun test` process.
 */
describe("createJobStatusPollFn — BUG15: a poll 401 must not evict the editor", () => {
	const hadWindow = "window" in globalThis;
	const originalWindow = (globalThis as Record<string, unknown>).window;

	class FakeWindow {
		dispatched: CustomEvent[] = [];
		addEventListener(): void {}
		removeEventListener(): void {}
		dispatchEvent(event: Event): boolean {
			this.dispatched.push(event as CustomEvent);
			return true;
		}
	}
	let fakeWindow: FakeWindow;

	beforeEach(() => {
		fakeWindow = new FakeWindow();
		(globalThis as Record<string, unknown>).window = fakeWindow;
	});

	afterEach(() => {
		if (hadWindow) {
			(globalThis as Record<string, unknown>).window = originalWindow;
		} else {
			delete (globalThis as Record<string, unknown>).window;
		}
	});

	test("a 401 poll response never dispatches byorn:unauthorized, and still marks the job failed + stops the poll", async () => {
		const fetchStub = installPollFetch(() => jsonResponse(null, 401));

		const outcome = await waitForJobTerminal("job-401");

		// (a) silent mode: no redirect/unauthorized event fired — this is the
		// regression BUG15 fixes (previously "prompt" mode here would evict an
		// anon/expired-session user out of the editor on the next poll tick).
		expect(fakeWindow.dispatched).toHaveLength(0);
		expect(
			fakeWindow.dispatched.some((e) => e.type === UNAUTHORIZED_EVENT),
		).toBe(false);

		// (b) the pre-existing terminal-4xx handling is preserved unchanged: a
		// silent 401 still flows into the same branch a "prompt" 401 would,
		// marking the job failed with the 401-specific message.
		expect(outcome).not.toBe("timeout");
		if (outcome === "timeout") return;
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toBe("You no longer have access to this generation.");

		// ...and the poll interval was actually torn down (mirrors the
		// "startPolling no-ops for an already-resolved job" assertion above):
		// a fresh startPolling call for this now-terminal jobId must not
		// re-invoke pollFn or fire another fetch — if `setStatus` hadn't
		// called `stopPolling`, the dedup-by-jobId interval would still be
		// live and silently swallow this call for a different reason, so the
		// call count staying flat is what actually proves the poll stopped.
		let pollFnInvoked = false;
		useGenerationStatusStore.getState().startPolling("job-401", async () => {
			pollFnInvoked = true;
		});
		await Promise.resolve();

		expect(pollFnInvoked).toBe(false);
		expect(fetchStub.calls()).toBe(1);
	});
});
