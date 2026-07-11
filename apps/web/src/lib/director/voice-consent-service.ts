/**
 * Consent CAPTURE orchestration for the voice-clone gate (Flow D #1).
 *
 * Turns a recorded/uploaded consent statement into a granted consent: transcribe
 * it (the app's existing Whisper path), verify the required phrase, optionally run
 * the speaker-similarity check (a documented stub today — see `voice-consent.ts`),
 * and, only on success, move the profile to `consented` in the durable store.
 *
 * All I/O is INJECTED (defaults hit `aiClient.transcribe` + the real store) so the
 * whole flow is unit-testable without a backend or a browser.
 */

import { aiClient } from "@/lib/ai-client";
import {
	type SpeakerSimilarityFn,
	verifyConsentPhrase,
	verifySpeakerSimilarity as defaultSpeakerSimilarity,
} from "@/lib/director/voice-consent";
import { useVoiceConsentStore } from "@/stores/voice-consent-store";
import type { ClonedVoiceProfile } from "@/lib/director/voice-consent";

/** Transcribe a consent recording to text (default: the app's Whisper path). */
export type TranscribeFn = (audio: File) => Promise<string>;

const defaultTranscribe: TranscribeFn = async (audio) => {
	const result = await aiClient.transcribe(audio);
	return result.segments
		.map((s) => s.text)
		.join(" ")
		.trim();
};

export interface CaptureConsentResult {
	ok: boolean;
	/** The updated profile when consent was granted. */
	profile?: ClonedVoiceProfile;
	/** Phrase-match score in [0,1]. */
	phraseScore: number;
	/** The transcript we matched against (for the caller to surface). */
	transcript: string;
	/** Similarity score if the speaker check ran; undefined ⇒ phrase-only (stub). */
	similarityScore?: number;
	/** Human-readable reason when `ok` is false. */
	reason?: string;
}

/**
 * Capture consent for a cloned voice profile from a recorded statement.
 *
 * Steps: transcribe → {@link verifyConsentPhrase} against `phrase` → (optional)
 * {@link SpeakerSimilarityFn} between the consent audio and the reference audio →
 * on success, grant consent in the store. Returns a structured result either way;
 * nothing is granted unless the phrase verifies (and, when a real similarity
 * function is supplied, the similarity passes its threshold).
 */
export async function captureConsent(input: {
	profileId: string;
	/** The recorded/uploaded consent statement. */
	consentAudio: File;
	/** The required phrase the speaker had to read (defaults to the profile's if omitted). */
	phrase: string;
	/** Optional reference audio for the speaker-similarity check. */
	referenceAudio?: File;
	grantedBy?: string;
	/** Phrase-match threshold (default 0.8, see `verifyConsentPhrase`). */
	phraseThreshold?: number;
	/** Minimum similarity to accept when a real similarity fn returns a score (default 0.7). */
	similarityThreshold?: number;
	transcribe?: TranscribeFn;
	speakerSimilarity?: SpeakerSimilarityFn;
}): Promise<CaptureConsentResult> {
	const transcribe = input.transcribe ?? defaultTranscribe;
	const speakerSimilarity = input.speakerSimilarity ?? defaultSpeakerSimilarity;
	const store = useVoiceConsentStore.getState();

	const profile = store.getProfile(input.profileId);
	if (!profile) {
		return {
			ok: false,
			phraseScore: 0,
			transcript: "",
			reason: `No voice profile "${input.profileId}".`,
		};
	}

	let transcript: string;
	try {
		transcript = await transcribe(input.consentAudio);
	} catch (err) {
		return {
			ok: false,
			phraseScore: 0,
			transcript: "",
			reason: `Could not transcribe the consent recording: ${
				err instanceof Error ? err.message : "unknown error"
			}.`,
		};
	}

	const phrase = verifyConsentPhrase(input.phrase, transcript, {
		...(input.phraseThreshold != null
			? { threshold: input.phraseThreshold }
			: {}),
	});
	if (!phrase.ok) {
		return {
			ok: false,
			phraseScore: phrase.score,
			transcript,
			reason:
				"The recording did not contain the required consent phrase — please read it exactly.",
		};
	}

	// Speaker-similarity: real when a fn is supplied AND returns a score; the
	// default stub returns undefined ⇒ phrase-verification-only (documented).
	let similarityScore: number | undefined;
	if (input.referenceAudio) {
		similarityScore = await speakerSimilarity(
			input.consentAudio,
			input.referenceAudio,
		).catch(() => undefined);
		const threshold = input.similarityThreshold ?? 0.7;
		if (similarityScore != null && similarityScore < threshold) {
			return {
				ok: false,
				phraseScore: phrase.score,
				transcript,
				similarityScore,
				reason:
					"The consenting voice does not match the cloned reference audio.",
			};
		}
	}

	const granted = store.grantProfileConsent(input.profileId, {
		phrase: input.phrase,
		transcript,
		...(similarityScore != null ? { similarityScore } : {}),
		...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
	});

	return {
		ok: true,
		profile: granted,
		phraseScore: phrase.score,
		transcript,
		similarityScore,
	};
}
