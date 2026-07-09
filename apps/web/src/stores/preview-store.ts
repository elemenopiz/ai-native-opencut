import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TPlatformLayout } from "@/types/editor";

interface LayoutGuideSettings {
	platform: TPlatformLayout | null;
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
	layoutGuide: LayoutGuideSettings;
	overlays: PreviewOverlaysState;
	/** Zoom multiplier relative to the fit-to-panel size (1 = fit). */
	zoom: number;
	/** Pan offset of the canvas in screen pixels, relative to the centered position. */
	pan: { x: number; y: number };
	/** When true, click-dragging the preview pans instead of selecting elements. */
	panMode: boolean;
	/** Display pixels per canvas pixel at zoom 1 (set by the preview canvas). */
	fitScale: number;
	setLayoutGuide: (settings: Partial<LayoutGuideSettings>) => void;
	toggleLayoutGuide: (platform: TPlatformLayout) => void;
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

export const usePreviewStore = create<PreviewState>()(
	persist(
		(set) => ({
			layoutGuide: { platform: null },
			overlays: DEFAULT_PREVIEW_OVERLAYS,
			zoom: 1,
			pan: { x: 0, y: 0 },
			panMode: false,
			fitScale: 0,
			setLayoutGuide: (settings) => {
				set((state) => ({
					layoutGuide: {
						...state.layoutGuide,
						...settings,
					},
				}));
			},
			toggleLayoutGuide: (platform) => {
				set((state) => ({
					layoutGuide: {
						platform: state.layoutGuide.platform === platform ? null : platform,
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
			version: 2,
			migrate: (persistedState) => {
				const state = persistedState as
					| {
							layoutGuide?: LayoutGuideSettings;
							overlays?: PreviewOverlaysState;
					  }
					| undefined;
				return {
					layoutGuide: state?.layoutGuide ?? { platform: null },
					overlays: state?.overlays ?? DEFAULT_PREVIEW_OVERLAYS,
				};
			},
			partialize: (state) => ({
				layoutGuide: state.layoutGuide,
				overlays: state.overlays,
			}),
		},
	),
);
