import type { GenerationSpec, TransitionData } from "./timeline";
import type { Transform } from "./rendering";
import type { TextBackground } from "./timeline";

/**
 * Arrangements — CapCut-style "templates" for an AI-native timeline.
 *
 * An arrangement is a serializable, MEDIA-FREE description of a timeline: an
 * array of generative-slot definitions (position, duration, adjacent-transition
 * config, and a generation-recipe STUB) plus any baked-in text overlays. All
 * source media is stripped — no `mediaId`, no `takes`, no reference-image URLs —
 * so an arrangement is safe to publish/share and re-hydrate into a fresh project
 * as empty slots the remixer then resolves (upload or generate).
 *
 * This maps 1:1 onto the existing generative-slot timeline (see
 * `apps/web/src/types/timeline.ts`) and needs no new timeline primitives — it is
 * purely a serialization layer. See `@/lib/arrangements` for serialize/hydrate.
 */

/** Bumped when the arrangement wire-shape changes incompatibly. */
export const ARRANGEMENT_VERSION = 1 as const;

/**
 * A generation recipe with all media/identity/take-specific fields stripped.
 * What survives is the *creative intent* (prompt, model, mode, look) — never a
 * pointer to concrete media, a persona a remixer wouldn't own, or a take's seed.
 */
export type ArrangementRecipe = Omit<
	GenerationSpec,
	| "referenceImageUrl"
	| "referenceImages"
	| "referenceVideos"
	| "personaId"
	| "seed"
	| "seedLocked"
>;

/**
 * One media slot in an arrangement — a video/image clip stripped of its source.
 * Hydrates into an empty generative slot awaiting an upload or a generation.
 */
export interface ArrangementSlot {
	/** Arrangement-local id (stable within one arrangement; not a project id). */
	id: string;
	/** The kind of element this slot hydrates into. */
	kind: "video" | "image";
	/** Which video lane (0-based, in track order) this slot lives on. */
	lane: number;
	/** Timeline start time in seconds. */
	startTime: number;
	/** Slot duration in seconds. */
	duration: number;
	/** Human label for the slot (e.g. the prompt's first words, or "Clip 1"). */
	label?: string;
	/** Generation recipe stub (media stripped). Absent ⇒ a plain "upload here" slot. */
	recipe?: ArrangementRecipe;
	/** Adjacent transition out of this slot (kept read-only in template mode). */
	transitionOut?: TransitionData;
	/** Layout — preserved so the template composes as its author intended. */
	transform?: Transform;
	opacity?: number;
}

/** A baked-in text overlay. Text carries no project media, so it is stored verbatim. */
export interface ArrangementText {
	id: string;
	/** Which text lane (0-based, in track order) this overlay lives on. */
	lane: number;
	startTime: number;
	duration: number;
	content: string;
	fontSize: number;
	fontFamily: string;
	color: string;
	textAlign: "left" | "center" | "right";
	fontWeight: "normal" | "bold";
	fontStyle: "normal" | "italic";
	background?: TextBackground;
	transform?: Transform;
	opacity?: number;
}

/** Canvas dimensions the arrangement was authored at (drives aspect ratio). */
export interface ArrangementCanvas {
	width: number;
	height: number;
}

/** A complete, media-free timeline template. */
export interface Arrangement {
	version: typeof ARRANGEMENT_VERSION;
	/** Public id — assigned when published to the share endpoint; absent for local/seed. */
	id?: string;
	name: string;
	description?: string;
	/** Canvas the template was authored at; drives the new project's aspect ratio. */
	canvas?: ArrangementCanvas;
	fps?: number;
	/** Total timeline length in seconds (derived; convenience for gallery cards). */
	totalDuration: number;
	slots: ArrangementSlot[];
	overlays: ArrangementText[];
	/** ISO timestamp; set on publish. */
	createdAt?: string;
	/** Optional thumbnail data URL for gallery display (local library only). */
	thumbnail?: string;
}

/** A locally-saved arrangement (the user's own gallery, persisted in localStorage). */
export interface SavedArrangement {
	/** Local library id. */
	localId: string;
	arrangement: Arrangement;
	savedAt: string;
	/** Public share id once published, if ever. */
	shareId?: string;
}
