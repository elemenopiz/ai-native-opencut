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
	virality: { composite: 75 },
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
});
