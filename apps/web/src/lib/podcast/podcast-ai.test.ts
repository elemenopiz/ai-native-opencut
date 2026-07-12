import { describe, expect, it } from "bun:test";
import {
	FIND_CLIPS_RESPONSE_SCHEMA,
	KEYWORD_CATEGORY_COLORS,
	findBestClips,
	extractKeywords,
	generateQuestionCards,
	parseFindClipsResponse,
	parseKeywordsResponse,
	parseQuestionCardsResponse,
	renderSegmentsForPrompt,
	snapToSegmentBounds,
	textOfGeminiResponse,
	type PodcastGeminiCall,
	type PodcastSegment,
} from "./podcast-ai";

/** A 100s talk: 20 segments of 5s each. */
const segments: PodcastSegment[] = Array.from({ length: 20 }, (_, i) => ({
	text: `Sentence number ${i}.`,
	start: i * 5,
	end: i * 5 + 5,
}));

const clipBounds = { minDuration: 15, maxDuration: 90, maxClips: 10 };

describe("renderSegmentsForPrompt", () => {
	it("renders bracketed one-decimal lines", () => {
		const out = renderSegmentsForPrompt(segments.slice(0, 2));
		expect(out).toBe(
			"[0.0–5.0] Sentence number 0.\n[5.0–10.0] Sentence number 1.",
		);
	});

	it("elides the middle (keeps head + tail) over budget", () => {
		const out = renderSegmentsForPrompt(segments, 200);
		expect(out).toContain("[… transcript elided for length …]");
		expect(out).toContain("Sentence number 0.");
		expect(out).toContain("Sentence number 19.");
		expect(out).not.toContain("Sentence number 10.");
	});
});

describe("snapToSegmentBounds", () => {
	it("snaps to the nearest segment start/end", () => {
		expect(snapToSegmentBounds(segments, 6.2, 33.8)).toEqual({
			start: 5,
			end: 35,
		});
	});

	it("rejects inverted/degenerate spans", () => {
		expect(snapToSegmentBounds(segments, 30, 30)).toBeNull();
		expect(snapToSegmentBounds([], 0, 10)).toBeNull();
	});
});

describe("parseFindClipsResponse", () => {
	it("coerces, snaps, clamps score, and orders by start", () => {
		const text = JSON.stringify({
			clips: [
				{
					title: "The big reveal",
					start: 51.2,
					end: 73.9,
					score: 250,
					reason: "strong hook",
					tags: ["startups", "money", "growth", "extra-dropped"],
				},
				{
					title: "Opening hook",
					start: 0.4,
					end: 19.6,
					score: 80,
					reason: "cold open",
					tags: ["intro"],
				},
			],
		});
		const result = parseFindClipsResponse(text, segments, clipBounds);
		expect(result.total_duration).toBe(100);
		expect(result.clips.map((c) => c.title)).toEqual([
			"Opening hook",
			"The big reveal",
		]);
		const reveal = result.clips[1];
		expect(reveal.start).toBe(50); // snapped to segment boundaries
		expect(reveal.end).toBe(75);
		expect(reveal.score).toBe(100); // clamped
		expect(reveal.tags).toHaveLength(3); // capped
	});

	it("drops out-of-bounds durations and de-overlaps by score", () => {
		const text = JSON.stringify({
			clips: [
				{
					title: "Too short",
					start: 0,
					end: 5,
					score: 99,
					reason: "",
					tags: [],
				},
				{
					title: "Winner",
					start: 10,
					end: 40,
					score: 90,
					reason: "",
					tags: [],
				},
				{
					title: "Overlaps winner",
					start: 30,
					end: 60,
					score: 50,
					reason: "",
					tags: [],
				},
				{
					title: "Standalone",
					start: 70,
					end: 95,
					score: 40,
					reason: "",
					tags: [],
				},
			],
		});
		const result = parseFindClipsResponse(text, segments, clipBounds);
		expect(result.clips.map((c) => c.title)).toEqual(["Winner", "Standalone"]);
	});

	it("fails safe to an empty list on garbage", () => {
		expect(
			parseFindClipsResponse("not json {", segments, clipBounds).clips,
		).toEqual([]);
		expect(
			parseFindClipsResponse('{"clips": "nope"}', segments, clipBounds).clips,
		).toEqual([]);
	});
});

describe("parseKeywordsResponse", () => {
	it("colors by category, dedupes case-insensitively", () => {
		const text = JSON.stringify({
			keywords: [
				{ word: "$40,000", category: "money" },
				{ word: "furious", category: "emotion" },
				{ word: "Furious", category: "emotion" },
				{ word: "quantum", category: "made-up-category" },
			],
		});
		const { keywords } = parseKeywordsResponse(text);
		expect(keywords).toHaveLength(3);
		expect(keywords[0].color).toBe(KEYWORD_CATEGORY_COLORS.money);
		expect(keywords[2].word).toBe("quantum"); // unknown category → fallback color
		expect(keywords[2].color).toBeDefined();
	});

	it("fails safe to empty on garbage", () => {
		expect(parseKeywordsResponse("{oops").keywords).toEqual([]);
	});
});

describe("parseQuestionCardsResponse", () => {
	it("clamps timestamps, coerces themes, sorts, caps", () => {
		const text = JSON.stringify({
			cards: [
				{
					question: "Why did it fail?",
					timestamp: 999,
					theme: "neon",
					emoji: "🔥",
				},
				{
					question: "What changed?",
					timestamp: 40,
					theme: "sparkly",
					emoji: "✨",
				},
				{
					question: "Who is this for?",
					timestamp: -3,
					theme: "dark",
					emoji: "🎯",
				},
			],
		});
		const { cards } = parseQuestionCardsResponse(text, segments, 3);
		expect(cards).toHaveLength(3);
		// Sorted by (clamped) timestamp: -3→0, 40, 999→100.
		expect(cards.map((c) => c.timestamp)).toEqual([0, 40, 100]);
		expect(cards[1].theme).toBe("gradient"); // unknown theme coerced
		expect(cards[2].theme).toBe("neon"); // allowed theme kept

		// The cap keeps the model's first N entries (its own ranking).
		const capped = parseQuestionCardsResponse(text, segments, 2);
		expect(capped.cards.map((c) => c.question)).toEqual([
			"What changed?",
			"Why did it fail?",
		]);
	});
});

describe("gemini plumbing", () => {
	it("textOfGeminiResponse concatenates candidate text parts", () => {
		expect(
			textOfGeminiResponse({
				candidates: [
					{ content: { parts: [{ text: '{"clips"' }, { text: ":[]}" }] } },
				],
			}),
		).toBe('{"clips":[]}');
		expect(textOfGeminiResponse({})).toBe("");
	});

	it("findBestClips sends the schema + transcript through the injected call", async () => {
		// Collected in an array (not a nullable local) so TS keeps the type
		// through the closure assignment.
		const calls: Parameters<PodcastGeminiCall>[0][] = [];
		const call: PodcastGeminiCall = async (req) => {
			calls.push(req);
			return JSON.stringify({
				clips: [
					{
						title: "Clip",
						start: 0,
						end: 20,
						score: 70,
						reason: "r",
						tags: [],
					},
				],
			});
		};
		const result = await findBestClips(segments, { call });
		expect(result.clips).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].responseSchema).toBe(FIND_CLIPS_RESPONSE_SCHEMA);
		expect(calls[0].userText).toContain("[0.0–5.0] Sentence number 0.");
		expect(calls[0].system).toContain(
			"Never cut into the middle of a sentence",
		);
	});

	it("extractKeywords and generateQuestionCards ride the same transport", async () => {
		const kw = await extractKeywords(segments, {
			call: async () =>
				JSON.stringify({ keywords: [{ word: "growth", category: "topic" }] }),
		});
		expect(kw.keywords[0].word).toBe("growth");

		const cards = await generateQuestionCards(segments, 5, {
			call: async () =>
				JSON.stringify({
					cards: [
						{ question: "Q?", timestamp: 10, theme: "dark", emoji: "💡" },
					],
				}),
		});
		expect(cards.cards[0].question).toBe("Q?");
	});
});
