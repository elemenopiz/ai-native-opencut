"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useSession } from "@/lib/auth/client";

/**
 * Client-side mirror of `GET /api/ai-access` — the one place that knows
 * whether the current visitor is signed in and whether they're entitled to
 * use AI features (existing accounts created before the early-access cutoff,
 * plus the owner; new signups are NOT entitled). Anonymous visitors can use
 * the editor and every non-AI feature freely; this store is only consulted by
 * AI-triggering surfaces to decide whether to show `<AiAccessNotice/>` instead
 * of running the action.
 *
 * A zustand store (mirroring `credits-store.ts`) rather than a per-hook fetch
 * so every mounted surface shares one in-flight request and one cached
 * result — `useAiAccess()` below is the thin hook wrapper, and
 * `useAiAccessStore.getState()` lets non-React code (e.g. the defense-in-depth
 * `gateOnAiAccess` helper) read the last-known state synchronously, the same
 * way `gateOn402` reads `useCreditsStore.getState()`.
 */
interface AiAccessState {
	signedIn: boolean;
	aiAccess: boolean;
	/** True once the first fetch has settled (success or fail-closed). */
	loaded: boolean;
	loading: boolean;
	/** Fetch the latest access state from the server. Safe to call repeatedly. */
	refresh: () => Promise<void>;
}

export const useAiAccessStore = create<AiAccessState>((set, get) => ({
	signedIn: false,
	aiAccess: false,
	loaded: false,
	loading: false,

	refresh: async () => {
		if (get().loading) return;
		set({ loading: true });
		try {
			const res = await fetch("/api/ai-access");
			if (!res.ok) {
				// Fail closed — an error here must never imply AI access.
				set({ signedIn: false, aiAccess: false, loaded: true, loading: false });
				return;
			}
			const data = (await res.json()) as {
				signedIn?: boolean;
				aiAccess?: boolean;
			};
			set({
				signedIn: Boolean(data.signedIn),
				aiAccess: Boolean(data.aiAccess),
				loaded: true,
				loading: false,
			});
		} catch {
			set({ signedIn: false, aiAccess: false, loaded: true, loading: false });
		}
	},
}));

/**
 * Whether the current visitor can use AI features. Fetches `GET /api/ai-access`
 * once and shares the result app-wide (via {@link useAiAccessStore}); re-fetches
 * whenever the better-auth session's signed-in state settles or changes, so a
 * sign-in/sign-out in this tab is reflected without a manual refresh. Fails
 * closed on any error: `{ signedIn: false, aiAccess: false, loading: false }`.
 */
export function useAiAccess(): {
	signedIn: boolean;
	aiAccess: boolean;
	loading: boolean;
} {
	const { data: session, isPending } = useSession();
	// Only used to detect a sign-in/out transition below — the store's own
	// `signedIn` (server-authoritative, from `/api/ai-access`) is what's
	// returned, never this client-cached copy.
	const sessionSignedIn = Boolean(session?.user);
	const signedIn = useAiAccessStore((s) => s.signedIn);
	const aiAccess = useAiAccessStore((s) => s.aiAccess);
	const loaded = useAiAccessStore((s) => s.loaded);
	const refresh = useAiAccessStore((s) => s.refresh);

	// Wait for better-auth's own session check to settle before firing ours
	// (avoids a redundant fetch while it's still pending), then re-fetch
	// whenever the signed-in state flips — covers sign-in/out that happens
	// without a full page navigation remounting this component.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionSignedIn is an intentional re-run trigger, not read in the body — refresh() always re-derives signedIn/aiAccess from the server, this just decides WHEN to call it.
	useEffect(() => {
		if (isPending) return;
		void refresh();
	}, [isPending, sessionSignedIn, refresh]);

	return {
		signedIn,
		aiAccess,
		loading: !loaded,
	};
}
