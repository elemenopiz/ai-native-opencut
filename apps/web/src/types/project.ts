import type { ProxyResolution } from "@/services/storage/types";
import type { TScene } from "./timeline";
// Type-only imports of the Director's session-state shapes. These are erased at
// runtime, so pulling them in here creates no import cycle even though the
// director lib imports `DirectorBrief` back from this file (mirrors how
// `lib/director/types.ts` already type-imports the same shapes).
import type { ConsistencyContext } from "@/lib/director/consistency-prompt";
import type {
	StoryboardPlan,
	StyleBible,
} from "@/lib/director/storyboard-plan";

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

/** A compact, durable snapshot of one reusable character in the persona roster. */
export interface PersonaRosterEntry {
	id: string;
	name: string;
	descriptor: string;
}

/**
 * The revertable subset of a {@link ProjectBible} — the creative state a
 * checkpoint restores. Every field optional so a partial write (e.g. only the
 * look changed) checkpoints cleanly. Deliberately mirrors the Director's
 * session-state artifacts so hydration can repopulate the WeakMap caches from it.
 */
export interface ProjectBibleState {
	/** The durable creative brief (goal/audience/tone/dos/donts/notes) at this checkpoint. */
	brief?: DirectorBrief;
	/** The reel look (palette/lens-mood/cast/setting). Also the seam the Understanding Pass seeds. */
	styleBible?: StyleBible;
	/** The reel-level STYLE/CHARACTERS/SETTING block hydrated into `consistency-prompt.ts`'s WeakMap. */
	consistencyContext?: ConsistencyContext;
	/** The active multi-shot storyboard plan hydrated into `storyboard-plan.ts`'s WeakMap. */
	plan?: StoryboardPlan;
	/** A durable snapshot of the reusable cast (so the roster survives even an empty persona store on reload). */
	personaRosterSummary?: PersonaRosterEntry[];
}

/** One entry in the bounded checkpoint history — a prior {@link ProjectBibleState} plus provenance. */
export interface BibleCheckpoint {
	/** The bible `version` this checkpoint captured (monotonic, matches the value at capture time). */
	version: number;
	/** Epoch ms the checkpoint was taken. */
	at: number;
	/**
	 * The write that SUPERSEDED this state (i.e. produced the checkpoint), e.g.
	 * "storyboard" — so a revert reads as "undo the {label}, return to this state".
	 */
	label?: string;
	/** The revertable creative state at this checkpoint. */
	state: ProjectBibleState;
}

/** One line in the bible's running decision log (newest last, bounded). */
export interface BibleDecision {
	at: number;
	/** A compact human-readable note ("Set consistency context", "Storyboarded 3 shots"). */
	note: string;
}

/**
 * The persistent, VERSIONED "Project Bible" — the Director's durable creative
 * memory for a reel, promoted out of the session-only WeakMaps (which are GC'd
 * on editor unmount) into the same durable project record the {@link DirectorBrief}
 * already rides on. It is the SOURCE OF TRUTH; the WeakMap caches in
 * `lib/director/consistency-prompt.ts` and `storyboard-plan.ts` are a fast read
 * path hydrated from it on editor mount (see `lib/director/project-bible.ts`).
 *
 * Every write-through (setConsistencyContext / storyboard / brief updates)
 * snapshots the PRIOR state into `history` and bumps `version`, so "revert the
 * look to before the last change" is a real, bounded operation (Descript's
 * per-turn checkpoint pattern — see `docs/poach/descript-underlord-poaches.md`
 * §4 #3). Because slots/takes are already versioned, this gives turn-level
 * rollback that is strictly richer than a linear undo stack.
 *
 * All fields optional so an untouched project simply has no bible, and legacy
 * projects saved before this existed load unchanged. The structure is a plain,
 * JSON-serializable object, so it is cleanly human-editable outside the Director
 * verbs. `assetManifest` and `understanding` are ADDITIVE attach points for two
 * sibling agents (Asset Manifest + Understanding Pass) and are intentionally
 * `unknown` so this file takes no dependency on their code.
 */
export interface ProjectBible extends ProjectBibleState {
	/** Monotonic revision counter — bumped on every write-through; the checkpoint id space. */
	version: number;
	/** Epoch ms of the last write. */
	updatedAt: number;
	/** Bounded, newest-last checkpoint history for turn-level revert. */
	history?: BibleCheckpoint[];
	/** Bounded, newest-last running log of notable Director decisions. */
	decisions?: BibleDecision[];
	/**
	 * ADDITIVE seam for the sibling "Asset Manifest" agent. Typed `unknown` so this
	 * type never depends on that agent's code; it attaches its manifest here later.
	 */
	assetManifest?: unknown;
	/**
	 * ADDITIVE seam for the sibling "Understanding Pass" agent — e.g. its style
	 * probe, which can seed `styleBible`. Typed `unknown` for the same reason.
	 */
	understanding?: unknown;
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
	/**
	 * Persistent, versioned Director "Project Bible" — the durable source of truth
	 * for reel-level creative state (style, cast, plan, intent, decisions), with a
	 * bounded checkpoint history. Serialized alongside `directorBrief`; hydrated
	 * into the session WeakMaps on editor mount. See {@link ProjectBible}.
	 */
	projectBible?: ProjectBible;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
