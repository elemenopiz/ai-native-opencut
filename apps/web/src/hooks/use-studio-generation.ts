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
	}) => Promise<void>;
	promoteTo1080p: (takeId: string) => Promise<void>;
	starTake: (takeId: string, starred: boolean) => Promise<void>;
	pinToBoard: (takeId: string, notes?: string) => Promise<void>;
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
	const pollJobToCompletion = useCallback(
		async (takeId: string, jobId: string): Promise<"done" | "error"> => {
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
				return "error";
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
				return "done";
			}

			setActiveTakes((prev) =>
				prev.map((t) =>
					t.takeId === takeId
						? { ...t, status: "error", error: outcome.error }
						: t,
				),
			);
			setError(outcome.error ?? "Generation failed");
			return "error";
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
		}) => {
			setStatus("submitting");
			setError(null);

			try {
				const res = await fetch("/api/studio/generate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(params),
				});

				if (!res.ok) {
					// Insufficient credits (402) → open the "Out of credits" modal.
					if (await gateOn402(res)) {
						setStatus("error");
						return;
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
					// Sync backends settle inline — refresh the header balance pill.
					void useCreditsStore.getState().refresh();
					return;
				}

				setStatus("polling");
				const outcome = await pollJobToCompletion(data.takeId, data.jobId);
				setStatus(outcome);
				// Async video settled/released on completion — refresh the balance.
				void useCreditsStore.getState().refresh();
			} catch (err) {
				setStatus("error");
				setError(err instanceof Error ? err.message : "Generation failed");
			}
		},
		[pollJobToCompletion],
	);

	const promoteTo1080p = useCallback(
		async (takeId: string) => {
			const res = await fetch(`/api/studio/takes/${takeId}/promote`, {
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

	const starTake = useCallback(async (takeId: string, starred: boolean) => {
		await fetch(`/api/studio/takes/${takeId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ starred }),
		});
		setActiveTakes((prev) =>
			prev.map((t) => (t.takeId === takeId ? { ...t, starred } : t)),
		);
	}, []);

	const pinToBoard = useCallback(async (takeId: string, notes?: string) => {
		const res = await fetch("/api/studio/board", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ takeId, notes }),
		});
		if (!res.ok) {
			const data = (await res.json()) as { error?: string };
			throw new Error(data.error ?? "Failed to pin to board");
		}
	}, []);

	// Hydrate the Takes grid from persisted generation sets so prior work
	// survives a reload. Resumes polling for any take still in-flight.
	const loadHistory = useCallback(async () => {
		try {
			const res = await fetch("/api/studio/sets");
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

			// Resume polling for takes that were mid-generation when last closed.
			for (const take of loaded) {
				if (take.status === "polling" && take.jobId) {
					void pollJobToCompletion(take.takeId, take.jobId);
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
		starTake,
		pinToBoard,
		loadHistory,
		historyLoaded,
		clearError,
	};
}
