// WebVTT (.vtt) parser.
//
// New for Byorn — valenbine/OpenCut-ZHS ships SRT + ASS parsers but no VTT
// parser. Modeled on the structure of ./srt.ts so the three parsers behave
// consistently (return seconds-based cues, count skipped blocks, never throw).
//
// Handles: optional cue identifier lines, cue settings after the end timestamp
// (align/position/line/size/vertical), both HH:MM:SS.mmm and MM:SS.mmm stamps,
// inline markup tags (<b>, <i>, <c.foo>, <v Speaker>, karaoke <00:00:01.000>),
// and NOTE / STYLE / REGION blocks (ignored).

import type { ParseSubtitleResult, SubtitleCue } from "./types";

const TIMESTAMP_SEPARATOR = /\s*-->\s*/;
// A VTT cue timestamp is HH:MM:SS.mmm or MM:SS.mmm. The line may carry cue
// settings after the end timestamp, so we only anchor the start of the line.
const TIMESTAMP_LINE_PATTERN =
	/^(\d{2,}:)?\d{2}:\d{2}\.\d{1,3}\s*-->\s*(\d{2,}:)?\d{2}:\d{2}\.\d{1,3}/;
const IGNORED_BLOCK_PREFIXES = ["NOTE", "STYLE", "REGION"];

export function parseVtt({ input }: { input: string }): ParseSubtitleResult {
	// Strip a UTF-8 BOM if present, then normalize line endings.
	const normalized = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();

	if (!normalized || !/^WEBVTT/.test(normalized)) {
		// Not a WebVTT file (missing the mandatory signature).
		return {
			captions: [],
			skippedCueCount: 0,
			warnings: normalized
				? ['File does not start with the required "WEBVTT" signature.']
				: [],
		};
	}

	const blocks = normalized.split(/\n{2,}/);
	const cues: SubtitleCue[] = [];
	const warnings = new Set<string>();
	let skippedCueCount = 0;
	let strippedInlineTagCueCount = 0;

	for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
		const rawBlock = blocks[blockIndex];
		const lines = rawBlock
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);

		if (lines.length === 0) {
			continue;
		}

		// The first block carries the WEBVTT signature (plus optional header
		// metadata). It is never a cue.
		if (blockIndex === 0 && /^WEBVTT/.test(lines[0])) {
			continue;
		}

		// Skip NOTE / STYLE / REGION blocks entirely.
		const firstToken = lines[0].split(/\s+/)[0];
		if (IGNORED_BLOCK_PREFIXES.includes(firstToken)) {
			continue;
		}

		// The timestamp line is the first line containing "-->".
		const timestampIndex = lines.findIndex((line) =>
			TIMESTAMP_SEPARATOR.test(line),
		);
		if (timestampIndex === -1) {
			skippedCueCount += 1;
			continue;
		}

		const timestampLine = lines[timestampIndex];
		if (!TIMESTAMP_LINE_PATTERN.test(timestampLine)) {
			skippedCueCount += 1;
			continue;
		}

		const textLines = lines.slice(timestampIndex + 1);
		const rawText = textLines.join("\n").trim();
		if (!rawText) {
			skippedCueCount += 1;
			continue;
		}

		// Split off cue settings that follow the end timestamp on the same line.
		const [rawStart, rawRest] = timestampLine.split(TIMESTAMP_SEPARATOR);
		const rawEnd = rawRest?.trim().split(/\s+/)[0];
		if (!rawStart || !rawEnd) {
			skippedCueCount += 1;
			continue;
		}

		const startTime = parseVttTimestamp({ input: rawStart });
		const endTime = parseVttTimestamp({ input: rawEnd });
		const duration = endTime - startTime;

		if (
			!Number.isFinite(startTime) ||
			!Number.isFinite(endTime) ||
			duration <= 0
		) {
			skippedCueCount += 1;
			continue;
		}

		const stripped = stripVttMarkup({ input: rawText });
		strippedInlineTagCueCount += stripped.hadInlineTags ? 1 : 0;
		if (!stripped.text) {
			skippedCueCount += 1;
			continue;
		}

		cues.push({
			text: stripped.text,
			startTime,
			duration,
		});
	}

	if (strippedInlineTagCueCount > 0) {
		warnings.add(
			`Stripped unsupported WebVTT inline tags from ${strippedInlineTagCueCount} subtitle cue(s).`,
		);
	}

	return {
		captions: cues,
		skippedCueCount,
		warnings: [...warnings],
	};
}

function parseVttTimestamp({ input }: { input: string }): number {
	const trimmed = input.trim();
	// MM:SS.mmm — hours omitted.
	const shortMatch = trimmed.match(/^(\d{2}):(\d{2})\.(\d{1,3})$/);
	if (shortMatch) {
		const [, minutes, seconds, milliseconds] = shortMatch;
		return (
			Number.parseInt(minutes, 10) * 60 +
			Number.parseInt(seconds, 10) +
			Number.parseInt(milliseconds.padEnd(3, "0"), 10) / 1000
		);
	}

	// HH:MM:SS.mmm — hours may be more than two digits.
	const longMatch = trimmed.match(/^(\d{2,}):(\d{2}):(\d{2})\.(\d{1,3})$/);
	if (longMatch) {
		const [, hours, minutes, seconds, milliseconds] = longMatch;
		return (
			Number.parseInt(hours, 10) * 3600 +
			Number.parseInt(minutes, 10) * 60 +
			Number.parseInt(seconds, 10) +
			Number.parseInt(milliseconds.padEnd(3, "0"), 10) / 1000
		);
	}

	return Number.NaN;
}

const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&lrm;": "‎",
	"&rlm;": "‏",
	"&nbsp;": " ",
};

function stripVttMarkup({ input }: { input: string }): {
	text: string;
	hadInlineTags: boolean;
} {
	const hadInlineTags = /<[^>]+>/.test(input);
	const text = input
		// Remove all cue markup / karaoke timestamp tags: <b>, </i>, <c.foo>,
		// <v Speaker>, <00:00:01.000>, etc.
		.replace(/<[^>]+>/g, "")
		// Decode the handful of entities WebVTT text may legally contain.
		.replace(
			/&(amp|lt|gt|lrm|rlm|nbsp);/g,
			(match) => HTML_ENTITIES[match] ?? match,
		)
		.trim();

	return {
		text,
		hadInlineTags,
	};
}
