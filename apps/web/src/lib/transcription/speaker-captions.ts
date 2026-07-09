import type { TranscriptionSegment } from "@/types/ai";

export const SPEAKER_COLORS: Record<string, string> = {
	"0": "#FF6B6B",
	"1": "#4ECDC4",
	"2": "#FFE66D",
	"3": "#A8E6CF",
	"4": "#DDA0DD",
	"5": "#87CEEB",
	"6": "#FFA07A",
	"7": "#98D8C8",
	"8": "#F7DC6F",
	"9": "#BB8FCE",
};

export const SPEAKER_COLORS_ARRAY = Object.values(SPEAKER_COLORS);

export function getSpeakerColor(speakerIndex: number): string {
	return SPEAKER_COLORS[String(speakerIndex % SPEAKER_COLORS_ARRAY.length)];
}

export function getSpeakerLabel(
	speaker: string | undefined,
	index: number,
): string {
	if (!speaker) return `Speaker ${index + 1}`;
	const match = speaker.match(/\d+/);
	const num = match ? parseInt(match[0], 10) : index;
	return `Speaker ${num + 1}`;
}

export interface SpeakerCaptionSegment {
	speaker: string;
	speakerIndex: number;
	speakerLabel: string;
	speakerColor: string;
	text: string;
	start: number;
	end: number;
	words: Array<{
		word: string;
		start: number;
		end: number;
	}>;
}

export interface BuildSpeakerCaptionOptions {
	/** Custom display names keyed by raw speaker id (e.g. "SPEAKER_A"). */
	speakerNames?: Record<string, string>;
	/**
	 * Merge runs of consecutive segments spoken by the same speaker into one
	 * caption block (text + word timings concatenated). Off by default so
	 * word-level karaoke timings stay per-segment.
	 */
	groupConsecutive?: boolean;
}

export function buildSpeakerCaptionSegments(
	segments: TranscriptionSegment[],
	optionsOrNames?: BuildSpeakerCaptionOptions | Record<string, string>,
): SpeakerCaptionSegment[] {
	// Back-compat: the old signature took a bare `speakerNames` map as the 2nd arg.
	const options: BuildSpeakerCaptionOptions =
		optionsOrNames && "speakerNames" in optionsOrNames
			? (optionsOrNames as BuildSpeakerCaptionOptions)
			: optionsOrNames
				? { speakerNames: optionsOrNames as Record<string, string> }
				: {};
	const { speakerNames, groupConsecutive } = options;

	const seenSpeakers = new Map<string, number>();
	let speakerCounter = 0;

	const indexFor = (speaker: string): number => {
		const existing = seenSpeakers.get(speaker);
		if (existing !== undefined) return existing;
		const next = speakerCounter;
		seenSpeakers.set(speaker, next);
		speakerCounter++;
		return next;
	};

	const build = (
		speaker: string,
		text: string,
		start: number,
		end: number,
		words: SpeakerCaptionSegment["words"],
	): SpeakerCaptionSegment => {
		const speakerIndex = indexFor(speaker);
		const rawLabel = getSpeakerLabel(speaker, speakerIndex);
		return {
			speaker,
			speakerIndex,
			speakerLabel: speakerNames?.[speaker] ?? rawLabel,
			speakerColor: getSpeakerColor(speakerIndex),
			text,
			start,
			end,
			words,
		};
	};

	if (!groupConsecutive) {
		return segments.map((seg) =>
			build(
				seg.speaker ?? "unknown",
				seg.text,
				seg.start,
				seg.end,
				seg.words.map((w) => ({ word: w.word, start: w.start, end: w.end })),
			),
		);
	}

	// Merge consecutive same-speaker segments.
	const result: SpeakerCaptionSegment[] = [];
	let run: {
		speaker: string;
		texts: string[];
		start: number;
		end: number;
		words: SpeakerCaptionSegment["words"];
	} | null = null;

	const flush = () => {
		if (!run) return;
		result.push(
			build(
				run.speaker,
				run.texts.join(" ").trim(),
				run.start,
				run.end,
				run.words,
			),
		);
		run = null;
	};

	for (const seg of segments) {
		const speaker = seg.speaker ?? "unknown";
		const words = seg.words.map((w) => ({
			word: w.word,
			start: w.start,
			end: w.end,
		}));
		if (run && run.speaker === speaker) {
			run.texts.push(seg.text);
			run.end = seg.end;
			run.words.push(...words);
		} else {
			flush();
			run = {
				speaker,
				texts: [seg.text],
				start: seg.start,
				end: seg.end,
				words,
			};
		}
	}
	flush();
	return result;
}
