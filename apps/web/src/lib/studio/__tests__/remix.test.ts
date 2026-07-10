import { describe, expect, it } from "bun:test";
import { buildRemixSpec, type RemixInput } from "../remix";
import type { GenerationSpec, Take } from "@/types/timeline";

/**
 * Regression coverage for `buildRemixSpec` — the pure spec-composer behind the
 * `remix` verb. The contract it must never regress on: the delta prompt is
 * *appended* to the prior prompt (Seedance has no separate edit channel), the
 * seed is carried, `seedLocked` is forced true, and the anchor image falls back
 * to the prior spec's own reference still.
 */

function baseSpec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
	return {
		prompt: "a red sports car on a coastal road",
		mode: "text-to-video",
		resolution: "720p",
		orientation: "landscape",
		duration: 6,
		...overrides,
	};
}

function priorTake(
	spec: Partial<GenerationSpec> = {},
	seed?: number,
): Pick<Take, "spec" | "seed"> {
	return { spec: baseSpec(spec), seed };
}

describe("buildRemixSpec", () => {
	it("appends the delta prompt onto the prior prompt (not replace)", () => {
		const out = buildRemixSpec({
			priorTake: priorTake(),
			remixPrompt: "add a sunset in the background",
		});
		expect(out.prompt).toBe(
			"a red sports car on a coastal road. add a sunset in the background.",
		);
	});

	it("trims both prompts before composing", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({ prompt: "  a lone hiker  " }),
			remixPrompt: "  make it snow  ",
		});
		expect(out.prompt).toBe("a lone hiker. make it snow.");
	});

	it("falls back to just the base prompt when the delta is empty/whitespace", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({ prompt: "  a quiet forest  " }),
			remixPrompt: "   ",
		});
		expect(out.prompt).toBe("a quiet forest");
	});

	it("always forces seedLocked:true so the remix stays anchored", () => {
		const unlocked = buildRemixSpec({
			priorTake: priorTake({ seedLocked: false }),
			remixPrompt: "warmer tones",
		});
		expect(unlocked.seedLocked).toBe(true);
	});

	it("carries the take's seed when present", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({ seed: 111 }, 4242),
			remixPrompt: "add rain",
		});
		// Take.seed wins over spec.seed.
		expect(out.seed).toBe(4242);
	});

	it("falls back to the spec seed when the take has no seed", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({ seed: 999 }, undefined),
			remixPrompt: "add rain",
		});
		expect(out.seed).toBe(999);
	});

	it("uses the explicit anchor image and switches to image-to-video", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({ mode: "text-to-video" }),
			remixPrompt: "add fog",
			anchorImageUrl: "https://cdn/anchor-frame.png",
		});
		expect(out.referenceImageUrl).toBe("https://cdn/anchor-frame.png");
		expect(out.mode).toBe("image-to-video");
	});

	it("falls back to the prior spec's referenceImageUrl when no anchor is passed", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({
				referenceImageUrl: "https://cdn/persona-still.png",
				mode: "image-to-video",
			}),
			remixPrompt: "add fog",
		});
		expect(out.referenceImageUrl).toBe("https://cdn/persona-still.png");
		expect(out.mode).toBe("image-to-video");
	});

	it("keeps the prior mode when neither an anchor nor a prior reference exists", () => {
		const out = buildRemixSpec({
			priorTake: priorTake({
				mode: "text-to-video",
				referenceImageUrl: undefined,
			}),
			remixPrompt: "add fog",
		});
		expect(out.referenceImageUrl).toBeUndefined();
		expect(out.mode).toBe("text-to-video");
	});

	it("preserves the rest of the prior spec (resolution, orientation, duration, persona)", () => {
		const input: RemixInput = {
			priorTake: priorTake({
				resolution: "1080p",
				orientation: "portrait",
				duration: 8,
				personaId: "persona_42",
			}),
			remixPrompt: "add lens flare",
		};
		const out = buildRemixSpec(input);
		expect(out.resolution).toBe("1080p");
		expect(out.orientation).toBe("portrait");
		expect(out.duration).toBe(8);
		expect(out.personaId).toBe("persona_42");
	});
});
