/**
 * OpenAI GPT Image 2 adapter — focused on the parts touched in this pass:
 * availability gating and `estimateCost()` now sourcing from `cost-table.ts`'s
 * `costFor()` instead of a hand-rolled quality table that had drifted from
 * what `/api/studio/image` actually bills (a flat per-image rate). `submit()`
 * itself wraps `image-generator.ts`/`gpt-image-edit.ts` (R2 rehost + multipart
 * upload plumbing, pre-existing and untouched here) and isn't re-tested.
 *
 * Only toggles `webEnv.OPENAI_API_KEY` directly (plain mutable object, no
 * `mock.module` needed) — restored in `afterEach` per the repo's
 * global-mutable-env-leak convention (see `fal-mmaudio.test.ts`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { openaiGptImageBackend } from "../openai-gpt-image";

const originalKey = webEnv.OPENAI_API_KEY;

afterEach(() => {
	webEnv.OPENAI_API_KEY = originalKey;
});

describe("openaiGptImageBackend — availability", () => {
	it("is inert without OPENAI_API_KEY", () => {
		webEnv.OPENAI_API_KEY = "";
		expect(openaiGptImageBackend.isAvailable()).toBe(false);
	});

	it("is available once OPENAI_API_KEY is set", () => {
		webEnv.OPENAI_API_KEY = "test-openai-key";
		expect(openaiGptImageBackend.isAvailable()).toBe(true);
	});
});

describe("openaiGptImageBackend.estimateCost", () => {
	it("matches what /api/studio/image actually bills for every quality tier", () => {
		// Real billing (apps/web/src/app/api/studio/image/route.ts) computes
		// `costFor(imageBackendId, "image", { count })` — quality is NOT a
		// costFor() input for this flat-rate backend, so the displayed estimate
		// must equal that same call for low/medium/high alike, or the UI would
		// promise a number the server doesn't charge.
		const billed = costFor("openai-gpt-image", "image", { count: 1 });
		for (const quality of ["low", "medium", "high"] as const) {
			const estimate = openaiGptImageBackend.estimateCost({
				modality: "image",
				prompt: "x",
				quality,
			});
			expect(estimate.credits).toBe(billed);
		}
	});

	it("basis mentions the requested quality tier", () => {
		const estimate = openaiGptImageBackend.estimateCost({
			modality: "image",
			prompt: "x",
			quality: "low",
		});
		expect(estimate.basis).toContain("low");
	});
});

describe("openaiGptImageBackend — capabilities", () => {
	it("models reference-conditioned edits but not seed-lock", () => {
		expect(openaiGptImageBackend.capabilities.supportsReferenceEdits).toBe(
			true,
		);
		expect(openaiGptImageBackend.capabilities.supportsSeedLock).toBe(false);
	});
});
