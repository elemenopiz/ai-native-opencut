import { create } from "zustand";
import { toast } from "sonner";
import {
	OWNER_GRANT_CREDITS,
	SIGNUP_GRANT_CREDITS,
} from "@/lib/credits/signup-grant";

/**
 * Client-side credit state: the header balance pill reads `spendable`; the
 * "Out of credits" modal reads `outOfCredits`. Balances are server-authoritative
 * (fetched from GET /api/credits/balance) — this store only mirrors them for the
 * UI and is refreshed after any paid action.
 */

/** Show the pill in amber below this many spendable credits. */
export const LOW_CREDIT_THRESHOLD = 50;

/**
 * Beta pacing nudge: the 650-credit allowance is a soft limit — the server
 * auto-extends the balance rather than blocking — so once LIFETIME spend
 * (granted − balance) crosses each allowance-sized chunk, show a one-time
 * "please pace yourself" toast. Owner-scale accounts (the 1M grant) are
 * exempt. localStorage keys the once-per-chunk behavior per browser.
 */

/**
 * Which allowance chunk (1, 2, …) the user's lifetime spend has reached, or
 * null when no nudge is due. Pure — the DOM/toast wrapper below stays thin.
 */
export function pacingNudgeChunk(
	lifetimeGranted: number,
	balance: number,
): number | null {
	if (lifetimeGranted <= 0 || lifetimeGranted >= OWNER_GRANT_CREDITS) {
		return null;
	}
	const spent = Math.max(0, lifetimeGranted - balance);
	if (spent < SIGNUP_GRANT_CREDITS) return null;
	return Math.floor(spent / SIGNUP_GRANT_CREDITS);
}

function maybeShowPacingNudge(lifetimeGranted: number, balance: number): void {
	if (typeof window === "undefined") return;
	const chunk = pacingNudgeChunk(lifetimeGranted, balance);
	if (chunk === null) return;

	const key = `byorn-beta-pace-nudge-${chunk}`;
	try {
		if (window.localStorage.getItem(key)) return;
		window.localStorage.setItem(key, "1");
	} catch {
		return; // storage unavailable — skip rather than nag on every refresh
	}

	toast("You've used your beta allowance", {
		description:
			"Keep creating — we've extended your credits. The beta pool is shared with the other testers, so please pace yourself.",
		duration: 10_000,
	});
}

interface OutOfCreditsInfo {
	open: boolean;
	/** Credits the blocked action needed. */
	needed: number;
	/** Credits the user had spendable. */
	spendable: number;
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
	openOutOfCredits: (info: { needed: number; spendable: number }) => void;
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
				lifetimeGranted?: number;
			};
			set({
				spendable: data.spendable,
				balance: data.balance,
				reserved: data.reserved,
				loaded: true,
				loading: false,
			});
			if (typeof data.lifetimeGranted === "number") {
				maybeShowPacingNudge(data.lifetimeGranted, data.balance);
			}
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
			},
		}),

	closeOutOfCredits: () =>
		set((s) => ({ outOfCredits: { ...s.outOfCredits, open: false } })),
}));
