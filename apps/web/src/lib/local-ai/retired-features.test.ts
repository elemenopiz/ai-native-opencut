import { describe, expect, test } from "bun:test";
import {
	RETIRED_FEATURES,
	isFeatureAvailable,
	retiredFeatureMessage,
	type RetiredFeature,
} from "./retired-features";

describe("RETIRED_FEATURES (ADR-004 beta freeze)", () => {
	// Features deliberately RE-HOMED off the retired Python stack. Adding an
	// entry here is the "deliberate post-freeze act" the gate test demands:
	// findClips re-homed on Gemini structured output (lib/podcast/podcast-ai.ts).
	const REHOMED: readonly RetiredFeature[] = ["findClips"];

	test("every NOT-re-homed feature ships gated OFF for the beta freeze", () => {
		// The freeze landing must be behavior-neutral for beta users: nothing
		// that targets the retired Python stack may be reachable. Flipping a
		// flag to true requires a new browser/cloud home AND an entry in
		// REHOMED above — this test forces both to move together.
		for (const [feature, enabled] of Object.entries(RETIRED_FEATURES)) {
			const expected = REHOMED.includes(feature as RetiredFeature);
			expect(
				enabled,
				expected
					? `${feature} is re-homed and must be enabled`
					: `${feature} must stay gated during the freeze`,
			).toBe(expected);
		}
	});

	test("the cloud-TTS-misuse trio from Task 8 is covered by the gate", () => {
		// These three hooks would otherwise send non-speech prompts to the
		// cloud TTS route (a music prompt read aloud, etc.) — the Priority 1
		// regression this module exists to stop.
		const misuseProne: RetiredFeature[] = [
			"musicGen",
			"scriptToVideo",
			"dubbing",
		];
		for (const feature of misuseProne) {
			expect(isFeatureAvailable(feature)).toBe(false);
		}
	});

	test("isFeatureAvailable mirrors the flag table", () => {
		for (const feature of Object.keys(RETIRED_FEATURES) as RetiredFeature[]) {
			expect(isFeatureAvailable(feature)).toBe(RETIRED_FEATURES[feature]);
		}
	});

	test("every feature has non-empty, beta-worded toast copy", () => {
		for (const feature of Object.keys(RETIRED_FEATURES) as RetiredFeature[]) {
			const message = retiredFeatureMessage(feature);
			expect(message.length).toBeGreaterThan(0);
			// The copy must read as a product decision, not a broken install:
			// no docker/localhost/backend-setup instructions.
			expect(message).not.toMatch(/docker|localhost|backend/i);
		}
	});
});
