import { describe, expect, test } from "bun:test";
import {
	RETIRED_FEATURES,
	isFeatureAvailable,
	retiredFeatureMessage,
	type RetiredFeature,
} from "./retired-features";

describe("RETIRED_FEATURES (ADR-004 beta freeze)", () => {
	test("every retired feature ships gated OFF for the beta freeze", () => {
		// The freeze landing must be behavior-neutral for beta users: nothing
		// that targets the retired Python stack may be reachable. Flipping a
		// flag to true is a deliberate post-freeze act (new browser/cloud home)
		// and should force this test to be updated alongside it.
		for (const [feature, enabled] of Object.entries(RETIRED_FEATURES)) {
			expect(enabled, `${feature} must stay gated during the freeze`).toBe(
				false,
			);
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
