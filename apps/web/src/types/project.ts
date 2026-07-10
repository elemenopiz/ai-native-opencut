import type { ProxyResolution } from "@/services/storage/types";
import type { TScene } from "./timeline";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: number;
	canvasSize: TCanvasSize;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
	proxyEditing?: boolean;
	proxyResolution?: ProxyResolution;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: number;
}

/**
 * The persistent DIRECTOR BRIEF — a per-project record of the user's creative
 * intent that the Director agent reads into its system prompt each turn and
 * writes back as it learns preferences. Unlike the reel-level consistency
 * context (which is session-only; see `lib/director/consistency-prompt.ts`),
 * this is DURABLE: it lives on `TProject` and is serialized alongside settings,
 * so it survives reloads and carries the director's memory across sessions.
 *
 * Every field is optional so an untouched project simply has no brief. The
 * helper surface (empty/patch/summarize/append) lives in
 * `lib/director/director-brief.ts`; this type is defined here so it can ride on
 * `TProject` without a circular import.
 */
export interface DirectorBrief {
	/** What this reel is for — the objective (e.g. "drive signups for the app"). */
	goal?: string;
	/** Who it's for — the target viewer (e.g. "Gen-Z skateboarders on TikTok"). */
	audience?: string;
	/** Desired mood/voice (e.g. "warm, playful, handheld"). */
	tone?: string;
	/** Style bible: reusable visual/edit rules (color grade, pacing, framing). */
	styleBible?: string;
	/** Positive constraints — things every shot SHOULD do. */
	dos?: string[];
	/** Negative constraints — things to AVOID. */
	donts?: string[];
	/**
	 * Learned, one-line notes appended over time — stated preferences and
	 * chosen-take rationale ("user prefers warm tones, handheld feel"). Newest
	 * last; capped so it never grows unbounded (see `MAX_BRIEF_NOTES`).
	 */
	notes?: string[];
	/** Epoch ms of the last write, for provenance. */
	updatedAt?: number;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
	/** Persistent per-project creative brief for the Director agent (durable). */
	directorBrief?: DirectorBrief;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
