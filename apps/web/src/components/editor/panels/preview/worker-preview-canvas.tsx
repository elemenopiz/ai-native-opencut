"use client";

/**
 * Worker-compositor preview canvas (perf prototype, 2026-07-14).
 *
 * Mounted instead of `PreviewCanvas` when the worker compositor flag is on
 * (see compositor-controller.ts's isWorkerCompositorEnabled). Two stacked
 * canvases:
 *   - `canvasRef`: control transferred to the worker ONCE at mount via
 *     transferControlToOffscreen. The worker composites every video/color/
 *     effect/transition layer there (see compositor.worker.ts) using the
 *     SAME buildScene()/CanvasRenderer/node classes as the main-thread path.
 *   - `overlayCanvasRef`: transparent, stacked via CSS on top, painted on the
 *     MAIN thread with the existing CanvasRenderer/useRafLoop pattern —
 *     carries text/image/sticker elements, which can't run in a worker today
 *     (see compositor-types.ts for why). THE fixture project has one text
 *     element and no image/sticker elements, so this is the only layer this
 *     overlay ever has to paint for the bench scenarios.
 *
 * PROTOTYPE LIMITATIONS (see HANDOFF.md for the full list):
 *   - No playback-quality downscale-while-playing (always composites at
 *     native project resolution) — bench forces quality="full" on both
 *     flag states for a fair comparison.
 *   - No pan/zoom/interaction-overlay wiring (selection, drag handles, mask
 *     handles) — those read/write the main-thread node tree synchronously,
 *     which the worker split doesn't support yet.
 *   - Masks (custom/text mask shapes) are not filtered out of the worker
 *     scene; THE fixture project doesn't use them, but a project that does
 *     would hit unaudited codepaths (custom-mask.ts/text-mask.ts use
 *     document.createElement for rasterization — untested in a worker).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { useContainerSize } from "@/hooks/use-container-size";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { getLastFrameTime } from "@/lib/time";
import { perfStats } from "@/services/renderer/perf-stats";
import type { PerfStatsSnapshot } from "@/services/renderer/perf-stats";
import {
	WorkerCompositor,
	isWorkerCompositorEnabled,
} from "@/services/renderer/worker/compositor-controller";
import { splitTracksForWorkerCompositor } from "@/services/renderer/worker/compositor-types";
import { usePreviewStore } from "@/stores/preview-store";
import { usePreviewCanvasStore } from "@/stores/preview-canvas-store";
import { cn } from "@/utils/ui";

export { isWorkerCompositorEnabled };

/** Debounce window between playback/scrub stopping and the preview scene
 *  rebuilding onto the full-res original. Long enough that a quick play-pause
 *  tap or a scrub-handle release-then-grab doesn't thrash a full scene
 *  rebuild; short enough that a held-still frame sharpens up promptly.
 *
 *  Duplicated from index.tsx's PLAYBACK_SETTLE_DELAY_MS (module-local there,
 *  not exported) — see index.tsx for the canonical copy. */
const PLAYBACK_SETTLE_DELAY_MS = 250;

/**
 * True once playback AND scrubbing have both been idle for
 * `PLAYBACK_SETTLE_DELAY_MS`. Drives the preview scene's `useProxy`: while
 * playing or actively scrubbing the scene keeps decoding the (cheap) proxy,
 * but once the playhead settles the scene rebuilds onto the ORIGINAL asset so
 * the held frame is pixel-sharp (see the regression this fixes: proxies were
 * being used for paused frames too, softening the "resting" preview).
 * Starts settled — a freshly-mounted, paused editor should show a sharp frame
 * immediately, with no wait. Debounced (not flipped synchronously on pause)
 * so this never fires the settle rebuild while still moving.
 *
 * Duplicated from index.tsx's useIsPlaybackSettled (module-local there, not
 * exported) — see index.tsx for the canonical copy.
 */
function useIsPlaybackSettled({ editor }: { editor: EditorCore }): boolean {
	const [settled, setSettled] = useState(
		() => !editor.playback.getIsPlaying() && !editor.playback.getIsScrubbing(),
	);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const clearTimer = () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};
		const evaluate = () => {
			clearTimer();
			const active =
				editor.playback.getIsPlaying() || editor.playback.getIsScrubbing();
			if (active) {
				setSettled(false);
			} else {
				timer = setTimeout(() => {
					setSettled(true);
				}, PLAYBACK_SETTLE_DELAY_MS);
			}
		};
		// Discrete playback events (play/pause/seek/scrub) all call notify(),
		// which this subscription rides — see PlaybackManager.subscribe.
		evaluate();
		const unsubscribe = editor.playback.subscribe(evaluate);
		return () => {
			clearTimer();
			unsubscribe();
		};
	}, [editor.playback]);

	return settled;
}

function useWorkerPreviewSize() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	return {
		width: activeProject?.settings.canvasSize.width,
		height: activeProject?.settings.canvasSize.height,
	};
}

/** Minimal fps/frame-ms HUD for the worker-side compositor (mirrors perf-hud.tsx's format). */
function WorkerPerfHud({ stats }: { stats: PerfStatsSnapshot | null }) {
	if (!stats) return null;
	return (
		<pre className="pointer-events-none absolute top-2 left-2 z-10 rounded-sm bg-black/70 p-2 font-mono text-[10px] leading-4 text-cyan-400 select-none">
			{[
				"[worker]",
				`fps     ${stats.fps.toFixed(1)}`,
				`frame   ${stats.avgFrameMs.toFixed(1)}ms avg  ${stats.p95FrameMs.toFixed(1)}ms p95`,
				`decode  ${stats.avgDecodeMs.toFixed(1)}ms`,
				`effects ${stats.avgEffectMs.toFixed(1)}ms`,
				`blit    ${stats.avgBlitMs.toFixed(2)}ms`,
				`long    ${stats.longFrames} >16.7ms  ${stats.veryLongFrames} >33.4ms`,
				`skipped ${stats.framesSkipped}  errors ${stats.renderErrors}`,
			].join("\n")}
		</pre>
	);
}

export function WorkerPreviewCanvas({
	containerRef: _containerRef,
}: {
	/**
	 * Accepted for API parity with PreviewCanvas (PreviewPanel passes it
	 * unconditionally). Unused here: this prototype doesn't wire up the
	 * pan/zoom/context-menu chrome that reads the outer panel bounds — see
	 * the file header's PROTOTYPE LIMITATIONS.
	 */
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
	const outerContainerRef = useRef<HTMLDivElement>(null);
	const compositorRef = useRef<WorkerCompositor | null>(null);
	// Separate from compositorRef: this must stay true for the rest of this
	// component INSTANCE's life, even across a dispose(). See the mount
	// effect below for why compositorRef alone can't guard
	// transferControlToOffscreen() against React StrictMode's dev-only
	// double-invoke.
	const hasTransferredCanvasRef = useRef(false);
	const overlayRootRef = useRef<RootNode | null>(null);
	const lastOverlayFrameRef = useRef(-1);
	const overlayRenderingRef = useRef(false);
	const wasPlayingRef = useRef(false);
	const lastSentSizeRef = useRef<{ width: number; height: number } | null>(
		null,
	);

	const editor = useEditor();
	const settled = useIsPlaybackSettled({ editor });
	const tracks = editor.timeline.getTracks();
	const mediaAssets = editor.media.getAssets();
	const activeProject = editor.project.getActive();
	const { width: nativeWidth, height: nativeHeight } = useWorkerPreviewSize();
	const containerSize = useContainerSize({ containerRef: outerContainerRef });
	const { overlays } = usePreviewStore();
	const [isPlaying, setIsPlaying] = useState(() =>
		editor.playback.getIsPlaying(),
	);
	const [workerStats, setWorkerStats] = useState<PerfStatsSnapshot | null>(
		null,
	);

	const overlayRenderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth ?? 1,
			height: nativeHeight ?? 1,
			realtime: true,
			transparent: true,
			fps: activeProject.settings.fps,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	const displaySize = useMemo(() => {
		if (
			!nativeWidth ||
			!nativeHeight ||
			containerSize.width === 0 ||
			containerSize.height === 0
		) {
			return { width: nativeWidth ?? 0, height: nativeHeight ?? 0 };
		}
		const paddingBuffer = 4;
		const availableWidth = containerSize.width - paddingBuffer;
		const availableHeight = containerSize.height - paddingBuffer;
		const aspectRatio = nativeWidth / nativeHeight;
		const containerAspect = availableWidth / availableHeight;
		const displayWidth =
			containerAspect > aspectRatio
				? availableHeight * aspectRatio
				: availableWidth;
		const displayHeight =
			containerAspect > aspectRatio
				? availableHeight
				: availableWidth / aspectRatio;
		return { width: displayWidth, height: displayHeight };
	}, [nativeWidth, nativeHeight, containerSize.width, containerSize.height]);

	// Mount the worker exactly once, as soon as the canvas element and the
	// project's native size are both available. transferControlToOffscreen
	// throws if called twice on the same canvas element, so this effect's
	// BODY must run at most once for the life of this <canvas> DOM node.
	//
	// Deliberately `[]` deps: nativeWidth/nativeHeight/activeProject.settings.fps
	// and editor.playback.* below are read for their value AT MOUNT TIME only.
	// Canvas-size changes are NOT handled here — the separate resize effect
	// below posts a resize message to the already-mounted worker instead of
	// tearing this effect down and re-running it (which would tear down the
	// compositor and re-transfer the same canvas element, throwing).
	//
	// hasTransferredCanvasRef (NOT compositorRef) is the re-run guard, and it
	// is intentionally never reset in the cleanup below. React StrictMode's
	// dev-only mount -> cleanup -> mount double-invoke re-runs this effect's
	// body on the SAME component instance and the SAME <canvas> DOM node
	// (React does not recreate refs or DOM between the two invocations), so a
	// guard cleared by cleanup — like compositorRef.current, which legitimately
	// must be nulled on real teardown — would let StrictMode's second
	// invocation call transferControlToOffscreen() again and throw.
	// hasTransferredCanvasRef staying true for the rest of this instance's
	// life is correct: a genuine unmount destroys the instance (and its refs)
	// entirely, so a later genuine remount gets a fresh ref alongside a fresh
	// <canvas> element.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once, see comment above
	useEffect(() => {
		if (hasTransferredCanvasRef.current) return;
		if (!canvasRef.current || !nativeWidth || !nativeHeight) return;
		hasTransferredCanvasRef.current = true;

		const compositor = new WorkerCompositor();
		compositorRef.current = compositor;
		lastSentSizeRef.current = { width: nativeWidth, height: nativeHeight };
		compositor.mount({
			canvas: canvasRef.current,
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
		});
		compositor.setPerfEnabled({ enabled: true });
		compositor.seek({ time: editor.playback.getCurrentTime() });
		if (editor.playback.getIsPlaying()) {
			wasPlayingRef.current = true;
			compositor.play();
		}
		const unsubscribeStats = compositor.subscribeStats((snapshot) =>
			setWorkerStats(snapshot),
		);

		return () => {
			unsubscribeStats();
			compositor.dispose();
			if (compositorRef.current === compositor) compositorRef.current = null;
		};
	}, []);

	// Resize after the initial mount (frame-preset / canvas-size change).
	useLayoutEffect(() => {
		if (!nativeWidth || !nativeHeight) return;
		const last = lastSentSizeRef.current;
		if (last && last.width === nativeWidth && last.height === nativeHeight) {
			return;
		}
		lastSentSizeRef.current = { width: nativeWidth, height: nativeHeight };
		compositorRef.current?.resize({ width: nativeWidth, height: nativeHeight });
	}, [nativeWidth, nativeHeight]);

	// Discrete play/pause transitions only — PlaybackManager's subscribe()
	// also fires on volume/mute/scrub-flag changes (same channel), and
	// forwarding those as duplicate play()/pause() calls would reset the
	// worker's clock anchor without changing its base time, rewinding
	// playback. Only a genuine isPlaying flip is forwarded.
	useEffect(() => {
		const unsubscribe = editor.playback.subscribe(() => {
			const playing = editor.playback.getIsPlaying();
			setIsPlaying(playing);
			if (playing === wasPlayingRef.current) return;
			wasPlayingRef.current = playing;
			if (playing) compositorRef.current?.play();
			else compositorRef.current?.pause();
		});
		return unsubscribe;
	}, [editor.playback]);

	// Seeks (scrub, boundary auto-seek, shuttle) — PlaybackManager dispatches
	// this DOM event on every discrete time jump (see playback-manager.ts).
	useEffect(() => {
		const handleSeek = (event: Event) => {
			const detail = (event as CustomEvent<{ time: number }>).detail;
			compositorRef.current?.seek({ time: detail.time });
			lastOverlayFrameRef.current = -1;
		};
		window.addEventListener("playback-seek", handleSeek);
		return () => window.removeEventListener("playback-seek", handleSeek);
	}, []);

	// Scene descriptor push (worker) + overlay-only tree (main thread, text/
	// image/sticker). Mirrors RenderTreeController's trigger deps exactly so
	// both trees rebuild on the same edits.
	useDeepCompareEffect(() => {
		if (!activeProject || !nativeWidth || !nativeHeight) return;
		const duration = editor.timeline.getTotalDuration();
		const canvasSize = { width: nativeWidth, height: nativeHeight };

		compositorRef.current?.updateScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize,
			background: activeProject.settings.background,
			isPreview: true,
			useProxy: (activeProject.settings.proxyEditing ?? true) && !settled,
		});

		const { overlayTracks } = splitTracksForWorkerCompositor(tracks);
		overlayRootRef.current = buildScene({
			tracks: overlayTracks,
			mediaAssets,
			duration,
			canvasSize,
			// Transparent: the worker canvas already painted the real
			// background; this overlay must only add text/image/sticker.
			background: { type: "color", color: "transparent" },
			isPreview: true,
			useProxy: (activeProject.settings.proxyEditing ?? true) && !settled,
		});
		lastOverlayFrameRef.current = -1;
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		activeProject?.settings.proxyEditing,
		nativeWidth,
		nativeHeight,
		settled,
	]);

	useEffect(() => {
		usePreviewCanvasStore.getState().setCanvasEl({ canvas: canvasRef.current });
		return () => {
			usePreviewCanvasStore.getState().setCanvasEl({ canvas: null });
		};
	}, []);

	const renderOverlay = () => {
		const overlayCanvas = overlayCanvasRef.current;
		const overlayRoot = overlayRootRef.current;
		if (!overlayCanvas || !overlayRoot) return;

		const time = editor.playback.getCurrentTime();
		const lastFrameTime = getLastFrameTime({
			duration: overlayRoot.duration,
			fps: overlayRenderer.fps,
		});
		const renderTime = Math.min(time, lastFrameTime);
		const frame = Math.floor(renderTime * overlayRenderer.fps);

		if (frame === lastOverlayFrameRef.current) return;
		if (overlayRenderingRef.current) return;

		overlayRenderingRef.current = true;
		lastOverlayFrameRef.current = frame;

		overlayRenderer
			.renderToCanvas({
				node: overlayRoot,
				time: renderTime,
				targetCanvas: overlayCanvas,
			})
			.catch((error) => {
				console.error("Overlay render failed:", error);
			})
			.finally(() => {
				overlayRenderingRef.current = false;
			});
	};

	useRafLoop(renderOverlay);

	useEffect(() => {
		perfStats.setEnabled({ enabled: true });
		return () => perfStats.setEnabled({ enabled: false });
	}, []);

	return (
		<div
			ref={outerContainerRef}
			className="relative flex size-full items-center justify-center overflow-hidden"
		>
			<div
				className="relative shrink-0"
				style={{ width: displaySize.width, height: displaySize.height }}
			>
				<canvas
					ref={canvasRef}
					width={nativeWidth}
					height={nativeHeight}
					className="block border"
					style={{
						width: displaySize.width,
						height: displaySize.height,
						background:
							activeProject.settings.background.type === "blur"
								? "transparent"
								: activeProject.settings.background.color,
					}}
				/>
				<canvas
					ref={overlayCanvasRef}
					width={nativeWidth}
					height={nativeHeight}
					className={cn("pointer-events-none absolute inset-0 block")}
					style={{ width: displaySize.width, height: displaySize.height }}
				/>
				{overlays.perfHud && (
					<>
						<WorkerPerfHud stats={workerStats} />
						<div
							className="pointer-events-none absolute top-2 right-2 z-10 rounded-sm bg-black/70 p-2 font-mono text-[10px] leading-4 text-amber-300 select-none"
							data-testid="overlay-hud"
						>
							{`[overlay/main] playing=${isPlaying}`}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
