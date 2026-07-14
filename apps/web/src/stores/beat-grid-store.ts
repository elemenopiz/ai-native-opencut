/**
 * Beat-snap grid state: the analyzed beat positions of one music/audio clip,
 * plus the snap toggle. Beats are stored in SOURCE time and mapped through
 * the clip's current placement, so the grid follows the clip when it is
 * moved or trimmed and disappears if the clip is deleted.
 */

import { create } from "zustand";
import type { TimelineTrack, TimelineElement } from "@/types/timeline";
import {
	mapBeatsToTimeline,
	type BeatMarker,
} from "@/lib/timeline/audio-sync-utils";

export interface BeatGrid {
	/** The element the beats were analyzed from. */
	elementId: string;
	trackId: string;
	mediaId: string;
	/** Beat timestamps in SOURCE time (seconds into the media file). */
	beats: number[];
	/** Subset of `beats` flagged as downbeats. */
	downbeats: number[];
	bpm: number | null;
	energyClass: string | null;
	analyzedAt: number;
}

interface BeatGridStore {
	grid: BeatGrid | null;
	beatSnappingEnabled: boolean;
	isAnalyzing: boolean;
	setGrid: (grid: BeatGrid | null) => void;
	setAnalyzing: (isAnalyzing: boolean) => void;
	toggleBeatSnapping: () => void;
	/**
	 * Drop the analyzed grid (project-scoped — its elementId/trackId/mediaId
	 * point into one project's timeline). Keeps `beatSnappingEnabled`: that's a
	 * user preference, not project state.
	 */
	reset: () => void;
}

export const useBeatGridStore = create<BeatGridStore>()((set) => ({
	grid: null,
	beatSnappingEnabled: true,
	isAnalyzing: false,

	setGrid: (grid) => {
		set({ grid });
	},

	setAnalyzing: (isAnalyzing) => {
		set({ isAnalyzing });
	},

	toggleBeatSnapping: () => {
		set((state) => ({ beatSnappingEnabled: !state.beatSnappingEnabled }));
	},

	reset: () => {
		set({ grid: null, isAnalyzing: false });
	},
}));

function findGridElement({
	tracks,
	grid,
}: {
	tracks: TimelineTrack[];
	grid: BeatGrid;
}): TimelineElement | null {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.id === grid.elementId) return element;
		}
	}
	return null;
}

/** Beat markers in TIMELINE time for the current grid, or [] when absent. */
export function getTimelineBeatMarkers({
	tracks,
	grid,
}: {
	tracks: TimelineTrack[];
	grid: BeatGrid | null;
}): BeatMarker[] {
	if (!grid) return [];
	const element = findGridElement({ tracks, grid });
	if (!element) return [];
	return mapBeatsToTimeline({
		element,
		beats: grid.beats,
		downbeats: grid.downbeats,
	});
}

/**
 * Beat positions (TIMELINE time) to feed into `findSnapPoints`. Returns []
 * when beat snapping is off or no grid is active — callers can pass the
 * result unconditionally. Safe outside React (uses getState); intended for
 * pointer-event handlers.
 */
export function getSnapBeats({
	tracks,
}: {
	tracks: TimelineTrack[];
}): number[] {
	const { grid, beatSnappingEnabled } = useBeatGridStore.getState();
	if (!beatSnappingEnabled) return [];
	return getTimelineBeatMarkers({ tracks, grid }).map((marker) => marker.time);
}
