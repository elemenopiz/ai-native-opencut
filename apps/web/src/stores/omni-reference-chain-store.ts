import { create } from "zustand";

/**
 * Omni-reference chaining seam. When a user trims a raw asset down on the
 * timeline and clicks "Send to Omni Reference" — as a still image or a video
 * with motion — the rendered clip's HOSTED (R2) URL is parked here. The
 * always-open right panel watches this store, switches to its Generate tab, and
 * the GenerationForm consumes the pending reference — APPENDING it as a new chip
 * to the Seedance Omni reference list (unlike the first-frame seam, which
 * replaces a single slot). This is a tiny cross-component channel because the
 * RightPanel's active tab and the GenerationForm's reference list are both LOCAL
 * component state (no shared context to thread a value through).
 *
 * `nonce` is bumped on every `setPendingReference` so the consumer re-applies
 * even if the same URL is chained twice in a row (a plain value change wouldn't
 * re-fire). Mirrors frame-chain-store.ts, generalized for either media kind.
 */

export interface PendingOmniReference {
	/** Publicly-fetchable (R2) URL — providers pull reference media server-side. */
	url: string;
	kind: "image" | "video";
	/** Short human label for the chip (e.g. "clip — trimmed" or "clip — with edits"). */
	label: string;
}

interface OmniReferenceChainState {
	pendingReference: PendingOmniReference | null;
	/** Bumped on each set so identical consecutive references still re-apply. */
	nonce: number;
	/** Park a hosted clip to become the next generation's omni reference. */
	setPendingReference: (ref: PendingOmniReference) => void;
	/** Clear after the GenerationForm has consumed it. */
	clearPendingReference: () => void;
}

export const useOmniReferenceChainStore = create<OmniReferenceChainState>(
	(set) => ({
		pendingReference: null,
		nonce: 0,
		setPendingReference: (ref) =>
			set((s) => ({ pendingReference: ref, nonce: s.nonce + 1 })),
		clearPendingReference: () => set({ pendingReference: null }),
	}),
);
