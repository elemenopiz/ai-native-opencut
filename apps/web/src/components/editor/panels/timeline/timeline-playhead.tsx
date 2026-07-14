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
import { useScrubAudio } from "@/hooks/audio/use-scrub-audio";

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

	const { playheadPosition, handlePlayheadMouseDown } = useTimelinePlayhead({
		zoomLevel,
		rulerRef,
		rulerScrollRef,
		tracksScrollRef,
		playheadRef,
	});
	const scrubAudio = useScrubAudio();

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
			const time = editor.playback.getCurrentTime();
			const centerPixel = timelineTimeToSnappedPixels({ time, zoomLevel });
			el.style.left = `${getCenteredLineLeft({ centerPixel })}px`;

			// Follow-scroll: the React-driven equivalent in useTimelinePlayhead is
			// frozen during playback (no re-renders), so keep the playhead in view
			// here instead.
			const rulerViewport = rulerScrollRef.current;
			const tracksViewport = tracksScrollRef.current;
			if (rulerViewport && tracksViewport) {
				const playheadPixels =
					time * TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;
				const viewportWidth = rulerViewport.clientWidth;
				const scrollMaximum = rulerViewport.scrollWidth - viewportWidth;
				if (
					playheadPixels < rulerViewport.scrollLeft ||
					playheadPixels > rulerViewport.scrollLeft + viewportWidth
				) {
					const desiredScroll = Math.max(
						0,
						Math.min(scrollMaximum, playheadPixels - viewportWidth / 2),
					);
					rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
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
		// Single-frame step: one audible grain at the landed frame (§4.2).
		scrubAudio.onFrameStep(nextTime, direction === 1 ? "forward" : "reverse");
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
				left: `${leftPosition}px`,
				top: 0,
				height: `${totalHeight}px`,
				width: `${TIMELINE_INDICATOR_LINE_WIDTH_PX}px`,
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
