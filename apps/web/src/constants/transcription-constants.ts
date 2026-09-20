import { LANGUAGES } from "@/constants/language-constants";
import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "@/types/transcription";
import type { LanguageCode } from "@/types/language";

/** Provider model id sent in the Foundry `enhancedMode.model` field. */
export const MAI_TRANSCRIBE_MODEL = "MAI-Transcribe-2";

/**
 * Target size for ONE upload to `/api/transcribe`.
 *
 * This is a HOST limit, not a provider limit: MAI-Transcribe-2 itself accepts
 * 500 MB / 5 hours per request, but Vercel caps serverless request bodies at
 * roughly 4.5 MB. Audio is extracted as 16 kHz mono Opus (~2 KB/s), so 4 MB is
 * about 33 minutes — anything longer is split into several chunks by
 * `transcribeWithMai` and stitched back together with corrected offsets.
 *
 * ON MIGRATING OFF VERCEL: Cloudflare Workers allow 100 MB request bodies on
 * Free and Pro (200 MB Business, 500 MB Enterprise), so raising this to
 * ~90_000_000 there makes chunking stop triggering for any realistic file —
 * a five-hour recording is ~36 MB at this bitrate, still one request. Nothing
 * else needs to change: the chunking path stays correct, it just never runs.
 */
export const TRANSCRIBE_CHUNK_TARGET_BYTES = 4_000_000;

/**
 * Hard reject bound on the server side. Slightly above the chunk target so a
 * chunk that compresses worse than predicted (dense speech, music under
 * dialogue) is still accepted rather than 413-ing a legitimate upload.
 */
export const TRANSCRIBE_MAX_UPLOAD_BYTES = 4_500_000;

/** Bitrate for the extracted Opus audio, in bits per second. */
export const TRANSCRIBE_AUDIO_BITRATE = 16_000;

/** Sample rate for extracted audio. 16 kHz is the speech-recognition standard. */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;

/**
 * Diarization ceiling, in seconds.
 *
 * Microsoft documents speaker diarization as failing on recordings "of about
 * 15 minutes and longer", so we stop asking for it past this point rather than
 * letting a long interview fail outright. Under the ceiling, diarization is
 * requested; over it, the transcript comes back without speaker labels.
 */
export const TRANSCRIBE_DIARIZATION_MAX_SECONDS = 15 * 60;

/**
 * Languages offered in the transcription UI.
 *
 * MAI-Transcribe-2 covers 60 languages; this is the subset the app already had
 * names and codes for (the former Whisper set plus the Indian regional
 * languages), every one of which the model supports. Widening this list is a
 * matter of adding entries to `LANGUAGES` — nothing here is a model limit.
 */
const SUPPORTED_TRANSCRIPTION_LANGS: ReadonlyArray<LanguageCode> = [
	"en",
	"es",
	"it",
	"fr",
	"de",
	"pt",
	"ru",
	"ja",
	"zh",
	"hi",
	"bn",
	"ta",
	"te",
	"mr",
	"gu",
	"kn",
	"ml",
	"pa",
	"od",
	"as",
	"ur",
	"sa",
	"ne",
	"sd",
	"ks",
	"kok",
	"doi",
	"mai",
	"mni",
	"sat",
	"brx",
];

export const TRANSCRIPTION_LANGUAGES = LANGUAGES.filter((language) =>
	SUPPORTED_TRANSCRIPTION_LANGS.includes(language.code),
);

/**
 * App language code -> BCP-47 locale for the provider's `locales` field.
 *
 * Azure wants a region-qualified tag ("en-US", not "en"); an unqualified code
 * is rejected. Codes absent from this map fall through to auto-detect, which
 * is the correct degradation - a wrong guessed region is worse than letting
 * the multilingual model decide.
 */
const TRANSCRIPTION_LOCALES: Partial<Record<LanguageCode, string>> = {
	en: "en-US",
	es: "es-ES",
	it: "it-IT",
	fr: "fr-FR",
	de: "de-DE",
	pt: "pt-BR",
	ru: "ru-RU",
	ja: "ja-JP",
	zh: "zh-CN",
	hi: "hi-IN",
	bn: "bn-IN",
	ta: "ta-IN",
	te: "te-IN",
	mr: "mr-IN",
	gu: "gu-IN",
	kn: "kn-IN",
	ml: "ml-IN",
	pa: "pa-IN",
	od: "or-IN",
	as: "as-IN",
	ur: "ur-IN",
	ne: "ne-NP",
};

/**
 * Resolve an app language code to a provider locale. Returns undefined for
 * "auto", unknown codes, and anything unmapped - all of which mean
 * "let the multilingual model identify the language".
 */
export function toTranscriptionLocale(
	code: string | undefined,
): string | undefined {
	if (!code || code === "auto") return undefined;
	return TRANSCRIPTION_LOCALES[code as LanguageCode];
}

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "mai-transcribe-2",
		name: "MAI-Transcribe-2",
		huggingFaceId: "",
		description: "60 languages, word timestamps, speaker labels",
		engine: "mai",
	},
	{
		id: "saaras-v3",
		name: "Sarvam Saaras v3",
		huggingFaceId: "",
		description: "Best for Indian regional languages (cloud, 22 languages)",
		engine: "sarvam",
	},
	{
		id: "pulse-v1",
		name: "Smallest AI Pulse",
		huggingFaceId: "",
		description: "39 languages, speaker diarization, emotion detection (cloud)",
		engine: "smallest",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"mai-transcribe-2";

export const DEFAULT_WORDS_PER_CAPTION = 3;
export const MIN_CAPTION_DURATION_SECONDS = 0.8;
