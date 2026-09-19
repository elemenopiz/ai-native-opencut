import { useState, useCallback } from "react";
import { aiClient } from "@/lib/ai-client";
import {
	MaiTranscribeError,
	transcribeWithMai,
} from "@/lib/transcription/mai-transcribe";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { TranscriptionEngine } from "@/types/transcription";
import type { TranscriptionResult } from "@/types/ai";

/**
 * Map a failure to copy a person can act on.
 *
 * `MaiTranscribeError` messages are already written for display (see
 * mai-transcribe.ts), so they pass through untouched. Everything else collapses
 * to one neutral line — no provider names, no status codes, no stack text.
 */
function formatTranscriptionError(error: unknown): string {
	if (error instanceof MaiTranscribeError) return error.message;
	return "Transcription didn't finish. Try again in a moment.";
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

	return transcribeWithMai(file, {
		language,
		onProgress: (p) => onProgress?.(p.message ?? "Transcribing..."),
	});
}
