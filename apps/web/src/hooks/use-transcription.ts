import { useState, useCallback } from "react";
import { aiClient, AIClientError } from "@/lib/ai-client";
import {
	isLocalWhisperSupported,
	transcribeLocally,
} from "@/lib/transcription/local-whisper";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { TranscriptionEngine } from "@/types/transcription";
import type { TranscriptionResult } from "@/types/ai";

function formatTranscriptionError(error: unknown): string {
	if (error instanceof AIClientError) {
		switch (error.errorType) {
			case "connection_refused":
				return "Cannot connect to AI backend. Start the backend server first (see AI Setup Guide).";
			case "timeout":
				return "Transcription request timed out. The model may still be loading — try again in a moment.";
			case "backend_error":
				return error.statusCode === 400
					? "Invalid file format. Supported: mp4, mkv, avi, mov, webm, wav, mp3, m4a, ogg, flac, aac."
					: `Backend error: ${error.message}`;
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : "Transcription failed";
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
				setProgress(10);

				// On-device Whisper first; fall back to the server route on failure.
				let result: Awaited<ReturnType<typeof aiClient.transcribe>>;
				try {
					if (isLocalWhisperSupported()) {
						result = await transcribeLocally(file, {
							language: language === "auto" ? undefined : language,
							onProgress: (p) =>
								setProgress(Math.min(90, Math.round(p.progress * 90))),
						});
					} else {
						result = await aiClient.transcribe(file, language);
					}
				} catch (localErr) {
					console.warn(
						"On-device Whisper failed, falling back to server:",
						localErr,
					);
					result = await aiClient.transcribe(file, language);
				}

				setSegments(result.segments);
				setLanguage(result.language);
				setProgress(100);

				return result;
			} catch (err) {
				const message = formatTranscriptionError(err);
				setError(message);
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
	/** Human-readable progress label, e.g. "Loading Whisper model... 40%". */
	onProgress?: (label: string) => void;
}

/**
 * Transcribes a single file through the selected engine.
 *
 * This is the shared single-file primitive: both the single-track transcribe
 * path and the whole-video (all-audio-tracks) path in the Captions panel call
 * this once per source file, so there is exactly one place that knows how to
 * talk to each backend and how on-device Whisper falls back to the server
 * route. Whole-video transcription loops this over every distinct media
 * asset backing an audio-bearing track instead of a parallel implementation.
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

	// Whisper — on-device first (Transformers.js/WebGPU), server route as fallback.
	try {
		if (isLocalWhisperSupported()) {
			return await transcribeLocally(file, {
				language,
				onProgress: (p) => {
					const label =
						p.stage === "decoding"
							? "Decoding audio on device..."
							: p.stage === "loading-model"
								? `Loading Whisper model... ${Math.round(p.progress * 100)}%`
								: "Transcribing on device...";
					onProgress?.(label);
				},
			});
		}
		return await aiClient.transcribe(file, language);
	} catch (localErr) {
		console.warn("On-device Whisper failed, falling back to server:", localErr);
		onProgress?.("Falling back to server...");
		return await aiClient.transcribe(file, language);
	}
}
