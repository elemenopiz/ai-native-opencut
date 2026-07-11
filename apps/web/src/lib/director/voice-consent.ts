/**
 * Voice-clone CONSENT gate — the liability fix (Flow D, gate #1).
 *
 * THE GAP THIS CLOSES: today the clone path (`aiClient.cloneVoice` →
 * `/api/tts/clone-voice`, driven from the Voiceover panel) "just uploads a
 * reference WAV and saves it — no consent, no fingerprint, no gating. This is a
 * liability gap, not just a feature gap." (`docs/poach/descript-underlord-poaches.md`
 * §4 #4). Descript requires a live spoken consent statement, verified before a
 * clone is usable.
 *
 * WHAT THIS MODULE IS: the PURE state machine for a cloned voice's consent —
 * types + transitions + phrase verification, no storage and no network. The
 * durable store (`@/stores/voice-consent-store`) and the capture orchestration
 * (`@/lib/director/voice-consent-service`) build on this; the TTS enforcement
 * (`generate-voiceover-take.ts`, the Director's `addVoiceover`) reads
 * {@link isProfileUsable} through the store so an UNCONSENTED clone is never
 * spoken.
 *
 * THE STATE MACHINE: a profile is born `pending` (created at clone time) and is
 * UNUSABLE until `consented`; `revoked` is terminal-until-re-granted and also
 * unusable, and revoking DROPS the reference so a tombstone can be deleted.
 *
 *     pending ──grantConsent(verified)──▶ consented ──revokeConsent──▶ revoked
 *        ▲                                                                 │
 *        └──────────────────── grantConsent (re-consent) ─────────────────┘
 *
 * FINGERPRINT / SPEAKER-SIMILARITY — WHAT IS REAL vs STUBBED: the consent phrase
 * is verified for REAL via the app's Whisper transcription path
 * (`aiClient.transcribe`, wired in the service) against {@link verifyConsentPhrase}.
 * A speaker-fingerprint match between the consent recording and the reference
 * audio is NOT implementable client-side today: the only speaker capability the
 * repo exposes is `aiClient.analyzeSpeakers` (pyannote DIARIZATION — it labels
 * speakers WITHIN one file), which returns neither a cross-file speaker embedding
 * nor a pairwise similarity score. So {@link verifySpeakerSimilarity} is a
 * documented STUB that returns `undefined` ("no comparison available"), consent
 * falls back to phrase-verification-only, and the seam is left explicit for when
 * a backend speaker-embedding endpoint lands. We deliberately do NOT fake a
 * fingerprint check that doesn't exist.
 */

export type ConsentStatus = "pending" | "consented" | "revoked";

/** How the consent phrase was verified when consent was granted. */
export type ConsentMethod = "phrase-transcription" | "phrase+similarity";

/** The recorded consent grant — who/when/phrase, stored minimally for audit. */
export interface ConsentRecord {
	/** The exact consent phrase the speaker was required to read. */
	phrase: string;
	/** Epoch ms the consent was granted. */
	grantedAt: number;
	/** Free-text speaker/grantor label (the app has no strong speaker identity). */
	grantedBy?: string;
	/** Whether a speaker-similarity check ran alongside phrase verification. */
	method: ConsentMethod;
	/** The transcript matched against the phrase (kept for audit; the raw audio is not). */
	transcript?: string;
	/** Similarity score in [0,1] when a real check ran (else undefined — see the stub). */
	similarityScore?: number;
}

/** The recorded revocation — who/when/why. Revoking immediately disables the clone. */
export interface RevocationRecord {
	at: number;
	by?: string;
	reason?: string;
}

/**
 * A cloned voice as tracked by the consent gate. The `referencePath` is the
 * backend speaker-WAV path (`aiClient.cloneVoice().path`) that TTS would submit
 * as `speakerWav` — it is the exact thing gated. A profile is UNUSABLE unless
 * `consentStatus === "consented"`.
 */
export interface ClonedVoiceProfile {
	/** Stable id (derived from the reference path — see {@link profileIdForReference}). */
	id: string;
	/** Display name for the clone. */
	name: string;
	/** Backend reference-audio path (the `speakerWav`) — the gated resource. */
	referencePath: string;
	consentStatus: ConsentStatus;
	/** Present only once consent has been granted (cleared on revoke). */
	consent?: ConsentRecord;
	/** Present only once revoked. */
	revocation?: RevocationRecord;
	createdAt: number;
}

/** The default consent phrase the speaker must read (personalized with the clone name). */
export function consentPhraseFor(name: string): string {
	const who = name.trim();
	return (
		`I, ${who || "the speaker"}, consent to having my voice cloned and used ` +
		`to generate synthetic speech in this project.`
	);
}

/** A stable profile id derived from the reference path (so re-clones dedupe). */
export function profileIdForReference(referencePath: string): string {
	return `voice:${referencePath}`;
}

/** Create a fresh, UNUSABLE (`pending`) profile at clone time. */
export function createPendingProfile(input: {
	name: string;
	referencePath: string;
	now?: number;
}): ClonedVoiceProfile {
	return {
		id: profileIdForReference(input.referencePath),
		name: input.name,
		referencePath: input.referencePath,
		consentStatus: "pending",
		createdAt: input.now ?? Date.now(),
	};
}

/** A cloned voice may only be spoken once consent is on record. */
export function isProfileUsable(
	profile: ClonedVoiceProfile | undefined,
): boolean {
	return profile?.consentStatus === "consented";
}

/**
 * Record a verified consent grant, moving the profile to `consented` (pure). The
 * CALLER is responsible for having verified the phrase (and, if available, the
 * speaker similarity) BEFORE calling this — see the service. `similarityScore`
 * present ⇒ method is recorded as `phrase+similarity`, else `phrase-transcription`.
 */
export function grantConsent(
	profile: ClonedVoiceProfile,
	input: {
		phrase: string;
		transcript?: string;
		similarityScore?: number;
		grantedBy?: string;
		now?: number;
	},
): ClonedVoiceProfile {
	const consent: ConsentRecord = {
		phrase: input.phrase,
		grantedAt: input.now ?? Date.now(),
		method:
			input.similarityScore != null
				? "phrase+similarity"
				: "phrase-transcription",
		...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
		...(input.transcript ? { transcript: input.transcript } : {}),
		...(input.similarityScore != null
			? { similarityScore: input.similarityScore }
			: {}),
	};
	const { revocation: _dropped, ...rest } = profile;
	return { ...rest, consentStatus: "consented", consent };
}

/**
 * Revoke consent, moving the profile to `revoked` and IMMEDIATELY disabling the
 * clone (pure). The prior consent record is dropped (revoke = delete the grant),
 * leaving only the revocation tombstone — align with data-deletion by removing
 * the whole profile from the store if a hard delete is wanted.
 */
export function revokeConsent(
	profile: ClonedVoiceProfile,
	input: { by?: string; reason?: string; now?: number } = {},
): ClonedVoiceProfile {
	const revocation: RevocationRecord = {
		at: input.now ?? Date.now(),
		...(input.by ? { by: input.by } : {}),
		...(input.reason ? { reason: input.reason } : {}),
	};
	const { consent: _dropped, ...rest } = profile;
	return { ...rest, consentStatus: "revoked", revocation };
}

// ── phrase verification (pure) ────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace — so "I consent." ≈ "i consent". */
export function normalizePhrase(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface PhraseVerification {
	/** True when the transcript covers the required phrase above the threshold. */
	ok: boolean;
	/** Token-recall of the expected phrase in [0,1] (share of expected words present, in order-agnostic form). */
	score: number;
}

/**
 * Verify a transcribed consent statement against the required phrase (pure). Uses
 * token RECALL of the expected phrase's words in the transcript — robust to minor
 * ASR errors, filler, and extra words the speaker adds — with a default 0.8
 * threshold. An exact normalized match short-circuits to 1.0.
 */
export function verifyConsentPhrase(
	expected: string,
	transcript: string,
	opts: { threshold?: number } = {},
): PhraseVerification {
	const threshold = opts.threshold ?? 0.8;
	const exp = normalizePhrase(expected);
	const got = normalizePhrase(transcript);
	if (!exp) return { ok: false, score: 0 };
	if (exp === got) return { ok: true, score: 1 };

	const expTokens = exp.split(" ").filter(Boolean);
	const gotTokens = new Set(got.split(" ").filter(Boolean));
	if (expTokens.length === 0) return { ok: false, score: 0 };

	const present = expTokens.filter((t) => gotTokens.has(t)).length;
	const score = present / expTokens.length;
	return { ok: score >= threshold, score };
}

// ── speaker-similarity seam (documented STUB) ─────────────────────────────────

/**
 * CONTRACT: compare a consent recording against the clone's reference audio and
 * return a speaker-similarity score in [0,1] (1 = certainly the same speaker), or
 * `undefined` when no faithful comparison is available.
 *
 * LIMITATION (why this is a stub, not a fake): the repo's only speaker capability
 * is `aiClient.analyzeSpeakers` — pyannote DIARIZATION, which segments/labels
 * speakers WITHIN a single file. It exposes neither a cross-file speaker embedding
 * nor a pairwise similarity, so a true voice-fingerprint match cannot be computed
 * client-side today. This default returns `undefined`; the consent flow then falls
 * back to PHRASE-VERIFICATION-ONLY (see the service). Replace this with a real
 * implementation when a backend speaker-embedding endpoint exists (pyannote
 * embeddings are vendored per the descript poach doc §4 #4).
 */
export type SpeakerSimilarityFn = (
	consentAudio: Blob | File,
	referenceAudio: Blob | File,
) => Promise<number | undefined>;

export const verifySpeakerSimilarity: SpeakerSimilarityFn = async () =>
	undefined;
