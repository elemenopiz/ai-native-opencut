/**
 * Last-frame extractor — grab the final frame of a completed take's video as an
 * image data URL, so a remix can anchor on the REAL last frame instead of only
 * the prior spec's `referenceImageUrl`. This is the "grab last frame from a
 * completed take" utility that `lib/studio/remix.ts` flags it needs to unblock
 * true img2img remix and first-last-frame (flf2v) mode.
 *
 * Reuses the existing mediabunny decode path — `getVideoInfo` (duration) plus
 * `generateThumbnail` (decode one frame → data URL) from `./processing` — so it
 * adds NO new decode dependency. Remote provider URLs are routed through the
 * same-origin `/api/studio/proxy` that `importVideoAsset` uses to dodge provider
 * CORS; in-memory Files and local (blob:/data:/same-origin) URLs decode directly.
 */

import { getVideoInfo } from "./mediabunny";
import { generateThumbnail, generateThumbnails } from "./processing";

/**
 * The reported duration can sit a hair past the last decodable sample's
 * timestamp, so we sample slightly before the end to reliably land on the final
 * frame rather than falling off the end of the track.
 */
export const LAST_FRAME_EPSILON_S = 0.05;

/**
 * Timestamp (seconds) to sample for "the last frame" of a clip of the given
 * duration. Pure; clamps to 0 for tiny/zero-length/invalid durations.
 */
export function lastFrameTimestamp(
	durationSeconds: number,
	epsilon = LAST_FRAME_EPSILON_S,
): number {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
	return Math.max(0, durationSeconds - epsilon);
}

/** The most frames a single review samples — a first/mid/last triptych. */
export const MAX_REVIEW_FRAMES = 3;

/**
 * Timestamps (seconds, ascending) to sample for a "review" of a clip — up to
 * `count` frames spread first → mid → last so the model can judge how a shot
 * OPENS, HOLDS, and RESOLVES, not just its final frame. Pure and cheap (it only
 * picks sample points; decoding happens in {@link extractFrames}).
 *
 *  - count 1 → just the last frame (matches {@link lastFrameTimestamp}).
 *  - count 2 → first + last.
 *  - count 3 → first + midpoint + last.
 *
 * `count` is clamped to 1..{@link MAX_REVIEW_FRAMES}. On tiny/zero/invalid
 * durations the samples collapse toward 0; timestamps within `epsilon` of each
 * other are de-duplicated so a very short clip doesn't decode the same frame
 * three times.
 */
export function reviewFrameTimestamps(
	durationSeconds: number,
	count = MAX_REVIEW_FRAMES,
	epsilon = LAST_FRAME_EPSILON_S,
): number[] {
	const last = lastFrameTimestamp(durationSeconds, epsilon);
	const n = Math.max(1, Math.min(MAX_REVIEW_FRAMES, Math.floor(count) || 1));
	if (last <= 0 || n === 1) return [last];
	const raw = n === 2 ? [0, last] : [0, last / 2, last];
	const out: number[] = [];
	for (const t of raw) {
		if (!out.some((u) => Math.abs(u - t) < epsilon)) out.push(t);
	}
	return out;
}

/**
 * Resolve the URL to actually fetch a take's video from. Remote (cross-origin
 * http/https) URLs are routed through the same-origin `/api/studio/proxy` to
 * dodge provider CORS; same-origin / `blob:` / `data:` URLs are fetched
 * directly. Pure given `origin` (pass `window.location.origin` at call sites).
 */
export function videoFetchUrl(videoUrl: string, origin: string): string {
	const isHttp = /^https?:\/\//i.test(videoUrl);
	const sameOrigin = origin ? videoUrl.startsWith(origin) : false;
	if (isHttp && !sameOrigin) {
		return `/api/studio/proxy?url=${encodeURIComponent(videoUrl)}`;
	}
	return videoUrl;
}

/** Fetch a take's video URL into a File, proxying remote URLs for CORS. */
export async function fetchVideoAsFile(
	videoUrl: string,
	name = "take",
): Promise<File> {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	const res = await fetch(videoFetchUrl(videoUrl, origin));
	if (!res.ok) throw new Error(`fetch failed ${res.status}`);
	const blob = await res.blob();
	const type = blob.type.startsWith("video/") ? blob.type : "video/mp4";
	const fileName = name.toLowerCase().endsWith(".mp4") ? name : `${name}.mp4`;
	return new File([blob], fileName, { type });
}

export interface LastFrameSource {
	/** In-memory video File (e.g. a completed take's imported `MediaAsset.file`). */
	videoFile?: File;
	/** Remote or local video URL; fetched (via proxy if cross-origin) when no File. */
	videoUrl?: string;
	/** Name for the fetched File (diagnostics only). */
	name?: string;
}

/**
 * Decode the final frame of a completed take's video to an image data URL.
 * Returns `undefined` (never throws) when the frame can't be produced, so remix
 * callers can transparently fall back to the prior spec's `referenceImageUrl`.
 */
export async function extractLastFrame(
	source: LastFrameSource,
): Promise<string | undefined> {
	try {
		const file =
			source.videoFile ??
			(source.videoUrl
				? await fetchVideoAsFile(source.videoUrl, source.name)
				: undefined);
		if (!file) return undefined;
		const { duration } = await getVideoInfo({ videoFile: file });
		return await generateThumbnail({
			videoFile: file,
			timeInSeconds: lastFrameTimestamp(duration),
		});
	} catch (error) {
		console.warn("extractLastFrame failed", error);
		return undefined;
	}
}

/**
 * Convenience over `extractLastFrame` for a resolved media asset (structurally
 * typed so this module stays free of the editor/store types). Prefers the
 * in-memory `file` (no fetch/CORS) and falls back to `url`. Non-video or missing
 * assets resolve to `undefined`, letting the remix fall back to its reference
 * still.
 */
export async function extractTakeLastFrame(
	asset: { type?: string; file?: File; url?: string } | undefined,
	name?: string,
): Promise<string | undefined> {
	if (asset?.type !== "video") return undefined;
	if (asset.file) return extractLastFrame({ videoFile: asset.file, name });
	if (asset.url) return extractLastFrame({ videoUrl: asset.url, name });
	return undefined;
}

/** Resolve a {@link LastFrameSource} to a decodable `File` (proxying remote URLs). */
async function resolveSourceFile(
	source: LastFrameSource,
): Promise<File | undefined> {
	if (source.videoFile) return source.videoFile;
	if (source.videoUrl) return fetchVideoAsFile(source.videoUrl, source.name);
	return undefined;
}

/**
 * Decode up to `count` frames (first/mid/last — see {@link reviewFrameTimestamps})
 * of a completed take's video to image data URLs, for a VISION review of the
 * shot. Decodes the file ONCE — all requested timestamps are sampled from a
 * single open decoder via {@link generateThumbnails} (mediabunny's
 * `samplesAtTimestamps`), rather than re-parsing the whole video per frame.
 * Never throws: timestamps that fall outside the track are skipped, and a total
 * decode failure resolves to `[]` so a caller can fall back to text-only review.
 */
export async function extractFrames(
	source: LastFrameSource,
	count = MAX_REVIEW_FRAMES,
): Promise<string[]> {
	try {
		const file = await resolveSourceFile(source);
		if (!file) return [];
		const { duration } = await getVideoInfo({ videoFile: file });
		return await generateThumbnails({
			videoFile: file,
			timesInSeconds: reviewFrameTimestamps(duration, count),
		});
	} catch (error) {
		console.warn("extractFrames failed", error);
		return [];
	}
}

/**
 * Convenience over {@link extractFrames} for a resolved media asset (structurally
 * typed so this module stays free of the editor/store types). Mirrors
 * {@link extractTakeLastFrame}: prefers the in-memory `file`, falls back to
 * `url`, and returns `[]` for non-video / missing assets.
 */
export async function extractTakeFrames(
	asset: { type?: string; file?: File; url?: string } | undefined,
	opts: { count?: number; name?: string } = {},
): Promise<string[]> {
	if (asset?.type !== "video") return [];
	const count = opts.count ?? MAX_REVIEW_FRAMES;
	if (asset.file)
		return extractFrames({ videoFile: asset.file, name: opts.name }, count);
	if (asset.url)
		return extractFrames({ videoUrl: asset.url, name: opts.name }, count);
	return [];
}

/** A single frame decoded at the source's native resolution, plus its size. */
export interface FullFrame {
	/** Lossless PNG data URL of the frame at NATIVE resolution (no 720p clamp). */
	dataUrl: string;
	/** Native pixel dimensions of the decoded frame. */
	width: number;
	height: number;
}

/**
 * Decode ONE frame at an arbitrary SOURCE-media `timeSec` at the video's NATIVE
 * resolution (no thumbnail clamp), returning the PNG data URL plus the frame's
 * pixel dimensions. This is the extraction primitive behind the "Extract frame"
 * UI and the Director `extractFrame` verb: unlike {@link extractLastFrame} it
 * samples any time (first / last / playhead), keeps full resolution so the frame
 * is fit to seed a new generation, and reports dimensions so the resulting image
 * asset carries correct width/height. Never throws — returns `undefined` when
 * the frame can't be produced (non-decodable, time out of range, missing source).
 */
export async function extractFrameFull(
	source: LastFrameSource,
	timeSec: number,
): Promise<FullFrame | undefined> {
	try {
		const file = await resolveSourceFile(source);
		if (!file) return undefined;
		const info = await getVideoInfo({ videoFile: file });
		const clampedTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
		const dataUrl = await generateThumbnail({
			videoFile: file,
			timeInSeconds: clampedTime,
			fullResolution: true,
		});
		return { dataUrl, width: info.width, height: info.height };
	} catch (error) {
		console.warn("extractFrameFull failed", error);
		return undefined;
	}
}

/**
 * Convenience over {@link extractFrameFull} for a resolved media asset
 * (structurally typed so this module stays free of editor/store types). Prefers
 * the in-memory `file`, falls back to `url`, and returns `undefined` for
 * non-video / missing assets.
 */
export async function extractTakeFrameFull(
	asset: { type?: string; file?: File; url?: string } | undefined,
	timeSec: number,
	name?: string,
): Promise<FullFrame | undefined> {
	if (asset?.type !== "video") return undefined;
	if (asset.file)
		return extractFrameFull({ videoFile: asset.file, name }, timeSec);
	if (asset.url)
		return extractFrameFull({ videoUrl: asset.url, name }, timeSec);
	return undefined;
}
