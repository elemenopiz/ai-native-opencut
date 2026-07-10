import { describe, expect, it } from "bun:test";
import {
	dataUrlToImageBlock,
	parseVerdict,
	wantsAutoReview,
} from "./vision-critic";

describe("parseVerdict", () => {
	it("parses a pass verdict", () => {
		expect(parseVerdict('{"verdict":"pass","reason":"on brief"}')).toEqual({
			verdict: "pass",
			reason: "on brief",
		});
	});

	it("parses reroll-with-delta and keeps the revised full prompt", () => {
		expect(
			parseVerdict(
				'{"verdict":"reroll-with-delta","reason":"wrong subject","revisedPrompt":"a red convertible on a coastal road at sunset"}',
			),
		).toEqual({
			verdict: "reroll-with-delta",
			reason: "wrong subject",
			revisedPrompt: "a red convertible on a coastal road at sunset",
		});
	});

	it("parses remix-with-anchor and keeps the short delta", () => {
		expect(
			parseVerdict(
				'{"verdict":"remix-with-anchor","reason":"extra finger","revisedPrompt":"fix the left hand"}',
			),
		).toMatchObject({
			verdict: "remix-with-anchor",
			revisedPrompt: "fix the left hand",
		});
	});

	it("normalizes verdict synonyms", () => {
		expect(
			parseVerdict('{"verdict":"remix","revisedPrompt":"add a sunset"}')
				.verdict,
		).toBe("remix-with-anchor");
		expect(
			parseVerdict('{"verdict":"regenerate","revisedPrompt":"new prompt"}')
				.verdict,
		).toBe("reroll-with-delta");
		expect(parseVerdict('{"verdict":"keep"}').verdict).toBe("pass");
	});

	it("accepts prompt / delta aliases for the revised prompt", () => {
		expect(
			parseVerdict('{"verdict":"reroll-with-delta","prompt":"new full prompt"}')
				.revisedPrompt,
		).toBe("new full prompt");
		expect(
			parseVerdict('{"verdict":"remix-with-anchor","delta":"add rain"}')
				.revisedPrompt,
		).toBe("add rain");
	});

	it("reads a fenced JSON block embedded in prose", () => {
		const reply =
			'Here is my judgment:\n```json\n{"verdict":"reroll-with-delta","revisedPrompt":"a golden retriever puppy"}\n```\nThanks!';
		expect(parseVerdict(reply)).toMatchObject({
			verdict: "reroll-with-delta",
			revisedPrompt: "a golden retriever puppy",
		});
	});

	it("fails SAFE to pass when a corrective verdict has no revised prompt", () => {
		const v = parseVerdict('{"verdict":"reroll-with-delta","reason":"bad"}');
		expect(v.verdict).toBe("pass");
		expect(v.reason).toContain("no revised prompt");
	});

	it("fails SAFE to pass on missing / malformed / unknown output", () => {
		expect(parseVerdict("no json here at all").verdict).toBe("pass");
		expect(parseVerdict("{ not valid json ,,, }").verdict).toBe("pass");
		expect(parseVerdict('{"verdict":"maybe?"}').verdict).toBe("pass");
		expect(parseVerdict("").verdict).toBe("pass");
	});
});

describe("dataUrlToImageBlock", () => {
	it("converts a base64 jpeg data URL to an Anthropic image block", () => {
		expect(dataUrlToImageBlock("data:image/jpeg;base64,AAAA")).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
		});
	});

	it("normalizes image/jpg to the canonical image/jpeg", () => {
		expect(dataUrlToImageBlock("data:image/jpg;base64,QUJD")?.source).toEqual({
			type: "base64",
			media_type: "image/jpeg",
			data: "QUJD",
		});
	});

	it("supports png / gif / webp", () => {
		expect(
			dataUrlToImageBlock("data:image/png;base64,AAAA")?.source,
		).toMatchObject({ media_type: "image/png" });
		expect(
			dataUrlToImageBlock("data:image/webp;base64,AAAA")?.source,
		).toMatchObject({ media_type: "image/webp" });
	});

	it("returns null for non-image / remote / malformed URLs", () => {
		expect(dataUrlToImageBlock("https://example.com/frame.jpg")).toBeNull();
		expect(dataUrlToImageBlock("data:image/svg+xml;base64,AAAA")).toBeNull();
		expect(dataUrlToImageBlock("data:image/jpeg;base64,")).toBeNull();
		expect(dataUrlToImageBlock("garbage")).toBeNull();
	});
});

describe("wantsAutoReview", () => {
	it("is always on when the studio setting is enabled", () => {
		expect(wantsAutoReview("", true)).toBe(true);
		expect(wantsAutoReview("just make a reel", true)).toBe(true);
	});

	it("triggers on explicit quality intent in the message", () => {
		expect(wantsAutoReview("make it look good", false)).toBe(true);
		expect(wantsAutoReview("make this perfect", false)).toBe(true);
		expect(wantsAutoReview("give me the best take", false)).toBe(true);
		expect(wantsAutoReview("auto-review the shots", false)).toBe(true);
		expect(wantsAutoReview("I want high quality output", false)).toBe(true);
	});

	it("does not trigger on incidental words", () => {
		expect(wantsAutoReview("generate a beach reel", false)).toBe(false);
		expect(wantsAutoReview("what's the best time to post?", false)).toBe(false);
		expect(wantsAutoReview("add a good vibe to the caption", false)).toBe(
			false,
		);
	});
});
