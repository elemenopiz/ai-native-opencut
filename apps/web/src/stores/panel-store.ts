import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PANEL_CONFIG } from "@/constants/editor-constants";

export interface PanelSizes {
	tools: number;
	preview: number;
	properties: number;
	mainContent: number;
	timeline: number;
}

export type PanelId = keyof PanelSizes;

interface PanelState {
	panels: PanelSizes;
	setPanel: (panel: PanelId, size: number) => void;
	setPanels: (sizes: Partial<PanelSizes>) => void;
	resetPanels: () => void;
}

export const usePanelStore = create<PanelState>()(
	persist(
		(set) => ({
			...PANEL_CONFIG,
			setPanel: (panel, size) =>
				set((state) => ({
					panels: {
						...state.panels,
						[panel]: size,
					},
				})),
			setPanels: (sizes) =>
				set((state) => ({
					panels: {
						...state.panels,
						...sizes,
					},
				})),
			resetPanels: () => set({ ...PANEL_CONFIG }),
		}),
		{
			name: "panel-sizes",
			version: 3,
			migrate: (persistedState) => {
				const state = persistedState as
					| {
							panels?: Partial<PanelSizes> | null;
							toolsPanel?: number;
							previewPanel?: number;
							propertiesPanel?: number;
							mainContent?: number;
							timeline?: number;
							tools?: number;
							preview?: number;
							properties?: number;
					  }
					| undefined
					| null;

				if (!state) return { panels: { ...PANEL_CONFIG.panels } };

				if (state.panels && typeof state.panels === "object") {
					const merged = {
						...PANEL_CONFIG.panels,
						...state.panels,
					};
					// v3 shrinks the default starting timeline height so the empty-editor
					// guide isn't clipped on first open. Only reset users still sitting on
					// the old 50/50 default — anyone who deliberately resized keeps their size.
					if (state.panels.mainContent === 50 && state.panels.timeline === 50) {
						merged.mainContent = PANEL_CONFIG.panels.mainContent;
						merged.timeline = PANEL_CONFIG.panels.timeline;
					}
					return { panels: merged };
				}

				return {
					panels: {
						tools: state.tools ?? state.toolsPanel ?? PANEL_CONFIG.panels.tools,
						preview:
							state.preview ??
							state.previewPanel ??
							PANEL_CONFIG.panels.preview,
						properties:
							state.properties ??
							state.propertiesPanel ??
							PANEL_CONFIG.panels.properties,
						mainContent: state.mainContent ?? PANEL_CONFIG.panels.mainContent,
						timeline: state.timeline ?? PANEL_CONFIG.panels.timeline,
					},
				};
			},
			partialize: (state) => ({
				panels: state.panels,
			}),
		},
	),
);
