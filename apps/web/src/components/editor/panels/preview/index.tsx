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
import { PreviewToolbar } from "./toolbar";
import { FramePresetPicker } from "./frame-preset-picker";
import { cn } from "@/utils/ui";

const WHEEL_ZOOM_SENSITIVITY = 0.0015;

function usePreviewSize() {
	const editor = useEditor();
	const activeProject = editor.project.getActive();

	return {
		width: activeProject?.settings.canvasSize.width,
		height: activeProject?.settings.canvasSize.height,
	};
}

export function PreviewPanel() {
	const containerRef = useRef<HTMLDivElement>(null);
	const { isFullscreen, toggleFullscreen } = useFullscreen({ containerRef });

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
				<PreviewCanvas
					onToggleFullscreen={toggleFullscreen}
					containerRef={containerRef}
				/>
				<RenderTreeController />
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
			useProxy: activeProject.settings.proxyEditing ?? false,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [
		tracks,
		mediaAssets,
		activeProject?.settings.background,
		activeProject?.settings.proxyEditing,
		width,
		height,
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
		if (canvasRef.current && renderTree && !renderingRef.current) {
			const time = editor.playback.getCurrentTime();
			const lastFrameTime = getLastFrameTime({
				duration: renderTree.duration,
				fps: renderer.fps,
			});
			const renderTime = Math.min(time, lastFrameTime);
			const frame = Math.floor(renderTime * renderer.fps);

			if (
				frame !== lastFrameRef.current ||
				renderTree !== lastSceneRef.current
			) {
				renderingRef.current = true;
				lastSceneRef.current = renderTree;
				lastFrameRef.current = frame;
				renderer
					.renderToCanvas({
						node: renderTree,
						time: renderTime,
						targetCanvas: canvasRef.current,
					})
					.then(() => {
						renderingRef.current = false;
					});
			}
		}
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
