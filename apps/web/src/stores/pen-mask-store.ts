import { create } from "zustand";

/**
 * Transient UI state for the custom pen-tool mask, shared between the
 * properties panel (crop-mask.tsx, which enters/exits draw mode) and the
 * preview overlay (pen-mask-handles.tsx, which handles on-canvas interaction).
 * Nothing here is persisted — it is reset when the element/mask changes.
 */
interface PenMaskStore {
	/** The element id currently in "draw" mode (canvas clicks append anchors), or null. */
	drawingElementId: string | null;
	/** Selected anchor point ids (highlighted, targeted by delete). */
	selectedPointIds: string[];
	startDrawing: (elementId: string) => void;
	stopDrawing: () => void;
	toggleDrawing: (elementId: string) => void;
	setSelectedPoints: (pointIds: string[]) => void;
	reset: () => void;
}

export const usePenMaskStore = create<PenMaskStore>((set) => ({
	drawingElementId: null,
	selectedPointIds: [],
	startDrawing: (elementId) =>
		set({ drawingElementId: elementId, selectedPointIds: [] }),
	stopDrawing: () => set({ drawingElementId: null }),
	toggleDrawing: (elementId) =>
		set((state) => ({
			drawingElementId: state.drawingElementId === elementId ? null : elementId,
			selectedPointIds: [],
		})),
	setSelectedPoints: (pointIds) => set({ selectedPointIds: pointIds }),
	reset: () => set({ drawingElementId: null, selectedPointIds: [] }),
}));
