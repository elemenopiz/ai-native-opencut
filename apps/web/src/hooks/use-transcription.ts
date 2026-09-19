import { useState, useCallback } from "react";
import { aiClient, AIClientError } from "@/lib/ai-client";
import {
	isLocalWhisperSupported,
	transcribeLocally,
} from "@/lib/transcription/local-whisper";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { TranscriptionEngine } from "@/types/transcription";
import type { TranscriptionResult } from "@/types/ai";
import { friendlyTranscriptionError } from "@/lib/transcription/friendly-errors";

/**
 * Customer-facing line for a failed transcription. Per the standing copy rule
 * this never names a backend, service, env var, or path — the technical cause
 * goes to the console and, where a surface offers one, a collapsed details
 * channel (see `lib/transcription/friendly-errors.ts`).
 */
function formatTranscriptionError(error: unknown): string {
	if (error instanceof AIClientError) {
		switch (error.errorType) {
			case "connection_refused":
				return friendlyTranscriptionError("connection_refused", "transcribe");
			case "timeout":
				return "Transcription is taking longer than expected. Please try again in a moment.";
			case "backend_error":
				return error.statusCode === 400
					? "That file type isn't supported. Try an MP4, MOV, WebM, MP3, or WAV."
					: friendlyTranscriptionError(error.message, "transcribe");
			default:
				return friendlyTranscriptionError(error.message, "transcribe");
		}
	}
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
				setProgress(10);

				// On-device Whisper first; fall back to the server route on failure.
				// In cloud deploys there is no server backend, so if BOTH fail we
				// keep the on-device error — it's the real, actionable cause. The
				// server's "cannot connect" would otherwise mask it (and prod
				// strips console.warn, so that mask leaves no trace at all).
				let result: Awaited<ReturnType<typeof aiClient.transcribe>>;
				if (isLocalWhisperSupported()) {
					try {
						result = await transcribeLocally(file, {
							language: language === "auto" ? undefined : language,
							onProgress: (p) =>
								setProgress(Math.min(90, Math.round(p.progress * 90))),
						});
					} catch (localErr) {
						console.warn(
							"On-device Whisper failed, trying server fallback:",
							localErr,
						);
						try {
							result = await aiClient.transcribe(file, language);
						} catch (serverErr) {
							console.error(
								"Transcription failed (on-device and server):",
								localErr,
							);
							throw localErr instanceof Error ? localErr : serverErr;
						}
					}
				} else {
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
	// Browsers without Worker/Web-Audio can't run it locally, so those go
	// straight to the server engine.
	if (!isLocalWhisperSupported()) {
		return await aiClient.transcribe(file, language);
	}

	const runLocal = () =>
		transcribeLocally(file, {
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

	// On-device model weights (HF) and the ORT runtime load over the network, so
	// a transient blip surfaces as a bare "network error". Files that already
	// downloaded stay in the browser cache, so one retry resumes cheaply and
	// usually succeeds — do that before giving up on the on-device path.
	let localErr: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await runLocal();
		} catch (err) {
			localErr = err;
			if (attempt === 0 && isTransientNetworkError(err)) {
				console.warn(
					"On-device Whisper hit a network error, retrying once:",
					err,
				);
				onProgress?.("Retrying on device...");
				continue;
			}
			break;
		}
	}

	// Both on-device attempts failed. The server retry below is for genuinely
	// self-hosted setups (no backend exists in cloud deploys); if it ALSO fails,
	// surface the on-device error rather than the server's "cannot connect" — the
	// on-device cause is the actionable one.
	console.warn("On-device Whisper failed, trying server fallback:", localErr);
	onProgress?.("Falling back to server...");
	try {
		return await aiClient.transcribe(file, language);
	} catch (serverErr) {
		console.error("Transcription failed (on-device and server):", localErr);
		throw localErr instanceof Error ? localErr : serverErr;
	}
}

/**
 * True for the transient, retryable network failures the on-device model/runtime
 * download can hit (CDN/HF hiccup, flaky connection). Deliberately narrow: a
 * decode failure or unsupported-file error is NOT retryable and should fall
 * through to the server fallback immediately.
 */
function isTransientNetworkError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes("network error") ||
		msg.includes("failed to fetch") ||
		msg.includes("networkerror") ||
		msg.includes("load failed") ||
		msg.includes("err_network") ||
		msg.includes("err_connection")
	);
}
