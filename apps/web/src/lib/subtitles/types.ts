// Subtitle-import types.
//
// Ported from valenbine/OpenCut-ZHS (MIT) @ 2593e12c4ff0e3649000f03fe00202f2ec941522
// src/subtitles/types.ts. The source pulled its primitive unions from internal
// @/text/* modules; here they are inlined so the parsers stay self-contained and
// match Byorn's TextElement model (apps/web/src/types/timeline.ts).
// See THIRD_PARTY_NOTICES.

/** Horizontal text alignment (matches TextElement.textAlign). */
export type SubtitleTextAlign = "left" | "center" | "right";
/** Font weight (matches TextElement.fontWeight). */
export type SubtitleFontWeight = "normal" | "bold";
/** Font slant (matches TextElement.fontStyle). */
export type SubtitleFontStyle = "normal" | "italic";
/** Text decoration (matches TextElement.textDecoration). */
export type SubtitleTextDecoration = "none" | "underline" | "line-through";

export interface SubtitlePlacementStyle {
	verticalAlign?: "top" | "middle" | "bottom";
	marginLeftRatio?: number;
	marginRightRatio?: number;
	marginVerticalRatio?: number;
}

export interface SubtitleStyleOverrides {
	/**
	 * Font size in app units (same coordinate space as TextElement.fontSize).
	 * Use fontSizeRatioOfPlayHeight when the source coordinate space is unknown
	 * (e.g. ASS files, where font size is relative to the script's play resolution).
	 */
	fontSize?: number;
	/**
	 * Font size expressed as a fraction of the reference canvas height.
	 * Set by the ASS parser so the inserter can convert to app units without
	 * the parser needing to know about the app's coordinate system.
	 * Takes precedence over fontSize when both are present.
	 */
	fontSizeRatioOfPlayHeight?: number;
	fontFamily?: string;
	color?: string;
	background?: { enabled: boolean; color: string };
	textAlign?: SubtitleTextAlign;
	fontWeight?: SubtitleFontWeight;
	fontStyle?: SubtitleFontStyle;
	textDecoration?: SubtitleTextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
	placement?: SubtitlePlacementStyle;
}

/**
 * A single parsed subtitle cue.
 * Times are in seconds (startTime = when the cue appears, duration = how long).
 */
export interface SubtitleCue {
	text: string;
	startTime: number;
	duration: number;
	style?: SubtitleStyleOverrides;
}

export interface ParseSubtitleResult {
	captions: SubtitleCue[];
	/** Number of malformed cues that were skipped during parsing. */
	skippedCueCount: number;
	/** Human-readable notes about lossy conversions (e.g. stripped ASS tags). */
	warnings: string[];
}
