import { describe, expect, it } from "bun:test";
import { asSpecOverride, asShots } from "./tool-catalog";

describe("asSpecOverride", () => {
	it("returns undefined for non-object / empty input", () => {
		expect(asSpecOverride(undefined)).toBeUndefined();
		expect(asSpecOverride(null)).toBeUndefined();
		expect(asSpecOverride("x")).toBeUndefined();
		expect(asSpecOverride([])).toBeUndefined();
		expect(asSpecOverride({})).toBeUndefined();
		// Only junk keys ⇒ nothing usable ⇒ undefined.
		expect(
			asSpecOverride({ nonsense: 1, prompt: "ignored here" }),
		).toBeUndefined();
	});

	it("keeps a valid image-to-video mode and drops an invalid one", () => {
		expect(asSpecOverride({ mode: "image-to-video" })).toEqual({
			mode: "image-to-video",
		});
		expect(asSpecOverride({ mode: "text-to-video" })).toEqual({
			mode: "text-to-video",
		});
		expect(asSpecOverride({ mode: "reference-to-video" })).toBeUndefined();
	});

	it("carries reference bindings (the @Image1 mechanism)", () => {
		expect(
			asSpecOverride({
				mode: "image-to-video",
				referenceMediaId: "media_abc",
			}),
		).toEqual({ mode: "image-to-video", referenceMediaId: "media_abc" });

		expect(asSpecOverride({ referenceImageUrl: "https://x/y.png" })).toEqual({
			referenceImageUrl: "https://x/y.png",
		});

		expect(asSpecOverride({ referenceImages: ["a", 2, "c"] })).toEqual({
			referenceImages: ["a", "2", "c"],
		});
	});

	it("coerces the silent-render toggle only from a real boolean", () => {
		expect(asSpecOverride({ generateAudio: false })).toEqual({
			generateAudio: false,
		});
		expect(asSpecOverride({ generateAudio: true })).toEqual({
			generateAudio: true,
		});
		// A stringy "false" is NOT a boolean → dropped (avoids silent truthiness bugs).
		expect(asSpecOverride({ generateAudio: "false" })).toBeUndefined();
	});

	it("coerces identity knobs and ignores wrong types", () => {
		expect(
			asSpecOverride({ seed: "42", seedLocked: true, personaId: "p1" }),
		).toEqual({ seed: 42, seedLocked: true, personaId: "p1" });
		// seedLocked must be a real boolean; a truthy string is dropped.
		expect(asSpecOverride({ seedLocked: "yes" })).toBeUndefined();
		// consistencyMode is a closed enum.
		expect(asSpecOverride({ consistencyMode: "high" })).toEqual({
			consistencyMode: "high",
		});
		expect(asSpecOverride({ consistencyMode: "medium" })).toBeUndefined();
	});
});

describe("asShots per-shot spec", () => {
	it("attaches a coerced spec only when present", () => {
		const shots = asShots({
			shots: [
				{ prompt: "plain shot" },
				{
					prompt: "anime reaction",
					duration: 3,
					spec: { mode: "image-to-video", referenceMediaId: "media_img1" },
				},
			],
		});
		expect(shots[0]).toEqual({ prompt: "plain shot", duration: 6 });
		expect(shots[0]).not.toHaveProperty("spec");
		expect(shots[1]).toEqual({
			prompt: "anime reaction",
			duration: 3,
			spec: { mode: "image-to-video", referenceMediaId: "media_img1" },
		});
	});

	it("still accepts bare-string shots", () => {
		expect(asShots({ shots: ["just a string"] })).toEqual([
			{ prompt: "just a string", duration: 6 },
		]);
	});
});
