// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
"use client";

/**
 * React hook composing `useGenerationStatusStore` for a single job. Ported
 * from sixsevenstudio's `useVideoPolling`, stripped of all Tauri/local-disk
 * logic (`fileExists`, `convertFileSrc`, `getVideoPath` into a project
 * folder) — our generated media has no local-file concept; a completed job
 * hands back a provider URL that the caller imports through our own media
 * pipeline instead.
 *
 * This hook does NOT know how to submit a job or import a finished video as
 * a project asset — `onCompleted` is caller-injected (see the WIRING TODO
 * below) so this file stays a thin, self-contained polling primitive.
 * Nothing currently calls this hook; wiring it into the timeline slot /
 * Takes grid is a later phase.
 */

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
	useGenerationStatusStore,
	type GenerationJobState,
} from "@/stores/generation-status-store";
import type { PollVideoResult } from "@/lib/studio/provider-adapter";

type PollFnResult = Pick<PollVideoResult, "status" | "videoUrl" | "seed" | "error">;

/** Default `pollFn`: hits our own poll endpoint, which wraps `pollVideo`. */
async function defaultPollFn(jobId: string): Promise<PollFnResult> {
	const res = await fetch(`/api/studio/generate/${jobId}`);
	if (!res.ok) throw new Error(`Poll request failed: ${res.status}`);
	return res.json();
}

interface UseGenerationPollingOptions {
	jobId: string;
	/**
	 * Fetches this job's latest status from OUR poll endpoint (not the provider
	 * directly — that call is server-only). Defaults to
	 * `GET /api/studio/generate/[jobId]`, which wraps `pollVideo` from
	 * `lib/studio/provider-adapter.ts`; override for jobs owned by a different
	 * endpoint.
	 */
	pollFn?: () => Promise<PollFnResult>;
	/**
	 * What happens once a job completes with a video URL — caller-injected so
	 * this hook stays a thin polling primitive. In our stack that's importing
	 * it as a project MediaAsset — see `importVideoAsset` in
	 * `lib/studio/generate-take.ts` (fetches via `/api/studio/proxy` to dodge
	 * provider CORS, runs it through `processMediaAssets`, then
	 * `editor.media.addMediaAsset`) — and/or rehosting it to R2 first via
	 * `rehostToR2` in `lib/studio/media-storage.ts` if the caller wants a
	 * durable URL before import. Called at most once per completed job
	 * (guarded by an internal ref, mirroring upstream's `hasDownloadedRef`).
	 */
	onCompleted?: (result: { videoUrl: string; seed?: number }) => void | Promise<void>;
}

/** Poll one generation job to a terminal state, deduped through the shared store. */
export function useGenerationPolling({
	jobId,
	pollFn,
	onCompleted,
}: UseGenerationPollingOptions): GenerationJobState | undefined {
	const { setStatus, getStatus, startPolling } = useGenerationStatusStore();
	// Guards onCompleted from firing twice for the same job (e.g. one poll
	// cycle lands "completed" while a stale interval tick also observes it).
	const hasCompletedRef = useRef(false);

	// Reset the guard when we start tracking a different job.
	useEffect(() => {
		hasCompletedRef.current = false;
	}, [jobId]);

	const poll = useCallback(async () => {
		try {
			const res = await (pollFn ?? (() => defaultPollFn(jobId)))();
			if (!res?.status) return;

			if (res.status === "completed" && res.videoUrl) {
				if (!hasCompletedRef.current) {
					hasCompletedRef.current = true;
					try {
						await onCompleted?.({ videoUrl: res.videoUrl, seed: res.seed });
					} catch (err) {
						console.error("Failed to process completed generation job:", err);
						toast.error("Failed to import generated video", {
							description: err instanceof Error ? err.message : String(err),
						});
						setStatus(jobId, { status: "failed", error: "Import failed" });
						return;
					}
				}

				setStatus(jobId, {
					status: "completed",
					videoUrl: res.videoUrl,
					seed: res.seed,
				});
				return;
			}

			if (res.status === "failed") {
				setStatus(jobId, { status: "failed", error: res.error });
				return;
			}

			setStatus(jobId, { status: res.status, seed: res.seed });
		} catch (err) {
			// Network hiccups shouldn't tear down the poll loop — just skip this
			// tick and let the next interval retry, matching upstream.
			console.error("Failed to poll status for generation job:", err);
		}
	}, [jobId, pollFn, onCompleted, setStatus]);

	useEffect(() => {
		const current = getStatus(jobId);
		if (!current || current.status !== "completed") {
			startPolling(jobId, poll);
		}
	}, [jobId, poll, startPolling, getStatus]);

	return getStatus(jobId);
}
