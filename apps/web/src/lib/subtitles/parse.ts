// Subtitle-file dispatcher — routes by extension to the right parser.
//
// Ported from valenbine/OpenCut-ZHS (MIT) @ 2593e12c4ff0e3649000f03fe00202f2ec941522
// src/subtitles/parse.ts, extended with the VTT branch (Byorn addition).
// See THIRD_PARTY_NOTICES.

import { parseAss } from "./ass";
import { parseSrt } from "./srt";
import { parseVtt } from "./vtt";
import type { ParseSubtitleResult } from "./types";

export type {
	ParseSubtitleResult,
	SubtitleCue,
	SubtitleStyleOverrides,
} from "./types";

/** File extensions this module can parse (lowercase, no dot). */
export const SUPPORTED_SUBTITLE_EXTENSIONS = [
	"srt",
	"vtt",
	"ass",
	"ssa",
] as const;

/** Comma-joined `accept` string for a file <input>. */
export const SUBTITLE_FILE_ACCEPT = ".srt,.vtt,.ass,.ssa";

export function parseSubtitleFile({
	fileName,
	input,
}: {
	fileName: string;
	input: string;
}): ParseSubtitleResult {
	const extension = getFileExtension({ fileName });

	switch (extension) {
		case "srt":
			return parseSrt({ input });
		case "vtt":
			return parseVtt({ input });
		// .ssa is the legacy sibling of .ass; the same parser handles both.
		case "ass":
		case "ssa":
			return parseAss({ input });
		default:
			throw new Error(
				`Unsupported subtitle format: .${extension || "(none)"}. Supported: ${SUPPORTED_SUBTITLE_EXTENSIONS.map(
					(ext) => `.${ext}`,
				).join(", ")}`,
			);
	}
}

function getFileExtension({ fileName }: { fileName: string }): string {
	const extension = fileName.split(".").pop();
	return extension?.toLowerCase() ?? "";
}
