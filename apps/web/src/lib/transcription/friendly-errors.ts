/**
 * Customer-facing copy for transcription / translation / speaker failures.
 *
 * Standing rule: customer surfaces never show technical errors and never name
 * providers, env vars, container commands, or file paths in primary copy. This
 * mirrors `components/editor/panels/assets/views/director.tsx`'s
 * `classifyAgentError` / `relayDevHint` pair — a short human line for the
 * visible message, with the raw detail kept behind a collapsed "Show details"
 * channel and the actionable developer pointer emitted only outside
 * production.
 */

/** What the user was trying to do, so the line can name it naturally. */
export type TranscriptionTask = "transcribe" | "translate" | "speakers";

const TASK_NOUN: Record<TranscriptionTask, string> = {
	transcribe: "Transcription",
	translate: "Translation",
	speakers: "Speaker detection",
};

/**
 * Raw-detail shapes that mean "the thing this needs isn't set up here" — a
 * permanent-until-an-operator-acts state, not a transient failure worth
 * retrying. Covers both wordings this app actually produces for the missing
 * `AZURE_SPEECH_KEY` / `AZURE_SPEECH_ENDPOINT` case:
 *  - the raw `/api/transcribe` 503 body ("No transcription key configured…"),
 *    which reaches here only if some caller ever forwards it unfiltered; and
 *  - `MaiTranscribeError`'s own already-friendly "isn't available right now"
 *    text, which some callers (e.g. the Captions panel) re-run through this
 *    classifier. Without matching that second shape, an already-correct "off"
 *    message would get re-flattened into the generic "didn't work, try again"
 *    line below — telling the user to retry a state that won't change until
 *    the key is set.
 */
function isNotConfigured(detail: string): boolean {
	return /api key|not configured|key configured|isn't available|not available|no .*backend|not found|404|501/i.test(
		detail,
	);
}

/** Raw-detail shapes that mean "couldn't reach it — might work next time". */
function isUnreachable(detail: string): boolean {
	return /cannot connect|connection_refused|econnrefused|network|failed to fetch|timeout|timed out|\b(429|5\d\d)\b/i.test(
		detail,
	);
}

/**
 * A short, human line for the visible message. Never echoes `detail`, and
 * never names a provider, environment variable, container, or path.
 */
export function friendlyTranscriptionError(
	detail: string,
	task: TranscriptionTask = "transcribe",
): string {
	const noun = TASK_NOUN[task];
	if (/invalid file format|unsupported/i.test(detail)) {
		return "That file type isn't supported. Try an MP4, MOV, WebM, MP3, or WAV.";
	}
	if (isUnreachable(detail)) {
		return `${noun} didn't go through. Please try again in a moment.`;
	}
	if (isNotConfigured(detail)) {
		return `${noun} isn't available on this account yet.`;
	}
	return `${noun} didn't work this time. Please try again.`;
}

/**
 * Non-production-only developer pointer, appended to the collapsed detail.
 * Returns "" in production so infrastructure names can never reach a customer.
 */
export function transcriptionDevHint(detail: string): string {
	if (process.env.NODE_ENV === "production") return "";
	if (/sarvam/i.test(detail)) {
		return " Dev: set BYORN_SARVAM_API_KEY, or pick a different engine.";
	}
	if (/smallest/i.test(detail)) {
		return " Dev: set BYORN_SMALLEST_API_KEY (or add the key in Settings → API Keys).";
	}
	if (isUnreachable(detail)) {
		return " Dev: no AI backend reachable — on-device Whisper needs a Chromium-based browser, or start the self-hosted backend.";
	}
	return "";
}

/**
 * The collapsed technical channel: raw detail plus the dev-only pointer.
 * Safe to render only behind a "Show details" toggle, never as primary copy.
 */
export function transcriptionErrorDetail(detail: string): string {
	return `${detail}${transcriptionDevHint(detail)}`.trim();
}
