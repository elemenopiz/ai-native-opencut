import { describe, expect, it } from "bun:test";
import { asBriefPatch, asSpecOverride, asShots } from "./tool-catalog";

describe("asBriefPatch", () => {
	it("passes durationSec through as a number", () => {
		expect(asBriefPatch({ durationSec: 60 })).toEqual({ durationSec: 60 });
	});

	it("omits durationSec when unset (no arg passed)", () => {
		expect(asBriefPatch({ goal: "x" })).toEqual({ goal: "x" });
	});

	it("passes 0 through untouched (applyBriefPatch decides it clears the target)", () => {
		expect(asBriefPatch({ durationSec: 0 })).toEqual({ durationSec: 0 });
	});

	it("coerces a numeric string and drops non-numeric junk", () => {
		expect(asBriefPatch({ durationSec: "45" })).toEqual({ durationSec: 45 });
		expect(asBriefPatch({ durationSec: "not-a-number" })).toEqual({});
	});

	// ── P1: platform + mustInclude ──────────────────────────────────────────

	it("passes platform through as a string", () => {
		expect(asBriefPatch({ platform: "TikTok" })).toEqual({
			platform: "TikTok",
		});
	});

	it("coerces mustInclude into a trimmed, non-empty string list", () => {
		expect(
			asBriefPatch({ mustInclude: [" show the logo ", "", "end on a CTA"] }),
		).toEqual({ mustInclude: ["show the logo", "end on a CTA"] });
	});

	it("omits mustInclude when the array is empty or all-blank", () => {
		expect(asBriefPatch({ mustInclude: [] })).toEqual({});
		expect(asBriefPatch({ mustInclude: ["  ", ""] })).toEqual({});
	});

	it("BUG31 idiom: a patch naming only ONE field carries no other keys at all", () => {
		// This is what makes `applyBriefPatch`'s `{...current, ...patch-derived}`
		// spread safe — an omitted field must never appear as `undefined` in the
		// patch object (which would otherwise read as "clear this field").
		const patch = asBriefPatch({ tone: "playful" });
		expect(patch).toEqual({ tone: "playful" });
		expect("platform" in patch).toBe(false);
		expect("mustInclude" in patch).toBe(false);
		expect("goal" in patch).toBe(false);
		expect("durationSec" in patch).toBe(false);
	});
});

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

	it("pins a backend: backendId → spec.model (the router's preferredBackendId)", () => {
		expect(asSpecOverride({ backendId: "byteplus-seedance" })).toEqual({
			model: "byteplus-seedance",
		});
		// A raw `model` is also accepted, but an explicit `backendId` wins.
		expect(asSpecOverride({ model: "kling" })).toEqual({ model: "kling" });
		expect(
			asSpecOverride({ backendId: "premium-x", model: "cheap-y" }),
		).toEqual({ model: "premium-x" });
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
