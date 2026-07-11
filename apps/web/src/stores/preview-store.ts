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

/**
 * Compositing resolution used WHILE PLAYING, as a fraction of the project's
 * native canvas size. Paused/scrubbed-to frames always render at full native
 * resolution so stills stay crisp regardless of this setting.
 */
export type PlaybackQuality = "auto" | "full" | "half" | "quarter";

/** Quantization step for the auto render scale — continuous wheel zoom during
 *  playback must not resize the canvas backing store on every tick. */
const AUTO_QUALITY_SCALE_STEP = 1 / 8;
/** Auto quality never composites below this long edge, however small the
 *  preview is displayed. */
const AUTO_QUALITY_MIN_LONG_EDGE = 480;

/**
 * The fraction of the native canvas size to composite at during playback.
 * "auto" targets the actually-displayed pixel size (display size × zoom ×
 * dpr), so a 4K project shown in a ~600px panel composites at roughly a
 * quarter of native instead of rendering pixels that are immediately thrown
 * away by the CSS downscale.
 */
export function getPlaybackRenderScale({
	quality,
	nativeWidth,
	nativeHeight,
	displayWidth,
	zoom,
	devicePixelRatio,
}: {
	quality: PlaybackQuality;
	nativeWidth: number;
	nativeHeight: number;
	displayWidth: number;
	zoom: number;
	devicePixelRatio: number;
}): number {
	if (quality === "full") return 1;
	if (quality === "half") return 0.5;
	if (quality === "quarter") return 0.25;

	if (!nativeWidth || !nativeHeight || !displayWidth) return 1;
	const dpr = Math.min(Math.max(devicePixelRatio, 1), 2);
	const raw = (displayWidth * zoom * dpr) / nativeWidth;
	const quantized =
		Math.ceil(raw / AUTO_QUALITY_SCALE_STEP) * AUTO_QUALITY_SCALE_STEP;
	const floor =
		AUTO_QUALITY_MIN_LONG_EDGE / Math.max(nativeWidth, nativeHeight);
	return Math.min(1, Math.max(quantized, floor));
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
	/** Compositing resolution while playing (paused frames are always full-res). */
	playbackQuality: PlaybackQuality;
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
	setPlaybackQuality: ({ quality }: { quality: PlaybackQuality }) => void;
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
	playbackQuality: PlaybackQuality;
};

/**
 * Migrates persisted `preview-settings` storage to the current (v4) shape.
 * v2 and earlier stored the active guide as `layoutGuide.platform`; v3
 * generalized it to `activeGuideId` and added `gridConfig`; v4 added
 * `playbackQuality`. Exported standalone (rather than inlined in `persist()`)
 * so it's unit-testable without going through zustand's storage rehydration.
 */
export function migratePreviewState(
	persistedState: unknown,
): PersistedPreviewState {
	const state = persistedState as
		| {
				// v2 shape
				layoutGuide?: { platform: GuideId | null };
				// v3+ shape
				activeGuideId?: GuideId | null;
				gridConfig?: GridConfig;
				overlays?: PreviewOverlaysState;
				// v4 shape
				playbackQuality?: PlaybackQuality;
		  }
		| undefined;
	return {
		activeGuideId: state?.activeGuideId ?? state?.layoutGuide?.platform ?? null,
		gridConfig: state?.gridConfig ?? DEFAULT_GRID_CONFIG,
		overlays: state?.overlays ?? DEFAULT_PREVIEW_OVERLAYS,
		playbackQuality: state?.playbackQuality ?? "auto",
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
			playbackQuality: "auto",
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
			setPlaybackQuality: ({ quality }) => {
				set(() => ({ playbackQuality: quality }));
			},
			resetView: () => {
				set(() => ({ zoom: 1, pan: { x: 0, y: 0 } }));
			},
		}),
		{
			name: "preview-settings",
			version: 4,
			migrate: migratePreviewState,
			partialize: (state) => ({
				activeGuideId: state.activeGuideId,
				gridConfig: state.gridConfig,
				overlays: state.overlays,
				playbackQuality: state.playbackQuality,
			}),
		},
	),
);
