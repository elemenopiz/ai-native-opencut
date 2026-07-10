import { describe, expect, it } from "bun:test";
import {
	buildPickUserBlocks,
	dataUrlToImageBlock,
	parsePick,
	parseVerdict,
	pickLabel,
	wantsAutoReview,
} from "./vision-critic";

const IMG = "data:image/jpeg;base64,AAAA";

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

describe("pickLabel", () => {
	it("labels the first 26 candidates A–Z, then wraps with a suffix", () => {
		expect(pickLabel(0)).toBe("A");
		expect(pickLabel(1)).toBe("B");
		expect(pickLabel(25)).toBe("Z");
		expect(pickLabel(26)).toBe("A1");
		expect(pickLabel(27)).toBe("B1");
	});
});

describe("buildPickUserBlocks", () => {
	it("emits the intent, a marker per candidate, and its image blocks", () => {
		const blocks = buildPickUserBlocks("a red kite", [
			{ label: "A", frames: [IMG] },
			{ label: "B", frames: [IMG, IMG] },
		]);
		// intent text + (marker + 1 image) + (marker + 2 images)
		expect(blocks).toHaveLength(1 + 2 + 3);
		expect(blocks[0]).toMatchObject({ type: "text" });
		expect((blocks[0] as { text: string }).text).toContain("a red kite");
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(3);
		expect((blocks[1] as { text: string }).text).toContain("Candidate A");
	});

	it("skips a candidate whose frames are all undecodable", () => {
		const blocks = buildPickUserBlocks("x", [
			{ label: "A", frames: ["not-a-data-url"] },
			{ label: "B", frames: [IMG] },
		]);
		// Only candidate B contributes a marker + image; A is dropped entirely.
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		expect(text).not.toContain("Candidate A");
		expect(text).toContain("Candidate B");
	});
});

describe("parsePick", () => {
	const labels = ["A", "B"];

	it("returns the winning label and reason", () => {
		expect(parsePick('{"winner":"B","reason":"sharper"}', labels)).toEqual({
			label: "B",
			reason: "sharper",
		});
	});

	it("matches labels case-insensitively and via synonym keys", () => {
		expect(parsePick('{"winner":"a"}', labels)?.label).toBe("A");
		expect(parsePick('{"pick":"B"}', labels)?.label).toBe("B");
	});

	it("returns null for an explicit null / missing / invalid winner", () => {
		expect(parsePick('{"winner":null,"reason":"tie"}', labels)).toBeNull();
		expect(parsePick('{"reason":"no winner field"}', labels)).toBeNull();
		expect(parsePick('{"winner":"C"}', labels)).toBeNull();
	});

	it("returns null on unparseable output (degrades to present-both)", () => {
		expect(parsePick("the model rambled with no json", labels)).toBeNull();
		expect(parsePick("{ broken ,,, }", labels)).toBeNull();
		expect(parsePick("", labels)).toBeNull();
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
		expect(wantsAutoReview("make it look perfect", false)).toBe(true);
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
		// Incidental "looks good" describing the scene, not an opt-in to spend.
		expect(
			wantsAutoReview("add a shot of a park that looks good at sunset", false),
		).toBe(false);
		expect(wantsAutoReview("a park that looks good at sunset", false)).toBe(
			false,
		);
	});
});
