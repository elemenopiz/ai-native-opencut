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
import { generateThumbnail } from "./processing";

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
	if (!asset || asset.type !== "video") return undefined;
	if (asset.file) return extractLastFrame({ videoFile: asset.file, name });
	if (asset.url) return extractLastFrame({ videoUrl: asset.url, name });
	return undefined;
}
