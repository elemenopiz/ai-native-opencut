import { create } from "zustand";

/**
 * Registry that exposes the live preview `<canvas>` element to non-preview
 * consumers (the color scopes panel, auto color-correction) so they can sample
 * the composited frame without prop-drilling the ref through the layout.
 *
 * The preview canvas registers itself on mount and clears on unmount. Read the
 * element imperatively via `usePreviewCanvasStore.getState().canvasEl` — don't
 * subscribe for render, it's a stable DOM handle, not reactive state.
 */
interface PreviewCanvasState {
	canvasEl: HTMLCanvasElement | null;
	setCanvasEl: ({ canvas }: { canvas: HTMLCanvasElement | null }) => void;
}

export const usePreviewCanvasStore = create<PreviewCanvasState>((set) => ({
	canvasEl: null,
	setCanvasEl: ({ canvas }) => set({ canvasEl: canvas }),
}));
