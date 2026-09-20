/**
 * AUDIO adapter — Higgsfield AI, Seed Audio 1.0 (`seed_audio`).
 *
 * TEXT-TO-SPEECH, NOT SOUND EFFECTS. Worth stating plainly because it is easy
 * to assume otherwise from the name: Seed Audio's entire documented flag
 * surface is speech-shaped — `voice_id`, `voice_type` (preset|element),
 * `speech_rate`, `pitch_rate`, `loudness_rate`, `sample_rate`, `format`
 * (first-party flag table, github.com/higgsfield-ai/cli, MODELS.md). There is
 * no SFX or ambience knob anywhere in it. Higgsfield's music model is a
 * separate id (`sonilo_music`), and its video-synced foley equivalent is what
 * `fal-mmaudio.ts` already covers here. So this adapter is Byorn's THIRD audio
 * shape — narration — sitting alongside score (MMAudio) and music (ElevenLabs).
 *
 * ── WHY `intents: []`, AND WHAT THAT COSTS ─────────────────────────────────
 * `SlotIntent` (in `backends/types.ts`) has exactly two audio intents:
 * `video-score` and `text-music`. Neither describes narration, and adding a
 * `text-speech` intent means editing `types.ts`, which is outside this change's
 * scope. Rather than mislabel this backend as a music model — which would let
 * the router hand it a music slot and return speech — it declares NO intents.
 *
 * The consequences, stated honestly rather than buried:
 *   - `routeSlot()` filters candidates by `intents.includes(intent)`, so this
 *     backend is never auto-routed. Correct, and deliberate.
 *   - `POST /api/studio/audio` only accepts `action: "score" | "music"` and
 *     rejects a pinned backend that doesn't declare the matching intent, so
 *     even an explicit `model: "higgsfield-seed-audio"` pin gets a 400 today.
 *     This adapter is therefore UNREACHABLE through any current route.
 *   - Byorn's shipping voiceover path is `/api/tts`, a different provider
 *     entirely; nothing here changes it.
 * Turning this on is a three-line follow-up once someone owns `types.ts`: add
 * `"text-speech"` to `SlotIntent`, list it here, and add a `"speech"` action to
 * the audio route. Until then this is real, complete, inert code — which is
 * exactly the brief.
 *
 * Async job API, same as every other Higgsfield modality: `POST` returns a
 * `request_id`, `GET /requests/{id}/status` resolves it. That direction works
 * end-to-end for audio — `GET /api/studio/audio/[jobId]` already polls async
 * audio jobs and settles the credit hold — so unlike the Higgsfield IMAGE
 * adapters, nothing about this adapter's async shape is a wiring gap.
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import {
	higgsfieldReady,
	pollHiggsfieldJob,
	submitHiggsfieldJob,
} from "@/lib/studio/backends/higgsfield-client";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";

const LABEL = "Higgsfield Seed Audio";
const ENDPOINT_ENV = "HIGGSFIELD_SEED_AUDIO_ENDPOINT";

/**
 * MEASURED 404 — this path does not exist, and neither does its sibling
 * guess. A live probe on 2026-09-19 against `https://api.higgsfield.ai` with
 * an unfunded API key hit BOTH `bytedance/seed-audio/text-to-speech` (this
 * exact constant) and `bytedance/seed-audio/text-to-audio` and got back HTTP
 * 404 `model_not_found` for both — not a validation error, meaning the path
 * itself does not resolve. (For contrast, a path that exists but has an
 * unmet body requirement answers 422 — see `higgsfield-soul.ts`.)
 *
 * The confirmed REST path shape is `/{vendor}/{model}/{tier}/{task?}` — a
 * TIER segment (`standard`, `pro`, `v2/standard`, …), not a task verb — so
 * this constant's `text-to-speech` guess was wrong on shape grounds
 * independent of the model existing at all.
 *
 * Conclusion: Higgsfield's OPEN REST API exposes a SUBSET of the CLI catalog
 * documented in Higgsfield's `MODELS.md`. `seed_audio` appears to be
 * CLI/console-only, with no open REST endpoint. This adapter is kept (not
 * deleted — that is the user's call, tracked as an open decision) purely as a
 * record of what was tried; it stays inert (gated behind {@link ENDPOINT_ENV},
 * unset by default) until Higgsfield adds a REST route for this model or
 * someone confirms a working path by other means.
 *
 * DOUBLY UNREACHABLE even if the endpoint existed: this backend declares
 * `intents: []` (see the file header above), and the one route that could
 * dispatch to it — `POST /api/studio/audio`
 * (`src/app/api/studio/audio/route.ts`) — only accepts
 * `action: "score" | "music"` (verified by reading that route's `AudioAction`
 * union and its `action !== "score" && action !== "music"` 400 check). There
 * is no `"speech"` action, so nothing in the app can currently route a request
 * to this adapter even with a correct endpoint and a pinned backend id.
 */
const ASSUMED_ENDPOINT = "bytedance/seed-audio/text-to-speech";

/**
 * Documented `sample_rate` enum. 24000 is the provider default and the one we
 * send — speech at 24 kHz is the standard tradeoff, and pinning it explicitly
 * keeps the rendered file predictable for the timeline's audio path instead of
 * following a provider default that could move.
 */
const SAMPLE_RATE = 24_000;

/**
 * Documented `format` enum is `wav` | `mp3` | `pcm` | `ogg_opus`, defaulting to
 * `wav`. We ask for `mp3`: the audio route rehosts the result to R2 and stamps
 * `audio/mpeg` on it, and an uncompressed wav of a long narration is a large
 * object to push through that path for no quality the timeline can use.
 */
const FORMAT = "mp3";

/** Words per second used to estimate narration length — see `speechSeconds`. */
const WORDS_PER_SECOND = 150 / 60;

/** Floor/ceiling on the estimate, so a one-word prompt still bills something
 *  finite and a pathological prompt can't estimate an hour of audio. */
const MIN_SPEECH_SEC = 1;
const MAX_SPEECH_SEC = 600;

function configuredEndpoint(): string {
	return webEnv.HIGGSFIELD_SEED_AUDIO_ENDPOINT;
}

/**
 * A voice is optional, but `voice_type` and `voice_id` must be supplied
 * TOGETHER (first-party constraint) — sending one alone is a validation error.
 * `BackendRequest` has no voice field, so the pair comes from env: a
 * project-default narrator, configured once. Returning `undefined` unless BOTH
 * are set is what enforces the constraint; there is no way to half-configure it.
 *
 * Get real values from `higgsfield voices list`. `voice_type` is `preset` (a
 * catalog voice) or `element` (a cloned voice).
 */
function configuredVoice():
	| { voice_type: string; voice_id: string }
	| undefined {
	const voiceType = webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_TYPE.trim();
	const voiceId = webEnv.HIGGSFIELD_SEED_AUDIO_VOICE_ID.trim();
	if (!voiceType || !voiceId) return undefined;
	return { voice_type: voiceType, voice_id: voiceId };
}

/**
 * How many seconds of speech this prompt is worth.
 *
 * TTS length is an OUTPUT, not an input — unlike music or a video clip, the
 * caller cannot ask for "30 seconds" and get it; the script decides. But the
 * credit path needs a finite, non-zero number BEFORE the call (the audio route
 * reserves a hold up front). So: honour an explicit `duration` when the caller
 * supplies one, otherwise estimate from word count at 150 wpm — the standard
 * measured rate for clear narration, and the same figure voiceover scripts are
 * timed against.
 *
 * This is an ESTIMATE and the real file will differ. That is why
 * `resolveDurationSec` is NOT implemented on this backend: that hook means
 * "the exact length I will submit" for backends that SNAP a requested duration
 * to a discrete provider value, and claiming it here would tell the billing
 * path a guess was exact. The residual gap — a long narration billed against a
 * word-count estimate — is a real known imprecision, recorded here rather than
 * hidden.
 */
export function speechSeconds(req: BackendRequest): number {
	if (
		req.duration != null &&
		Number.isFinite(req.duration) &&
		req.duration > 0
	) {
		return Math.min(MAX_SPEECH_SEC, Math.max(MIN_SPEECH_SEC, req.duration));
	}
	const words = req.prompt.trim().split(/\s+/).filter(Boolean).length;
	const seconds = Math.ceil(words / WORDS_PER_SECOND);
	return Math.min(MAX_SPEECH_SEC, Math.max(MIN_SPEECH_SEC, seconds));
}

/**
 * Builds the raw submit body. Isolated to one function so these field names can
 * be corrected in one place once a live account confirms the REST input schema.
 *
 * UNVERIFIED as REST body keys: `prompt`, `format`, `sample_rate`, `voice_id`,
 * `voice_type`. Names taken from the first-party CLI flag table on the
 * assumption flags pass through as snake_case body keys — see
 * `higgsfield-client.ts`'s header.
 *
 * DELIBERATELY OMITTED, each for a reason:
 *   - `speech_rate` / `pitch_rate` / `loudness_rate` — integer deltas whose
 *     documented default is 0 (i.e. "unmodified"). `BackendRequest` has no
 *     field for prosody, and sending 0 explicitly is indistinguishable from
 *     omitting it. Nothing is lost.
 *   - `image_references` / `audio_references` — the two are MUTUALLY EXCLUSIVE
 *     per the first-party constraints, and a voice can be combined with neither
 *     an image reference nor more than 2 audio references. `BackendRequest`'s
 *     `referenceImages` is an image slot with generic semantics; forwarding it
 *     into a speech model would be a guess about intent that could collide with
 *     the configured voice and 422 the whole request. Left out until there is a
 *     caller that actually means it.
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	return {
		prompt: req.prompt,
		format: FORMAT,
		sample_rate: SAMPLE_RATE,
		...(configuredVoice() ?? {}),
	};
}

export const higgsfieldSeedAudioBackend: GenerationBackend = {
	id: "higgsfield-seed-audio",
	label: LABEL,
	vendor: "Higgsfield AI",
	modality: "audio",
	safetyTier: "partner",
	// The voice pair is NOT required — without it the model uses its own default
	// voice, which is a legitimate configuration. Only the credential and the
	// confirmed endpoint path gate availability.
	requiredEnv: ["HIGGSFIELD_CREDENTIALS", ENDPOINT_ENV],
	capabilities: {
		// Advertised as the estimator's clamp range, not a requestable length —
		// see `speechSeconds` for why TTS duration is an output.
		durationRangeSec: { min: MIN_SPEECH_SEC, max: MAX_SPEECH_SEC },
		supportsSeedLock: false,
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: false,
		requiresVideoRef: false,
		// Intentionally empty — narration has no `SlotIntent`. See file header.
		intents: [],
	},

	isAvailable() {
		return higgsfieldReady(configuredEndpoint());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const seconds = speechSeconds(req);
		// Straight from the server-authoritative billing table, so the displayed
		// number is the charged number.
		const credits = costFor("higgsfield-seed-audio", "audio", { seconds });
		return {
			credits,
			basis: `${LABEL} × ~${seconds}s${
				req.duration != null ? "" : " (estimated from script length)"
			}`,
		};
	},

	submit(req: BackendRequest): Promise<SubmitResult> {
		return submitHiggsfieldJob({
			configuredEndpoint: configuredEndpoint(),
			endpointEnvVar: ENDPOINT_ENV,
			assumedEndpoint: ASSUMED_ENDPOINT,
			body: buildSubmitBody(req),
			label: LABEL,
		});
	},

	poll(jobId: string): Promise<PollResult> {
		return pollHiggsfieldJob(jobId, LABEL);
	},
};
