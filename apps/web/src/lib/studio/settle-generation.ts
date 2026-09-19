/**
 * Drive a backend submission to a terminal state, whether the backend answers
 * inline or hands back a job to poll.
 *
 * WHY THIS EXISTS. `SubmitResult` has always allowed either shape — "async
 * backends return a `jobId` to poll; sync backends (most image models) return
 * `status: "completed"` with `mediaUrl` inline" (backends/types.ts). Every
 * video and audio caller honours both halves. The two IMAGE callers did not:
 * they read `submitted.mediaUrl` and threw whenever it was absent, because
 * until now every registered image backend happened to answer inline.
 *
 * That stopped being true when the Higgsfield image adapters landed. Higgsfield
 * runs its image models through the same job queue as its video models, so
 * `submit()` returns `pending` and the picture arrives on a later `poll()`. A
 * caller that throws on `pending` would report a perfectly healthy generation
 * as a failure. The breakage is latent today only because those adapters are
 * gated behind a per-model endpoint variable and the router never selects them;
 * it would surface the first time an operator configured a real endpoint.
 *
 * THE SYNC PATH IS UNCHANGED AND UNTAXED. A backend that returns
 * `completed` + `mediaUrl` is returned immediately and `poll()` is never
 * called — no extra round trip, no added latency, no behaviour change for the
 * five inline image backends.
 *
 * BUDGETS ARE THE CALLER'S. This polls inside the request handler, so the
 * budget has to fit under that route's `maxDuration` with room left for the
 * credit settle and the response. Callers pass their own `budgetMs` rather
 * than inheriting a default that silently exceeds a 60s route.
 */

import type {
	GenerationBackend,
	SubmitResult,
} from "@/lib/studio/backends/types";

/** Default gap between polls. Images settle faster than video, so this is
 *  tighter than `multiframe.ts`'s 4s client-side loop. */
export const DEFAULT_SETTLE_INTERVAL_MS = 2_000;

/** Just the slice of a backend this needs — keeps tests from having to build
 *  a whole `GenerationBackend`. */
type SettleableBackend = Pick<GenerationBackend, "poll" | "label">;

export interface SettleOptions {
	/**
	 * Total wall-clock budget for polling, milliseconds. MUST leave headroom
	 * under the calling route's `maxDuration`.
	 */
	budgetMs: number;
	/** Gap between polls. Defaults to {@link DEFAULT_SETTLE_INTERVAL_MS}. */
	intervalMs?: number;
	/** Injectable for tests, so a poll loop doesn't cost real seconds. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

export interface SettledGeneration {
	mediaUrl: string;
	seed?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolve `submitted` to a media URL, polling if the backend handed back a job.
 *
 * Throws on a failed job, on a terminal-but-empty result, and on budget
 * exhaustion. Callers that hold credits should let those throws reach their
 * existing release path — a timeout must not be charged for.
 *
 * Error messages name the backend's friendly `label` only: no ids, endpoints,
 * or env var names, so a message that reaches a customer surface stays
 * readable.
 */
export async function settleGeneration(
	backend: SettleableBackend,
	submitted: SubmitResult,
	options: SettleOptions,
): Promise<SettledGeneration> {
	const {
		budgetMs,
		intervalMs = DEFAULT_SETTLE_INTERVAL_MS,
		sleep = realSleep,
		now = Date.now,
	} = options;

	if (submitted.status === "failed") {
		throw new Error(submitted.error ?? `${backend.label} could not generate`);
	}

	// Inline backends: done before we ever reach the loop.
	if (submitted.status === "completed") {
		if (!submitted.mediaUrl) {
			throw new Error(submitted.error ?? `${backend.label} returned no image`);
		}
		return { mediaUrl: submitted.mediaUrl, seed: submitted.seed };
	}

	// Still running. Without a job handle there is nothing to poll, so this is
	// a malformed result rather than a slow one.
	if (!submitted.jobId) {
		throw new Error(`${backend.label} returned no job to track`);
	}

	const deadline = now() + budgetMs;
	let lastSeed = submitted.seed;

	while (now() < deadline) {
		await sleep(intervalMs);
		const polled = await backend.poll(submitted.jobId);
		lastSeed = polled.seed ?? lastSeed;

		if (polled.status === "failed") {
			throw new Error(polled.error ?? `${backend.label} could not generate`);
		}
		if (polled.status === "completed") {
			if (!polled.mediaUrl) {
				throw new Error(polled.error ?? `${backend.label} returned no image`);
			}
			return { mediaUrl: polled.mediaUrl, seed: lastSeed };
		}
		// pending / processing — keep waiting until the budget runs out.
	}

	throw new Error(`${backend.label} took too long to respond`);
}
