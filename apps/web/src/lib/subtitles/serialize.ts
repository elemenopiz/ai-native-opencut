// SRT/VTT cue serializers.
//
// Companions to ./srt.ts and ./vtt.ts (parsers). These take app-native
// SubtitleCue[] (seconds) and produce SRT/VTT text, entirely client-side —
// no backend round-trip. Round-trips losslessly through parseSrt/parseVtt to
// millisecond precision; see serialize.test.ts.

import type { SubtitleCue } from "./types";

interface SerializeCuesOptions {
	cues: SubtitleCue[];
}

interface NormalizedCue {
	start: number;
	end: number;
	text: string;
}

// C0 controls below space (except newline, codepoint 10) and the C1 range —
// unsafe or undefined in SRT/VTT cue text. Expressed as codepoint ranges
// (rather than a regex literal) to avoid embedding literal control bytes in
// this source file.
const UNSAFE_CONTROL_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0, 9],
	[11, 31],
	[127, 159],
];

function isUnsafeControlChar(codePoint: number): boolean {
	return UNSAFE_CONTROL_CHAR_RANGES.some(
		([lo, hi]) => codePoint >= lo && codePoint <= hi,
	);
}

/** Strip control characters that are unsafe/undefined in SRT/VTT cue text,
 *  while preserving internal newlines for multi-line cues. Line endings are
 *  normalized to LF first so a carriage return never leaks into the output. */
function sanitizeCueText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	let result = "";
	for (const ch of normalized) {
		const codePoint = ch.codePointAt(0);
		if (codePoint === undefined || !isUnsafeControlChar(codePoint)) {
			result += ch;
		}
	}
	return result;
}

/**
 * Validate + clamp a cue for serialization:
 *  - NaN/non-finite start or duration -> dropped (unrepresentable).
 *  - Negative start -> clamped to 0 (never emit a negative timestamp).
 *  - Non-positive duration after clamping (including negative duration
 *    collapsing past start) -> dropped (nothing to show).
 *  - Empty text (after sanitizing/trimming) -> dropped.
 */
function normalizeCue(cue: SubtitleCue): NormalizedCue | null {
	if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.duration)) {
		return null;
	}

	const start = Math.max(0, cue.startTime);
	const rawEnd = cue.startTime + cue.duration;
	if (!Number.isFinite(rawEnd)) {
		return null;
	}
	const end = Math.max(start, rawEnd);
	if (end <= start) {
		return null;
	}

	const text = sanitizeCueText(cue.text).trim();
	if (!text) {
		return null;
	}

	return { start, end, text };
}

function pad(value: number, width: number): string {
	return String(Math.max(0, value)).padStart(width, "0");
}

/** Break seconds into {h, m, s, ms} via a single rounded millisecond total,
 *  so rounding carries (e.g. 1.9995s -> 00:00:02.000) resolve correctly
 *  instead of drifting when hours/minutes/seconds are rounded independently. */
function toClock(seconds: number): {
	h: number;
	m: number;
	s: number;
	ms: number;
} {
	const totalMs = Math.round(seconds * 1000);
	const ms = totalMs % 1000;
	const totalSeconds = Math.floor(totalMs / 1000);
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return { h, m, s, ms };
}

function formatSrtTimestamp(seconds: number): string {
	const { h, m, s, ms } = toClock(seconds);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function formatVttTimestamp(seconds: number): string {
	const { h, m, s, ms } = toClock(seconds);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function normalizeCues(cues: SubtitleCue[]): NormalizedCue[] {
	const normalized: NormalizedCue[] = [];
	for (const cue of cues) {
		const n = normalizeCue(cue);
		if (n) normalized.push(n);
	}
	return normalized;
}

/** Serialize cues to SubRip (.srt) text: 1-based index blocks, LF-separated,
 *  `HH:MM:SS,mmm --> HH:MM:SS,mmm` timestamps. */
export function serializeSrt({ cues }: SerializeCuesOptions): string {
	const normalized = normalizeCues(cues);
	if (normalized.length === 0) return "";

	const blocks = normalized.map((cue, index) => {
		const start = formatSrtTimestamp(cue.start);
		const end = formatSrtTimestamp(cue.end);
		return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
	});

	return `${blocks.join("\n\n")}\n`;
}

/** Serialize cues to WebVTT (.vtt) text: `WEBVTT` header, LF-separated,
 *  `HH:MM:SS.mmm --> HH:MM:SS.mmm` timestamps (dot, not comma). */
export function serializeVtt({ cues }: SerializeCuesOptions): string {
	const normalized = normalizeCues(cues);

	const blocks = normalized.map((cue) => {
		const start = formatVttTimestamp(cue.start);
		const end = formatVttTimestamp(cue.end);
		return `${start} --> ${end}\n${cue.text}`;
	});

	if (blocks.length === 0) {
		return "WEBVTT\n";
	}

	return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
