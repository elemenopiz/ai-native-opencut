// Turn a parsed subtitle cue into a Byorn text element.
//
// Adapted from valenbine/OpenCut-ZHS (MIT) @ 2593e12c4ff0e3649000f03fe00202f2ec941522
// src/subtitles/build-subtitle-text-element.ts. The source builds a "params"-style
// text element (dotted keys) and does full canvas text measurement using its own
// layout utilities. Byorn's TextElement model is flat and the renderer handles
// wrapping/centering from textAlign + transform, so this port maps cue styling to
// our flat fields and positions via transform offsets (matching the convention in
// captions.tsx `addSubtitleTrack`), rather than porting the source's measurement code.
// See THIRD_PARTY_NOTICES.

import {
	DEFAULT_TEXT_ELEMENT,
	DEFAULT_TEXT_BACKGROUND,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import type { CreateTextElement } from "@/types/timeline";
import type { SubtitleCue } from "./types";

/** Default subtitle font size in app units (matches the caption presets, ~4–6). */
const DEFAULT_SUBTITLE_FONT_SIZE = 5;
/**
 * Fraction of canvas height used as the top/bottom margin for placement.
 * Yields a transform.position.y around ±0.4·height for edge-aligned cues, the
 * same magnitude the existing caption tracks use.
 */
const DEFAULT_EDGE_MARGIN_RATIO = 0.1;

/**
 * Resolve the transform.position.y offset (center-origin, +y = downward) from a
 * cue's vertical placement. Bottom cues sit below center, top cues above it.
 */
function resolvePositionY({
	canvasHeight,
	cue,
}: {
	canvasHeight: number;
	cue: SubtitleCue;
}): number {
	const placement = cue.style?.placement;
	const verticalAlign = placement?.verticalAlign ?? "bottom";
	const marginRatio =
		placement?.marginVerticalRatio ?? DEFAULT_EDGE_MARGIN_RATIO;

	if (verticalAlign === "middle") {
		return 0;
	}
	if (verticalAlign === "top") {
		return -(canvasHeight * (0.5 - marginRatio));
	}
	// bottom
	return canvasHeight * (0.5 - marginRatio);
}

export function buildSubtitleTextElement({
	index,
	cue,
	canvasSize,
}: {
	index: number;
	cue: SubtitleCue;
	canvasSize: { width: number; height: number };
}): CreateTextElement {
	const style = cue.style;

	// ASS reports font size as a ratio of the script's play resolution; convert
	// to app units the same way the source did (ratio · reference height).
	const fontSize =
		style?.fontSizeRatioOfPlayHeight != null
			? style.fontSizeRatioOfPlayHeight * FONT_SIZE_SCALE_REFERENCE
			: (style?.fontSize ?? DEFAULT_SUBTITLE_FONT_SIZE);

	const background = style?.background?.enabled
		? {
				...DEFAULT_TEXT_BACKGROUND,
				enabled: true,
				color: style.background.color,
			}
		: DEFAULT_TEXT_BACKGROUND;

	const positionY = resolvePositionY({
		canvasHeight: canvasSize.height,
		cue,
	});

	return {
		...DEFAULT_TEXT_ELEMENT,
		name: `Caption ${index + 1}`,
		content: cue.text,
		startTime: cue.startTime,
		duration: cue.duration,
		fontSize: fontSize > 0 ? fontSize : DEFAULT_SUBTITLE_FONT_SIZE,
		fontFamily: style?.fontFamily ?? DEFAULT_TEXT_ELEMENT.fontFamily,
		color: style?.color ?? "#ffffff",
		textAlign: style?.textAlign ?? "center",
		// Subtitles read best bold; only downgrade if the source says "normal".
		fontWeight: style?.fontWeight ?? "bold",
		fontStyle: style?.fontStyle ?? "normal",
		textDecoration: style?.textDecoration ?? "none",
		letterSpacing: style?.letterSpacing ?? DEFAULT_TEXT_ELEMENT.letterSpacing,
		lineHeight: style?.lineHeight ?? DEFAULT_TEXT_ELEMENT.lineHeight,
		background,
		opacity: 1,
		transform: {
			scale: 1,
			position: { x: 0, y: positionY },
			rotate: 0,
		},
	};
}
