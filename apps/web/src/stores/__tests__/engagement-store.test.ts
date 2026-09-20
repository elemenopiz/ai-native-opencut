import { describe, expect, test, beforeEach } from "bun:test";
import { useEngagementStore } from "@/stores/engagement-store";
import type { EngagementScoreResult } from "@/lib/ai-client";

// Pins the backend-unavailable UX added when EngagementPanel was un-orphaned
// (restored into the editor's Tools tab): a scorer-unreachable error must be
// tagged `errorKind: "backend_unavailable"` so the panel can render it as a
// calm heads-up instead of alarming red error text, and that tag must not
// leak into unrelated error or success paths.

const SCORE: EngagementScoreResult = {
	hook: { composite: 80 },
	curiosity: { composite: 70 },
	energy: { composite: 60 },
	audio_sync: { composite: 90 },
	face_presence: { composite: 50 },
	emotional_arc: { composite: 65 },
	reach: { composite: 75 },
	suggestions: [],
	composite: 72,
	grade: "B",
	grade_label: "Good",
};

beforeEach(() => {
	useEngagementStore.getState().clear();
});

describe("useEngagementStore", () => {
	test("setError defaults to a generic errorKind", () => {
		useEngagementStore.getState().setError("Scoring failed");

		const state = useEngagementStore.getState();
		expect(state.error).toBe("Scoring failed");
		expect(state.errorKind).toBe("generic");
	});

	test("setError tags a backend-unavailable message with its kind", () => {
		useEngagementStore
			.getState()
			.setError(
				"Local scoring needs the AI backend running. Start it and try again.",
				"backend_unavailable",
			);

		const state = useEngagementStore.getState();
		expect(state.error).toContain("AI backend");
		expect(state.errorKind).toBe("backend_unavailable");
	});

	test("clearing the error also clears errorKind", () => {
		useEngagementStore.getState().setError("boom", "backend_unavailable");
		useEngagementStore.getState().setError(null);

		expect(useEngagementStore.getState().errorKind).toBeNull();
	});

	test("a successful score wipes out any prior errorKind", () => {
		useEngagementStore.getState().setError("boom", "backend_unavailable");
		useEngagementStore.getState().setScore(SCORE);

		const state = useEngagementStore.getState();
		expect(state.currentScore).toEqual(SCORE);
		expect(state.error).toBeNull();
		expect(state.errorKind).toBeNull();
	});

	test("clear() resets error state entirely", () => {
		useEngagementStore.getState().setError("boom", "backend_unavailable");
		useEngagementStore.getState().clear();

		const state = useEngagementStore.getState();
		expect(state.error).toBeNull();
		expect(state.errorKind).toBeNull();
		expect(state.currentScore).toBeNull();
	});

	// Pins the before/after delta read: re-scoring a cut must not discard the
	// prior number, it must shift it into `previousScore` so the panel can
	// show current vs. previous side by side.
	test("setScore shifts the old currentScore into previousScore", () => {
		useEngagementStore.getState().setScore(SCORE);
		expect(useEngagementStore.getState().previousScore).toBeNull();

		const better: EngagementScoreResult = {
			...SCORE,
			composite: 85,
			grade: "A",
		};
		useEngagementStore.getState().setScore(better);

		const state = useEngagementStore.getState();
		expect(state.currentScore).toEqual(better);
		expect(state.previousScore).toEqual(SCORE);
	});

	test("clear() also resets previousScore", () => {
		useEngagementStore.getState().setScore(SCORE);
		useEngagementStore.getState().setScore({ ...SCORE, composite: 90 });
		useEngagementStore.getState().clear();

		expect(useEngagementStore.getState().previousScore).toBeNull();
	});

	// Pins the no-technical-errors-to-customers rule: a generic error's raw
	// detail is stored separately from the friendly `error` copy, and must be
	// wiped whenever a new attempt starts or succeeds so it can't leak into an
	// unrelated later error.
	test("setError stores an optional technical detail separately from the friendly message", () => {
		useEngagementStore
			.getState()
			.setError(
				"Couldn't score this cut right now. Try again in a moment.",
				"generic",
				"TypeError: fetch failed at engagement-panel.tsx:117",
			);

		const state = useEngagementStore.getState();
		expect(state.error).not.toContain("TypeError");
		expect(state.errorDetail).toContain("TypeError");
	});

	test("setAnalyzing clears any previous errorDetail", () => {
		useEngagementStore.getState().setError("boom", "generic", "raw detail");
		useEngagementStore.getState().setAnalyzing(true);

		expect(useEngagementStore.getState().errorDetail).toBeNull();
	});

	test("a successful score wipes out any prior errorDetail", () => {
		useEngagementStore.getState().setError("boom", "generic", "raw detail");
		useEngagementStore.getState().setScore(SCORE);

		expect(useEngagementStore.getState().errorDetail).toBeNull();
	});

	// Regression: `EngagementPanel.handleCheck` calls `setAnalyzing(false)`
	// unconditionally in a `finally` block to drop the spinner, on every path
	// — including right after a failed check already called `setError` in the
	// `catch` block just above it. `setAnalyzing(false)` must be a no-op on
	// error state, or that `finally` erases the error the instant it's set
	// and a failed check silently falls back to the idle button with no
	// visible feedback at all (caught live: the store round-tripped through
	// the backend_unavailable error and back to clean state in the same
	// tick, before a screenshot could ever catch it).
	test("setAnalyzing(false) does not clear an error set moments earlier", () => {
		useEngagementStore.getState().setAnalyzing(true);
		useEngagementStore
			.getState()
			.setError(
				"Local scoring needs the AI backend running. Start it and try again.",
				"backend_unavailable",
			);
		useEngagementStore.getState().setAnalyzing(false);

		const state = useEngagementStore.getState();
		expect(state.error).toContain("AI backend");
		expect(state.errorKind).toBe("backend_unavailable");
		expect(state.isAnalyzing).toBe(false);
	});

	test("setAnalyzing(true) still clears a stale error when a new attempt starts", () => {
		useEngagementStore.getState().setError("boom", "backend_unavailable");
		useEngagementStore.getState().setAnalyzing(true);

		const state = useEngagementStore.getState();
		expect(state.error).toBeNull();
		expect(state.errorKind).toBeNull();
		expect(state.isAnalyzing).toBe(true);
	});
});
