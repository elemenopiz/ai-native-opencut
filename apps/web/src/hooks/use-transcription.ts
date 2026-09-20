import { useState, useCallback, useSyncExternalStore } from "react";
import { aiClient } from "@/lib/ai-client";
import {
	MaiTranscribeError,
	transcribeWithMai,
} from "@/lib/transcription/mai-transcribe";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { TranscriptionEngine } from "@/types/transcription";
import type { TranscriptionResult } from "@/types/ai";
import { friendlyTranscriptionError } from "@/lib/transcription/friendly-errors";

// ── "transcription not configured" session cache ────────────────────────────
// Mirrors `enhance-prompt-button.tsx`'s external-store pattern. MAI-Transcribe-2
// needs AZURE_SPEECH_KEY/AZURE_SPEECH_ENDPOINT; when either is unset,
// `/api/transcribe` answers 503 `transcription_not_configured` and
// `transcribeWithMai` surfaces it as `MaiTranscribeError` with
// `code: "not_configured"` (see mai-transcribe.ts's `postChunk`). There is no
// local fallback engine for "mai", so once any attempt learns this, every
// "Generate transcript" surface disables itself for the mai engine for the
// rest of the session instead of re-running a guaranteed-503 round trip.
let transcriptionNotConfigured = false;
const transcriptionListeners = new Set<() => void>();

function markTranscriptionNotConfigured() {
	if (transcriptionNotConfigured) return;
	transcriptionNotConfigured = true;
	for (const l of transcriptionListeners) l();
}

function subscribeTranscriptionAvailability(cb: () => void): () => void {
	transcriptionListeners.add(cb);
	return () => transcriptionListeners.delete(cb);
}

/** Plain (non-hook) read of the same flag — for call sites outside React and
 * for tests, which have no renderer in this repo to exercise the hook form. */
export function isTranscriptionNotConfigured(): boolean {
	return transcriptionNotConfigured;
}

/** True once a "mai" transcription attempt has learned the feature is off. */
export function useTranscriptionNotConfigured(): boolean {
	return useSyncExternalStore(
		subscribeTranscriptionAvailability,
		isTranscriptionNotConfigured,
		isTranscriptionNotConfigured,
	);
}

/**
 * Test-only escape hatch: this flag is an intentional session-sticky cache
 * (see the block comment above), not per-test state, so nothing in the app
 * itself should ever call this — only test files resetting isolation between
 * cases/files.
 */
export function __resetTranscriptionAvailabilityForTests(): void {
	transcriptionNotConfigured = false;
}

/**
 * The exact customer-facing line for "mai" transcription being switched off —
 * derived from the same classifier `friendly-errors.ts` uses for this failure
 * shape, so the disabled-button explanation never drifts from the sentence a
 * failed round trip would have shown anyway.
 */
export const TRANSCRIPTION_UNAVAILABLE_MESSAGE = friendlyTranscriptionError(
	"isn't available right now",
	"transcribe",
);

function markIfNotConfigured(err: unknown): void {
	if (err instanceof MaiTranscribeError && err.code === "not_configured") {
		markTranscriptionNotConfigured();
	}
}

/**
 * Customer-facing line for a failed transcription. Per the standing copy rule
 * this never names a backend, service, env var, or path — the technical cause
 * goes to the console and, where a surface offers one, a collapsed details
 * channel (see `lib/transcription/friendly-errors.ts`).
 *
 * `MaiTranscribeError` messages are already written to that rule at the point
 * of failure, where the specific cause is known (not configured / signed out /
 * rate limited), so they pass through instead of being re-flattened to the
 * generic line.
 */
function formatTranscriptionError(error: unknown): string {
	if (error instanceof MaiTranscribeError) return error.message;
	return friendlyTranscriptionError(
		error instanceof Error ? error.message : "",
		"transcribe",
	);
}

export function useTranscription() {
	const [error, setError] = useState<string | null>(null);

	const {
		isTranscribing,
		progress,
		setTranscribing,
		setProgress,
		setSegments,
		setLanguage,
	} = useTranscriptStore();

	const transcribeVideo = useCallback(
		async (file: File, language?: string) => {
			setError(null);
			setTranscribing(true);
			setProgress(0);

			try {
				const result = await transcribeWithMai(file, {
					language,
					onProgress: (p) => setProgress(Math.round(p.progress * 100)),
				});

				setSegments(result.segments);
				setLanguage(result.language);
				setProgress(100);

				return result;
			} catch (err) {
				markIfNotConfigured(err);
				setError(formatTranscriptionError(err));
				throw err;
			} finally {
				setTranscribing(false);
			}
		},
		[setTranscribing, setProgress, setSegments, setLanguage],
	);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	return {
		transcribeVideo,
		isTranscribing,
		progress,
		error,
		clearError,
	};
}

export interface TranscribeFileParams {
	file: File;
	engine: TranscriptionEngine;
	/** Already-resolved language code for the given engine. Undefined = auto-detect where supported. */
	language?: string;
	/** Human-readable progress label, e.g. "Transcribing (part 2 of 3)". */
	onProgress?: (label: string) => void;
}

/**
 * Transcribes a single file through the selected engine.
 *
 * This is the shared single-file primitive: both the single-track transcribe
 * path and the whole-video (all-audio-tracks) path in the Captions panel call
 * this once per source file, so there is exactly one place that knows how to
 * talk to each backend. Whole-video transcription loops this over every
 * distinct media asset backing an audio-bearing track instead of a parallel
 * implementation.
 *
 * "mai" is the only engine reachable in cloud deploys. "sarvam" and "smallest"
 * still go through the external Python backend at NEXT_PUBLIC_AI_BACKEND_URL,
 * so they work only against a locally-running backend — they are kept as-is
 * rather than removed, but nothing routes to them by default.
 */
export async function transcribeFileWithEngine({
	file,
	engine,
	language,
	onProgress,
}: TranscribeFileParams): Promise<TranscriptionResult> {
	if (engine === "sarvam") {
		return aiClient.sarvamTranscribe(file, language);
	}
	if (engine === "smallest") {
		return aiClient.smallestTranscribe(file, language ?? "en");
	}

	try {
		return await transcribeWithMai(file, {
			language,
			onProgress: (p) => onProgress?.(p.message ?? "Transcribing..."),
		});
	} catch (err) {
		markIfNotConfigured(err);
		throw err;
	}
}
