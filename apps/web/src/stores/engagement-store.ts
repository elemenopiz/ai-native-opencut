import { create } from "zustand";
import type { EngagementScoreResult } from "@/lib/ai-client";

/**
 * Distinguishes a "scorer unreachable" error (e.g. the local ai-backend
 * isn't running) from any other scoring failure, so the panel can render a
 * calm, expected-looking state for the former instead of alarming red text.
 */
export type EngagementErrorKind = "backend_unavailable" | "generic";

interface EngagementState {
	currentScore: EngagementScoreResult | null;
	isAnalyzing: boolean;
	lastAnalyzedAt: number | null;
	error: string | null;
	errorKind: EngagementErrorKind | null;

	setScore: (score: EngagementScoreResult) => void;
	setAnalyzing: (v: boolean) => void;
	setError: (error: string | null, kind?: EngagementErrorKind) => void;
	clear: () => void;
}

export const useEngagementStore = create<EngagementState>()((set) => ({
	currentScore: null,
	isAnalyzing: false,
	lastAnalyzedAt: null,
	error: null,
	errorKind: null,

	setScore: (score) =>
		set({
			currentScore: score,
			isAnalyzing: false,
			lastAnalyzedAt: Date.now(),
			error: null,
			errorKind: null,
		}),

	setAnalyzing: (v) => set({ isAnalyzing: v, error: null, errorKind: null }),

	setError: (error, kind = "generic") =>
		set({ error, errorKind: error ? kind : null, isAnalyzing: false }),

	clear: () =>
		set({
			currentScore: null,
			isAnalyzing: false,
			lastAnalyzedAt: null,
			error: null,
			errorKind: null,
		}),
}));
