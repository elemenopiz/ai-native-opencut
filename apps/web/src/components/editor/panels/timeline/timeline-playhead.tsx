"use client";

import { useEffect, useRef } from "react";
import {
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
	timelineTimeToSnappedPixels,
} from "@/lib/timeline";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useTimelinePlayhead } from "@/hooks/timeline/use-timeline-playhead";
import { useEditor } from "@/hooks/use-editor";

interface TimelinePlayheadProps {
	zoomLevel: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	playheadRef?: React.RefObject<HTMLDivElement | null>;
	isSnappingToPlayhead?: boolean;
}

export function TimelinePlayhead({
	zoomLevel,
	rulerRef,
	rulerScrollRef,
	tracksScrollRef,
	timelineRef,
	playheadRef: externalPlayheadRef,
	isSnappingToPlayhead = false,
}: TimelinePlayheadProps) {
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const internalPlayheadRef = useRef<HTMLDivElement>(null);
	const playheadRef = externalPlayheadRef || internalPlayheadRef;

	// Cached ruler-viewport geometry for the playback rAF loop below. Reading
	// clientWidth/scrollWidth/scrollLeft from the DOM on every tick (right
	// after writing a layout-affecting style) forces a synchronous
	// style/layout recalc every frame. Instead we track the three numbers we
	// need out-of-band — width/content-width via ResizeObserver, scroll
	// offset via a passive scroll listener — so the rAF tick never touches
	// layout-reading DOM getters at all.
	const viewportMetricsRef = useRef({
		clientWidth: 0,
		scrollWidth: 0,
		scrollLeft: 0,
	});

	useEffect(() => {
		const rulerViewport = rulerScrollRef.current;
		if (!rulerViewport) return;

		const readSize = () => {
			viewportMetricsRef.current.clientWidth = rulerViewport.clientWidth;
			viewportMetricsRef.current.scrollWidth = rulerViewport.scrollWidth;
		};
		const readScroll = () => {
			viewportMetricsRef.current.scrollLeft = rulerViewport.scrollLeft;
		};

		readSize();
		readScroll();

		const resizeObserver = new ResizeObserver(readSize);
		resizeObserver.observe(rulerViewport);
		// The viewport's own box only changes on panel/window resize; the
		// scrollable *content* (which drives scrollWidth) is this single
		// wrapping child (see timeline/index.tsx) — observe it too so zoom
		// and content-width changes stay in sync without a per-tick read.
		const contentEl = rulerViewport.firstElementChild;
		if (contentEl) resizeObserver.observe(contentEl);

		rulerViewport.addEventListener("scroll", readScroll, { passive: true });

		return () => {
			resizeObserver.disconnect();
			rulerViewport.removeEventListener("scroll", readScroll);
		};
	}, [rulerScrollRef]);

	const { playheadPosition, handlePlayheadMouseDown } = useTimelinePlayhead({
		zoomLevel,
		rulerRef,
		rulerScrollRef,
		tracksScrollRef,
		playheadRef,
	});

	// Use scrollHeight (total content) so the playhead extends through all tracks,
	// not just the visible viewport
	const timelineContainerHeight = Math.max(
		tracksScrollRef.current?.scrollHeight ?? 0,
		tracksScrollRef.current?.clientHeight ?? 0,
		timelineRef.current?.clientHeight ?? 400,
	);
	const totalHeight = Math.max(0, timelineContainerHeight - 4);

	const centerPosition = timelineTimeToSnappedPixels({
		time: playheadPosition,
		zoomLevel,
	});
	const leftPosition = getCenteredLineLeft({ centerPixel: centerPosition });

	// While playing, advance the playhead directly via the DOM in a RAF loop
	// rather than through React. Playback ticks on a separate time channel
	// (subscribeTime) that deliberately does NOT re-render the editor tree, so
	// this component stays mounted-but-idle during playback; this effect moves
	// the marker (and follows it with the viewport scroll) without paying for
	// ~60Hz reconciliation of the whole editor.
	const isPlaying = editor.playback.getIsPlaying();
	const isScrubbing = editor.playback.getIsScrubbing();

	useEffect(() => {
		if (!isPlaying || isScrubbing) return;
		const el = playheadRef.current;
		if (!el) return;

		let raf = 0;
		const tick = () => {
			// Read cached (out-of-band) geometry first, then write — never the
			// other way around — so this tick never triggers a forced
			// synchronous layout.
			const metrics = viewportMetricsRef.current;
			const time = editor.playback.getCurrentTime();
			const centerPixel = timelineTimeToSnappedPixels({ time, zoomLevel });

			// Compositor-only write: transform never invalidates layout, unlike
			// the `left` write this replaced.
			el.style.transform = `translateX(${getCenteredLineLeft({ centerPixel })}px)`;

			// Follow-scroll: the React-driven equivalent in useTimelinePlayhead is
			// frozen during playback (no re-renders), so keep the playhead in view
			// here instead. Uses the cached metrics above instead of reading
			// clientWidth/scrollWidth/scrollLeft off the DOM every tick.
			const rulerViewport = rulerScrollRef.current;
			const tracksViewport = tracksScrollRef.current;
			if (rulerViewport && tracksViewport) {
				const playheadPixels =
					time * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
				const viewportWidth = metrics.clientWidth;
				const scrollMaximum = metrics.scrollWidth - viewportWidth;
				if (
					playheadPixels < metrics.scrollLeft ||
					playheadPixels > metrics.scrollLeft + viewportWidth
				) {
					const desiredScroll = Math.max(
						0,
						Math.min(scrollMaximum, playheadPixels - viewportWidth / 2),
					);
					rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
					// Keep the cache in sync immediately rather than waiting for the
					// (async) scroll event, so the next tick's comparison is correct.
					metrics.scrollLeft = desiredScroll;
				}
			}

			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [
		isPlaying,
		isScrubbing,
		zoomLevel,
		editor.playback,
		playheadRef,
		rulerScrollRef,
		tracksScrollRef,
	]);

	const handlePlayheadKeyDown = (
		event: React.KeyboardEvent<HTMLDivElement>,
	) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

		event.preventDefault();
		const step = 1 / Math.max(1, editor.project.getActive().settings.fps);
		const direction = event.key === "ArrowRight" ? 1 : -1;
		const nextTime = Math.max(
			0,
			Math.min(duration, playheadPosition + direction * step),
		);

		editor.playback.seek({ time: nextTime });
	};

	return (
		<div
			ref={playheadRef}
			role="slider"
			aria-label="Timeline playhead"
			aria-valuemin={0}
			aria-valuemax={duration}
			aria-valuenow={playheadPosition}
			tabIndex={0}
			className="pointer-events-none absolute z-5"
			style={{
				left: 0,
				top: 0,
				height: `${totalHeight}px`,
				width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
				// Positioned via transform (not `left`) so the rAF playback loop
				// below can move the marker with a single compositor-only write
				// instead of a layout-invalidating one. React re-renders (rest,
				// scrub, resize) set the same property here; the rAF loop
				// overwrites it directly during playback.
				transform: `translateX(${leftPosition}px)`,
			}}
			onKeyDown={handlePlayheadKeyDown}
		>
			<div className="bg-foreground pointer-events-none absolute left-0 h-full w-0.5" />

			<button
				type="button"
				aria-label="Drag playhead"
				className={`pointer-events-auto absolute top-1 left-1/2 size-3 -translate-x-1/2 transform cursor-col-resize rounded-full border-2 shadow-xs ${isSnappingToPlayhead ? "bg-foreground border-foreground" : "bg-foreground border-foreground/50"}`}
				onMouseDown={handlePlayheadMouseDown}
			/>
		</div>
	);
}
