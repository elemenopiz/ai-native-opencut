import type { LanguageCode } from "./language";

export type TranscriptionLanguage = LanguageCode | "auto";

/**
 * Engine used for transcription.
 *
 * "mai" (MAI-Transcribe-2 via Microsoft Foundry) is the default and the only
 * one reachable in cloud deploys. "sarvam" and "smallest" still route through
 * the external Python backend at NEXT_PUBLIC_AI_BACKEND_URL, so they only work
 * against a locally-running backend. On-device Whisper was removed.
 */
export type TranscriptionEngine = "mai" | "sarvam" | "smallest";

/** Sarvam STT modes */
export type SarvamSTTMode = "transcribe" | "translate";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
	speaker?: string;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "mai-transcribe-2"
	| "saaras-v3"
	| "pulse-v1";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
	engine: TranscriptionEngine;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}

/** Sarvam translation request */
export interface SarvamTranslateRequest {
	text: string;
	sourceLanguageCode: string;
	targetLanguageCode: string;
	model?: string;
	mode?: "formal" | "modern-colloquial" | "classic-colloquial";
}

/** Sarvam TTS request */
export interface SarvamTTSRequest {
	text: string;
	targetLanguageCode: string;
	speaker?: string;
	model?: string;
	pace?: number;
	sampleRate?: number;
}

/** Sarvam TTS response */
export interface SarvamTTSResult {
	audioBase64: string;
	requestId: string;
}
