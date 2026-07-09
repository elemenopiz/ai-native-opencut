import { create } from "zustand";

/**
 * Cross-panel signal for the Takes tab icon. Generation happens in the right
 * panel (GenerateView) while takes live in the left-rail "Takes" tab — these are
 * separate component trees, so we broadcast status through a tiny store:
 *
 *   idle       → normal star icon
 *   generating → star fills with blue (a generation is in flight)
 *   ready       → star stays solid blue (takes are waiting, unseen) until the
 *                 user opens the Takes tab, which clears it back to idle.
 */
export type TakesNotificationStatus = "idle" | "generating" | "ready";

interface TakesNotificationStore {
	status: TakesNotificationStatus;
	setGenerating: () => void;
	/** End of a generation — only nudges to "ready" if we were generating. */
	setReady: () => void;
	/** User has seen the takes (opened the tab) — reset to normal. */
	clear: () => void;
}

export const useTakesNotificationStore = create<TakesNotificationStore>(
	(set) => ({
		status: "idle",
		setGenerating: () => set({ status: "generating" }),
		setReady: () =>
			set((s) => (s.status === "generating" ? { status: "ready" } : s)),
		clear: () => set({ status: "idle" }),
	}),
);
