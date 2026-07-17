import { describe, expect, test } from "bun:test";
import { parseSrt } from "./srt";
import { parseVtt } from "./vtt";
import { serializeSrt, serializeVtt } from "./serialize";
import type { SubtitleCue } from "./types";

describe("serializeSrt", () => {
	test("produces 1-based index blocks with comma-millisecond timestamps", () => {
		const cues: SubtitleCue[] = [
			{ text: "Hello world", startTime: 1, duration: 3 },
			{ text: "Second line", startTime: 5.5, duration: 1.75 },
		];

		const output = serializeSrt({ cues });
		expect(output).toBe(
			[
				"1",
				"00:00:01,000 --> 00:00:04,000",
				"Hello world",
				"",
				"2",
				"00:00:05,500 --> 00:00:07,250",
				"Second line",
				"",
			].join("\n"),
		);
	});

	test("uses LF line endings only", () => {
		const output = serializeSrt({
			cues: [{ text: "A", startTime: 0, duration: 1 }],
		});
		expect(output.includes("\r")).toBe(false);
	});

	test("preserves internal newlines in multi-line cue text", () => {
		const output = serializeSrt({
			cues: [{ text: "Line one\nLine two", startTime: 0, duration: 2 }],
		});
		expect(output).toContain("Line one\nLine two");
	});

	test("skips empty-text cues", () => {
		const cues: SubtitleCue[] = [
			{ text: "   ", startTime: 0, duration: 1 },
			{ text: "Real cue", startTime: 2, duration: 1 },
		];
		const output = serializeSrt({ cues });
		expect(output).not.toContain("00:00:00,000");
		// Re-indexed to 1 despite the dropped cue at index 0.
		expect(output.startsWith("1\n00:00:02,000")).toBe(true);
	});

	test("drops non-positive-duration and NaN cues", () => {
		const cues: SubtitleCue[] = [
			{ text: "Zero duration", startTime: 0, duration: 0 },
			{ text: "Negative duration", startTime: 1, duration: -1 },
			{ text: "NaN start", startTime: Number.NaN, duration: 1 },
			{ text: "Good", startTime: 2, duration: 1 },
		];
		const { captions } = parseSrt({ input: serializeSrt({ cues }) });
		expect(captions).toHaveLength(1);
		expect(captions[0].text).toBe("Good");
	});

	test("clamps a negative start time to zero instead of dropping", () => {
		const output = serializeSrt({
			cues: [{ text: "Almost at zero", startTime: -0.5, duration: 2 }],
		});
		expect(output).toContain("00:00:00,000 --> 00:00:01,500");
	});

	test("formats timestamps past one hour with correct carry", () => {
		const output = serializeSrt({
			cues: [{ text: "Late cue", startTime: 3661.2345, duration: 1 }],
		});
		// 3661.2345s = 1h 1m 1.2345s -> rounds to 1.235s (well within ms tolerance)
		expect(output).toContain("01:01:01,");
	});

	test("rounds 59.999s without dropping a whole second", () => {
		const output = serializeSrt({
			cues: [{ text: "Boundary", startTime: 59.999, duration: 1 }],
		});
		expect(output).toContain("00:00:59,999");
	});

	test("carries a millisecond rounding across a second boundary", () => {
		const output = serializeSrt({
			cues: [{ text: "Carry", startTime: 1.9996, duration: 1 }],
		});
		// 1.9996s rounds to 2000ms, not 1s 1000ms.
		expect(output).toContain("00:00:02,000");
	});

	test("returns an empty string when every cue is unusable", () => {
		expect(serializeSrt({ cues: [] })).toBe("");
		expect(
			serializeSrt({ cues: [{ text: "", startTime: 0, duration: 1 }] }),
		).toBe("");
	});
});

describe("serializeVtt", () => {
	test("emits the WEBVTT header and dot-millisecond timestamps", () => {
		const output = serializeVtt({
			cues: [{ text: "Hello VTT", startTime: 1, duration: 3 }],
		});
		expect(output).toBe(
			["WEBVTT", "", "00:00:01.000 --> 00:00:04.000", "Hello VTT", ""].join(
				"\n",
			),
		);
	});

	test("emits just the header when there are no usable cues", () => {
		expect(serializeVtt({ cues: [] })).toBe("WEBVTT\n");
	});

	test("uses LF line endings only", () => {
		const output = serializeVtt({
			cues: [{ text: "A", startTime: 0, duration: 1 }],
		});
		expect(output.includes("\r")).toBe(false);
	});
});

describe("SRT round-trip through parseSrt", () => {
	test("reproduces text and millisecond-precise timestamps", () => {
		const cues: SubtitleCue[] = [
			{ text: "First cue", startTime: 0, duration: 2.5 },
			{ text: "Multi\nline cue", startTime: 3.333, duration: 1.001 },
			{ text: "Past an hour", startTime: 3725.75, duration: 4.2 },
		];

		const { captions, skippedCueCount } = parseSrt({
			input: serializeSrt({ cues }),
		});

		expect(skippedCueCount).toBe(0);
		expect(captions).toHaveLength(cues.length);
		captions.forEach((cue, i) => {
			expect(cue.text).toBe(cues[i].text);
			expect(cue.startTime).toBeCloseTo(cues[i].startTime, 3);
			expect(cue.duration).toBeCloseTo(cues[i].duration, 3);
		});
	});
});

describe("VTT round-trip through parseVtt", () => {
	test("reproduces text and millisecond-precise timestamps", () => {
		const cues: SubtitleCue[] = [
			{ text: "First cue", startTime: 0, duration: 2.5 },
			{ text: "Multi\nline cue", startTime: 3.333, duration: 1.001 },
			{ text: "Past an hour", startTime: 3725.75, duration: 4.2 },
		];

		const { captions, skippedCueCount } = parseVtt({
			input: serializeVtt({ cues }),
		});

		expect(skippedCueCount).toBe(0);
		expect(captions).toHaveLength(cues.length);
		captions.forEach((cue, i) => {
			expect(cue.text).toBe(cues[i].text);
			expect(cue.startTime).toBeCloseTo(cues[i].startTime, 3);
			expect(cue.duration).toBeCloseTo(cues[i].duration, 3);
		});
	});
});
