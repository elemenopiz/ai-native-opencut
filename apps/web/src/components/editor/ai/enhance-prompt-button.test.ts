import { describe, expect, it } from "bun:test";
import { restoreDroppedHandles } from "./enhance-prompt-button";

describe("restoreDroppedHandles (Omni @mention preservation backstop)", () => {
	it("returns the enhanced text unchanged when it has no @handles to protect", () => {
		const enhanced = "a cinematic shot of a cat";
		expect(restoreDroppedHandles("a cat", enhanced)).toBe(enhanced);
	});

	it("passes through untouched when the rewrite already kept every handle", () => {
		const original = "@Image1 walking through fog";
		const enhanced = "@Image1 walking through dense fog, cinematic lighting";
		expect(restoreDroppedHandles(original, enhanced)).toBe(enhanced);
	});

	it("appends a single handle the rewrite silently dropped", () => {
		const original = "@Image1 walking through fog";
		const enhanced = "a figure walking through dense fog, cinematic lighting";
		expect(restoreDroppedHandles(original, enhanced)).toBe(
			`${enhanced} @Image1`,
		);
	});

	it("appends only the handles that are actually missing, not ones already present", () => {
		const original = "@Image1 meets @Video2 at dusk";
		const enhanced = "@Image1 meets a mysterious figure at golden-hour dusk";
		expect(restoreDroppedHandles(original, enhanced)).toBe(
			`${enhanced} @Video2`,
		);
	});

	it("de-duplicates a handle mentioned twice in the original into one restore", () => {
		const original = "@Image1 and, separately, @Image1 again";
		const enhanced = "a lone figure, shown twice";
		expect(restoreDroppedHandles(original, enhanced)).toBe(
			`${enhanced} @Image1`,
		);
	});

	it("ignores @ text that isn't a handle (no trailing digits)", () => {
		const original = "email me @support about the shot";
		const enhanced = "a dramatic shot, wide angle, golden light";
		expect(restoreDroppedHandles(original, enhanced)).toBe(enhanced);
	});

	it("ignores @word<digit> tokens that aren't minted handles (shared surfaces have no mention system)", () => {
		// The button is shared with Director/image/B-roll prompts where a user
		// might type arbitrary @-tokens — only @Image<n>/@Video<n> are handles.
		const original = "tighten @scene2 and export as @mp4";
		const enhanced = "tighten the second scene and export as mp4";
		expect(restoreDroppedHandles(original, enhanced)).toBe(enhanced);
	});

	it("does not let a longer handle (@Image10) falsely satisfy a shorter one (@Image1)", () => {
		const original = "@Image1 stands beside @Image10 at sunset";
		// The rewrite kept @Image10 but dropped @Image1 — a naive `.includes`
		// check would see "@Image1" as a substring of "@Image10" and wrongly
		// conclude it survived.
		const enhanced = "a figure stands beside @Image10 at golden-hour sunset";
		expect(restoreDroppedHandles(original, enhanced)).toBe(
			`${enhanced} @Image1`,
		);
	});
});
