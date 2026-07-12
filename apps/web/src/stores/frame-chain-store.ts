import { create } from "zustand";

/**
 * Frame-chaining seam. When a user extracts a still from a clip and clicks
 * "Use as next first frame" / "Use in Generate", the frame's HOSTED (R2) URL is
 * parked here. The always-open right panel watches this store, switches to its
 * Generate tab, and the GenerationForm consumes the pending frame — dropping it
 * into the First-frame slot. This is a tiny cross-component channel because the
 * RightPanel's active tab and the GenerationForm's frame state are both LOCAL
 * component state (no shared context to thread a value through).
 *
 * `nonce` is bumped on every `setPendingFirstFrame` so the consumer re-applies
 * even if the same URL is chained twice in a row (a plain value change wouldn't
 * re-fire).
 */

export interface PendingFirstFrame {
	/** Publicly-fetchable (R2) URL — providers pull generation seeds server-side. */
	url: string;
	/** Short human label for the toast/source (e.g. "clip — last frame"). */
	label: string;
}

interface FrameChainState {
	pendingFirstFrame: PendingFirstFrame | null;
	/** Bumped on each set so identical consecutive frames still re-apply. */
	nonce: number;
	/** Park a hosted frame to become the next generation's first frame. */
	setPendingFirstFrame: (frame: PendingFirstFrame) => void;
	/** Clear after the GenerationForm has consumed it. */
	clearPendingFirstFrame: () => void;
}

export const useFrameChainStore = create<FrameChainState>((set) => ({
	pendingFirstFrame: null,
	nonce: 0,
	setPendingFirstFrame: (frame) =>
		set((s) => ({ pendingFirstFrame: frame, nonce: s.nonce + 1 })),
	clearPendingFirstFrame: () => set({ pendingFirstFrame: null }),
}));
