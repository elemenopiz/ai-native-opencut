import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Arrangement } from "@/types/arrangement";

/**
 * Hand-off queue for loading an arrangement into a freshly-created project.
 *
 * Mirrors `studio-handoff-store`: a caller (the new-project picker, or the
 * public `/t/[id]` remix landing) stashes an arrangement here, creates a blank
 * project, and navigates to `/editor/[id]`. The editor drains the queue once a
 * project is active (`use-arrangement-handoff`) and hydrates it onto the
 * timeline. Persisted so it survives the route change.
 */
interface ArrangementHandoffState {
	pending: Arrangement | null;
	setPending: (arrangement: Arrangement) => void;
	/** Returns the pending arrangement and clears it atomically. */
	take: () => Arrangement | null;
	clear: () => void;
}

export const useArrangementHandoffStore = create<ArrangementHandoffState>()(
	persist(
		(set, get) => ({
			pending: null,
			setPending: (arrangement) => set({ pending: arrangement }),
			take: () => {
				const pending = get().pending;
				if (pending) set({ pending: null });
				return pending;
			},
			clear: () => set({ pending: null }),
		}),
		{ name: "arrangement-handoff" },
	),
);
