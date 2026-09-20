/**
 * watchBack — render the COMPOSITED timeline (the actual cut, as an audience
 * would see it) at a handful of requested times and hand the decoded frames
 * back so the Director can SEE what it just assembled.
 *
 * This is deliberately NOT `extractFrame`/`lib/media/frame-extraction.ts`:
 * that module decodes from a single clip's SOURCE media (respecting its
 * trims) — it inspects an ingredient. `watchBack` samples the RENDERED
 * OUTPUT — tracks, transitions, text, effects, everything composited
 * together — which is the dish. See
 * `docs/plans/2026-09-18-director-autonomy-architecture.md` §7 for the
 * findings this module is built on.
 *
 * Mirrors the freeze-frame action (`hooks/actions/use-editor-actions.ts`,
 * "freeze-frame") exactly for the render path:
 *
 *   buildScene({ tracks, mediaAssets, duration, canvasSize, background,
 *     isPreview: true, useProxy }) -> new CanvasRenderer(...)
 *     -> renderToCanvas({ node, time, targetCanvas }) -> canvas -> data URL
 *
 * LOAD-BEARING: the render tree is built fresh with `buildScene()` on every
 * call, never read from `editor.renderer.getRenderTree()`. That stored tree
 * is only kept current by `RenderTreeController`, which is NOT mounted when
 * the worker compositor is active (its scene tree lives in the worker
 * instead — see `worker-preview-canvas.tsx`), so it can be stale or null in
 * that mode. Freeze-frame carries this same warning for the same reason.
 *
 * Two seams keep this headless-testable (same pattern as
 * `lib/media/frame-extraction.ts`'s injectable `decode`):
 *  - {@link WatchBackRenderer} — the actual canvas render (browser-bound
 *    default {@link renderWatchBackFrames}; tests inject a fake).
 *  - `watchBackTimeline`'s `editor` param — any `EditorCore`-shaped object
 *    (`fake-editor.ts` drives it in tests the same way it drives every other
 *    Director verb).
 */

import type { EditorCore } from "@/core";
import type { TBackground, TCanvasSize } from "@/types/project";
import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack } from "@/types/timeline";
import { getLastFrameTime } from "@/lib/time";

// ── tunables ─────────────────────────────────────────────────────────────

/**
 * Max distinct frames rendered per `watchBack` call. Every frame is an image
 * the model has to look at — real context/latency cost — so this stays small
 * (task guidance: 3–5). Picked 4: `reviewTake` caps at 3 for a SINGLE take's
 * first/mid/last triptych, but `watchBack` samples across the whole
 * assembled cut, where the interesting moments (a hard cut, a transition, an
 * overlay appearing) tend to cluster at boundaries rather than being evenly
 * spaced — one extra frame over reviewTake's cap buys the agent room for
 * "start + a cut point + the end" or similar without ballooning the call's
 * image cost past what a single-clip review already costs.
 */
export const WATCH_BACK_MAX_FRAMES = 4;

/**
 * Long-edge size (px) each frame is downscaled to before being returned.
 * Judging composition, framing, whether the right clip is on screen, and
 * whether text/overlays landed correctly does not need full canvas
 * resolution (often 1080p+) — 512px is comfortably enough detail for that
 * while keeping each frame's token/bandwidth cost low. Not tied to any
 * specific model's image-tiling constants on purpose: this is a "plenty for
 * judging a cut" constant, not a model-specific one.
 */
export const WATCH_BACK_LONG_EDGE_PX = 512;

/** Decimal places times are rounded to before de-duplication — merges
 * float-noise-close requests (e.g. 2.00001 vs 2.0) without merging genuinely
 * distinct moments; 10ms precision is well below what a still frame needs. */
const DEDUPE_DECIMALS = 2;

// ── pure helpers ─────────────────────────────────────────────────────────

/**
 * Clamp every requested time into `[0, maxTime]`, de-duplicate (see
 * {@link DEDUPE_DECIMALS}), sort ascending, and cap to `cap` entries.
 * Non-finite inputs are dropped rather than clamped to 0 — a NaN/Infinity in
 * the request is almost certainly a caller bug, not an intentional "start of
 * timeline" ask.
 */
export function clampAndDedupeTimes(
	times: readonly number[],
	maxTime: number,
	cap: number,
): number[] {
	const hi = Math.max(0, maxTime);
	const seen = new Set<number>();
	const out: number[] = [];
	for (const raw of times) {
		if (!Number.isFinite(raw)) continue;
		const clamped = Math.min(Math.max(raw, 0), hi);
		const rounded = Number(clamped.toFixed(DEDUPE_DECIMALS));
		if (seen.has(rounded)) continue;
		seen.add(rounded);
		out.push(rounded);
	}
	out.sort((a, b) => a - b);
	return out.slice(0, Math.max(0, cap));
}

/**
 * Scale `size` down so its long edge is `longEdgePx`, preserving aspect
 * ratio. Never upscales (a canvas already smaller than the target is left
 * alone) — this is a downscale-only helper.
 */
export function downscaleSize(
	size: TCanvasSize,
	longEdgePx: number,
): TCanvasSize {
	const longEdge = Math.max(size.width, size.height);
	if (!(longEdge > 0)) return { width: longEdgePx, height: longEdgePx };
	const scale = Math.min(1, longEdgePx / longEdge);
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

/**
 * Cheap "what's on screen at time T": the first non-hidden VIDEO-track
 * element (in track order) whose timeline span covers `time`. Not full
 * z-order compositing (that's `buildScene`'s job) — a good-enough caption for
 * the agent, not a rendering decision.
 */
export function describeClipAt(
	tracks: readonly TimelineTrack[],
	time: number,
): string | undefined {
	for (const track of tracks) {
		if (track.type !== "video" || track.hidden) continue;
		for (const element of track.elements) {
			if (
				time >= element.startTime &&
				time <= element.startTime + element.duration
			) {
				return element.name || undefined;
			}
		}
	}
	return undefined;
}

// ── render seam ──────────────────────────────────────────────────────────

/** One decoded frame from the default renderer, before captioning. */
export interface RenderedWatchBackFrame {
	time: number;
	dataUrl: string;
}

/** Everything the renderer needs to know to rasterize the composited scene. */
export interface WatchBackRenderInput {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	canvasSize: TCanvasSize;
	background: TBackground;
	fps: number;
	useProxy: boolean;
	/** Already clamped, de-duplicated, sorted, capped — see `clampAndDedupeTimes`. */
	times: number[];
	/** Target size each frame is rendered/downscaled to — see `downscaleSize`. */
	targetSize: TCanvasSize;
}

/** Injectable render boundary — browser-bound by default; tests inject a fake. */
export type WatchBackRenderer = (
	input: WatchBackRenderInput,
) => Promise<RenderedWatchBackFrame[]>;

async function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read rendered frame"));
		reader.readAsDataURL(blob);
	});
}

/**
 * Default renderer: build the scene fresh with `buildScene()` (see the
 * LOAD-BEARING note in this file's header), then render + blit each
 * requested time onto a canvas already sized to the downscaled target — the
 * internal renderer draws at full resolution and `renderToCanvas` blits it
 * scaled onto whatever `targetCanvas` size is given, so this downscales in
 * the same pass rather than rendering full-res then shrinking after.
 * Browser-bound (dynamic imports + `document.createElement("canvas")`) —
 * headless tests inject a fake `WatchBackRenderer` instead of this.
 */
export const renderWatchBackFrames: WatchBackRenderer = async (input) => {
	const { buildScene } = await import("@/services/renderer/scene-builder");
	const { CanvasRenderer } = await import(
		"@/services/renderer/canvas-renderer"
	);

	const renderTree = buildScene({
		tracks: input.tracks,
		mediaAssets: input.mediaAssets,
		duration: input.duration,
		canvasSize: input.canvasSize,
		background: input.background,
		isPreview: true,
		useProxy: input.useProxy,
	});

	const renderer = new CanvasRenderer({
		width: input.canvasSize.width,
		height: input.canvasSize.height,
		fps: input.fps,
	});

	const frames: RenderedWatchBackFrame[] = [];
	for (const time of input.times) {
		const targetCanvas = document.createElement("canvas");
		targetCanvas.width = input.targetSize.width;
		targetCanvas.height = input.targetSize.height;

		await renderer.renderToCanvas({ node: renderTree, time, targetCanvas });

		const blob = await new Promise<Blob | null>((resolve) => {
			targetCanvas.toBlob((result) => resolve(result), "image/jpeg", 0.82);
		});
		if (!blob) continue;
		frames.push({ time, dataUrl: await blobToDataUrl(blob) });
	}
	return frames;
};

// ── orchestration ────────────────────────────────────────────────────────

export interface WatchBackInput {
	editor: EditorCore;
	/** Requested timeline times, in SECONDS; clamped/de-duplicated/capped here. */
	times: number[];
	/** Override the renderer (tests inject a fake; default is browser-bound). */
	render?: WatchBackRenderer;
}

/** One returned frame: its timestamp, the decoded image, and — when cheap to
 * determine — the name of the clip on screen at that moment. */
export interface WatchBackFrame {
	time: number;
	dataUrl: string;
	clip?: string;
}

export interface WatchBackOutcome {
	frames: WatchBackFrame[];
	/** One-line-per-frame human summary, e.g. "@2.0s — Intro shot". */
	summary: string;
}

/**
 * Render the composited timeline at up to {@link WATCH_BACK_MAX_FRAMES} of the
 * requested times and return the decoded, downscaled frames plus a plain-text
 * summary. Read-only: never mutates the editor. Fails (never throws) with
 * actionable copy when there's nothing to render (empty timeline, no active
 * project, no valid times, or every render attempt failed).
 */
export async function watchBackTimeline(
	input: WatchBackInput,
): Promise<WatchBackOutcome | { error: string }> {
	const { editor } = input;

	const duration = editor.timeline.getTotalDuration();
	if (!(duration > 0)) {
		return { error: "Timeline is empty — nothing to watch back yet." };
	}

	let project: ReturnType<EditorCore["project"]["getActive"]>;
	try {
		project = editor.project.getActive();
	} catch {
		return { error: "No active project to render." };
	}

	const { fps, canvasSize, background, proxyEditing } = project.settings;
	const lastFrameTime = getLastFrameTime({ duration, fps });

	const times = clampAndDedupeTimes(
		input.times,
		lastFrameTime,
		WATCH_BACK_MAX_FRAMES,
	);
	if (times.length === 0) {
		return {
			error: `watchBack needs at least one time between 0s and ${lastFrameTime.toFixed(1)}s.`,
		};
	}

	const tracks = editor.timeline.getTracks();
	const render = input.render ?? renderWatchBackFrames;

	let rendered: RenderedWatchBackFrame[];
	try {
		rendered = await render({
			tracks,
			mediaAssets: editor.media.getAssets(),
			duration,
			canvasSize,
			background,
			fps,
			useProxy: proxyEditing ?? true,
			times,
			targetSize: downscaleSize(canvasSize, WATCH_BACK_LONG_EDGE_PX),
		});
	} catch (err) {
		return {
			error:
				err instanceof Error ? err.message : "Failed to render the timeline.",
		};
	}
	if (rendered.length === 0) {
		return { error: "Couldn't render any frames of the composited timeline." };
	}

	const frames: WatchBackFrame[] = rendered.map((f) => ({
		time: f.time,
		dataUrl: f.dataUrl,
		clip: describeClipAt(tracks, f.time),
	}));

	const lines = frames.map(
		(f) =>
			`@${f.time.toFixed(1)}s${f.clip ? ` — ${f.clip}` : " — nothing on screen"}`,
	);

	return {
		frames,
		summary: `Watched back ${frames.length} frame(s) of the composited timeline: ${lines.join("; ")}.`,
	};
}
