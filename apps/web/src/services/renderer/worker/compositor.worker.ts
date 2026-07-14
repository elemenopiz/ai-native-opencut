/**
 * Worker compositor prototype (perf wave 2026-07-14, opportunity #6 / axis-2
 * #1: "OffscreenCanvas + WORKER compositor + worker-side decode").
 *
 * Owns, entirely off the renderer main thread:
 *   - the mediabunny/WebCodecs decode pump (VideoCache — imported unmodified;
 *     it's a plain TS class with no DOM dependency beyond File/BlobSource,
 *     both available in a dedicated worker)
 *   - the node-tree evaluation (buildScene/CanvasRenderer/node classes —
 *     also imported unmodified)
 *   - the rAF-equivalent render loop (worker-scope requestAnimationFrame,
 *     verified available in Chrome 150 for a worker holding an OffscreenCanvas
 *     rendering context; falls back to setTimeout(1000/fps) otherwise)
 *
 * Messaging contract: see compositor-types.ts. No SharedArrayBuffer — the
 * transferred OffscreenCanvas + structured-clone scene descriptors are the
 * only cross-thread channel (crossOriginIsolated is false in this deploy;
 * postMessage + transferables is sufficient, per the audit's runtime checks).
 *
 * Scope: PLAYBACK ONLY. Export stays on the existing main-thread path
 * (scene-exporter.ts is untouched and not imported here).
 */
import { buildScene } from "../scene-builder";
import { CanvasRenderer } from "../canvas-renderer";
import type { RootNode } from "../nodes/root-node";
import { perfStats } from "../perf-stats";
import { getLastFrameTime } from "@/lib/time";
import { registerDefaultEffects } from "@/lib/effects";
import { registerDefaultTransitions } from "@/lib/transitions";
import type {
	CompositorInboundMessage,
	CompositorOutboundMessage,
} from "./compositor-types";

// The effect/transition registries are per-realm module state, normally
// populated by the EditorCore constructor on the MAIN thread (core/index.ts).
// This worker is a separate realm with its own registry instances, so they
// must be populated here too or every effect/transition render throws
// "Unknown effect type". (User .cube LUT presets are NOT hydrated here —
// hydrateUserLutPresets reads persisted storage; a project using a saved
// user LUT would need that ported. Prototype limitation.)
registerDefaultEffects();
registerDefaultTransitions();

/**
 * Minimal structural view of the dedicated-worker global (same pattern as
 * whisper.worker.ts / clip.worker.ts — avoids the webworker/dom lib clash
 * since tsconfig's "lib" is dom-only).
 */
type WorkerScope = {
	postMessage(message: CompositorOutboundMessage): void;
	onmessage: ((event: MessageEvent<CompositorInboundMessage>) => void) | null;
	requestAnimationFrame?: (cb: (t: number) => void) => number;
	cancelAnimationFrame?: (handle: number) => void;
	setTimeout: (cb: () => void, ms: number) => number;
	clearTimeout: (handle: number) => void;
};
const ctx = self as unknown as WorkerScope;

/** HUD-rate stats push, matching PerfHud's own refresh interval. */
const STATS_PUSH_INTERVAL_MS = 250;

let offscreen: OffscreenCanvas | null = null;
let renderer: CanvasRenderer | null = null;
let rootNode: RootNode | null = null;
let fps = 30;

// Mirrors PlaybackManager's rAF-delta clock (playback-manager.ts updateTime),
// but driven independently inside the worker so this loop never depends on
// the main thread being free to tick a rAF callback.
let isPlaying = false;
let baseTime = 0;
let baseTimestamp = 0;

let loopHandle: number | null = null;
let usingRaf = false;
let renderInFlight = false;
let lastRenderedFrameIndex = -1;
let lastStatsPost = 0;
let disposed = false;

function currentTime(): number {
	if (!isPlaying) return baseTime;
	return baseTime + (performance.now() - baseTimestamp) / 1000;
}

function scheduleNext() {
	if (disposed) return;
	if (usingRaf && ctx.requestAnimationFrame) {
		loopHandle = ctx.requestAnimationFrame(tick);
	} else {
		loopHandle = ctx.setTimeout(() => tick(performance.now()), 1000 / fps);
	}
}

async function tick(_t: number) {
	if (disposed) return;

	maybePostStats();

	if (!renderer || !rootNode || !offscreen || renderInFlight) {
		scheduleNext();
		return;
	}

	const time = currentTime();
	const lastFrameTime = getLastFrameTime({
		duration: rootNode.duration,
		fps: renderer.fps,
	});
	const renderTime = Math.min(Math.max(time, 0), lastFrameTime);
	const frameIndex = Math.floor(renderTime * renderer.fps);

	if (frameIndex === lastRenderedFrameIndex) {
		scheduleNext();
		return;
	}

	renderInFlight = true;
	lastRenderedFrameIndex = frameIndex;

	const collect = perfStats.enabled;
	const renderStart = collect ? performance.now() : 0;
	if (collect) perfStats.beginFrame();

	try {
		// renderToCanvas only touches getContext("2d")/drawImage on its target —
		// an OffscreenCanvas duck-types fine even though the signature says
		// HTMLCanvasElement (this file is the only caller of that cast).
		await renderer.renderToCanvas({
			node: rootNode,
			time: renderTime,
			targetCanvas: offscreen as unknown as HTMLCanvasElement,
		});
		if (collect) {
			perfStats.endFrame({ totalMs: performance.now() - renderStart });
		}
	} catch (error) {
		perfStats.countRenderError();
		ctx.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		renderInFlight = false;
	}

	scheduleNext();
}

function maybePostStats() {
	const now = performance.now();
	if (now - lastStatsPost < STATS_PUSH_INTERVAL_MS) return;
	lastStatsPost = now;
	ctx.postMessage({ type: "stats", snapshot: perfStats.getStats() });
}

function startLoopIfNeeded() {
	if (loopHandle !== null) return;
	usingRaf = typeof ctx.requestAnimationFrame === "function";
	scheduleNext();
}

ctx.onmessage = (event: MessageEvent<CompositorInboundMessage>) => {
	const msg = event.data;
	switch (msg.type) {
		case "init": {
			offscreen = msg.canvas;
			fps = msg.fps;
			renderer = new CanvasRenderer({
				width: msg.width,
				height: msg.height,
				fps: msg.fps,
				realtime: true,
			});
			offscreen.width = msg.width;
			offscreen.height = msg.height;
			startLoopIfNeeded();
			ctx.postMessage({ type: "ready" });
			break;
		}
		case "scene": {
			const { scene } = msg;
			rootNode = buildScene({
				tracks: scene.tracks,
				mediaAssets: scene.mediaAssets,
				duration: scene.duration,
				canvasSize: scene.canvasSize,
				background: scene.background,
				isPreview: scene.isPreview,
				useProxy: scene.useProxy,
			});
			// Force the next tick to repaint even if the frame index is unchanged
			// (e.g. an edit that doesn't move the playhead).
			lastRenderedFrameIndex = -1;
			break;
		}
		case "resize": {
			if (!offscreen || !renderer) break;
			offscreen.width = msg.width;
			offscreen.height = msg.height;
			renderer.setSize({ width: msg.width, height: msg.height });
			lastRenderedFrameIndex = -1;
			break;
		}
		case "play": {
			baseTimestamp = performance.now();
			isPlaying = true;
			break;
		}
		case "pause": {
			baseTime = currentTime();
			isPlaying = false;
			break;
		}
		case "seek": {
			baseTime = msg.time;
			baseTimestamp = performance.now();
			lastRenderedFrameIndex = -1;
			break;
		}
		case "perf": {
			perfStats.setEnabled({ enabled: msg.enabled });
			break;
		}
		case "dispose": {
			disposed = true;
			if (loopHandle !== null) {
				if (usingRaf && ctx.cancelAnimationFrame) {
					ctx.cancelAnimationFrame(loopHandle);
				} else {
					ctx.clearTimeout(loopHandle);
				}
				loopHandle = null;
			}
			break;
		}
	}
};
