// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
/**
 * Global, cross-component status tracker for in-flight generation jobs, keyed
 * by our provider `jobId` (see `Take.jobId` in `@/types/timeline`).
 *
 * Why this exists: `useStudioGeneration` (apps/web/src/hooks/use-studio-generation.ts)
 * already polls a job to completion, but its poll loop lives in that hook's
 * component-local `useState` — if two components watch the same job (e.g. a
 * timeline slot badge and the Takes grid), each spins its own interval and
 * neither knows about the other. This store centralizes exactly one poll
 * interval per jobId behind a shared `statusMap`, so any number of components
 * can read the same job's status without re-polling.
 *
 * Ported from sixsevenstudio's `useVideoStatusStore`, which polled OpenAI's
 * `videos.retrieve` directly. We don't hardcode a provider here at all: the
 * poll function is caller-injected (see `startPolling`), so it plugs into
 * whichever endpoint owns the job — today that's
 * `GET /api/studio/generate/[jobId]` → `pollVideo` in
 * `lib/studio/provider-adapter.ts`. All Tauri/local-filesystem logic from the
 * original (`fileExists`, `convertFileSrc`, on-disk video paths) is dropped —
 * our generated media is rehosted to R2 (`lib/studio/media-storage.ts`), not
 * saved to a local project folder.
 */

import { create } from "zustand";
import type { PollVideoResult } from "@/lib/studio/provider-adapter";

/** Per-job status, mirroring the fields our provider poll endpoint returns. */
export type GenerationJobState = Pick<
	PollVideoResult,
	"status" | "videoUrl" | "seed" | "error"
>;

interface GenerationStatusStore {
	statusMap: Record<string, GenerationJobState>;
	setStatus: (jobId: string, status: GenerationJobState) => void;
	getStatus: (jobId: string) => GenerationJobState | undefined;
	/**
	 * Start polling `jobId` on an interval, invoking the caller-supplied
	 * `pollFn` immediately and then every `POLL_INTERVAL_MS`. `pollFn` is
	 * expected to resolve the job's latest status and call `setStatus` itself
	 * (see `createJobStatusPollFn` below for the canonical implementation).
	 * No-ops if a poll is already running for this id, or if the job is already
	 * terminal.
	 */
	startPolling: (jobId: string, pollFn: () => Promise<void>) => void;
	stopPolling: (jobId: string) => void;
}

// Intervals live outside Zustand state — they're not serializable UI state,
// just bookkeeping for the dedup check below.
const pollingIntervals = new Map<string, ReturnType<typeof setInterval>>();
// 4s between poll cycles, matching the cadence of the per-component loops this
// store replaces (upstream used 15s against OpenAI's slower video jobs).
const POLL_INTERVAL_MS = 4000;
// ~8 min ceiling, matching the old loops' MAX_POLLS (120) × 4s.
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

function isTerminalState(status: PollVideoResult["status"]): boolean {
	return status === "completed" || status === "failed";
}

export const useGenerationStatusStore = create<GenerationStatusStore>()(
	(set, get) => ({
		statusMap: {},

		setStatus: (jobId, status) => {
			set((state) => ({
				statusMap: { ...state.statusMap, [jobId]: status },
			}));

			if (isTerminalState(status.status)) {
				get().stopPolling(jobId);
			}
		},

		getStatus: (jobId) => get().statusMap[jobId],

		startPolling: (jobId, pollFn) => {
			// Dedup: don't stack a second interval for a job already being polled.
			if (pollingIntervals.has(jobId)) return;

			// Don't poll if we already know this job is done.
			const current = get().statusMap[jobId];
			if (current && isTerminalState(current.status)) return;

			// Poll once immediately so callers don't wait a full interval to learn
			// the job's current state, then keep polling on an interval.
			void pollFn();

			const interval = setInterval(() => {
				void pollFn();
			}, POLL_INTERVAL_MS);
			pollingIntervals.set(jobId, interval);
		},

		stopPolling: (jobId) => {
			const interval = pollingIntervals.get(jobId);
			if (interval) {
				clearInterval(interval);
				pollingIntervals.delete(jobId);
			}
		},
	}),
);

/** Human-readable error for a terminal 4xx poll response, so the UI's error
 *  state has something meaningful to show instead of a silent stuck spinner. */
function terminalPollError(status: number): string {
	if (status === 401 || status === 403) {
		return "You no longer have access to this generation.";
	}
	if (status === 404) {
		return "This generation could not be found.";
	}
	return `Generation could not be loaded (error ${status}).`;
}

/**
 * The canonical `pollFn` for jobs owned by our generate endpoint: one poll
 * cycle against `GET /api/studio/generate/[jobId]`, recorded into the shared
 * store. Pass to `startPolling` so every watcher of a job shares one fetch.
 *
 * Failure handling distinguishes two classes of non-OK response:
 *  - **Transient** (5xx server error, network hiccup): skip this tick and let
 *    the next interval retry, matching the old per-component loops.
 *  - **Terminal** (4xx — esp. 401/403/404): the request won't ever succeed
 *    (e.g. the job's set has a null/mismatched userId, so the auth-gated route
 *    returns 404). Retrying forever leaves the slot spinning, so we mark the
 *    job `failed` with a clear error. `setStatus` then stops the poll and the
 *    UI resolves the spinner to its normal error state.
 */
export function createJobStatusPollFn(jobId: string): () => Promise<void> {
	return async () => {
		try {
			const res = await fetch(`/api/studio/generate/${jobId}`);
			if (!res.ok) {
				// 4xx is a permanent client/permission error — terminate the poll so
				// the spinner resolves to an error. 5xx / other codes stay transient.
				if (res.status >= 400 && res.status < 500) {
					useGenerationStatusStore.getState().setStatus(jobId, {
						status: "failed",
						error: terminalPollError(res.status),
					});
				}
				return;
			}
			const poll = (await res.json()) as Partial<PollVideoResult>;
			if (!poll.status) return;
			useGenerationStatusStore.getState().setStatus(jobId, {
				status: poll.status,
				videoUrl: poll.videoUrl,
				seed: poll.seed,
				error: poll.error,
			});
		} catch (err) {
			console.error("Failed to poll status for generation job:", err);
		}
	};
}

/**
 * Non-React entry point: start (or join) the deduped poll for `jobId` and
 * resolve once the job reaches a terminal state. Concurrent callers for the
 * same job share one interval via `startPolling`'s dedup. On timeout the job's
 * interval is stopped too, mirroring the old loops exiting.
 */
export function waitForJobTerminal(
	jobId: string,
	options: { timeoutMs?: number } = {},
): Promise<GenerationJobState | "timeout"> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
	const store = useGenerationStatusStore.getState();

	const existing = store.getStatus(jobId);
	if (existing && isTerminalState(existing.status)) {
		return Promise.resolve(existing);
	}

	store.startPolling(jobId, createJobStatusPollFn(jobId));

	return new Promise((resolve) => {
		let unsubscribe: () => void = () => {};
		let deadline: ReturnType<typeof setTimeout> | undefined;

		const finish = (value: GenerationJobState | "timeout") => {
			unsubscribe();
			if (deadline) clearTimeout(deadline);
			if (value === "timeout") {
				useGenerationStatusStore.getState().stopPolling(jobId);
			}
			resolve(value);
		};

		unsubscribe = useGenerationStatusStore.subscribe((state) => {
			const job = state.statusMap[jobId];
			if (job && isTerminalState(job.status)) finish(job);
		});

		// Re-check after subscribing in case a poll landed terminal in between.
		const current = useGenerationStatusStore.getState().getStatus(jobId);
		if (current && isTerminalState(current.status)) {
			finish(current);
			return;
		}

		deadline = setTimeout(() => finish("timeout"), timeoutMs);
	});
}
