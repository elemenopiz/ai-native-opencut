/**
 * Shared message protocol + scene-splitting helper for the worker compositor
 * prototype (perf wave 2026-07-14, axis-2 opportunity #6 / #1 in the render-
 * pipeline audit). This file is imported by BOTH the main thread
 * (compositor-controller.ts) and the worker (compositor.worker.ts), so it
 * must stay free of DOM- or worker-global-scope-only APIs — plain types and
 * pure data transforms only.
 *
 * PROTOTYPE LIMITATION (see HANDOFF.md): the worker composites video/image/
 * color/effect/transition layers via the SAME buildScene()/CanvasRenderer/
 * node classes the main thread already uses (imported unmodified — nothing
 * in services/renderer/nodes/* or scene-builder.ts was changed). Text,
 * image, and sticker elements are deliberately excluded from the worker
 * scene and rendered separately on a main-thread overlay canvas instead:
 *   - text-node.ts uses DOM font measurement and is being edited by another
 *     live session (explicitly off-limits for this task).
 *   - image-node.ts and sticker-node.ts construct `new Image()`
 *     (HTMLImageElement), which does not exist in a Worker global scope.
 * THE fixture project (bench.js) has 1 text element and 0 image/sticker
 * elements, so this split has zero effect on the measured scenario.
 */
import type { MediaAsset } from "@/types/assets";
import type { TBackground, TCanvasSize } from "@/types/project";
import type { TimelineTrack } from "@/types/timeline";
import type { PerfStatsSnapshot } from "../perf-stats";

/** Element types the worker's node classes cannot (yet) render off-DOM. */
const WORKER_UNSUPPORTED_ELEMENT_TYPES = new Set<string>([
	"text",
	"image",
	"sticker",
]);

/**
 * Split each track's elements into the subset the worker can composite
 * (video/audio-less visual layers, effects, anything buildScene turns into
 * VideoNode/ColorNode/EffectLayerNode/TransitionNode) and the subset that
 * must stay on the main thread (text/image/sticker). Track shape/order is
 * preserved on both sides so z-order and transition-adjacency logic inside
 * scene-builder.ts keep working unmodified — a track with all elements
 * filtered out just contributes nothing, which scene-builder already
 * tolerates.
 */
export function splitTracksForWorkerCompositor(tracks: TimelineTrack[]): {
	workerTracks: TimelineTrack[];
	overlayTracks: TimelineTrack[];
} {
	const workerTracks = tracks.map((track) => ({
		...track,
		elements: track.elements.filter(
			(el) => !WORKER_UNSUPPORTED_ELEMENT_TYPES.has(el.type),
		),
	})) as TimelineTrack[];
	const overlayTracks = tracks.map((track) => ({
		...track,
		elements: track.elements.filter((el) =>
			WORKER_UNSUPPORTED_ELEMENT_TYPES.has(el.type),
		),
	})) as TimelineTrack[];
	return { workerTracks, overlayTracks };
}

/** Serializable scene-build inputs, structured-clone-safe (File objects clone fine). */
export interface SceneDescriptor {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	duration: number;
	canvasSize: TCanvasSize;
	background: TBackground;
	isPreview?: boolean;
	useProxy?: boolean;
}

export type CompositorInboundMessage =
	| {
			type: "init";
			canvas: OffscreenCanvas;
			width: number;
			height: number;
			fps: number;
	  }
	| { type: "scene"; scene: SceneDescriptor }
	| { type: "resize"; width: number; height: number }
	| { type: "play" }
	| { type: "pause" }
	| { type: "seek"; time: number }
	| { type: "perf"; enabled: boolean }
	| { type: "dispose" };

export type CompositorOutboundMessage =
	| { type: "ready" }
	| { type: "stats"; snapshot: PerfStatsSnapshot }
	| { type: "error"; message: string };
