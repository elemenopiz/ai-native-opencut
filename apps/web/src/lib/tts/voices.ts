/**
 * The cloud TTS voice allowlist — the SINGLE source of truth shared by the
 * `/api/tts` route (zod enum validation) and its clients (voice pickers,
 * `generate-voiceover-take`'s pass-through filter). One list means a voice the
 * UI offers can never 400 at the route, and a legacy value (XTTS speaker names,
 * the old "male"/"female" toggle) is detectably NOT a cloud voice.
 *
 * These are OpenAI's built-in `gpt-4o-mini-tts` voices (browser-first local AI
 * plan Task 7/8 — speech synthesis stays a cloud capability for beta).
 */
export const TTS_VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"onyx",
	"nova",
	"sage",
	"shimmer",
	"verse",
] as const;

export type TTSVoice = (typeof TTS_VOICES)[number];

/** Voice the route falls back to when none is supplied. */
export const DEFAULT_TTS_VOICE: TTSVoice = "alloy";

/** True when `voice` is one of the route's allowed voices — anything else
 *  (an XTTS-era speaker name, "male"/"female") must be omitted from requests
 *  or the route rejects the whole call with a 400. */
export function isTTSVoice(voice: string | undefined): voice is TTSVoice {
	return (
		voice !== undefined && (TTS_VOICES as readonly string[]).includes(voice)
	);
}
