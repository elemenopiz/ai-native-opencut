"use client";

/**
 * Beat-grid tick marks rendered inside the timeline ruler. Beats live in
 * SOURCE time on the analyzed clip (see `stores/beat-grid-store`) and are
 * mapped through the clip's current placement, so ticks follow the clip when
 * it moves and vanish if it is deleted.
 */

import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import { useEditor } from "@/hooks/use-editor";
import {
	getTimelineBeatMarkers,
	useBeatGridStore,
} from "@/stores/beat-grid-store";

export function BeatTicks({ zoomLevel }: { zoomLevel: number }) {
	const editor = useEditor();
	const grid = useBeatGridStore((s) => s.grid);
	const beatSnappingEnabled = useBeatGridStore((s) => s.beatSnappingEnabled);

	if (!grid) return null;

	const markers = getTimelineBeatMarkers({
		tracks: editor.timeline.getTracks(),
		grid,
	});
	if (markers.length === 0) return null;

	const pixelsPerSecond = TIMELINE_CONSTANTS.PIXELS_PER_SECOND * zoomLevel;

	return (
		<div
			className="pointer-events-none absolute inset-0"
			aria-hidden="true"
			data-beat-count={markers.length}
		>
			{markers.map((marker) => (
				<div
					key={marker.time}
					className={
						marker.isDownbeat
							? "absolute bottom-0 w-px bg-primary/80"
							: "absolute bottom-0 w-px bg-primary/40"
					}
					style={{
						left: `${marker.time * pixelsPerSecond}px`,
						height: marker.isDownbeat ? "10px" : "6px",
						opacity: beatSnappingEnabled ? 1 : 0.35,
					}}
				/>
			))}
		</div>
	);
}
