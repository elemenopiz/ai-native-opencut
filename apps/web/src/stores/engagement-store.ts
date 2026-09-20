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
	/**
	 * The score that was `currentScore` immediately before the latest
	 * `setScore` call. This is what makes the before/after read possible:
	 * whoever owns the real scoring pipeline just calls `setScore(result)`
	 * after every (re-)score, same as today, and the store shifts the old
	 * current into `previousScore` for free — no extra bookkeeping needed
	 * on the caller side. `null` until a second score has ever landed.
	 */
	previousScore: EngagementScoreResult | null;
	isAnalyzing: boolean;
	lastAnalyzedAt: number | null;
	error: string | null;
	errorKind: EngagementErrorKind | null;
	/**
	 * Technical detail behind a "generic" error (e.g. a raw exception
	 * message). Never rendered as primary copy — the panel collapses this
	 * behind a "Technical details" disclosure, per the standing rule that
	 * customer surfaces never show technical errors up front.
	 */
	errorDetail: string | null;

	setScore: (score: EngagementScoreResult) => void;
	setAnalyzing: (v: boolean) => void;
	setError: (
		error: string | null,
		kind?: EngagementErrorKind,
		detail?: string | null,
	) => void;
	clear: () => void;
}

export const useEngagementStore = create<EngagementState>()((set) => ({
	currentScore: null,
	previousScore: null,
	isAnalyzing: false,
	lastAnalyzedAt: null,
	error: null,
	errorKind: null,
	errorDetail: null,

	setScore: (score) =>
		set((state) => ({
			currentScore: score,
			previousScore: state.currentScore,
			isAnalyzing: false,
			lastAnalyzedAt: Date.now(),
			error: null,
			errorKind: null,
			errorDetail: null,
		})),

	// Only clears a stale error when a NEW attempt starts (v === true).
	// `handleCheck` calls `setAnalyzing(false)` unconditionally in its
	// `finally` block to drop the spinner on every path, including right
	// after a failure already called `setError` in the `catch` block above
	// it — if this unconditionally cleared error state too, that `finally`
	// would immediately erase the error the `catch` just set, so a failed
	// check would silently fall back to the idle button with no visible
	// feedback (confirmed live: the store transitioned to the
	// backend_unavailable error and back to clean state in the same tick).
	setAnalyzing: (v) =>
		set(
			v
				? { isAnalyzing: true, error: null, errorKind: null, errorDetail: null }
				: { isAnalyzing: false },
		),

	setError: (error, kind = "generic", detail = null) =>
		set({
			error,
			errorKind: error ? kind : null,
			errorDetail: error ? detail : null,
			isAnalyzing: false,
		}),

	clear: () =>
		set({
			currentScore: null,
			previousScore: null,
			isAnalyzing: false,
			lastAnalyzedAt: null,
			error: null,
			errorKind: null,
			errorDetail: null,
		}),
}));
