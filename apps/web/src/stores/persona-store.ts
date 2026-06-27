import { create } from "zustand";

/**
 * Reusable character identities. The active persona is threaded through the
 * generation flow so the same face recurs across shots (reference-conditioned —
 * see lib/studio/persona-still.ts). List data is server-backed; the active
 * selection is session state.
 */

export interface Persona {
	id: string;
	name: string;
	descriptor: string;
	anchorImageUrl: string;
	refImageUrls: string[];
	seed: number | null;
	createdAt: string;
}

interface CreatePersonaInput {
	name: string;
	descriptor: string;
	anchorImageUrl: string;
	refImageUrls?: string[];
	seed?: number;
}

interface PersonaState {
	personas: Persona[];
	activePersonaId: string | null;
	loading: boolean;
	load: () => Promise<void>;
	create: (input: CreatePersonaInput) => Promise<Persona | null>;
	remove: (id: string) => Promise<void>;
	setActive: (id: string | null) => void;
	getActive: () => Persona | undefined;
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
	personas: [],
	activePersonaId: null,
	loading: false,

	load: async () => {
		set({ loading: true });
		try {
			const res = await fetch("/api/studio/personas");
			if (!res.ok) return;
			const data = (await res.json()) as { personas: Persona[] };
			set({ personas: data.personas });
		} catch {
			// Soft-fail: leave the existing list in place.
		} finally {
			set({ loading: false });
		}
	},

	create: async (input) => {
		const res = await fetch("/api/studio/personas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { persona: Persona };
		set((s) => ({ personas: [data.persona, ...s.personas] }));
		return data.persona;
	},

	remove: async (id) => {
		const res = await fetch(`/api/studio/personas/${id}`, { method: "DELETE" });
		if (!res.ok) return;
		set((s) => ({
			personas: s.personas.filter((p) => p.id !== id),
			activePersonaId: s.activePersonaId === id ? null : s.activePersonaId,
		}));
	},

	setActive: (id) => set({ activePersonaId: id }),

	getActive: () => {
		const { personas, activePersonaId } = get();
		return personas.find((p) => p.id === activePersonaId);
	},
}));
