import { describe, expect, it } from "bun:test";
import type { PollResult, SubmitResult } from "@/lib/studio/backends/types";
import { settleGeneration } from "@/lib/studio/settle-generation";

/**
 * A stand-in backend that hands back a scripted sequence of poll results and
 * counts how many times it was polled — the count is what proves the sync path
 * never reaches the loop.
 */
function fakeBackend(sequence: PollResult[]) {
	const calls: string[] = [];
	let i = 0;
	return {
		label: "Test Model",
		calls,
		poll: async (jobId: string): Promise<PollResult> => {
			calls.push(jobId);
			const next = sequence[Math.min(i, sequence.length - 1)];
			i += 1;
			return next;
		},
	};
}

/** Virtual clock, so a budget-exhaustion test costs no real time. */
function virtualClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

const submitted = (over: Partial<SubmitResult>): SubmitResult => ({
	jobId: "job-1",
	status: "pending",
	...over,
});

describe("settleGeneration", () => {
	it("returns an inline result without ever polling", async () => {
		const backend = fakeBackend([]);
		const result = await settleGeneration(
			backend,
			submitted({
				status: "completed",
				mediaUrl: "https://cdn/a.png",
				seed: 7,
			}),
			{ budgetMs: 45_000, ...virtualClock() },
		);
		expect(result.mediaUrl).toBe("https://cdn/a.png");
		expect(result.seed).toBe(7);
		// The whole point: the five inline image backends pay nothing for this.
		expect(backend.calls.length).toBe(0);
	});

	it("polls a pending job through to completion", async () => {
		const backend = fakeBackend([
			{ jobId: "job-1", status: "processing" },
			{ jobId: "job-1", status: "processing" },
			{ jobId: "job-1", status: "completed", mediaUrl: "https://cdn/b.png" },
		]);
		const result = await settleGeneration(backend, submitted({}), {
			budgetMs: 45_000,
			...virtualClock(),
		});
		expect(result.mediaUrl).toBe("https://cdn/b.png");
		expect(backend.calls.length).toBe(3);
		expect(backend.calls[0]).toBe("job-1");
	});

	it("carries a seed that only appears on a later poll", async () => {
		const backend = fakeBackend([
			{ jobId: "job-1", status: "processing", seed: 42 },
			{ jobId: "job-1", status: "completed", mediaUrl: "https://cdn/c.png" },
		]);
		const result = await settleGeneration(backend, submitted({}), {
			budgetMs: 45_000,
			...virtualClock(),
		});
		expect(result.seed).toBe(42);
	});

	it("throws when submit already failed, without polling", async () => {
		const backend = fakeBackend([]);
		await expect(
			settleGeneration(
				backend,
				submitted({ status: "failed", error: "content blocked" }),
				{ budgetMs: 45_000, ...virtualClock() },
			),
		).rejects.toThrow("content blocked");
		expect(backend.calls.length).toBe(0);
	});

	it("throws when a poll reports failure", async () => {
		const backend = fakeBackend([
			{ jobId: "job-1", status: "failed", error: "provider rejected" },
		]);
		await expect(
			settleGeneration(backend, submitted({}), {
				budgetMs: 45_000,
				...virtualClock(),
			}),
		).rejects.toThrow("provider rejected");
	});

	it("throws when a job completes with no media", async () => {
		const backend = fakeBackend([{ jobId: "job-1", status: "completed" }]);
		await expect(
			settleGeneration(backend, submitted({}), {
				budgetMs: 45_000,
				...virtualClock(),
			}),
		).rejects.toThrow("returned no image");
	});

	it("throws when the budget runs out before the job settles", async () => {
		const backend = fakeBackend([{ jobId: "job-1", status: "processing" }]);
		await expect(
			settleGeneration(backend, submitted({}), {
				budgetMs: 10_000,
				intervalMs: 2_000,
				...virtualClock(),
			}),
		).rejects.toThrow("took too long");
		// Bounded by the budget, not unbounded: 10s / 2s per poll.
		expect(backend.calls.length).toBe(5);
	});

	it("treats a pending result with no job handle as malformed", async () => {
		const backend = fakeBackend([]);
		await expect(
			settleGeneration(backend, submitted({ jobId: "" }), {
				budgetMs: 45_000,
				...virtualClock(),
			}),
		).rejects.toThrow("no job to track");
		expect(backend.calls.length).toBe(0);
	});

	it("names the backend's friendly label, never ids or endpoints", async () => {
		const backend = fakeBackend([{ jobId: "job-1", status: "failed" }]);
		await expect(
			settleGeneration(backend, submitted({}), {
				budgetMs: 45_000,
				...virtualClock(),
			}),
		).rejects.toThrow("Test Model");
	});
});
