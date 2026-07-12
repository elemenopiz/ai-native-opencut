/**
 * Frame extraction — pull a full-resolution still out of a video clip and add it
 * to the media library WITH provenance, so users (and the Director) can chain
 * shots: feed the LAST frame of clip N as the FIRST frame of clip N+1 and let
 * consecutive generations mesh.
 *
 * This module owns three things, kept small and mostly pure so they unit-test
 * without a browser decoder:
 *   1. SOURCE-time math — which timestamp in the source media a "first" / "last"
 *      / "playhead" frame maps to, respecting an element's trims.
 *   2. Naming + provenance — the human name ("clip — last frame") and the
 *      machine-readable {@link DerivedFrom} stamped onto the new asset.
 *   3. `extractAndAddFrame` — the one orchestration that decodes (injectable),
 *      materializes a File, and adds it to the library.
 *
 * Trim semantics (see `lib/timeline/audio-sync-utils.ts`): an element shows
 * SOURCE range `[trimStart, trimStart + duration]` at TIMELINE range
 * `[startTime, startTime + duration]`, where `duration` is the VISIBLE duration.
 * (playbackRate/reversed are intentionally NOT modeled here — the canonical
 * source↔timeline mapping ignores them too; see the design doc.)
 */

import type { EditorCore } from "@/core";
import type { DerivedFrom, DerivedFrameLabel } from "@/services/storage/types";
import { LAST_FRAME_EPSILON_S } from "@/lib/media/last-frame";
import { extractFrameFull, type FullFrame } from "@/lib/media/last-frame";
import { dataUrlToFile } from "@/lib/media/data-url";

/** Minimal shape of a trimmed timeline element we need for source-time math. */
export interface TrimmedElement {
	startTime: number;
	duration: number;
	trimStart: number;
}

// ── SOURCE-time math (pure) ─────────────────────────────────────────────────

/** SOURCE time of the FIRST visible frame (respecting the element's trim). */
export function firstFrameSourceTime(element: TrimmedElement): number {
	return Math.max(0, element.trimStart);
}

/**
 * SOURCE time of the LAST visible frame: `trimStart + visibleDuration - epsilon`
 * (the reported end can sit a hair past the last decodable sample, so we sample
 * just before it — mirrors {@link lastFrameTimestamp}). Never precedes the first
 * visible frame.
 */
export function lastFrameSourceTime(
	element: TrimmedElement,
	epsilon = LAST_FRAME_EPSILON_S,
): number {
	const start = firstFrameSourceTime(element);
	return Math.max(start, element.trimStart + element.duration - epsilon);
}

/** Is `playheadTime` within the element's timeline span (inclusive)? */
export function isPlayheadWithinElement(
	element: TrimmedElement,
	playheadTime: number,
): boolean {
	return (
		playheadTime >= element.startTime &&
		playheadTime <= element.startTime + element.duration
	);
}

/**
 * SOURCE time under the playhead: map the timeline `playheadTime` back through
 * the element's placement/trim. Clamped to the visible source span.
 */
export function playheadSourceTime(
	element: TrimmedElement,
	playheadTime: number,
): number {
	const raw = element.trimStart + (playheadTime - element.startTime);
	const lo = firstFrameSourceTime(element);
	const hi = element.trimStart + element.duration;
	return Math.min(hi, Math.max(lo, raw));
}

// ── Naming + provenance (pure) ──────────────────────────────────────────────

/** Strip a trailing media file extension so names read cleanly. */
function stripMediaExt(name: string): string {
	return name.replace(/\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i, "").trim();
}

/**
 * Human name for an extracted frame — "«source clip name» — last frame" /
 * "— first frame" / "— frame @ 4.2s". The "@ Ns" form is used for the generic
 * `frame` label (playhead / arbitrary time) so the exact moment is visible.
 */
export function frameAssetName(
	sourceName: string,
	label: DerivedFrameLabel,
	sourceTimeSec: number,
): string {
	const base = stripMediaExt(sourceName) || "Clip";
	if (label === "frame") {
		return `${base} — frame @ ${sourceTimeSec.toFixed(1)}s`;
	}
	return `${base} — ${label}`;
}

/** Build the machine-readable provenance stamp for an extracted frame. */
export function buildDerivedFrom(
	sourceAssetId: string,
	sourceTimeSec: number,
	label: DerivedFrameLabel,
): DerivedFrom {
	return { assetId: sourceAssetId, sourceTimeSec, label };
}

// ── Orchestration ───────────────────────────────────────────────────────────

/** Video source to decode from — an in-memory File and/or a (proxied) URL. */
export interface FrameDecodeSource {
	videoFile?: File;
	videoUrl?: string;
	name?: string;
}

/** Injectable full-res decoder (default = browser mediabunny decode). */
export type FrameDecoder = (
	source: FrameDecodeSource,
	timeSec: number,
) => Promise<FullFrame | undefined>;

export interface ExtractAndAddFrameInput {
	editor: EditorCore;
	projectId: string;
	/** Video to decode from. */
	source: FrameDecodeSource;
	/** `MediaAsset.id` of the source video (for provenance). */
	sourceAssetId: string;
	/** Display name of the source clip (drives the frame's name). */
	sourceName: string;
	/** SOURCE-media time to decode. */
	timeSec: number;
	/** Which visible frame this is (drives name + provenance). */
	label: DerivedFrameLabel;
	/** Override the decoder (tests inject a fake; default decodes for real). */
	decode?: FrameDecoder;
}

export interface ExtractedFrame {
	mediaId: string;
	name: string;
	dataUrl: string;
	width: number;
	height: number;
}

/**
 * Decode a full-resolution still at `timeSec`, materialize it as an image File,
 * and add it to the project's media library with a name + {@link DerivedFrom}
 * provenance. Returns the created asset's id and the decoded data URL (the
 * caller may upload that to R2 for use as a generation seed). Throws with a
 * human-readable message if the frame can't be decoded or the asset can't be
 * saved — callers surface it as a toast.
 */
export async function extractAndAddFrame(
	input: ExtractAndAddFrameInput,
): Promise<ExtractedFrame> {
	const decode = input.decode ?? extractFrameFull;
	const frame = await decode(input.source, input.timeSec);
	if (!frame) {
		throw new Error("Could not decode a frame from this clip.");
	}

	const name = frameAssetName(input.sourceName, input.label, input.timeSec);
	const file = dataUrlToFile(frame.dataUrl, name);
	const url =
		typeof URL !== "undefined" && "createObjectURL" in URL
			? URL.createObjectURL(file)
			: undefined;

	const mediaId = await input.editor.media.addMediaAsset({
		projectId: input.projectId,
		asset: {
			name,
			type: "image",
			file,
			url,
			width: frame.width,
			height: frame.height,
			derivedFrom: buildDerivedFrom(
				input.sourceAssetId,
				input.timeSec,
				input.label,
			),
		},
	});

	return {
		mediaId,
		name,
		dataUrl: frame.dataUrl,
		width: frame.width,
		height: frame.height,
	};
}
