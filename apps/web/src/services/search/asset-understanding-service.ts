/**
 * Asset Understanding orchestrator — the ingest-time pass that turns an imported
 * {@link MediaAsset} into a persisted {@link AssetUnderstanding}.
 *
 * Steps: sample a handful of frames (shot-aware, so a multi-shot source doesn't
 * flood) → hand them to the tool-less VLM call → MEASURE the two facets that
 * call has no evidence for → persist the structured record.
 *
 * That measuring step is load-bearing. The VLM sees 1–8 JPEG stills and no audio
 * bytes, so `motion` and `audio` cannot come from it without being invented; the
 * prompt used to demand both anyway and the Director consumed the results as
 * observed fact. Now `motion` falls out of the luma fingerprints the shot
 * detector already computes ({@link estimateMotion} — no second decode) and
 * `audio` out of the transcript plus the same deterministic loudness curve the
 * silence detector runs ({@link probeAssetAudio}). Either may be legitimately
 * ABSENT; absent is the honest answer and every consumer already degrades on it.
 * This is the RUNTIME half; the pure framing/parsing/belief logic lives in
 * `lib/search/asset-understanding.ts` and the persistence in
 * `asset-understanding-store.ts`.
 *
 * The VLM call is the only network step and it bills the server relay key, so it
 * is INJECTED (default {@link relayUnderstandAsset}) and the auto-run at ingest is
 * gated behind {@link isUnderstandingAutorunEnabled} (env flag, default off) — the
 * pipeline is always callable on demand (e.g. by the Asset Manifest builder), it
 * just doesn't fire a paid call on every import unless asked to.
 *
 * The PRIMARY trigger is demand-driven: `useDirector` runs
 * {@link understandAssetBatch} over the not-yet-understood assets when the user
 * engages the Director (that's the moment the manifest needs grounding). The
 * ingest autorun above is an opt-in PREFETCH on top, capped per tick. Both
 * funnel through {@link understandAssetBatch}, which routes a relay 402 through
 * the client credit gate and stops — being out of credits never blocks import
 * or editing, the manifest just keeps its media-type-count fallback.
 */

import {
	type AssetUnderstanding,
	type AudioProbe,
	classifyAudioEnergy,
	computeLumaGrid,
	configuredUnderstandingModel,
	type DeicticBeat,
	degradedUnderstanding,
	estimateMotion,
	findTranscriptCues,
	type FrameReason,
	isCreditGateError,
	type LumaGrid,
	type MotionClass,
	type PersonaRef,
	chooseUnderstandingFrames,
	selectUnderstandAssetFn,
	type ShotSummary,
	summarizeShots,
	type UnderstandAssetFn,
	type UnderstandingFrame,
} from "@/lib/search/asset-understanding";
import { computeLoudness } from "@/lib/auto-cut";
import { type AssetTranscript, hasSpeech } from "@/lib/search/asset-transcript";
import { getTranscript } from "@/services/search/asset-transcript-store";
import { DECODE_SAMPLE_RATE, decodeToMono16k } from "@/lib/media/decode-audio";
import { gateOn402 } from "@/lib/credits/client-gate";
import { FEATURE_UNDERSTANDING_PASS } from "@/lib/feature-flags";
import {
	getUnderstanding,
	saveUnderstanding,
} from "@/services/search/asset-understanding-store";
import { cacheUnderstanding } from "@/lib/director/understanding-lookup";
import {
	getUserMediaMemory,
	saveUserMediaMemory,
} from "@/services/storage/user-memory-store";
import { computeMediaIdentity } from "@/lib/search/media-identity";
import type { MediaAsset } from "@/types/assets";

/**
 * Version tag for the understanding model/pipeline — bump to invalidate old records.
 *
 * `vlm-v2` retires every `vlm-v1` record: those were produced by a prompt that
 * required the model to emit `motion` and `audio` from frames that showed
 * neither, so each one carries two confidently fabricated fields. They cannot be
 * repaired in place (the values were never grounded in anything), so they are
 * invalidated wholesale and re-derived on demand. Records stored under an
 * explicit `NEXT_PUBLIC_UNDERSTANDING_MODEL` tag are not covered by this bump —
 * `normalizeMotion` at the read boundary collapses their legacy motion
 * vocabulary, and their `audio` is overwritten the next time the asset is
 * understood.
 */
export const UNDERSTANDING_MODEL = "vlm-v2";

/**
 * Resolve the model tag a NEW understanding record is produced and stored
 * under — the ONE place `AssetUnderstanding.modelName` originates:
 * explicit per-call override (tests) → the configured model
 * (`NEXT_PUBLIC_UNDERSTANDING_MODEL`, e.g. `gemini-3.5-flash`) → the default
 * {@link UNDERSTANDING_MODEL} pipeline tag.
 *
 * The stored `modelName` is thus always the ACTUAL model requested, and the
 * `existing.modelName === modelName` checks in {@link understandAsset} (the
 * per-project store and the FLOW E cross-project cache) keep working: flipping
 * the config changes the resolved tag, so records produced under the old model
 * stop short-circuiting and become re-computable.
 */
export function resolveUnderstandingModelName(override?: string): string {
	return override ?? configuredUnderstandingModel() ?? UNDERSTANDING_MODEL;
}

/** Candidate frame cadence (seconds) before shot-aware selection thins it down. */
const CANDIDATE_INTERVAL_SEC = 2;
/** Hard ceiling on candidate frames sampled from any one video. */
const MAX_CANDIDATES = 48;
/** Max frames actually sent to the VLM (one per shot, capped + evenly spread). */
const MAX_VLM_FRAMES = 8;
/** Sampling width in px — small keeps the base64 frames light for the relay. */
const SAMPLE_WIDTH = 384;
/** JPEG quality for the frames sent to the VLM. */
const SAMPLE_QUALITY = 0.6;

/**
 * Whether the ingest hook should auto-run the (paid) understanding pass on
 * import. Requires BOTH the closed-beta master switch
 * (`FEATURE_UNDERSTANDING_PASS` — Understanding is not one of the three
 * Gemini surfaces allowed to spend from the shared beta pool) AND the
 * per-deployment opt-in (`NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1`), so flipping
 * the autorun var alone can never re-enable spend while the beta gate is on.
 */
export function isUnderstandingAutorunEnabled(): boolean {
	return (
		FEATURE_UNDERSTANDING_PASS &&
		process.env.NEXT_PUBLIC_UNDERSTANDING_AUTORUN === "1"
	);
}

interface SampledFrame {
	/** JPEG `data:` URL for the VLM. */
	dataUrl: string;
	/** 8×8 luma fingerprint for shot segmentation. */
	grid: LumaGrid;
	timestampSec: number;
	/** Why this sample exists — the grid cadence, or a pinned transcript cue. */
	reason: FrameReason;
}

/** Draw the current canvas contents into a light JPEG data URL + a luma fingerprint. */
function encodeFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
	const { width, height } = canvas;
	const image = ctx.getImageData(0, 0, width, height);
	const grid = computeLumaGrid({ data: image.data, width, height });
	const dataUrl = canvas.toDataURL("image/jpeg", SAMPLE_QUALITY);
	return { dataUrl, grid };
}

/** Two cue times closer than this are the same moment — keep one seek, not two. */
const CUE_MERGE_EPSILON_SEC = 0.25;

/**
 * Sample candidate frames from a video via the HTML video + canvas approach.
 *
 * `cueTimes` are transcript-cue moments ({@link findTranscriptCues}) merged into
 * the uniform grid as EXTRA seeks. Sampling them here rather than snapping each
 * cue to the nearest grid frame is the point: at a 2 s cadence, snapping lands
 * up to a second off, which is the difference between the gesture and the
 * reveal. A cue within {@link CUE_MERGE_EPSILON_SEC} of a grid sample is dropped
 * — the grid frame already covers that moment and a second seek is the
 * expensive part of this function.
 */
function sampleVideoCandidates(
	url: string,
	cueTimes: readonly number[] = [],
): Promise<SampledFrame[]> {
	return new Promise((resolve, reject) => {
		if (typeof document === "undefined") {
			resolve([]);
			return;
		}
		const video = document.createElement("video");
		video.crossOrigin = "anonymous";
		video.muted = true;
		video.preload = "auto";

		const timeout = setTimeout(() => {
			video.src = "";
			reject(new Error("understanding frame sampling timed out"));
		}, 30_000);

		const frames: SampledFrame[] = [];

		video.onloadedmetadata = () => {
			const duration = video.duration;
			if (!duration || !Number.isFinite(duration)) {
				clearTimeout(timeout);
				reject(new Error("video duration unavailable"));
				return;
			}
			const step = Math.max(CANDIDATE_INTERVAL_SEC, duration / MAX_CANDIDATES);
			const plan: { t: number; reason: FrameReason }[] = [];
			for (let t = step * 0.5; t < duration; t += step) {
				plan.push({ t, reason: "shot" });
				if (plan.length >= MAX_CANDIDATES) break;
			}
			if (plan.length === 0)
				plan.push({ t: Math.min(0.1, duration / 2), reason: "shot" });
			for (const cue of cueTimes) {
				if (!Number.isFinite(cue) || cue < 0 || cue >= duration) continue;
				if (plan.some((q) => Math.abs(q.t - cue) < CUE_MERGE_EPSILON_SEC))
					continue;
				plan.push({ t: cue, reason: "transcript-cue" });
			}
			plan.sort((a, b) => a.t - b.t);
			if (plan.length === 1) plan[0].reason = "only-frame";

			const canvas = document.createElement("canvas");
			const ratio = video.videoHeight / video.videoWidth || 9 / 16;
			canvas.width = SAMPLE_WIDTH;
			canvas.height = Math.round(SAMPLE_WIDTH * ratio);
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				clearTimeout(timeout);
				reject(new Error("canvas 2D context unavailable"));
				return;
			}

			const captureNext = (idx: number) => {
				if (idx >= plan.length) {
					clearTimeout(timeout);
					resolve(frames);
					return;
				}
				video.currentTime = plan[idx].t;
			};

			video.onseeked = () => {
				// One frame is pushed per seek, so the count IS the plan index.
				const idx = frames.length;
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				const { dataUrl, grid } = encodeFrame(canvas, ctx);
				frames.push({
					dataUrl,
					grid,
					timestampSec: video.currentTime,
					reason: plan[idx]?.reason ?? "shot",
				});
				captureNext(frames.length);
			};

			captureNext(0);
		};

		video.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("video element failed to load"));
		};

		video.src = url;
	});
}

/** Sample a single frame from a still image. */
function sampleImageCandidate(url: string): Promise<SampledFrame[]> {
	return new Promise((resolve, reject) => {
		if (typeof document === "undefined") {
			resolve([]);
			return;
		}
		const img = new Image();
		img.crossOrigin = "anonymous";
		const timeout = setTimeout(
			() => reject(new Error("image load timed out")),
			15_000,
		);
		img.onload = () => {
			clearTimeout(timeout);
			const canvas = document.createElement("canvas");
			const ratio = img.height / img.width || 1;
			canvas.width = SAMPLE_WIDTH;
			canvas.height = Math.round(SAMPLE_WIDTH * ratio);
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("canvas 2D context unavailable"));
				return;
			}
			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
			const { dataUrl, grid } = encodeFrame(canvas, ctx);
			resolve([{ dataUrl, grid, timestampSec: 0, reason: "only-frame" }]);
		};
		img.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("image failed to load"));
		};
		img.src = url;
	});
}

/** What one sampling pass yields: the frames to caption, plus what they measure. */
export interface UnderstandingFrameSelection {
	/** Representative frames as `data:` URLs, in time order — the model's input. */
	frames: string[];
	/**
	 * Camera motion measured from the FULL uniform candidate set (not the thinned
	 * representatives — the dense fingerprints are the evidence). `null` when the
	 * samples can't support a verdict; see {@link estimateMotion}.
	 */
	motion: MotionClass | null;
	/**
	 * Time + reason for each frame in {@link frames}, same order — the provenance
	 * that makes an `anchorFrame` index resolvable to a timestamp.
	 */
	framesSeen: UnderstandingFrame[];
	/** Shot structure measured from the uniform candidates. `null` ⇒ under two samples. */
	shots: ShotSummary | null;
	/**
	 * Deictic cues read from the transcript. `null` ⇒ no transcript was supplied,
	 * which is NOT the same as `[]` ("read it, found none") — the record keeps
	 * that distinction so a later re-run after transcription is worth doing.
	 */
	cues: DeicticBeat[] | null;
}

/**
 * Nothing sampled — every field at its honest empty value. A factory, not a
 * shared constant: the arrays are handed to callers and a single frozen-by-
 * convention instance would be one `push` away from leaking between assets.
 */
function emptySelection(): UnderstandingFrameSelection {
	return { frames: [], motion: null, framesSeen: [], shots: null, cues: null };
}

/** Options for {@link selectUnderstandingFrames}. */
export interface SelectFramesOptions {
	/**
	 * The asset's transcript, when one exists. Drives transcript-cue frames —
	 * frames pinned where the SPEAKER points at something, which the visual
	 * selector systematically misses (see {@link DeicticBeat}).
	 *
	 * The transcript is used for SELECTION ONLY and is never shown to the model.
	 * Handing it the words would reintroduce exactly the failure the
	 * confabulation fix removed: a model that reads "as you can see, the logo is
	 * blue" will report a blue logo whether or not the pixels show one.
	 */
	transcript?: AssetTranscript | null;
}

/**
 * Sample an asset once and take everything the pass needs from that sampling:
 * the frames to caption (transcript cues pinned first, then one representative
 * per detected shot, capped at {@link MAX_VLM_FRAMES}), the measured
 * {@link MotionClass}, the {@link ShotSummary}, and the cues themselves.
 *
 * The motion and shot measurements reuse the luma fingerprints `encodeFrame`
 * already computes — decoding the video a second time to answer "did the camera
 * move?" would cost more than the model call it replaces.
 *
 * MEASUREMENTS READ THE UNIFORM GRID ONLY. A pinned cue frame lands at an
 * arbitrary second, so letting it into {@link estimateMotion} or
 * {@link summarizeShots} would make an irregular sampling interval look like
 * camera movement or an extra cut — the cue frames are for the model's eyes,
 * not for the measurements, and keeping them out means adding cues cannot move
 * a `motion` or `shots` value that was already correct.
 */
export async function selectUnderstandingFrames(
	media: MediaAsset,
	opts?: SelectFramesOptions,
): Promise<UnderstandingFrameSelection> {
	if (!media.url) return emptySelection();

	const transcript = opts?.transcript;
	const cues = transcript
		? findTranscriptCues(transcript.segments, {
				durationSec: transcript.durationSec,
			})
		: null;

	const candidates =
		media.type === "video"
			? await sampleVideoCandidates(media.url, cues?.map((c) => c.t) ?? [])
			: media.type === "image"
				? await sampleImageCandidate(media.url)
				: [];
	if (candidates.length === 0) return emptySelection();

	const uniform = candidates.filter((c) => c.reason !== "transcript-cue");
	const motion = estimateMotion(uniform);
	const shots = summarizeShots(uniform);

	const describe = (picked: SampledFrame[]): UnderstandingFrameSelection => ({
		frames: picked.map((f) => f.dataUrl),
		motion,
		framesSeen: picked.map((f) => ({
			t: Math.round(f.timestampSec * 100) / 100,
			reason: f.reason,
		})),
		shots,
		cues,
	});

	// Which frames the model sees — cues pinned, the rest to shot coverage. The
	// rule itself is pure and tested in `lib/search/asset-understanding`.
	const picked = chooseUnderstandingFrames(candidates, MAX_VLM_FRAMES);
	return describe(picked.map((i) => candidates[i]));
}

/**
 * Just the frames from {@link selectUnderstandingFrames}, for callers that don't
 * need the measurements.
 */
export async function sampleUnderstandingFrames(
	media: MediaAsset,
	opts?: SelectFramesOptions,
): Promise<string[]> {
	return (await selectUnderstandingFrames(media, opts)).frames;
}

/** Longest asset the measured audio probe will decode — past this the decode costs more than the field is worth. */
const AUDIO_PROBE_MAX_DURATION_SEC = 20 * 60;

/** Analysis chunks per second for the loudness curve (the auto-cut engine's default timebase). */
const AUDIO_PROBE_TIMEBASE = 30;

/** Injectable seams for {@link probeAssetAudio} (tests stub both; production uses the real stores). */
export interface AudioProbeDeps {
	/** Decode a media file to mono 16 kHz PCM (default: the shared Whisper/auto-cut decode). */
	decode?: (file: File) => Promise<Float32Array>;
	/** Read the stored transcript for an asset (default: the transcript store). */
	transcript?: (mediaId: string) => Promise<AssetTranscript | undefined>;
}

/**
 * MEASURE an asset's {@link AudioProbe} from its real audio — the replacement
 * for asking a model that was never sent any.
 *
 * `hasSpeech` comes from the stored transcript, which answers it definitively;
 * no transcript yet ⇒ the field is ABSENT, which is a different claim from
 * `false` ("transcribed, and silent") and is the distinction the story
 * inventory already relies on. `energy` comes from `computeLoudness` — the same
 * per-chunk curve the silence detector runs — banded by
 * {@link classifyAudioEnergy}.
 *
 * Everything here is best-effort and silent: no audio track, no `file` on the
 * asset (a URL-only generated clip), an over-long asset, or a decode failure all
 * just drop `energy`. Returns `undefined` when neither field could be measured,
 * so the caller omits `audio` entirely rather than persisting an empty shell.
 */
export async function probeAssetAudio(
	media: MediaAsset,
	deps?: AudioProbeDeps,
): Promise<AudioProbe | undefined> {
	const readTranscript = deps?.transcript ?? getTranscript;
	const decode = deps?.decode ?? decodeToMono16k;

	const transcript = await readTranscript(media.id).catch(() => undefined);
	const speech = transcript ? hasSpeech(transcript) : undefined;

	const energy = await measureAudioEnergy(media, decode);

	if (speech === undefined && !energy) return undefined;
	return {
		...(speech !== undefined ? { hasSpeech: speech } : {}),
		...(energy ? { energy } : {}),
	};
}

/** The `energy` half of {@link probeAssetAudio} — decode, loudness curve, band. Never throws. */
async function measureAudioEnergy(
	media: MediaAsset,
	decode: (file: File) => Promise<Float32Array>,
): Promise<AudioProbe["energy"]> {
	// Images have no audio track; a URL-only asset has no bytes to decode here.
	if (media.type === "image" || !media.file) return undefined;
	if (media.duration != null && media.duration > AUDIO_PROBE_MAX_DURATION_SEC)
		return undefined;
	try {
		const samples = await decode(media.file);
		const levels = computeLoudness(
			samples,
			DECODE_SAMPLE_RATE,
			AUDIO_PROBE_TIMEBASE,
		);
		return classifyAudioEnergy(levels) ?? undefined;
	} catch {
		// A file with no decodable audio track is the common case here, not an
		// error worth surfacing — the probe simply has nothing to report.
		return undefined;
	}
}

export interface UnderstandAssetOptions {
	/** Persona roster to reconcile faces against (default: none). */
	personas?: PersonaRef[];
	/**
	 * The VLM call (default: {@link selectUnderstandAssetFn} on the resolved
	 * model — the Director relay, or the native Gemini relay for `gemini-*`);
	 * tests inject a stub.
	 */
	understand?: UnderstandAssetFn;
	/**
	 * Model/pipeline tag stored on the record (default
	 * {@link resolveUnderstandingModelName}: the configured
	 * `NEXT_PUBLIC_UNDERSTANDING_MODEL`, else {@link UNDERSTANDING_MODEL}).
	 * Also drives which default seam runs when `understand` is not injected.
	 */
	modelName?: string;
	/** Free-text hint about what the user is doing (passed to the VLM). */
	hint?: string;
	/**
	 * The measured audio probe (default: {@link probeAssetAudio} — the transcript
	 * plus a real loudness curve). Injected so headless tests don't need Web
	 * Audio; return `undefined` to leave `audio` off the record.
	 */
	audio?: (media: MediaAsset) => Promise<AudioProbe | undefined>;
	/**
	 * Loads the asset's transcript, which drives transcript-cue frames (default:
	 * the per-asset transcript store). Injected so headless tests don't need
	 * IndexedDB; resolve `undefined` to select frames visually, as before.
	 *
	 * A transcript is OPTIONAL and often absent: transcription is its own pass
	 * and may not have run yet at ingest. That case is recorded honestly —
	 * `deicticBeats` stays absent rather than empty — so a later re-run knows
	 * there is something new to find.
	 */
	transcript?: (mediaId: string) => Promise<AssetTranscript | undefined>;
	/** Re-run even if a record already exists for the current model. */
	force?: boolean;
	/**
	 * FLOW E cross-project reuse (all optional; production defaults touch the
	 * user-media memory store, tests inject stubs). When these resolve a cached
	 * understanding for the SAME media (by stable content identity) the paid VLM
	 * pass is skipped; a freshly-produced understanding is written back for the
	 * NEXT project. Pass `crossProject: false` to disable reuse entirely.
	 */
	crossProject?:
		| false
		| {
				/** Stable content identity for `media` (default: hash `media.file`). */
				identify?: (media: MediaAsset) => Promise<string | undefined>;
				/** Look up a cached understanding by content identity. */
				lookup?: (
					contentHash: string,
				) => Promise<AssetUnderstanding | undefined>;
				/** Persist a produced understanding for future projects. */
				save?: (
					contentHash: string,
					understanding: AssetUnderstanding,
					name?: string,
				) => Promise<void>;
		  };
}

/** Default content identity: a content hash of the asset's bytes (falls back to a signature). */
async function defaultIdentify(media: MediaAsset): Promise<string | undefined> {
	if (!media.file) return undefined;
	return computeMediaIdentity(media.file);
}

/** Default cross-project lookup — the user-media memory, unwrapped to the understanding. */
async function defaultReuseLookup(
	contentHash: string,
): Promise<AssetUnderstanding | undefined> {
	return (await getUserMediaMemory(contentHash))?.understanding;
}

/** Default cross-project save — the user-media memory. */
async function defaultReuseSave(
	contentHash: string,
	understanding: AssetUnderstanding,
	name?: string,
): Promise<void> {
	await saveUserMediaMemory(contentHash, understanding, { name });
}

/** A produced understanding worth caching cross-project — a degraded "nothing usable" record is not. */
function isWorthCaching(u: AssetUnderstanding): boolean {
	return (
		u.roleConfidence > 0 || u.tags.length > 0 || u.caption.trim().length > 0
	);
}

/**
 * Understand ONE media asset and persist the record. Returns the understanding,
 * or `null` when the asset can't be understood (no visual frames, or the VLM
 * relay errored — a transient network failure is NOT persisted, so a later retry
 * can still succeed). A successful relay that yields an unusable reply DOES
 * persist a degraded record (`b-roll` @ 0) — that's a real "nothing usable here"
 * answer, not a transport failure.
 */
export async function understandAsset(
	media: MediaAsset,
	options?: UnderstandAssetOptions,
): Promise<AssetUnderstanding | null> {
	const modelName = resolveUnderstandingModelName(options?.modelName);
	// The seam follows the resolved model: `gemini-*` runs on the native Gemini
	// relay, everything else on the Director relay (an injected stub wins).
	const understand = options?.understand ?? selectUnderstandAssetFn(modelName);
	const personas = options?.personas ?? [];

	if (!options?.force) {
		const existing = await getUnderstanding(media.id).catch(() => undefined);
		if (existing && existing.modelName === modelName) return existing;
	}

	if (!media.url || (media.type !== "video" && media.type !== "image")) {
		return null; // audio / URL-less assets have no visual signal to understand.
	}

	// FLOW E — cross-project reuse. Resolve a STABLE content identity for the asset;
	// if a prior project already understood the same media (same content) with the
	// current model, re-key that record to this asset and skip the paid VLM pass.
	const reuse = options?.crossProject;
	const reuseEnabled = reuse !== false;
	const reuseCfg = reuse === false ? undefined : reuse;
	const identify = reuseCfg?.identify ?? defaultIdentify;
	const reuseLookup = reuseCfg?.lookup ?? defaultReuseLookup;
	const reuseSave = reuseCfg?.save ?? defaultReuseSave;
	let contentHash: string | undefined;
	if (reuseEnabled && !options?.force) {
		contentHash = await identify(media).catch(() => undefined);
		if (contentHash) {
			const cached = await reuseLookup(contentHash).catch(() => undefined);
			if (cached && cached.modelName === modelName) {
				// Persona ids on faces are user-scoped (stable across projects), so the
				// only stale field is the mediaId — re-key it to this asset and persist
				// into the per-project store so downstream consumers find it.
				const rekeyed: AssetUnderstanding = { ...cached, mediaId: media.id };
				await saveUnderstanding(rekeyed).catch(() => undefined);
				// Refresh the live sync cache the manifest/proposals read each turn, so
				// a reused understanding shows up without a reload (Flow-D follow-up A).
				cacheUnderstanding(rekeyed);
				return rekeyed;
			}
		}
	}

	// Start the audio measurement NOW so its decode overlaps the (much slower)
	// frame sampling + model call instead of adding latency after them. The
	// `catch` is what makes that safe: every path below can return early and
	// abandon this promise un-awaited, and a settled-to-undefined promise can't
	// surface as an unhandled rejection when it does.
	const probe = options?.audio ?? probeAssetAudio;
	const audioProbe = Promise.resolve()
		.then(() => probe(media))
		.catch(() => undefined);

	// Transcript cues only steer WHICH frames get sampled, so a lookup failure
	// degrades to the old purely-visual selection rather than failing the pass.
	const loadTranscript = options?.transcript ?? getTranscript;
	const transcript =
		media.type === "video"
			? await loadTranscript(media.id).catch(() => undefined)
			: undefined; // a still image has no speech to cue off.

	let selection: UnderstandingFrameSelection;
	try {
		selection = await selectUnderstandingFrames(media, { transcript });
	} catch {
		return null; // sampling failure — leave the asset un-understood for a retry.
	}
	const frames = selection.frames;
	if (frames.length === 0) return null;

	let record: AssetUnderstanding;
	try {
		record = await understand(frames, {
			mediaId: media.id,
			personas,
			modelName,
			hint: options?.hint,
		});
	} catch (err) {
		// Insufficient credits (402) is POLICY, not transport: rethrow so the
		// batch runner can open the out-of-credits gate and stop instead of
		// silently burning through the rest of the queue.
		if (isCreditGateError(err)) throw err;
		// Transport error against the paid relay — don't poison the store; a later
		// retry (or on-demand call) can still produce a real understanding.
		return null;
	}

	// Belt-and-suspenders: never persist a record keyed to the wrong asset.
	const parsed: AssetUnderstanding =
		record.mediaId === media.id
			? record
			: degradedUnderstanding({ mediaId: media.id, modelName });

	// Merge the MEASURED facets over whatever came back. These two are sourced,
	// not asked for: the model is told not to report them and the parser drops
	// them if it does, so this is the only place either can enter a record. An
	// unmeasurable facet stays absent — we never fill it with a default.
	const measuredAudio = await audioProbe;
	const safe: AssetUnderstanding = {
		...parsed,
		...(selection.motion ? { motion: selection.motion } : {}),
		...(measuredAudio ? { audio: measuredAudio } : {}),
		...(selection.framesSeen.length
			? { framesSeen: selection.framesSeen }
			: {}),
		...(selection.shots ? { shots: selection.shots } : {}),
		...(selection.cues ? { deicticBeats: selection.cues } : {}),
	};
	await saveUnderstanding(safe).catch(() => undefined);
	// Refresh the live sync cache the manifest/proposals read each turn, so a
	// freshly-understood asset shows up in the digest without a reload (follow-up A).
	cacheUnderstanding(safe);

	// FLOW E — cache a real understanding under its content identity so the NEXT
	// project that references the same media reuses it (skips the paid pass). A
	// degraded "nothing usable" record is not cached, so a retry elsewhere can try
	// again.
	if (reuseEnabled && isWorthCaching(safe)) {
		if (!contentHash)
			contentHash = await identify(media).catch(() => undefined);
		if (contentHash) {
			await reuseSave(contentHash, safe, media.name).catch(() => undefined);
		}
	}

	return safe;
}

/**
 * Assets an `understandAssetBatch` is CURRENTLY processing, across every batch
 * on the page. Both understanding triggers (the demand-driven Director batch
 * and the import-time autorun) can run at once, and `understandAsset`'s store
 * de-dupe only protects against re-billing AFTER a record is persisted — two
 * concurrent calls on the same asset would both pass the check and both bill.
 * This set closes that window: a batch skips (doesn't fail) an asset another
 * batch already has inflight.
 */
const inflightBatchIds = new Set<string>();

export interface UnderstandBatchSummary {
	/** Assets this run attempted (excludes inflight-elsewhere skips and a gated tail). */
	processed: number;
	/** Attempts that yielded a persisted understanding record. */
	understood: number;
	/** True when the run stopped early on the 402 credit gate. */
	gated: boolean;
}

/**
 * Understand many assets sequentially. Sequential on purpose: the VLM relay is
 * rate-limited per account and the user is editing — we don't want to burst it.
 *
 * This is the ONE seam where the paid understanding pass meets the credit
 * system: a relay 402 is routed through `gateOn402` (opens the "Out of
 * credits" modal, same as every other paid verb) and the batch stops
 * gracefully — assets already understood keep their records, the rest stay
 * eligible for a later run, and import/editing is never blocked.
 */
export async function understandAssetBatch(
	mediaList: MediaAsset[],
	options?: UnderstandAssetOptions & {
		/** Per-asset progress callback (record is null when the asset failed/skipped). */
		onAssetComplete?: (
			mediaId: string,
			record: AssetUnderstanding | null,
		) => void;
		/** Checked before each asset — return false to stop (e.g. hook unmounted). */
		shouldContinue?: () => boolean;
		/** The 402 handler (default {@link gateOn402}); tests inject a stub. */
		gate?: (res: Response) => Promise<boolean>;
		/** The per-asset pass (default {@link understandAsset}); tests inject a stub. */
		understandOne?: typeof understandAsset;
	},
): Promise<UnderstandBatchSummary> {
	const gate = options?.gate ?? gateOn402;
	const understandOne = options?.understandOne ?? understandAsset;
	const summary: UnderstandBatchSummary = {
		processed: 0,
		understood: 0,
		gated: false,
	};
	for (const media of mediaList) {
		if (options?.shouldContinue && !options.shouldContinue()) break;
		if (inflightBatchIds.has(media.id)) continue; // another batch owns it
		inflightBatchIds.add(media.id);
		try {
			const record = await understandOne(media, options);
			summary.processed += 1;
			if (record) summary.understood += 1;
			options?.onAssetComplete?.(media.id, record);
		} catch (err) {
			summary.processed += 1;
			options?.onAssetComplete?.(media.id, null);
			if (isCreditGateError(err)) {
				// Out of credits: surface the modal once and stop the whole batch —
				// every remaining asset would hit the same wall.
				summary.gated = true;
				await gate(err.response).catch(() => undefined);
				break;
			}
			// Anything else is a per-asset failure; keep going.
			console.warn(`[asset-understanding] failed for ${media.id}:`, err);
		} finally {
			inflightBatchIds.delete(media.id);
		}
	}
	return summary;
}
