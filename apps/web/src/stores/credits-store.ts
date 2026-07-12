import { create } from "zustand";

/**
 * Client-side credit state: the header balance pill reads `spendable`; the
 * "Out of credits" modal reads `outOfCredits`. Balances are server-authoritative
 * (fetched from GET /api/credits/balance) — this store only mirrors them for the
 * UI and is refreshed after any paid action.
 */

/** Show the pill in amber below this many spendable credits. */
export const LOW_CREDIT_THRESHOLD = 50;

interface OutOfCreditsInfo {
	open: boolean;
	/** Credits the blocked action needed. */
	needed: number;
	/** Credits the user had spendable. */
	spendable: number;
	/**
	 * Set when the block was a per-modality earmark rather than the overall
	 * balance: names the exhausted budget ("video" | "image"); `spendable` is
	 * then what remains in THAT earmark.
	 */
	budget?: "video" | "image";
}

interface CreditsStore {
	spendable: number;
	balance: number;
	reserved: number;
	loaded: boolean;
	loading: boolean;
	outOfCredits: OutOfCreditsInfo;

	/** Fetch the latest balance from the server. Safe to call repeatedly. */
	refresh: () => Promise<void>;
	/** Open the "Out of credits" modal (called by the 402 gate). */
	openOutOfCredits: (info: {
		needed: number;
		spendable: number;
		budget?: "video" | "image";
	}) => void;
	closeOutOfCredits: () => void;
}

export const useCreditsStore = create<CreditsStore>((set, get) => ({
	spendable: 0,
	balance: 0,
	reserved: 0,
	loaded: false,
	loading: false,
	outOfCredits: { open: false, needed: 0, spendable: 0 },

	refresh: async () => {
		if (get().loading) return;
		set({ loading: true });
		try {
			const res = await fetch("/api/credits/balance");
			if (!res.ok) {
				// 401 (signed out) etc. — leave prior values, just stop loading.
				set({ loading: false });
				return;
			}
			const data = (await res.json()) as {
				spendable: number;
				balance: number;
				reserved: number;
			};
			set({
				spendable: data.spendable,
				balance: data.balance,
				reserved: data.reserved,
				loaded: true,
				loading: false,
			});
		} catch {
			set({ loading: false });
		}
	},

	openOutOfCredits: (info) =>
		set({
			outOfCredits: {
				open: true,
				needed: info.needed,
				spendable: info.spendable,
				budget: info.budget,
			},
		}),

	closeOutOfCredits: () =>
		set((s) => ({ outOfCredits: { ...s.outOfCredits, open: false } })),
}));
