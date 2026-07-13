/**
 * Clip → reference video — turn a CUT-DOWN timeline clip (trim in/out) into a
 * standalone video File so it can be handed to a video-gen reference slot
 * ("Seedance Omni Reference"). Unlike frame extraction (which pulls a single
 * still — see `lib/media/frame-extraction.ts`), this preserves MOTION: the
 * trimmed span becomes its own short clip.
 *
 * Two render paths, mirroring the two buttons the timeline offers on a clip:
 *   1. `extractTrimmedVideoRaw` — a FAST raw cut. Stream-copies the encoded
 *      samples inside the trim window via mediabunny's `Conversion` (no forced
 *      re-encode), so it's cheap and pixel-exact to the source — but it ignores
 *      any timeline edits (filters/speed/crop/transform).
 *   2. `extractTrimmedVideoComposited` — a FULL render through the real
 *      compositor + encoder, so every edit applied on the timeline (effects,
 *      speed, crop, transform, background) is BAKED into the output.
 *
 * The module keeps its trim-bound math + naming pure (unit-testable without a
 * decoder) and injects the IO-touching bits (`convert` / `render`) so the
 * orchestration can be exercised without a real browser/WebCodecs environment,
 * the same way `extractAndAddFrame` injects its `decode`.
 *
 * Trim semantics match `frame-extraction.ts`: an element shows SOURCE range
 * `[trimStart, trimStart + duration]` — but here we want the WHOLE visible span
 * as a range, so (unlike still extraction) NO "last frame epsilon" is applied.
 */

import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import type {
	FrameDecodeSource,
	TrimmedElement,
} from "@/lib/media/frame-extraction";
import { fetchVideoAsFile } from "@/lib/media/last-frame";
import { getVideoInfo } from "@/lib/media/mediabunny";
import { createTimelineAudioBuffer } from "@/lib/media/audio";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import {
	buildScene,
	type BuildSceneParams,
} from "@/services/renderer/scene-builder";
import type { MediaAsset } from "@/types/assets";
import type { ExportFormat, ExportQuality } from "@/types/export";
import type { TBackground, TCanvasSize } from "@/types/project";
import type {
	ImageElement,
	TimelineTrack,
	VideoElement,
	VideoTrack,
} from "@/types/timeline";

/** A rendered clip: the File plus its pixel size and (encoded) duration. */
export interface ExtractedClip {
	file: File;
	width: number;
	height: number;
	durationSec: number;
}

/** MIME type + File extension for a given output container. */
function formatMime(format: ExportFormat): { mime: string; ext: string } {
	return format === "webm"
		? { mime: "video/webm", ext: "webm" }
		: { mime: "video/mp4", ext: "mp4" };
}

// ── SOURCE-time math (pure) ─────────────────────────────────────────────────

/**
 * SOURCE time where the cut starts — the element's `trimStart`, clamped to 0
 * (a negative trim can't map before the source's first sample). Mirrors
 * {@link firstFrameSourceTime} in `frame-extraction.ts`.
 */
export function clipSourceStart(element: TrimmedElement): number {
	return Math.max(0, element.trimStart);
}

/**
 * SOURCE time where the cut ends — `trimStart + visibleDuration`, the full
 * visible span. Deliberately NOT nudged back by an epsilon (that trick is for
 * landing on a single last FRAME; here we want the whole range).
 */
export function clipSourceEnd(element: TrimmedElement): number {
	return element.trimStart + element.duration;
}

/** Inclusive source range `[start, end]` (seconds) the cut should copy. */
export interface ClipSourceRange {
	start: number;
	end: number;
}

/** The source range `[clipSourceStart, clipSourceEnd]` for a trimmed element. */
export function trimmedVideoRange(element: TrimmedElement): ClipSourceRange {
	return { start: clipSourceStart(element), end: clipSourceEnd(element) };
}

// ── Naming (pure) ───────────────────────────────────────────────────────────

/** Strip a trailing media file extension so names read cleanly. */
function stripMediaExt(name: string): string {
	return name.replace(/\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i, "").trim();
}

/**
 * Human name for an extracted clip — "«source clip name» — clip". Mirrors
 * {@link frameAssetName} in `frame-extraction.ts`.
 */
export function clipAssetName(sourceName: string): string {
	const base = stripMediaExt(sourceName) || "Clip";
	return `${base} — clip`;
}

/** Turn a clip name + format into a safe File name with the right extension. */
function clipFileName(sourceName: string, format: ExportFormat): string {
	const { ext } = formatMime(format);
	const safe = clipAssetName(sourceName)
		.replace(/[\\/:*?"<>|]+/g, "_")
		.trim();
	return `${safe || "clip"}.${ext}`;
}

// ── Raw cut (stream-copy) ────────────────────────────────────────────────────

/** The raw encoded bytes of a cut plus the source's pixel dimensions. */
export interface RawCutResult {
	buffer: ArrayBuffer;
	width: number;
	height: number;
}

/**
 * Injectable stream-copy conversion (default = mediabunny {@link Conversion}).
 * Tests supply a fake so the orchestration runs without a real decoder.
 */
export type ClipConverter = (params: {
	sourceFile: File;
	start: number;
	end: number;
	format: ExportFormat;
}) => Promise<RawCutResult>;

/**
 * Default {@link ClipConverter}: trims `[start, end]` out of `sourceFile` with
 * mediabunny's `Conversion`, stream-copying encoded samples where possible (no
 * forced re-encode). Reads the source's native dimensions for the result.
 */
const runMediabunnyConversion: ClipConverter = async ({
	sourceFile,
	start,
	end,
	format,
}) => {
	const input = new Input({
		source: new BlobSource(sourceFile),
		formats: ALL_FORMATS,
	});

	try {
		const { width, height } = await getVideoInfo({ videoFile: sourceFile });

		const output = new Output({
			format:
				format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const conversion = await Conversion.init({
			input,
			output,
			trim: { start, end },
		});

		if (!conversion.isValid) {
			const reasons =
				conversion.discardedTracks
					.map((d) => `${d.track.type} track (${d.reason})`)
					.join(", ") || "no convertible tracks";
			throw new Error(
				`Can't cut this clip into a ${format.toUpperCase()} video: ${reasons}.`,
			);
		}

		await conversion.execute();

		const buffer = output.target.buffer;
		if (!buffer) {
			throw new Error("The clip cut produced no video data.");
		}

		return { buffer, width, height };
	} finally {
		input.dispose();
	}
};

export interface ExtractTrimmedVideoRawInput {
	/** Trim info (trimStart/duration/startTime) of the element being cut. */
	element: TrimmedElement;
	/** Where to read the source video from (in-memory File and/or URL). */
	source: FrameDecodeSource;
	/** Display name of the source clip (drives the output File name). */
	sourceName: string;
	/** Output container. Defaults to "mp4". */
	format?: ExportFormat;
	/** Override the conversion (tests inject a fake; default uses mediabunny). */
	convert?: ClipConverter;
}

/**
 * FAST raw cut: copy the trimmed span `[trimStart, trimStart + duration]` of the
 * source video into a standalone clip File, stream-copying encoded samples where
 * possible (no re-encode). Ignores any timeline edits — use
 * {@link extractTrimmedVideoComposited} to bake those in. Throws with a
 * human-readable message when the source can't be resolved, the trim range is
 * empty, or the container can't be cut — callers surface it as a toast.
 */
export async function extractTrimmedVideoRaw(
	input: ExtractTrimmedVideoRawInput,
): Promise<ExtractedClip> {
	const format = input.format ?? "mp4";
	const convert = input.convert ?? runMediabunnyConversion;

	const sourceFile =
		input.source.videoFile ??
		(input.source.videoUrl
			? await fetchVideoAsFile(input.source.videoUrl, input.source.name)
			: undefined);
	if (!sourceFile) {
		throw new Error("No source video to cut from.");
	}

	const { start, end } = trimmedVideoRange(input.element);
	if (!(end > start)) {
		throw new Error("This clip has no visible duration to cut.");
	}

	const { buffer, width, height } = await convert({
		sourceFile,
		start,
		end,
		format,
	});

	const { mime } = formatMime(format);
	const file = new File([buffer], clipFileName(input.sourceName, format), {
		type: mime,
	});

	return { file, width, height, durationSec: end - start };
}

// ── Composited render (bake in timeline edits) ───────────────────────────────

/**
 * Build the synthetic single-clip scene the composited path renders: one video
 * track holding a shallow clone of the real element pinned to `startTime: 0`
 * (its `trimStart`/`duration` and every edit — effects/speed/crop/transform —
 * are preserved untouched, so they still apply in the mini-scene). Pure, so the
 * placement can be unit-tested without building a real render tree.
 */
export function buildSingleClipTrack(
	element: VideoElement | ImageElement,
): VideoTrack {
	return {
		id: "clip-reference-track",
		name: "Clip",
		type: "video",
		isMain: true,
		muted: false,
		hidden: false,
		elements: [{ ...element, startTime: 0 }],
	};
}

/**
 * Injectable compositor+encoder (default = real {@link SceneExporter}). Tests
 * supply a fake so the orchestration runs without a browser canvas/WebCodecs.
 */
export type ClipRenderer = (params: {
	rootNode: RootNode;
	width: number;
	height: number;
	fps: number;
	format: ExportFormat;
	quality: ExportQuality;
	includeAudio: boolean;
	audioBuffer?: AudioBuffer;
}) => Promise<ArrayBuffer>;

/** Default {@link ClipRenderer}: render+encode the scene like `exportProject`. */
const runSceneExport: ClipRenderer = async ({
	rootNode,
	width,
	height,
	fps,
	format,
	quality,
	includeAudio,
	audioBuffer,
}) => {
	const exporter = new SceneExporter({
		width,
		height,
		fps,
		format,
		quality,
		// A reference clip is never watermarked — it's an input to generation,
		// not a deliverable export.
		watermark: false,
		shouldIncludeAudio: includeAudio,
		audioBuffer,
	});
	const buffer = await exporter.export({ rootNode });
	if (!buffer) {
		throw new Error("The clip render produced no video data.");
	}
	return buffer;
};

/** Injectable scene builder (default = real `buildScene`). */
export type ClipSceneBuilder = (params: BuildSceneParams) => RootNode;

/** Injectable audio-buffer builder (default = `createTimelineAudioBuffer`). */
export type ClipAudioBuilder = (params: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
}) => Promise<AudioBuffer | null>;

export interface ExtractTrimmedVideoCompositedInput {
	/** The real timeline element to render (carries its edits/effects/trim). */
	element: VideoElement | ImageElement;
	/** All project media assets (the element's `mediaId` is resolved here). */
	mediaAssets: MediaAsset[];
	/** Output canvas size (also the output clip's pixel dimensions). */
	canvasSize: TCanvasSize;
	/** Scene background (color/blur) baked behind the clip. */
	background: TBackground;
	/** Frames per second for the render. */
	fps: number;
	/** Display name of the source clip (drives the output File name). */
	sourceName?: string;
	/** Output container. Defaults to "mp4". */
	format?: ExportFormat;
	/** Encode quality. Defaults to "high". */
	quality?: ExportQuality;
	/** Bake the clip's own audio into the output. Defaults to false. */
	includeAudio?: boolean;
	/** Override the scene builder (tests inject a fake). */
	buildSceneFn?: ClipSceneBuilder;
	/** Override the renderer (tests inject a fake). */
	render?: ClipRenderer;
	/** Override the audio-buffer builder (tests inject a fake). */
	createAudioBuffer?: ClipAudioBuilder;
}

/**
 * FULL composited render: place the element (edits intact) into a one-clip scene
 * at t=0 and render it through the real compositor+encoder, so filters/speed/
 * crop/transform/background applied on the timeline are BAKED into the output
 * clip. Slower than {@link extractTrimmedVideoRaw} but faithful to what the user
 * sees. Throws with a human-readable message on render failure.
 */
export async function extractTrimmedVideoComposited(
	input: ExtractTrimmedVideoCompositedInput,
): Promise<ExtractedClip> {
	const format = input.format ?? "mp4";
	const quality = input.quality ?? "high";
	const includeAudio = input.includeAudio ?? false;
	const build = input.buildSceneFn ?? buildScene;
	const render = input.render ?? runSceneExport;
	const buildAudio = input.createAudioBuffer ?? createTimelineAudioBuffer;

	const duration = input.element.duration;
	if (!(duration > 0)) {
		throw new Error("This clip has no visible duration to render.");
	}

	const track = buildSingleClipTrack(input.element);

	const rootNode = build({
		tracks: [track],
		mediaAssets: input.mediaAssets,
		duration,
		canvasSize: input.canvasSize,
		background: input.background,
	});

	let audioBuffer: AudioBuffer | undefined;
	if (includeAudio) {
		audioBuffer =
			(await buildAudio({
				tracks: [track],
				mediaAssets: input.mediaAssets,
				duration,
			})) ?? undefined;
	}

	const buffer = await render({
		rootNode,
		width: input.canvasSize.width,
		height: input.canvasSize.height,
		fps: input.fps,
		format,
		quality,
		includeAudio: includeAudio && !!audioBuffer,
		audioBuffer,
	});

	const { mime } = formatMime(format);
	const name = input.sourceName ?? input.element.name;
	const file = new File([buffer], clipFileName(name, format), { type: mime });

	return {
		file,
		width: input.canvasSize.width,
		height: input.canvasSize.height,
		durationSec: duration,
	};
}
