"use client";

import { useCallback, useState } from "react";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import { waitForJobTerminal } from "@/stores/generation-status-store";
import { gateOn402 } from "@/lib/credits/client-gate";
import { useCreditsStore } from "@/stores/credits-store";
import { apiFetch } from "@/lib/auth/unauthorized";
import type { EditorCore } from "@/core";
import { addItemsToProjectMedia } from "@/lib/studio/add-to-editor";

// Module-level (not per-hook-instance) so a takeId's resume is deduped across
// GenerateView remounts — e.g. the user tabs away and back while a resumed
// poll (up to DEFAULT_TIMEOUT_MS) is still in flight. Resets on a full page
// reload, which is fine: a fresh reload is exactly the scenario this resume
// path handles, so a genuinely-new resume attempt there is correct, not a dup.
const resumingTakeIds = new Set<string>();

// Module-level (not per-hook-instance) tracking of takes a LIVE generate()
// call currently owns end-to-end (poll → route). Without this, loadHistory's
// resume loop only dedupes against other resumes — it has no way to know a
// take is already being polled and routed by an in-session generate() call,
// so it would re-pin the same take to Board a second time. A takeId is added
// once its jobId is known and removed once that take's poll+route lifecycle
// settles (success, error, or throw), so the resume loop can safely skip it.
const liveTakeIds = new Set<string>();

// Sentinel so the outer catch in generate() can tell "the 402 modal already
// told the user" apart from a real failure — gateOn402 opens the "Out of
// credits" modal itself, so surfacing the same failure again via setError
// would double the user-facing signal (modal + inline error) for one event.
class InsufficientCreditsError extends Error {
	constructor(message = "Insufficient credits") {
		super(message);
		this.name = "InsufficientCreditsError";
	}
}

export type GenerationStatus =
	| "idle"
	| "submitting"
	| "polling"
	| "done"
	| "error";

export interface StudioTake {
	takeId: string;
	setId: string;
	jobId: string;
	seed?: number;
	status: GenerationStatus;
	videoUrl?: string;
	error?: string;
	resolution: VideoResolution;
	orientation?: VideoOrientation;
	prompt: string;
	starred?: boolean;
}

export interface UseStudioGenerationReturn {
	status: GenerationStatus;
	activeTakes: StudioTake[];
	error: string | null;
	generate: (params: {
		prompt: string;
		referenceImageUrl?: string;
		referenceImages?: string[];
		referenceVideos?: string[];
		lastFrameUrl?: string;
		seed?: number;
		resolution: VideoResolution;
		orientation: VideoOrientation;
		duration: number;
		mode: VideoMode;
		personaId?: string;
		consistencyMode?: "high" | "fast";
		editor: EditorCore;
		projectId: string;
		batchSize: number;
	}) => Promise<void>;
	promoteTo1080p: (takeId: string) => Promise<void>;
	loadHistory: () => Promise<void>;
	historyLoaded: boolean;
	clearError: () => void;
}

export function useStudioGeneration(): UseStudioGenerationReturn {
	const [status, setStatus] = useState<GenerationStatus>("idle");
	const [activeTakes, setActiveTakes] = useState<StudioTake[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [historyLoaded, setHistoryLoaded] = useState(false);

	// Shared poll — waits for a job to reach a terminal state and patches the
	// take by takeId. Used by both initial generation and promote-to-1080p so
	// every pending take resolves instead of spinning forever. Polling itself
	// runs through the shared generation-status store, so any other watcher of
	// the same jobId (timeline slot badge, Takes grid) joins one deduped
	// interval instead of stacking its own fetch loop.
	//
	// Returns the settled videoUrl alongside the status instead of making
	// callers re-read it from `activeTakes` state: that state update and this
	// function's return both resolve off the same `waitForJobTerminal` result,
	// but the state update lands via React's effect/render cycle (a macrotask)
	// while an `await`ed caller resumes on the microtask queue — so a
	// same-tick read of `activeTakes` (or a ref mirroring it) is guaranteed to
	// still see the pre-completion value.
	const pollJobToCompletion = useCallback(
		async (
			takeId: string,
			jobId: string,
		): Promise<
			| { status: "done"; videoUrl?: string }
			| { status: "error"; error?: string }
		> => {
			const outcome = await waitForJobTerminal(jobId);

			if (outcome === "timeout") {
				setActiveTakes((prev) =>
					prev.map((t) =>
						t.takeId === takeId
							? { ...t, status: "error", error: "Generation timed out" }
							: t,
					),
				);
				setError("Generation timed out");
				return { status: "error", error: "Generation timed out" };
			}

			if (outcome.status === "completed") {
				setActiveTakes((prev) =>
					prev.map((t) =>
						t.takeId === takeId
							? {
									...t,
									status: "done",
									videoUrl: outcome.videoUrl,
									seed: outcome.seed ?? t.seed,
								}
							: t,
					),
				);
				return { status: "done", videoUrl: outcome.videoUrl };
			}

			setActiveTakes((prev) =>
				prev.map((t) =>
					t.takeId === takeId
						? { ...t, status: "error", error: outcome.error }
						: t,
				),
			);
			setError(outcome.error ?? "Generation failed");
			return { status: "error", error: outcome.error };
		},
		[],
	);

	// Routes one finished take: a lone result goes straight into the project's
	// Assets library (no review step); a take from a 2+ batch is parked in the
	// board's pending-review queue instead, so the user picks a winner there.
	//
	// A completed take has already been billed, so it must always land
	// somewhere retrievable — neither branch below is allowed to swallow a
	// failure and let the caller believe the take is safe.
	const routeCompletedTake = useCallback(
		async (args: {
			editor: EditorCore;
			projectId: string;
			batchSize: number;
			takeId: string;
			videoUrl: string;
			prompt: string;
		}) => {
			const saveToAssets = () =>
				addItemsToProjectMedia({
					editor: args.editor,
					projectId: args.projectId,
					items: [
						{
							url: args.videoUrl,
							name: args.prompt || "Generated take",
							kind: "video",
						},
					],
					source: "ai",
				});

			if (args.batchSize <= 1) {
				// addItemsToProjectMedia only console.errors internally and never
				// throws, so a failed save has to be surfaced here instead of
				// silently resolving as if the take were safely in Assets.
				const { added, failed } = await saveToAssets();
				if (added === 0 || failed > 0) {
					throw new Error("Failed to save the generated take to Assets");
				}
				return;
			}

			const res = await apiFetch("/api/studio/board", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ takeId: args.takeId }),
			});
			if (res.ok) return;

			const boardData = (await res.json().catch(() => ({}))) as {
				error?: string;
			};

			// Pin failed — the Takes-tab fallback was removed with
			// StarredTakesView, so Assets is the only remaining safety net for a
			// paid take. A successful fallback save is an acceptable degraded
			// outcome (the take just isn't staged in Board for review); only
			// throw if the fallback ALSO fails, so the take is never silently
			// orphaned.
			let fallbackOk = false;
			let fallbackErrorMessage: string | undefined;
			try {
				const { added, failed } = await saveToAssets();
				fallbackOk = added > 0 && failed === 0;
			} catch (fallbackErr) {
				fallbackErrorMessage =
					fallbackErr instanceof Error ? fallbackErr.message : undefined;
			}
			if (!fallbackOk) {
				throw new Error(
					fallbackErrorMessage ??
						boardData.error ??
						"Failed to pin to board, and fallback save to Assets also failed",
				);
			}
		},
		[],
	);

	const generate = useCallback(
		async (params: {
			prompt: string;
			referenceImageUrl?: string;
			seed?: number;
			resolution: VideoResolution;
			orientation: VideoOrientation;
			duration: number;
			mode: VideoMode;
			personaId?: string;
			consistencyMode?: "high" | "fast";
			editor: EditorCore;
			projectId: string;
			batchSize: number;
		}) => {
			// editor/projectId/batchSize are client-only routing metadata for
			// routeCompletedTake — not part of the /api/studio/generate contract,
			// so keep them out of the request body.
			const { editor, projectId, batchSize, ...apiParams } = params;

			setStatus("submitting");
			setError(null);

			try {
				const res = await apiFetch("/api/studio/generate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(apiParams),
				});

				if (!res.ok) {
					// Insufficient credits (402) → open the "Out of credits" modal.
					// gateOn402 already surfaces this to the user, so this throws a
					// distinct sentinel type — the outer catch still rejects (a batch
					// caller counts it as failed) but skips setError to avoid also
					// showing an inline error for the same event.
					if (await gateOn402(res)) {
						setStatus("error");
						throw new InsufficientCreditsError();
					}
					const data = (await res.json()) as { error?: string };
					throw new Error(data.error ?? "Submission failed");
				}

				const data = (await res.json()) as {
					takeId: string;
					setId: string;
					jobId: string;
					seed?: number;
					status: string;
					videoUrl?: string;
				};

				// Mark this take as owned by this live call for its whole
				// poll+route lifecycle, so loadHistory's resume loop (which only
				// dedupes against other resumes) doesn't also pick it up and
				// double-pin it to Board.
				liveTakeIds.add(data.takeId);
				try {
					const newTake: StudioTake = {
						takeId: data.takeId,
						setId: data.setId,
						jobId: data.jobId,
						seed: data.seed,
						status: data.status === "completed" ? "done" : "polling",
						videoUrl: data.videoUrl,
						resolution: params.resolution,
						orientation: params.orientation,
						prompt: params.prompt,
					};

					setActiveTakes((prev) => [newTake, ...prev]);

					if (data.status === "completed") {
						setStatus("done");
						if (data.videoUrl) {
							await routeCompletedTake({
								editor,
								projectId,
								batchSize,
								takeId: data.takeId,
								videoUrl: data.videoUrl,
								prompt: params.prompt,
							});
						}
						// Sync backends settle inline — refresh the header balance pill.
						void useCreditsStore.getState().refresh();
						return;
					}

					setStatus("polling");
					const outcome = await pollJobToCompletion(data.takeId, data.jobId);
					setStatus(outcome.status);
					if (outcome.status === "done" && outcome.videoUrl) {
						await routeCompletedTake({
							editor,
							projectId,
							batchSize,
							takeId: data.takeId,
							videoUrl: outcome.videoUrl,
							prompt: params.prompt,
						});
					}
					// Async video settled/released on completion — refresh the balance.
					void useCreditsStore.getState().refresh();
					// A batch caller (Promise.allSettled) needs a timed-out/errored take
					// to actually reject — otherwise it reads as "fulfilled" and gets
					// counted toward the success toast alongside real takes.
					if (outcome.status === "error") {
						throw new Error(outcome.error ?? "Generation failed");
					}
				} finally {
					liveTakeIds.delete(data.takeId);
				}
			} catch (err) {
				setStatus("error");
				// The 402 modal already surfaced this failure to the user —
				// setError would double it up as an inline error too. Real
				// failures (submission errors, Fix 2/3's save failures) are plain
				// Error instances and still setError as before.
				if (!(err instanceof InsufficientCreditsError)) {
					setError(err instanceof Error ? err.message : "Generation failed");
				}
				throw err instanceof Error ? err : new Error("Generation failed");
			}
		},
		[pollJobToCompletion, routeCompletedTake],
	);

	const promoteTo1080p = useCallback(
		async (takeId: string) => {
			const res = await apiFetch(`/api/studio/takes/${takeId}/promote`, {
				method: "POST",
			});
			if (!res.ok) {
				const data = (await res.json()) as { error?: string };
				throw new Error(data.error ?? "Promote failed");
			}
			const data = (await res.json()) as { takeId: string; jobId: string };

			// Add a polling take for the promoted version, then actually poll it.
			const source = activeTakes.find((t) => t.takeId === takeId);
			const promoted: StudioTake = {
				takeId: data.takeId,
				setId: source?.setId ?? "",
				jobId: data.jobId,
				seed: source?.seed,
				status: "polling",
				resolution: "1080p",
				orientation: source?.orientation,
				prompt: source?.prompt ?? "",
			};
			setActiveTakes((prev) => [promoted, ...prev]);

			await pollJobToCompletion(data.takeId, data.jobId);
		},
		[activeTakes, pollJobToCompletion],
	);

	// Hydrate the Takes grid from persisted generation sets so prior work
	// survives a reload. Resumes polling for any take still in-flight.
	const loadHistory = useCallback(async () => {
		try {
			// Background hydration on mount: an anonymous 401 here is normal, not
			// an error worth evicting the editor for — see unauthorized.ts.
			const res = await apiFetch("/api/studio/sets", undefined, {
				on401: "silent",
			});
			if (!res.ok) return;

			const data = (await res.json()) as {
				sets: Array<{
					id: string;
					prompt: string;
					orientation?: string;
					takes: Array<{
						id: string;
						setId: string;
						seed: number | null;
						resolution: string;
						videoUrl: string | null;
						status: string;
						starred: boolean;
						providerJobId: string | null;
						errorMessage: string | null;
					}>;
				}>;
			};

			const loaded: StudioTake[] = [];
			for (const set of data.sets) {
				for (const take of set.takes) {
					const status: GenerationStatus = take.videoUrl
						? "done"
						: take.errorMessage
							? "error"
							: "polling";
					loaded.push({
						takeId: take.id,
						setId: take.setId,
						jobId: take.providerJobId ?? "",
						seed: take.seed ?? undefined,
						status,
						videoUrl: take.videoUrl ?? undefined,
						error: take.errorMessage ?? undefined,
						resolution: take.resolution as VideoResolution,
						orientation: set.orientation as VideoOrientation | undefined,
						prompt: set.prompt,
						starred: take.starred,
					});
				}
			}

			setActiveTakes((prev) => {
				// Keep any session takes that aren't already in the loaded set.
				const loadedIds = new Set(loaded.map((t) => t.takeId));
				const sessionOnly = prev.filter((t) => !loadedIds.has(t.takeId));
				return [...sessionOnly, ...loaded];
			});
			setHistoryLoaded(true);

			// Resume polling for takes that were mid-generation when last closed
			// (e.g. the page reloaded mid-poll). We don't know the original
			// batchSize here — it was never persisted, just an ephemeral param on
			// the original request — so route any that finish to Board rather than
			// guessing: Board is always a safe, reviewable landing spot, whereas
			// silently auto-adding to Assets could surprise the user with an asset
			// they don't remember asking for.
			for (const take of loaded) {
				if (
					take.status === "polling" &&
					take.jobId &&
					!resumingTakeIds.has(take.takeId) &&
					!liveTakeIds.has(take.takeId)
				) {
					const { takeId, jobId } = take;
					resumingTakeIds.add(takeId);
					void pollJobToCompletion(takeId, jobId)
						.then((outcome) => {
							if (outcome.status === "done" && outcome.videoUrl) {
								void apiFetch("/api/studio/board", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ takeId }),
								});
							}
						})
						.catch(() => {
							// Best-effort recovery path; nothing more to do if it fails.
						})
						.finally(() => {
							resumingTakeIds.delete(takeId);
						});
				}
			}
		} catch {
			// History is best-effort; the grid still works without it.
			setHistoryLoaded(true);
		}
	}, [pollJobToCompletion]);

	const clearError = useCallback(() => {
		setError(null);
		setStatus("idle");
	}, []);

	return {
		status,
		activeTakes,
		error,
		generate,
		promoteTo1080p,
		loadHistory,
		historyLoaded,
		clearError,
	};
}
