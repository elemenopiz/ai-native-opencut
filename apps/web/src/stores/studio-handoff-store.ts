import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Hand-off queue between the standalone Studio (/studio) and the editor
 * (/editor/[project_id]). The Studio enqueues generated clips, navigates to the
 * editor, and the editor drains the queue onto the timeline once a project is
 * active. Persisted to localStorage so the queue survives the route change.
 */

export interface PendingClip {
	id: string;
	videoUrl: string;
	name: string;
	/** Best-known duration in seconds; used as a fallback before probing. */
	durationHint?: number;
}

interface StudioHandoffState {
	pendingClips: PendingClip[];
	enqueueClips: (clips: PendingClip[]) => void;
	/** Returns the queued clips and clears the queue atomically. */
	takeAll: () => PendingClip[];
	clear: () => void;
}

export const useStudioHandoffStore = create<StudioHandoffState>()(
	persist(
		(set, get) => ({
			pendingClips: [],
			enqueueClips: (clips) =>
				set((state) => ({ pendingClips: [...state.pendingClips, ...clips] })),
			takeAll: () => {
				const clips = get().pendingClips;
				if (clips.length > 0) set({ pendingClips: [] });
				return clips;
			},
			clear: () => set({ pendingClips: [] }),
		}),
		{ name: "studio-timeline-handoff" },
	),
);
