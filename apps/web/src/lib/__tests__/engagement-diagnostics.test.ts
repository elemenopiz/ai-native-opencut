/**
 * Regression cover for `deriveDiagnostics`' hook math.
 *
 * WHY THIS FILE EXISTS: nothing exercised this module directly, which is how a
 * field rename (`virality` → `reach`) nearly shipped a SILENT wrong answer —
 * `num()` tolerates a missing sub-score by falling back to a default, so
 * reading the old key would have returned a plausible number instead of
 * throwing. The scoring beat the product demos rides on this file, so the hook
 * composite is pinned to an arithmetic expectation here: any future rename that
 * breaks the read changes the number, and the number is asserted.
 */
import { describe, expect, test } from "bun:test";
import {
	deriveDiagnostics,
	type EngagementDiagnostics,
} from "@/lib/engagement-diagnostics";
import type { EngagementScoreResult } from "@/lib/ai-client";

/** Minimal result: only the fields `deriveHook` actually reads carry signal. */
function resultWith(reachHookStrength: number | undefined): EngagementScoreResult {
	return {
		hook: { composite: 80 },
		curiosity: { composite: 60 },
		energy: { composite: 50 },
		audio_sync: { composite: 50 },
		face_presence: { composite: 50 },
		emotional_arc: { composite: 50 },
		reach:
			reachHookStrength === undefined
				? { composite: 50 }
				: { composite: 50, hook_strength: reachHookStrength },
		composite: 70,
		grade: "B",
		grade_label: "Good",
	} as EngagementScoreResult;
}

function hook(reachHookStrength: number | undefined): EngagementDiagnostics["hook"] {
	// No segments → no opening text → none of the text nudges apply, so the
	// score is exactly the three-signal blend and the arithmetic is checkable.
	return deriveDiagnostics({ result: resultWith(reachHookStrength) }).hook;
}

describe("deriveDiagnostics — hook blend", () => {
	test("reads hook_strength off `reach` (0-25, scaled to 0-100)", () => {
		// hook 80*0.55 + curiosity 60*0.20 + reachHook (22*4=88)*0.25
		//  = 44 + 12 + 22 = 78
		expect(hook(22).score).toBe(78);
	});

	test("a missing hook_strength falls back — and that fallback is NOT the real answer", () => {
		// The bug class this file guards: `num()` swallows a missing field and
		// returns its default (12 → 48 after scaling), producing 68 instead of
		// 78. Both are plausible scores; only one is correct. If a rename ever
		// breaks the `reach` read again, the first test drops to this value.
		expect(hook(undefined).score).toBe(68);
		expect(hook(undefined).score).not.toBe(hook(22).score);
	});

	test("hook_strength moves the composite monotonically", () => {
		expect(hook(0).score).toBeLessThan(hook(12).score);
		expect(hook(12).score).toBeLessThan(hook(25).score);
	});
});
