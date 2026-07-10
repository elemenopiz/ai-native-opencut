"use client";

/**
 * Marker flags rendered inside the timeline ruler. Markers live in absolute
 * timeline time (see `core/managers/scenes-manager`) and are colored per the
 * user's choice. Mirrors `beat-ticks.tsx`: purely presentational, pointer
 * events disabled so the ruler underneath stays interactive. Re-renders when
 * markers change because `useEditor` subscribes to the scenes manager.
 */

import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEditor } from "@/hooks/use-editor";

const MARKER_TICK_COLOR: Record<string, string> = {
	red: "bg-red-500",
	yellow: "bg-yellow-500",
	green: "bg-green-500",
	blue: "bg-blue-500",
	purple: "bg-purple-500",
};

const markerColorClass = (color: string): string =>
	MARKER_TICK_COLOR[color] ?? "bg-red-500";

export function MarkerTicks({ zoomLevel }: { zoomLevel: number }) {
	const editor = useEditor();
	const markers = editor.scenes.getMarkers();

	if (markers.length === 0) return null;

	const pixelsPerSecond = TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;

	return (
		<div
			className="pointer-events-none absolute inset-0"
			aria-hidden="true"
			data-marker-count={markers.length}
		>
			{markers.map((marker) => (
				<div
					key={marker.id}
					className={`absolute top-0 h-full w-px ${markerColorClass(marker.color)}`}
					style={{ left: `${marker.time * pixelsPerSecond}px` }}
				>
					<div
						className={`absolute top-0 left-0 size-1.5 rounded-sm ${markerColorClass(marker.color)}`}
					/>
				</div>
			))}
		</div>
	);
}
