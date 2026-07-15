"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { getLastFrameTime } from "@/lib/time";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { BookmarkNoteOverlay } from "./bookmark-note-overlay";
import { LayoutGuideOverlay } from "./layout-guide-overlay";
import { GuidePicker } from "./guide-picker";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { GridTableIcon } from "@hugeicons/core-free-icons";
import {
	clampPreviewZoom,
	getPlaybackRenderScale,
	usePreviewStore,
} from "@/stores/preview-store";
import { usePreviewCanvasStore } from "@/stores/preview-canvas-store";
import { PreviewContextMenu } from "./context-menu";
import { PerfHud } from "./perf-hud";
import { PreviewToolbar } from "./toolbar";
import { perfStats } from "@/services/renderer/perf-stats";
import { FramePresetPicker } from "./frame-preset-picker";
import { cn } from "@/utils/ui";
import {
	WorkerPreviewCanvas,
	isWorkerCompositorEnabled,
} from "./worker-preview-canvas";

const WHEEL_ZOOM_SENSITIVITY = 0.0015;

function usePreviewSize() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();

	return {
		width: activeProject?.settings.canvasSize.width,
		height: activeProject?.settings.canvasSize.height,
	};
}

/** Debounce window between playback/scrub stopping and the preview scene
 *  rebuilding onto the full-res original. Long enough that a quick play-pause
 *  tap or a scrub-handle release-then-grab doesn't thrash a full scene
 *  rebuild; short enough that a held-still frame sharpens up promptly. */
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

/**
 * Cheap estimate of the preview canvas's actual backing-store long edge
 * (device pixels) right now — mirrors `PreviewCanvas`'s own `renderSize`
 * computation (see `getPlaybackRenderScale`) using the same reactive inputs
 * from `usePreviewStore` (zoom/fitScale/playbackQuality set by that
 * component) plus devicePixelRatio. Used only to decide whether a proxy would
 * be upscaled to fill the canvas (scene-builder.ts's
 * `previewBackingStoreLongEdge` / `proxyWouldBeUpscaled`) — an approximation
 * is fine here since a false negative just means one extra frame decoded from
 * the proxy before the next recompute, never a correctness issue.
 */
function usePreviewBackingStoreLongEdge({
	nativeWidth,
	nativeHeight,
}: {
	nativeWidth?: number;
	nativeHeight?: number;
}): number | undefined {
	// Individual selectors (not a destructured whole-store read): this hook
	// feeds RenderTreeController, whose effect drives a scene rebuild, so it
	// should only re-run for the specific fields the estimate depends on —
	// not every unrelated preview-store change (guides, overlays, pan…).
	const zoom = usePreviewStore((state) => state.zoom);
	const fitScale = usePreviewStore((state) => state.fitScale);
	const playbackQuality = usePreviewStore((state) => state.playbackQuality);

	return useMemo(() => {
		if (!nativeWidth || !nativeHeight || !fitScale) return undefined;
		const devicePixelRatio =
			typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
		const scale = getPlaybackRenderScale({
			quality: playbackQuality,
			nativeWidth,
			nativeHeight,
			displayWidth: fitScale * nativeWidth,
			zoom,
			devicePixelRatio,
		});
		return Math.round(Math.max(nativeWidth, nativeHeight) * scale);
	}, [nativeWidth, nativeHeight, zoom, fitScale, playbackQuality]);
}

export function PreviewPanel() {
	const containerRef = useRef<HTMLDivElement>(null);
	const { isFullscreen, toggleFullscreen } = useFullscreen({ containerRef });

	// perf prototype (2026-07-14): NEXT_PUBLIC_WORKER_COMPOSITOR=1 or
	// localStorage["byorn-worker-compositor"]="1" swaps the preview canvas
	// for the worker-compositor path. Default OFF — untouched PreviewCanvas
	// otherwise. See worker-preview-canvas.tsx.
	//
	// Initial state only reads the build-time env var (identical on server
	// and client, so no hydration mismatch); the localStorage override is
	// checked in an effect AFTER mount, deferring any component swap to a
	// client-only re-render.
	const [workerCompositorEnabled, setWorkerCompositorEnabled] = useState(
		() => process.env.NEXT_PUBLIC_WORKER_COMPOSITOR === "1",
	);
	useEffect(() => {
		if (isWorkerCompositorEnabled()) setWorkerCompositorEnabled(true);
	}, []);

	return (
		<div
			ref={containerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<div className="grid grid-cols-[1fr_auto_1fr] items-center border-b">
				<div />
				<FramePresetPicker />
				<div className="justify-self-end pr-2">
					<GuidePickerButton />
				</div>
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-2 pb-0">
				{workerCompositorEnabled ? (
					<WorkerPreviewCanvas containerRef={containerRef} />
				) : (
					<PreviewCanvas
						onToggleFullscreen={toggleFullscreen}
						containerRef={containerRef}
					/>
				)}
				{/* WorkerPreviewCanvas owns its own scene tree inside the worker (plus
				    a main-thread overlay-only tree) when the worker compositor is
				    active — RenderTreeController's continuously-maintained
				    editor.renderer render tree has no consumer in that mode (the only
				    other reader, PreviewCanvas, isn't mounted either), so mounting it
				    would just be a redundant main-thread buildScene() on every edit.
				    The freeze-frame action (use-editor-actions.ts) builds its own
				    render tree on demand instead of depending on this one. */}
				{!workerCompositorEnabled && <RenderTreeController />}
			</div>
			<PreviewToolbar
				isFullscreen={isFullscreen}
				onToggleFullscreen={toggleFullscreen}
			/>
		</div>
	);
}

// Isolated leaf: only this button re-renders when the active guide changes,
// instead of the whole preview panel.
function GuidePickerButton() {
	const activeGuideId = usePreviewStore((state) => state.activeGuideId);

	return (
		<GuidePicker>
			<Button
				variant="text"
				size="icon"
				className={cn(activeGuideId && "text-primary bg-primary/10")}
				title="Guides"
			>
				<HugeiconsIcon icon={GridTableIcon} className="size-4" />
			</Button>
		</GuidePicker>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const tracks = editor.timeline.getTracks();
	const mediaAssets = editor.media.getAssets();
	const activeProject = editor.project.getActive();

	const { width, height } = usePreviewSize();
	const settled = useIsPlaybackSettled({ editor });
	const previewBackingStoreLongEdge = usePreviewBackingStoreLongEdge({
		nativeWidth: width,
		nativeHeight: height,
	});

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background: activeProject.settings.background,
			isPreview: true,
			// Defaults to true: once a proxy exists for an asset (auto-generated
			// in the background on ingest, or manually generated), preview/scrub
			// should use it automatically. Export always builds with isPreview
			// unset, so it never reads this and always decodes full-res
			// originals regardless of this setting. Gated on `!settled` on top of
			// that: playing/scrubbing keeps the proxy, but once the playhead has
			// been idle for PLAYBACK_SETTLE_DELAY_MS the scene rebuilds onto the
			// original so the held/paused frame is pixel-sharp (see
			// useIsPlaybackSettled — this is the fix for proxies staying in use on
			// paused frames).
			useProxy: (activeProject.settings.proxyEditing ?? true) && !settled,
			// Never display an upscaled proxy: if the canvas backing store would
			// need more pixels than the proxy has (zoomed-in preview, high DPR),
			// scene-builder falls back to the original per-element even while
			// !settled (playing). See proxyWouldBeUpscaled.
			previewBackingStoreLongEdge,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		activeProject?.settings.proxyEditing,
		width,
		height,
		settled,
		previewBackingStoreLongEdge,
	]);

	return null;
}

function PreviewCanvas({
	onToggleFullscreen,
	containerRef,
}: {
	onToggleFullscreen: () => void;
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const outerContainerRef = useRef<HTMLDivElement>(null);
	const canvasBoundsRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const renderingRef = useRef(false);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const containerSize = useContainerSize({ containerRef: outerContainerRef });
	const editor = useEditor();
	const activeProject = editor.project.getActive();
	const { overlays, zoom, pan, panMode, playbackQuality } = usePreviewStore();
	const [isPanning, setIsPanning] = useState(false);
	const [isPlaying, setIsPlaying] = useState(() =>
		editor.playback.getIsPlaying(),
	);
	const panDragRef = useRef<{
		pointerId: number;
		startClientX: number;
		startClientY: number;
		startPan: { x: number; y: number };
	} | null>(null);

	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
			// Live playback may serve the newest already-decoded frame instead
			// of stalling the render loop on a late decode (video-cache drop
			// policy). Only the preview renderer sets this.
			realtime: true,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps]);

	// Play/pause via the discrete channel — NOT the per-frame time tick — so
	// this component re-renders only on state changes, never 60×/sec.
	useEffect(() => {
		const unsubscribe = editor.playback.subscribe(() => {
			setIsPlaying(editor.playback.getIsPlaying());
		});
		return unsubscribe;
	}, [editor.playback]);

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

	const zoomedSize = useMemo(
		() => ({
			width: displaySize.width * zoom,
			height: displaySize.height * zoom,
		}),
		[displaySize.width, displaySize.height, zoom],
	);

	// Resolution the frame is composited at. While playing this can drop below
	// the project's native size (playback quality); paused/scrub-settled frames
	// always come back to full native res so stills stay crisp. CSS sizing
	// (zoomedSize) is unaffected — only the backing store shrinks.
	const renderSize = useMemo(() => {
		const native = { width: nativeWidth ?? 0, height: nativeHeight ?? 0 };
		if (!isPlaying || !nativeWidth || !nativeHeight) return native;
		const scale = getPlaybackRenderScale({
			quality: playbackQuality,
			nativeWidth,
			nativeHeight,
			displayWidth: displaySize.width,
			zoom,
			devicePixelRatio:
				typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
		});
		if (scale >= 1) return native;
		return {
			width: Math.max(2, Math.round(nativeWidth * scale)),
			height: Math.max(2, Math.round(nativeHeight * scale)),
		};
	}, [
		isPlaying,
		playbackQuality,
		nativeWidth,
		nativeHeight,
		displaySize.width,
		zoom,
	]);

	// Keep the compositor at the render resolution, and force the next rAF to
	// repaint the current frame: React committing new canvas width/height wiped
	// the visible canvas, and without bumping the guard the loop would skip the
	// redraw until the frame index changes. Layout effect so it lands before
	// the next rAF paints.
	useLayoutEffect(() => {
		if (
			renderer.width !== renderSize.width ||
			renderer.height !== renderSize.height
		) {
			renderer.setSize({
				width: renderSize.width,
				height: renderSize.height,
			});
		}
		lastFrameRef.current = -1;
	}, [renderer, renderSize.width, renderSize.height]);

	useEffect(() => {
		if (!nativeWidth || displaySize.width === 0) return;
		usePreviewStore
			.getState()
			.setFitScale({ fitScale: displaySize.width / nativeWidth });
	}, [displaySize.width, nativeWidth]);

	useEffect(() => {
		const container = outerContainerRef.current;
		if (!container) return;

		const handleWheel = (event: WheelEvent) => {
			event.preventDefault();
			const state = usePreviewStore.getState();
			const rect = container.getBoundingClientRect();
			const cursorX = event.clientX - rect.left - rect.width / 2;
			const cursorY = event.clientY - rect.top - rect.height / 2;
			const nextZoom = clampPreviewZoom({
				zoom: state.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
			});
			if (nextZoom === state.zoom) return;

			// Keep the canvas point under the cursor stationary while zooming.
			const scale = nextZoom / state.zoom;
			state.setZoomAndPan({
				zoom: nextZoom,
				pan: {
					x: cursorX - (cursorX - state.pan.x) * scale,
					y: cursorY - (cursorY - state.pan.y) * scale,
				},
			});
		};

		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => container.removeEventListener("wheel", handleWheel);
	}, []);

	const handlePanPointerDown = useCallback((event: React.PointerEvent) => {
		const state = usePreviewStore.getState();
		const isPanGesture =
			event.button === 1 || (state.panMode && event.button === 0);
		if (!isPanGesture) return;
		event.preventDefault();
		event.stopPropagation();
		panDragRef.current = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startPan: state.pan,
		};
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		setIsPanning(true);
	}, []);

	const handlePanPointerMove = useCallback((event: React.PointerEvent) => {
		const drag = panDragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) return;
		usePreviewStore.getState().setPan({
			pan: {
				x: drag.startPan.x + (event.clientX - drag.startClientX),
				y: drag.startPan.y + (event.clientY - drag.startClientY),
			},
		});
	}, []);

	const handlePanPointerUp = useCallback((event: React.PointerEvent) => {
		const drag = panDragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) return;
		panDragRef.current = null;
		setIsPanning(false);
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}, []);

	// Publish the composited-frame canvas so the scopes panel and auto
	// color-correction can sample pixels without prop-drilling the ref.
	useEffect(() => {
		usePreviewCanvasStore.getState().setCanvasEl({ canvas: canvasRef.current });
		return () => {
			usePreviewCanvasStore.getState().setCanvasEl({ canvas: null });
		};
	}, []);

	const renderTree = editor.renderer.getRenderTree();

	const render = useCallback(() => {
		if (!canvasRef.current || !renderTree) return;

		const time = editor.playback.getCurrentTime();
		const lastFrameTime = getLastFrameTime({
			duration: renderTree.duration,
			fps: renderer.fps,
		});
		const renderTime = Math.min(time, lastFrameTime);
		const frame = Math.floor(renderTime * renderer.fps);

		if (frame === lastFrameRef.current && renderTree === lastSceneRef.current) {
			return;
		}
		if (renderingRef.current) {
			// A new frame is due but the previous render is still in flight; it's
			// dropped (the next free tick renders the newest frame instead).
			if (perfStats.enabled) perfStats.countSkippedFrame();
			return;
		}

		renderingRef.current = true;
		lastSceneRef.current = renderTree;
		lastFrameRef.current = frame;

		const collect = perfStats.enabled;
		const renderStart = collect ? performance.now() : 0;
		if (collect) perfStats.beginFrame();

		renderer
			.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: canvasRef.current,
			})
			.then(() => {
				if (collect) {
					perfStats.endFrame({ totalMs: performance.now() - renderStart });
				}
			})
			.catch((error) => {
				perfStats.countRenderError();
				console.error("Preview render failed:", error);
			})
			// finally (not then): a rejected render must never leave the guard
			// stuck, which would freeze the preview permanently.
			.finally(() => {
				renderingRef.current = false;
			});
	}, [renderer, renderTree, editor.playback]);

	useRafLoop(render);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: canvas pan surface, pointer-only interaction
		<div
			ref={outerContainerRef}
			className={cn(
				"relative flex size-full items-center justify-center overflow-hidden",
				panMode && "cursor-grab",
				isPanning && "cursor-grabbing",
			)}
			onPointerDownCapture={handlePanPointerDown}
			onPointerMove={handlePanPointerMove}
			onPointerUp={handlePanPointerUp}
			onPointerCancel={handlePanPointerUp}
		>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						ref={canvasBoundsRef}
						className="relative shrink-0"
						style={{
							width: zoomedSize.width,
							height: zoomedSize.height,
							transform: `translate(${pan.x}px, ${pan.y}px)`,
						}}
					>
						<canvas
							ref={canvasRef}
							width={renderSize.width}
							height={renderSize.height}
							// Interaction overlays and hit-testing must keep working in
							// project-canvas coordinates even while the backing store is
							// downscaled during playback (see preview-coords.ts).
							data-logical-width={nativeWidth}
							data-logical-height={nativeHeight}
							className="block border"
							style={{
								width: zoomedSize.width,
								height: zoomedSize.height,
								background:
									activeProject.settings.background.type === "blur"
										? "transparent"
										: activeProject?.settings.background.color,
							}}
						/>
						{/* Preview-only chrome: rendered behind the interaction/transform/
						    mask-handle layers so it never steals pointer events, and never
						    composited into buildScene/export output. */}
						<LayoutGuideOverlay />
						<PreviewInteractionOverlay
							canvasRef={canvasRef}
							containerRef={canvasBoundsRef}
						/>
						{overlays.bookmarks && <BookmarkNoteOverlay />}
						{overlays.perfHud && <PerfHud />}
					</div>
				</ContextMenuTrigger>
				<PreviewContextMenu
					onToggleFullscreen={onToggleFullscreen}
					containerRef={containerRef}
				/>
			</ContextMenu>
		</div>
	);
}
