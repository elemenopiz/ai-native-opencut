import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Preview-only guide overlays. Only one is ever shown at a time. */
export type GuideId = "tiktok" | "grid";

export interface GridConfig {
	rows: number;
	cols: number;
}

export const GRID_MIN = 1;
export const GRID_MAX = 24;
export const DEFAULT_GRID_CONFIG: GridConfig = { rows: 3, cols: 3 };

/** Clamp + round a grid rows/cols value to the supported range. */
export function clampGridValue(value: number): number {
	return Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(value)));
}

/**
 * Positions (as a 0–100 percentage) of the interior grid lines for a
 * `rows` x `cols` grid — i.e. `cols - 1` vertical lines and `rows - 1`
 * horizontal lines, evenly spaced. Shared by the canvas overlay and the
 * guide-picker's preview thumbnails so both draw the identical grid.
 */
export function computeGridLines({ rows, cols }: GridConfig): {
	verticals: number[];
	horizontals: number[];
} {
	const verticals = Array.from(
		{ length: Math.max(0, cols - 1) },
		(_, i) => ((i + 1) / cols) * 100,
	);
	const horizontals = Array.from(
		{ length: Math.max(0, rows - 1) },
		(_, i) => ((i + 1) / rows) * 100,
	);
	return { verticals, horizontals };
}

interface PreviewOverlaysState {
	bookmarks: boolean;
}

export const PREVIEW_MIN_ZOOM = 0.25;
export const PREVIEW_MAX_ZOOM = 8;

export function clampPreviewZoom({ zoom }: { zoom: number }): number {
	return Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, zoom));
}

interface PreviewState {
	/** The single active preview guide overlay, or null if none is shown. */
	activeGuideId: GuideId | null;
	/** Rows/cols for the grid guide (used only while activeGuideId === "grid"). */
	gridConfig: GridConfig;
	overlays: PreviewOverlaysState;
	/** Zoom multiplier relative to the fit-to-panel size (1 = fit). */
	zoom: number;
	/** Pan offset of the canvas in screen pixels, relative to the centered position. */
	pan: { x: number; y: number };
	/** When true, click-dragging the preview pans instead of selecting elements. */
	panMode: boolean;
	/** Display pixels per canvas pixel at zoom 1 (set by the preview canvas). */
	fitScale: number;
	/** Show `guideId`'s overlay, or hide it again if it's already active. */
	toggleGuide: (guideId: GuideId) => void;
	setGridConfig: (config: Partial<GridConfig>) => void;
	setOverlayVisibility: ({
		overlay,
		isVisible,
	}: {
		overlay: keyof PreviewOverlaysState;
		isVisible: boolean;
	}) => void;
	toggleOverlayVisibility: ({
		overlay,
	}: {
		overlay: keyof PreviewOverlaysState;
	}) => void;
	setZoom: ({ zoom }: { zoom: number }) => void;
	setPan: ({ pan }: { pan: { x: number; y: number } }) => void;
	setZoomAndPan: ({
		zoom,
		pan,
	}: {
		zoom: number;
		pan: { x: number; y: number };
	}) => void;
	togglePanMode: () => void;
	setFitScale: ({ fitScale }: { fitScale: number }) => void;
	resetView: () => void;
}

const DEFAULT_PREVIEW_OVERLAYS: PreviewOverlaysState = {
	bookmarks: true,
};

/** Persisted slice of `PreviewState` (see `partialize` below). */
export type PersistedPreviewState = {
	activeGuideId: GuideId | null;
	gridConfig: GridConfig;
	overlays: PreviewOverlaysState;
};

/**
 * Migrates persisted `preview-settings` storage to the current (v3) shape.
 * v2 and earlier stored the active guide as `layoutGuide.platform`; v3
 * generalized it to `activeGuideId` and added `gridConfig`. Exported
 * standalone (rather than inlined in `persist()`) so it's unit-testable
 * without going through zustand's storage rehydration.
 */
export function migratePreviewState(
	persistedState: unknown,
): PersistedPreviewState {
	const state = persistedState as
		| {
				// v2 shape
				layoutGuide?: { platform: GuideId | null };
				// v3 shape
				activeGuideId?: GuideId | null;
				gridConfig?: GridConfig;
				overlays?: PreviewOverlaysState;
		  }
		| undefined;
	return {
		activeGuideId: state?.activeGuideId ?? state?.layoutGuide?.platform ?? null,
		gridConfig: state?.gridConfig ?? DEFAULT_GRID_CONFIG,
		overlays: state?.overlays ?? DEFAULT_PREVIEW_OVERLAYS,
	};
}

export const usePreviewStore = create<PreviewState>()(
	persist(
		(set) => ({
			activeGuideId: null,
			gridConfig: DEFAULT_GRID_CONFIG,
			overlays: DEFAULT_PREVIEW_OVERLAYS,
			zoom: 1,
			pan: { x: 0, y: 0 },
			panMode: false,
			fitScale: 0,
			toggleGuide: (guideId) => {
				set((state) => ({
					activeGuideId: state.activeGuideId === guideId ? null : guideId,
				}));
			},
			setGridConfig: (config) => {
				set((state) => ({
					gridConfig: {
						rows: clampGridValue(config.rows ?? state.gridConfig.rows),
						cols: clampGridValue(config.cols ?? state.gridConfig.cols),
					},
				}));
			},
			setOverlayVisibility: ({ overlay, isVisible }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlay]: isVisible,
					},
				}));
			},
			toggleOverlayVisibility: ({ overlay }) => {
				set((state) => ({
					overlays: {
						...state.overlays,
						[overlay]: !state.overlays[overlay],
					},
				}));
			},
			setZoom: ({ zoom }) => {
				set(() => ({ zoom: clampPreviewZoom({ zoom }) }));
			},
			setPan: ({ pan }) => {
				set(() => ({ pan }));
			},
			setZoomAndPan: ({ zoom, pan }) => {
				set(() => ({ zoom: clampPreviewZoom({ zoom }), pan }));
			},
			togglePanMode: () => {
				set((state) => ({ panMode: !state.panMode }));
			},
			setFitScale: ({ fitScale }) => {
				set(() => ({ fitScale }));
			},
			resetView: () => {
				set(() => ({ zoom: 1, pan: { x: 0, y: 0 } }));
			},
		}),
		{
			name: "preview-settings",
			version: 3,
			migrate: migratePreviewState,
			partialize: (state) => ({
				activeGuideId: state.activeGuideId,
				gridConfig: state.gridConfig,
				overlays: state.overlays,
			}),
		},
	),
);
