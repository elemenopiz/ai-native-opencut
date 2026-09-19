/**
 * POST /api/transcribe — speech-to-text via MAI-Transcribe-2 (Microsoft Foundry).
 *
 * WHY THIS SHAPE: this is the app's ONLY transcription backend. On-device
 * Whisper (Transformers.js in a worker) used to be the default and this route's
 * predecessor lived on the external Python backend at
 * `NEXT_PUBLIC_AI_BACKEND_URL` — which does not exist in cloud deploys, so in
 * prod transcription was on-device or nothing. Both are gone: Whisper was
 * removed deliberately, and this Next route replaces the unreachable backend so
 * the feature works in prod for the first time.
 *
 * It mirrors `/api/tts` deliberately: the same "no key → 503 with a
 * machine-readable code so the client hides the feature" contract, the same
 * session→401 gate placed AFTER the no-key check, the same per-account rate
 * limiting, and the same never-echo-the-provider-body rule.
 *
 * SIZE / CHUNKING: the client sends ONE chunk per call. It extracts 16 kHz mono
 * Opus audio in the browser and splits anything above
 * `TRANSCRIBE_CHUNK_TARGET_BYTES` into several calls, re-offsetting timestamps
 * as it stitches. That threshold exists because Vercel caps serverless request
 * bodies near 4.5 MB — NOT because of the provider, which accepts 500 MB / 5 h.
 * On Cloudflare Workers (100 MB bodies on Free/Pro) raising that one constant
 * makes chunking stop triggering; nothing here changes.
 *
 * Config (see `.env.example`):
 *  - `AZURE_SPEECH_KEY` / `AZURE_SPEECH_ENDPOINT` — when either is unset we
 *    return a 503 with `error: "transcription_not_configured"`.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { aiAccessDeniedResponse, hasAiAccess } from "@/lib/ai-access";
import { reportError } from "@/lib/observability/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import {
	MAI_TRANSCRIBE_MODEL,
	TRANSCRIBE_MAX_UPLOAD_BYTES,
} from "@/constants/transcription-constants";
import type { TranscriptionResult, TranscriptionSegment } from "@/types/ai";

export const runtime = "nodejs";
// A ~30-minute chunk takes the provider tens of seconds; give the invocation
// the same generous wall-clock budget as the other heavy provider routes.
export const maxDuration = 60;

/** Fail OUR way (catchable 502) before the platform kills the invocation. */
const PROVIDER_TIMEOUT_MS = 55_000;

const API_VERSION = "2025-10-15";

/**
 * Azure's fast-transcription response. Only the fields we actually read are
 * modelled — the provider sends more (per-channel splits, profanity tags) and
 * unknown keys are ignored rather than rejected, so a provider-side additive
 * change can't 500 this route.
 */
interface AzurePhraseWord {
	text?: string;
	offsetMilliseconds?: number;
	durationMilliseconds?: number;
}

interface AzurePhrase {
	text?: string;
	offsetMilliseconds?: number;
	durationMilliseconds?: number;
	locale?: string;
	confidence?: number;
	speaker?: number;
	words?: AzurePhraseWord[];
}

interface AzureTranscription {
	durationMilliseconds?: number;
	combinedPhrases?: { text?: string }[];
	phrases?: AzurePhrase[];
}

const ms = (value: number | undefined) => (value ?? 0) / 1000;

/**
 * Azure's phrase/word shape → our `TranscriptionResult`.
 *
 * `offsetMilliseconds` is absolute within the SUBMITTED audio, so for a chunked
 * file these are chunk-relative. The client adds the chunk's start offset while
 * stitching — deliberately not done here, because the route is stateless and
 * has no idea which chunk it is looking at.
 */
function toTranscriptionResult(azure: AzureTranscription): TranscriptionResult {
	const phrases = azure.phrases ?? [];

	const segments: TranscriptionSegment[] = phrases.map((phrase, index) => {
		const start = ms(phrase.offsetMilliseconds);
		return {
			id: index,
			text: phrase.text ?? "",
			start,
			end: start + ms(phrase.durationMilliseconds),
			// Speaker 0 is a real speaker, so compare against undefined rather
			// than relying on truthiness — `speaker: 0` must not become "no
			// speaker" and collapse a two-person diarized interview into one.
			...(phrase.speaker !== undefined
				? { speaker: `Speaker ${phrase.speaker + 1}` }
				: {}),
			words: (phrase.words ?? []).map((word) => {
				const wordStart = ms(word.offsetMilliseconds);
				return {
					word: word.text ?? "",
					start: wordStart,
					end: wordStart + ms(word.durationMilliseconds),
					// Azure reports confidence per phrase, not per word. Inheriting
					// the phrase value keeps the field honest (it IS the model's
					// confidence for this text) without inventing a number.
					confidence: phrase.confidence ?? 0,
				};
			}),
		};
	});

	return {
		segments,
		// Locale comes back per phrase (auto-detect can switch mid-file); the
		// first phrase's locale is the file's dominant language in practice.
		language: phrases[0]?.locale ?? "en-US",
		duration: ms(azure.durationMilliseconds),
	};
}

export async function POST(req: Request) {
	const apiKey = webEnv.AZURE_SPEECH_KEY;
	const endpoint = webEnv.AZURE_SPEECH_ENDPOINT.replace(/\/+$/, "");
	if (!apiKey || !endpoint) {
		// Machine-readable "no key" signal — the client maps this exact code to a
		// friendly "transcription isn't available" state and hides the feature.
		// There is no local fallback any more, so this must never read as a crash.
		return NextResponse.json(
			{
				error: "transcription_not_configured",
				message:
					"No transcription key configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_ENDPOINT in apps/web/.env.local.",
			},
			{ status: 503 },
		);
	}

	// A key IS configured, so this route bills it — require a signed-in user.
	// (After the no-key check so a self-hosted instance with no key returns the
	// 503 the client uses to hide the feature, not a 401.)
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!hasAiAccess(session.user)) return aiAccessDeniedResponse();

	const limited = await enforceRateLimit({
		name: "transcribe:audio",
		request: req,
		userId: session.user.id,
	});
	if (limited) return limited;

	// Bound the body before reading it — content-length can lie or be absent, so
	// the actual blob size is re-checked below too.
	const contentLength = Number(req.headers.get("content-length") ?? 0);
	if (contentLength > TRANSCRIBE_MAX_UPLOAD_BYTES) {
		return NextResponse.json({ error: "Payload too large" }, { status: 413 });
	}

	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return NextResponse.json(
			{
				error: "bad_request",
				message: "Request body must be multipart form data.",
			},
			{ status: 400 },
		);
	}

	const audio = form.get("audio");
	if (!(audio instanceof Blob) || audio.size === 0) {
		return NextResponse.json(
			{ error: "bad_request", message: "Missing audio." },
			{ status: 400 },
		);
	}
	if (audio.size > TRANSCRIBE_MAX_UPLOAD_BYTES) {
		return NextResponse.json({ error: "Payload too large" }, { status: 413 });
	}

	// Locale is an opaque BCP-47 tag to us; bound its length so a hostile value
	// can't be used to pad the outbound definition JSON.
	const localeRaw = form.get("language");
	const locale =
		typeof localeRaw === "string" && localeRaw && localeRaw !== "auto"
			? localeRaw.slice(0, 16)
			: undefined;
	const diarize = form.get("diarize") === "true";
	const style = form.get("style") === "clean" ? "clean" : "verbatim";

	const definition = {
		enhancedMode: { enabled: true, model: MAI_TRANSCRIBE_MODEL },
		// Word timestamps are not optional for us — captions are built by
		// splitting on word boundaries, so a segment-only response would
		// silently degrade every caption preset to phrase-length blocks.
		modelOptions: { timestamps: "word", transcribeStyle: style },
		// Omitting `locales` entirely selects the multilingual model, which is
		// what "auto" means here. Passing a single locale is both more accurate
		// and lower-latency, so send one whenever the user picked a language.
		...(locale ? { locales: [locale] } : {}),
		// Diarization is mono-only and documented to fail on recordings of
		// roughly 15 minutes or longer, so the client only asks for it on short
		// audio — this route just honours the flag.
		...(diarize ? { diarization: { enabled: true, maxSpeakers: 8 } } : {}),
	};

	const outbound = new FormData();
	outbound.append("audio", audio, "audio.ogg");
	outbound.append("definition", JSON.stringify(definition));

	const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;

	try {
		const res = await fetchWithTimeout(url, {
			method: "POST",
			timeoutMs: PROVIDER_TIMEOUT_MS,
			// Content-Type is deliberately NOT set — fetch derives the multipart
			// boundary from the FormData body, and setting it by hand omits the
			// boundary and makes the provider reject the request as malformed.
			headers: { "Ocp-Apim-Subscription-Key": apiKey },
			body: outbound,
		});

		if (!res.ok) {
			// Log the provider's status/body server-side (truncated), but NEVER echo
			// it to the client — provider error bodies can quote the request key.
			const providerBody = await res.text().catch(() => "");
			reportError(new Error(`MAI-Transcribe-2 error ${res.status}`), {
				route: "transcribe",
				providerStatus: res.status,
				providerBody: providerBody.slice(0, 500),
			});
			return NextResponse.json(
				{
					error: "provider_api_error",
					message: "The transcription provider rejected the request.",
				},
				{ status: 502 },
			);
		}

		const azure = (await res.json()) as AzureTranscription;
		return NextResponse.json(toTranscriptionResult(azure));
	} catch (error) {
		reportError(error, { route: "transcribe" });
		return NextResponse.json(
			{
				error: "provider_unreachable",
				message: "Could not reach the transcription provider.",
			},
			{ status: 502 },
		);
	}
}
