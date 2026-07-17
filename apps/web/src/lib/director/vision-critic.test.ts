import { beforeEach, describe, expect, it } from "bun:test";
import {
	buildCriticSystemPrompt,
	buildCriticUserBlocks,
	buildPickUserBlocks,
	classifyFailureAxes,
	clearVerdictMemory,
	dataUrlToImageBlock,
	normalizePromptKey,
	parsePick,
	parseVerdict,
	pickLabel,
	recentVerdictsFor,
	recordVerdict,
	wantsAutoReview,
} from "./vision-critic";

const IMG = "data:image/jpeg;base64,AAAA";

// The verdict-memory ledger is module-scoped (in-memory, per session by
// design — see vision-critic.ts) so it persists across tests in this file
// unless cleared. Every test starts from an empty ledger.
beforeEach(() => {
	clearVerdictMemory();
});

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
			failureAxes: ["prompt-mismatch"],
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

	// ── temporal / motion coherence ─────────────────────────────────────────
	it("carries a temporalIssue on a corrective verdict", () => {
		expect(
			parseVerdict(
				'{"verdict":"reroll-with-delta","reason":"morphs","temporalIssue":"face identity drifts between frames","revisedPrompt":"a steady portrait, consistent face"}',
			),
		).toEqual({
			verdict: "reroll-with-delta",
			reason: "morphs",
			revisedPrompt: "a steady portrait, consistent face",
			temporalIssue: "face identity drifts between frames",
			failureAxes: ["identity-drift", "motion-artifact"],
		});
	});

	it("keeps a temporalIssue even on a pass (borderline motion is logged)", () => {
		expect(
			parseVerdict(
				'{"verdict":"pass","reason":"on brief","temporalIssue":"slight hand flicker"}',
			),
		).toEqual({
			verdict: "pass",
			reason: "on brief",
			temporalIssue: "slight hand flicker",
		});
	});

	it("accepts the motionIssue alias for a temporal issue", () => {
		expect(
			parseVerdict(
				'{"verdict":"remix-with-anchor","motionIssue":"left hand warps","revisedPrompt":"steady the left hand"}',
			).temporalIssue,
		).toBe("left hand warps");
	});

	it("omits temporalIssue when motion is clean", () => {
		expect(parseVerdict('{"verdict":"pass","reason":"clean"}')).toEqual({
			verdict: "pass",
			reason: "clean",
		});
	});

	// ── cross-shot continuity ───────────────────────────────────────────────
	it("parses a remix-for-continuity verdict and keeps its delta", () => {
		expect(
			parseVerdict(
				'{"verdict":"remix-for-continuity","reason":"outfit changed","revisedPrompt":"match the teal jacket of the previous shot"}',
			),
		).toEqual({
			verdict: "remix-for-continuity",
			reason: "outfit changed",
			revisedPrompt: "match the teal jacket of the previous shot",
			failureAxes: ["continuity-break"],
		});
	});

	it("normalizes continuity synonyms without being swallowed by 'remix'", () => {
		// "remix-for-continuity" contains "remix" — continuity must win.
		expect(
			parseVerdict('{"verdict":"remix-for-continuity","revisedPrompt":"x"}')
				.verdict,
		).toBe("remix-for-continuity");
		expect(
			parseVerdict('{"verdict":"continuity","revisedPrompt":"match palette"}')
				.verdict,
		).toBe("remix-for-continuity");
	});

	it("fails SAFE to pass when a continuity verdict has no delta", () => {
		expect(
			parseVerdict('{"verdict":"remix-for-continuity","reason":"drifted"}')
				.verdict,
		).toBe("pass");
	});
});

describe("classifyFailureAxes", () => {
	it("returns no axes for a pass verdict", () => {
		expect(
			classifyFailureAxes({ verdict: "pass", reason: "on brief" }),
		).toEqual([]);
	});

	it("always includes continuity-break for remix-for-continuity", () => {
		expect(
			classifyFailureAxes({
				verdict: "remix-for-continuity",
				reason: "recast the lead",
			}),
		).toContain("continuity-break");
	});

	it("detects exposure/color issues from the reason text", () => {
		expect(
			classifyFailureAxes({
				verdict: "remix-with-anchor",
				reason: "the shot is badly overexposed and washed out",
			}),
		).toEqual(["exposure-color"]);
	});

	it("detects motion artifacts from the temporalIssue", () => {
		expect(
			classifyFailureAxes({
				verdict: "reroll-with-delta",
				reason: "unusable",
				temporalIssue: "left hand warps mid-shot",
			}),
		).toContain("motion-artifact");
	});

	it("falls back to prompt-mismatch when no keyword matches and there's no temporal issue", () => {
		expect(
			classifyFailureAxes({
				verdict: "remix-with-anchor",
				reason: "an extra finger on the left hand",
			}),
		).toEqual(["prompt-mismatch"]);
	});

	it("falls back to motion-artifact when a temporal issue is flagged but unclassifiable", () => {
		expect(
			classifyFailureAxes({
				verdict: "reroll-with-delta",
				reason: "",
				temporalIssue: "something is off across the frames",
			}),
		).toEqual(["motion-artifact"]);
	});
});

describe("buildCriticSystemPrompt", () => {
	it("always instructs motion/temporal judging", () => {
		const base = buildCriticSystemPrompt(false);
		expect(base).toMatch(/MOTION/i);
		expect(base).toMatch(/temporalIssue/);
	});

	it("adds continuity rules + the remix-for-continuity verdict only when enabled", () => {
		const base = buildCriticSystemPrompt(false);
		const cont = buildCriticSystemPrompt(true);
		expect(base).not.toMatch(/remix-for-continuity/);
		expect(base).not.toMatch(/CROSS-SHOT CONTINUITY/);
		expect(cont).toMatch(/CROSS-SHOT CONTINUITY/);
		expect(cont).toMatch(/remix-for-continuity/);
	});
});

describe("buildCriticUserBlocks", () => {
	const frame = (n: number) => `data:image/jpeg;base64,AAA${n}`;

	it("puts intent first, then the frames, for a plain review", () => {
		const blocks = buildCriticUserBlocks("a red car", [frame(1), frame(2)]);
		expect(blocks[0].type).toBe("text");
		expect((blocks[0] as { text: string }).text).toContain("a red car");
		// no prior-shot language
		expect((blocks[0] as { text: string }).text).not.toContain("PREVIOUS shot");
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
	});

	it("pushes the prior-shot frame FIRST and surfaces the bible for a continuity review", () => {
		const blocks = buildCriticUserBlocks("shot 2", [frame(1), frame(2)], {
			priorFrame: frame(0),
			bible: "palette: warm amber; recurring cast: Mara (freckled)",
		});
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).toContain("STYLE BIBLE");
		expect(intro).toContain("Mara (freckled)");
		expect(intro).toContain("PREVIOUS shot");
		// prior frame is the FIRST image block, ahead of this shot's 2 frames.
		const images = blocks.filter((b) => b.type === "image");
		expect(images).toHaveLength(3);
		expect((images[0] as { source: { data: string } }).source.data).toBe(
			"AAA0",
		);
	});

	it("ignores continuity context when the prior frame can't be decoded", () => {
		const blocks = buildCriticUserBlocks("shot 2", [frame(1)], {
			priorFrame: "https://example.com/not-a-data-url.jpg",
			bible: "palette: warm",
		});
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).not.toContain("PREVIOUS shot");
		expect(intro).not.toContain("STYLE BIBLE");
		expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
	});

	// ── feed-forward: a second review of a previously-failed prompt ──────────
	it("carries no PRIOR ATTEMPTS line when nothing has been recorded for this prompt", () => {
		const blocks = buildCriticUserBlocks("a lone astronaut on a red dune", [
			frame(1),
		]);
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).not.toContain("PRIOR ATTEMPTS");
	});

	it("SECOND ATTEMPT SEES FIRST FAILURE: surfaces a recorded verdict for the same prompt", () => {
		const prompt = "a lone astronaut on a red dune";
		recordVerdict({
			promptKey: prompt,
			verdict: {
				verdict: "reroll-with-delta",
				reason: "wrong subject entirely",
				failureAxes: ["prompt-mismatch"],
			},
			slotId: "slot1",
		});

		const blocks = buildCriticUserBlocks(prompt, [frame(1)]);
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).toContain("PRIOR ATTEMPTS ON THIS PROMPT");
		expect(intro).toContain("wrong subject entirely");
		expect(intro).toContain("prompt-mismatch");
	});

	it("matches the prior prompt case/whitespace-insensitively", () => {
		recordVerdict({
			promptKey: "  A Lone Astronaut ON a Red Dune  ",
			verdict: { verdict: "remix-with-anchor", reason: "extra finger" },
		});
		const blocks = buildCriticUserBlocks("a lone astronaut on a red dune", [
			frame(1),
		]);
		expect((blocks[0] as { text: string }).text).toContain("extra finger");
	});

	it("never surfaces a PASS verdict as a prior failure", () => {
		recordVerdict({
			promptKey: "a calm lake at dawn",
			verdict: { verdict: "pass", reason: "on brief" },
		});
		const blocks = buildCriticUserBlocks("a calm lake at dawn", [frame(1)]);
		expect((blocks[0] as { text: string }).text).not.toContain(
			"PRIOR ATTEMPTS",
		);
	});
});

describe("verdict memory: recordVerdict / recentVerdictsFor", () => {
	it("returns an empty string when nothing is recorded", () => {
		expect(recentVerdictsFor("never seen this prompt")).toBe("");
	});

	it("is a no-op for a blank promptKey", () => {
		recordVerdict({
			promptKey: "   ",
			verdict: { verdict: "reroll-with-delta", reason: "x" },
		});
		expect(recentVerdictsFor("   ")).toBe("");
	});

	it("formats verdict + failure axes + reason compactly", () => {
		recordVerdict({
			promptKey: "a red convertible",
			verdict: {
				verdict: "remix-with-anchor",
				reason: "extra finger on left hand",
				failureAxes: ["prompt-mismatch"],
			},
		});
		expect(recentVerdictsFor("a red convertible")).toBe(
			"remix-with-anchor [prompt-mismatch]: extra finger on left hand",
		);
	});

	it("returns the most recent failures first, bounded by limit", () => {
		const key = "a busy street market";
		recordVerdict({
			promptKey: key,
			verdict: { verdict: "reroll-with-delta", reason: "first failure" },
		});
		recordVerdict({
			promptKey: key,
			verdict: { verdict: "remix-with-anchor", reason: "second failure" },
		});
		recordVerdict({
			promptKey: key,
			verdict: { verdict: "remix-with-anchor", reason: "third failure" },
		});
		const history = recentVerdictsFor(key, { limit: 2 });
		expect(history).toContain("third failure");
		expect(history).toContain("second failure");
		expect(history).not.toContain("first failure");
	});

	it("falls back to a takeId/slotId match when the prompt key has no history", () => {
		recordVerdict({
			promptKey: "some other prompt entirely",
			verdict: { verdict: "reroll-with-delta", reason: "wrong scene" },
			takeId: "take-42",
		});
		expect(recentVerdictsFor("take-42")).toContain("wrong scene");
	});

	it("clearVerdictMemory wipes all recorded history", () => {
		recordVerdict({
			promptKey: "a red convertible",
			verdict: { verdict: "reroll-with-delta", reason: "bad" },
		});
		clearVerdictMemory();
		expect(recentVerdictsFor("a red convertible")).toBe("");
	});
});

describe("normalizePromptKey", () => {
	it("trims, lower-cases, and collapses whitespace", () => {
		expect(normalizePromptKey("  A Red   Car  ")).toBe("a red car");
	});

	it("caps length so a runaway prompt can't grow the key unbounded", () => {
		const long = "x".repeat(500);
		expect(normalizePromptKey(long).length).toBe(200);
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

	it("omits the PRIOR ATTEMPTS line when no history is passed (unchanged output)", () => {
		const blocks = buildPickUserBlocks("a red kite", [
			{ label: "A", frames: [IMG] },
		]);
		expect((blocks[0] as { text: string }).text).not.toContain(
			"PRIOR ATTEMPTS",
		);
	});

	it("folds a supplied history string into the intro when present", () => {
		const blocks = buildPickUserBlocks(
			"a red kite",
			[{ label: "A", frames: [IMG] }],
			"reroll-with-delta [prompt-mismatch]: wrong subject entirely",
		);
		const intro = (blocks[0] as { text: string }).text;
		expect(intro).toContain("PRIOR ATTEMPTS ON THIS PROMPT");
		expect(intro).toContain("wrong subject entirely");
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
