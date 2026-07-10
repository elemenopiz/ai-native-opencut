/**
 * Asset Understanding orchestrator — the ingest-time pass that turns an imported
 * {@link MediaAsset} into a persisted {@link AssetUnderstanding}.
 *
 * Steps: sample a handful of frames (shot-aware, so a multi-shot source doesn't
 * flood) → hand them to the tool-less VLM call → persist the structured record.
 * This is the RUNTIME half; the pure framing/parsing/belief logic lives in
 * `lib/search/asset-understanding.ts` and the persistence in
 * `asset-understanding-store.ts`.
 *
 * The VLM call is the only network step and it bills the server relay key, so it
 * is INJECTED (default {@link relayUnderstandAsset}) and the auto-run at ingest is
 * gated behind {@link isUnderstandingAutorunEnabled} (env flag, default off) — the
 * pipeline is always callable on demand (e.g. by the Asset Manifest builder), it
 * just doesn't fire a paid call on every import unless asked to.
 */

import {
	type AssetUnderstanding,
	computeLumaGrid,
	degradedUnderstanding,
	type LumaGrid,
	type PersonaRef,
	pickShotRepresentatives,
	relayUnderstandAsset,
	segmentShots,
	type UnderstandAssetFn,
} from "@/lib/search/asset-understanding";
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

/** Version tag for the understanding model/pipeline — bump to invalidate old records. */
export const UNDERSTANDING_MODEL = "vlm-v1";

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

/** Whether the ingest hook should auto-run the (paid) understanding pass on import. */
export function isUnderstandingAutorunEnabled(): boolean {
	return process.env.NEXT_PUBLIC_UNDERSTANDING_AUTORUN === "1";
}

interface SampledFrame {
	/** JPEG `data:` URL for the VLM. */
	dataUrl: string;
	/** 8×8 luma fingerprint for shot segmentation. */
	grid: LumaGrid;
	timestampSec: number;
}

/** Draw the current canvas contents into a light JPEG data URL + a luma fingerprint. */
function encodeFrame(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
	const { width, height } = canvas;
	const image = ctx.getImageData(0, 0, width, height);
	const grid = computeLumaGrid({ data: image.data, width, height });
	const dataUrl = canvas.toDataURL("image/jpeg", SAMPLE_QUALITY);
	return { dataUrl, grid };
}

/** Sample candidate frames from a video via the HTML video + canvas approach. */
function sampleVideoCandidates(url: string): Promise<SampledFrame[]> {
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
			const timestamps: number[] = [];
			for (let t = step * 0.5; t < duration; t += step) {
				timestamps.push(t);
				if (timestamps.length >= MAX_CANDIDATES) break;
			}
			if (timestamps.length === 0) timestamps.push(Math.min(0.1, duration / 2));

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
				if (idx >= timestamps.length) {
					clearTimeout(timeout);
					resolve(frames);
					return;
				}
				video.currentTime = timestamps[idx];
			};

			video.onseeked = () => {
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				const { dataUrl, grid } = encodeFrame(canvas, ctx);
				frames.push({ dataUrl, grid, timestampSec: video.currentTime });
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
			resolve([{ dataUrl, grid, timestampSec: 0 }]);
		};
		img.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("image failed to load"));
		};
		img.src = url;
	});
}

/**
 * Sample the frames to caption: candidate frames, thinned to one representative
 * per detected shot (capped at {@link MAX_VLM_FRAMES}). Returns the frames as
 * `data:` URLs in time order.
 */
export async function sampleUnderstandingFrames(
	media: MediaAsset,
): Promise<string[]> {
	if (!media.url) return [];
	const candidates =
		media.type === "video"
			? await sampleVideoCandidates(media.url)
			: media.type === "image"
				? await sampleImageCandidate(media.url)
				: [];
	if (candidates.length === 0) return [];
	if (candidates.length === 1) return [candidates[0].dataUrl];

	const shots = segmentShots(candidates.map((c) => c.grid));
	const repIndices = pickShotRepresentatives(shots, MAX_VLM_FRAMES);
	return repIndices.map((i) => candidates[i].dataUrl);
}

export interface UnderstandAssetOptions {
	/** Persona roster to reconcile faces against (default: none). */
	personas?: PersonaRef[];
	/** The VLM call (default {@link relayUnderstandAsset}); tests inject a stub. */
	understand?: UnderstandAssetFn;
	/** Model/pipeline tag stored on the record (default {@link UNDERSTANDING_MODEL}). */
	modelName?: string;
	/** Free-text hint about what the user is doing (passed to the VLM). */
	hint?: string;
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
	const modelName = options?.modelName ?? UNDERSTANDING_MODEL;
	const understand = options?.understand ?? relayUnderstandAsset;
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

	let frames: string[];
	try {
		frames = await sampleUnderstandingFrames(media);
	} catch {
		return null; // sampling failure — leave the asset un-understood for a retry.
	}
	if (frames.length === 0) return null;

	let record: AssetUnderstanding;
	try {
		record = await understand(frames, {
			mediaId: media.id,
			personas,
			modelName,
			hint: options?.hint,
		});
	} catch {
		// Transport error against the paid relay — don't poison the store; a later
		// retry (or on-demand call) can still produce a real understanding.
		return null;
	}

	// Belt-and-suspenders: never persist a record keyed to the wrong asset.
	const safe: AssetUnderstanding =
		record.mediaId === media.id
			? record
			: degradedUnderstanding({ mediaId: media.id, modelName });
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
 * Understand many assets sequentially. Sequential on purpose: the VLM relay is
 * rate-limited per account and the user is editing — we don't want to burst it.
 */
export async function understandAssetBatch(
	mediaList: MediaAsset[],
	options?: UnderstandAssetOptions & {
		onAssetComplete?: (
			mediaId: string,
			record: AssetUnderstanding | null,
		) => void;
	},
): Promise<void> {
	for (const media of mediaList) {
		const record = await understandAsset(media, options).catch(() => null);
		options?.onAssetComplete?.(media.id, record);
	}
}
