import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Arrangement, SavedArrangement } from "@/types/arrangement";
import { generateUUID } from "@/utils/id";

/**
 * The user's local arrangement gallery — their own saved templates, persisted
 * to localStorage. Publishing/sharing is server-side (`/api/arrangements`); this
 * is the private, no-network library that backs the "Save as arrangement" flow
 * and the gallery picker.
 */
interface ArrangementLibraryState {
	saved: SavedArrangement[];
	/** Save an arrangement to the local library; returns its local id. */
	save: (arrangement: Arrangement) => string;
	/** Record the public share id for a previously-saved arrangement. */
	setShareId: (localId: string, shareId: string) => void;
	remove: (localId: string) => void;
	get: (localId: string) => SavedArrangement | undefined;
}

export const useArrangementStore = create<ArrangementLibraryState>()(
	persist(
		(set, get) => ({
			saved: [],
			save: (arrangement) => {
				const localId = generateUUID();
				const entry: SavedArrangement = {
					localId,
					arrangement,
					savedAt: new Date().toISOString(),
				};
				set((state) => ({ saved: [entry, ...state.saved] }));
				return localId;
			},
			setShareId: (localId, shareId) =>
				set((state) => ({
					saved: state.saved.map((s) =>
						s.localId === localId
							? { ...s, shareId, arrangement: { ...s.arrangement, id: shareId } }
							: s,
					),
				})),
			remove: (localId) =>
				set((state) => ({
					saved: state.saved.filter((s) => s.localId !== localId),
				})),
			get: (localId) => get().saved.find((s) => s.localId === localId),
		}),
		{ name: "arrangement-library" },
	),
);
