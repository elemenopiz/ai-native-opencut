import { describe, expect, test } from "bun:test";
import { parseSrt } from "./srt";
import { parseAss } from "./ass";
import { parseVtt } from "./vtt";
import { parseSubtitleFile } from "./parse";

describe("parseSrt", () => {
	test("parses a basic multi-cue file", () => {
		const input = [
			"1",
			"00:00:01,000 --> 00:00:04,000",
			"Hello world",
			"",
			"2",
			"00:00:05,500 --> 00:00:07,250",
			"Second line",
		].join("\n");

		const { captions, skippedCueCount, warnings } = parseSrt({ input });

		expect(warnings).toEqual([]);
		expect(skippedCueCount).toBe(0);
		expect(captions).toHaveLength(2);
		expect(captions[0]).toEqual({
			text: "Hello world",
			startTime: 1,
			duration: 3,
		});
		expect(captions[1].startTime).toBeCloseTo(5.5, 5);
		expect(captions[1].duration).toBeCloseTo(1.75, 5);
	});

	test("keeps multi-line cue text", () => {
		const input = [
			"1",
			"00:00:00,000 --> 00:00:02,000",
			"Line one",
			"Line two",
		].join("\n");

		const { captions } = parseSrt({ input });
		expect(captions[0].text).toBe("Line one\nLine two");
	});

	test("accepts cues without a leading index line", () => {
		const input = ["00:00:01,000 --> 00:00:02,000", "No index here"].join("\n");
		const { captions, skippedCueCount } = parseSrt({ input });
		expect(skippedCueCount).toBe(0);
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("No index here");
	});

	test("accepts a dot as the millisecond separator", () => {
		const input = ["1", "00:00:01.000 --> 00:00:02.000", "Dot ms"].join("\n");
		const { captions } = parseSrt({ input });
		expect(captions[0].startTime).toBe(1);
		expect(captions[0].duration).toBe(1);
	});

	test("preserves overlapping timestamps (no dedup / reorder)", () => {
		const input = [
			"1",
			"00:00:00,000 --> 00:00:05,000",
			"A",
			"",
			"2",
			"00:00:02,000 --> 00:00:06,000",
			"B (overlaps A)",
		].join("\n");

		const { captions } = parseSrt({ input });
		expect(captions).toHaveLength(2);
		// Cue B starts before cue A ends — both retained as-is.
		expect(captions[0].startTime + captions[0].duration).toBeGreaterThan(
			captions[1].startTime,
		);
	});

	test("skips malformed blocks and counts them", () => {
		const input = [
			"1",
			"not a timestamp",
			"orphan text",
			"",
			"2",
			"00:00:01,000 --> 00:00:00,000", // non-positive duration
			"Backwards",
			"",
			"3",
			"00:00:03,000 --> 00:00:04,000",
			"Good one",
		].join("\n");

		const { captions, skippedCueCount } = parseSrt({ input });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("Good one");
		expect(skippedCueCount).toBe(2);
	});

	test("normalizes CRLF line endings", () => {
		const input = "1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF cue\r\n";
		const { captions } = parseSrt({ input });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("CRLF cue");
	});

	test("returns empty for empty input", () => {
		expect(parseSrt({ input: "" })).toEqual({
			captions: [],
			skippedCueCount: 0,
			warnings: [],
		});
	});
});

describe("parseAss", () => {
	const ASS = [
		"[Script Info]",
		"PlayResX: 1920",
		"PlayResY: 1080",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, Underline, StrikeOut, BorderStyle, Alignment, MarginL, MarginR, MarginV",
		"Style: Default,Arial,72,&H00FFFFFF,&H80000000,-1,0,0,0,1,2,10,10,20",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}Bold tagged{\\b0} line",
		"Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,First\\NSecond",
		"Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,should be ignored",
	].join("\n");

	test("parses dialogue events with timestamps", () => {
		const { captions } = parseAss({ input: ASS });
		expect(captions).toHaveLength(2);
		expect(captions[0].startTime).toBe(1);
		expect(captions[0].duration).toBe(2);
	});

	test("strips inline override tags and warns", () => {
		const { captions, warnings } = parseAss({ input: ASS });
		expect(captions[0].text).toBe("Bold tagged line");
		expect(warnings.some((w) => w.includes("inline override tags"))).toBe(true);
	});

	test("converts \\N to a real newline", () => {
		const { captions } = parseAss({ input: ASS });
		expect(captions[1].text).toBe("First\nSecond");
	});

	test("ignores non-dialogue (Comment) events and warns", () => {
		const { captions, warnings } = parseAss({ input: ASS });
		expect(captions.every((c) => c.text !== "should be ignored")).toBe(true);
		expect(warnings.some((w) => w.includes("non-dialogue"))).toBe(true);
	});

	test("maps style color and bold from the referenced style", () => {
		const { captions } = parseAss({ input: ASS });
		// PrimaryColour &H00FFFFFF -> opaque white.
		expect(captions[0].style?.color).toBe("#ffffff");
		expect(captions[0].style?.fontWeight).toBe("bold");
		// Fontsize 72 over PlayResY 1080 -> ratio 0.067.
		expect(captions[0].style?.fontSizeRatioOfPlayHeight).toBeCloseTo(0.067, 3);
	});

	test("returns empty for empty input", () => {
		expect(parseAss({ input: "" }).captions).toEqual([]);
	});
});

describe("parseVtt", () => {
	test("parses basic cues with HH:MM:SS.mmm and MM:SS.mmm stamps", () => {
		const input = [
			"WEBVTT",
			"",
			"00:00:01.000 --> 00:00:04.000",
			"Hello VTT",
			"",
			"00:05.000 --> 00:07.500",
			"Short stamp",
		].join("\n");

		const { captions, skippedCueCount, warnings } = parseVtt({ input });
		expect(warnings).toEqual([]);
		expect(skippedCueCount).toBe(0);
		expect(captions).toHaveLength(2);
		expect(captions[0]).toEqual({
			text: "Hello VTT",
			startTime: 1,
			duration: 3,
		});
		expect(captions[1].startTime).toBe(5);
		expect(captions[1].duration).toBe(2.5);
	});

	test("ignores cue identifier lines and cue settings", () => {
		const input = [
			"WEBVTT",
			"",
			"intro-1",
			"00:00:01.000 --> 00:00:02.000 align:start position:10%",
			"Positioned cue",
		].join("\n");

		const { captions } = parseVtt({ input });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("Positioned cue");
		expect(captions[0].duration).toBe(1);
	});

	test("strips inline markup and speaker/karaoke tags, warns", () => {
		const input = [
			"WEBVTT",
			"",
			"00:00:00.000 --> 00:00:03.000",
			"<v Roger><c.loud>Loud</c> <b>bold</b> <00:00:01.500>word",
		].join("\n");

		const { captions, warnings } = parseVtt({ input });
		expect(captions[0].text).toBe("Loud bold word");
		expect(warnings.some((w) => w.includes("inline tags"))).toBe(true);
	});

	test("decodes standard HTML entities", () => {
		const input = [
			"WEBVTT",
			"",
			"00:00:00.000 --> 00:00:02.000",
			"Tom &amp; Jerry &lt;3",
		].join("\n");

		const { captions } = parseVtt({ input });
		expect(captions[0].text).toBe("Tom & Jerry <3");
	});

	test("ignores NOTE / STYLE blocks", () => {
		const input = [
			"WEBVTT",
			"",
			"NOTE This is a comment block",
			"spanning two lines",
			"",
			"STYLE",
			"::cue { color: yellow }",
			"",
			"00:00:01.000 --> 00:00:02.000",
			"Only real cue",
		].join("\n");

		const { captions, skippedCueCount } = parseVtt({ input });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("Only real cue");
		expect(skippedCueCount).toBe(0);
	});

	test("keeps multi-line cue text", () => {
		const input = [
			"WEBVTT",
			"",
			"00:00:00.000 --> 00:00:02.000",
			"Line one",
			"Line two",
		].join("\n");

		const { captions } = parseVtt({ input });
		expect(captions[0].text).toBe("Line one\nLine two");
	});

	test("warns when the WEBVTT signature is missing", () => {
		const input = "00:00:01.000 --> 00:00:02.000\nNo header";
		const { captions, warnings } = parseVtt({ input });
		expect(captions).toEqual([]);
		expect(warnings.some((w) => w.includes("WEBVTT"))).toBe(true);
	});

	test("strips a UTF-8 BOM before the signature", () => {
		const input = "﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBom cue";
		const { captions } = parseVtt({ input });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("Bom cue");
	});
});

describe("parseSubtitleFile dispatcher", () => {
	const SRT = "1\n00:00:01,000 --> 00:00:02,000\nsrt cue";
	const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nvtt cue";
	const ASS = [
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,ass cue",
	].join("\n");

	test("routes .srt to the SRT parser", () => {
		const { captions } = parseSubtitleFile({
			fileName: "movie.srt",
			input: SRT,
		});
		expect(captions[0].text).toBe("srt cue");
	});

	test("routes .vtt to the VTT parser", () => {
		const { captions } = parseSubtitleFile({
			fileName: "movie.vtt",
			input: VTT,
		});
		expect(captions[0].text).toBe("vtt cue");
	});

	test("routes .ass and legacy .ssa to the ASS parser", () => {
		expect(
			parseSubtitleFile({ fileName: "a.ass", input: ASS }).captions[0].text,
		).toBe("ass cue");
		expect(
			parseSubtitleFile({ fileName: "a.ssa", input: ASS }).captions[0].text,
		).toBe("ass cue");
	});

	test("is case-insensitive on the extension", () => {
		const { captions } = parseSubtitleFile({
			fileName: "MOVIE.SRT",
			input: SRT,
		});
		expect(captions[0].text).toBe("srt cue");
	});

	test("throws on an unsupported extension", () => {
		expect(() =>
			parseSubtitleFile({ fileName: "notes.txt", input: "hi" }),
		).toThrow(/Unsupported subtitle format/);
	});
});
