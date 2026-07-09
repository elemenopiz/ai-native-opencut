import type { ElementAnimations } from "./animation";
import type { Effect, EffectParamValues } from "./effects";
import type { BlendMode, Transform, CropRect, MaskShape } from "./rendering";
// Sourced from the provider adapter so there is a single source of truth for
// these unions (the adapter owns them; cost/route code imports them from there).
// Imported for local use in this file *and* re-exported below for existing
// consumers that pull these from "@/types/timeline".
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";

export interface TransitionData {
	type: string;
	duration: number;
}

export interface Bookmark {
	time: number;
	note?: string;
	color?: string;
	duration?: number;
}

export interface Marker {
	id: string;
	time: number;
	note?: string;
	color: string;
	createdAt: number;
}

export type MarkerColor = "red" | "yellow" | "green" | "blue" | "purple";

export interface TScene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: TimelineTrack[];
	bookmarks: Bookmark[];
	markers: Marker[];
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "sticker" | "effect";

export type TrackColor =
	| "default"
	| "red"
	| "orange"
	| "yellow"
	| "green"
	| "blue"
	| "purple"
	| "pink";

interface BaseTrack {
	id: string;
	name: string;
	color?: TrackColor;
	locked?: boolean;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	elements: (VideoElement | ImageElement)[];
	isMain: boolean;
	muted: boolean;
	hidden: boolean;
	volume?: number;
	solo?: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	elements: TextElement[];
	hidden: boolean;
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	elements: AudioElement[];
	muted: boolean;
	volume?: number;
	pan?: number;
	solo?: boolean;
}

export interface StickerTrack extends BaseTrack {
	type: "sticker";
	elements: StickerElement[];
	hidden: boolean;
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
	elements: EffectElement[];
	hidden: boolean;
}

export type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| StickerTrack
	| EffectTrack;

export type { Transform } from "./rendering";

// Audio elements can also be generative slots: a voiceover slot is an audio
// clip whose `generation.kind === "voiceover"`, holding TTS takes exactly the
// way video/image slots hold visual takes (same `takes`/`activeTakeId`
// bookkeeping in timeline-manager).
interface BaseAudioElement extends BaseTimelineElement, GenerativeFields {
	type: "audio";
	volume: number;
	muted?: boolean;
	/** Playback speed multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double speed. */
	playbackRate?: number;
	buffer?: AudioBuffer;
}

export interface UploadAudioElement extends BaseAudioElement {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioElement extends BaseAudioElement {
	sourceType: "library";
	sourceUrl: string;
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

interface BaseTimelineElement {
	id: string;
	name: string;
	duration: number;
	startTime: number;
	trimStart: number;
	trimEnd: number;
	sourceDuration?: number;
	animations?: ElementAnimations;
}

// ── AI-native generative clips ────────────────────────────────────────────────
// A "generative slot" is a normal Video/Image element that additionally carries a
// `generation` recipe and a list of `takes` (generated alternates). The active
// take's media is mirrored onto the element's `mediaId`, so once a take is chosen
// the clip behaves exactly like any other element — no special-casing downstream.

// Re-exported for existing consumers that import these from "@/types/timeline".
export type { VideoResolution, VideoOrientation, VideoMode };

/** The recipe that produces a take — the consolidated studio + videogen params. */
export interface GenerationSpec {
	prompt: string;
	provider?: string;
	model?: string;
	mode: VideoMode;
	referenceImageUrl?: string;
	/** Seedance omni-reference media (URLs) — extra subject/style/scene refs. */
	referenceImages?: string[];
	referenceVideos?: string[];
	personaId?: string;
	/**
	 * Persona consistency tier:
	 *  - "fast": use the persona anchor image directly (cheapest, loosest likeness).
	 *  - "high": per-shot gpt-image-2 still (Balanced — current default).
	 *  - "durable": local PhotoMaker v1 still via the image service (best durable
	 *    likeness, $0 API cost, needs the local image service running).
	 */
	consistencyMode?: "high" | "fast" | "durable";
	cameraPreset?: string;
	seed?: number;
	seedLocked?: boolean;
	resolution: VideoResolution;
	orientation: VideoOrientation;
	duration: number;

	// ── Voiceover (TTS) takes — additive; absent ⇒ visual generation ─────────
	/** Discriminator: "voiceover" routes this spec through the TTS engine
	 *  (`lib/studio/generate-voiceover-take.ts` → `aiClient.generateSpeech`)
	 *  instead of `/api/studio/generate`. For voiceover specs `prompt` is the
	 *  spoken text/dialogue, and the visual fields (`mode`/`resolution`/
	 *  `orientation`) are carried but ignored. */
	kind?: "video" | "voiceover";
	/** Built-in TTS speaker/voice id (e.g. "male", "female"). */
	voice?: string;
	/** Cloned-voice reference — the server path returned by
	 *  `aiClient.cloneVoice`; takes precedence over `voice` when both are set. */
	voiceRef?: string;
	/** TTS language code (voiceover takes; defaults to "en"). */
	language?: string;
	/** Serialized voice-lock fragment (`voiceLockFragment` in
	 *  `lib/director/consistency-prompt.ts`) prepended to the dialogue at
	 *  submission — the audio analog of visual seed-lock. Recorded here so the
	 *  exact text sent to the provider is reproducible take-to-take. */
	voiceLock?: string;
}

export type TakeStatus = "queued" | "generating" | "ready" | "failed";

/**
 * Commercial-safety tier of the backend that produced a take — Adobe's
 * indemnity tiering mapped onto our take primitive, but surfaced as a visible
 * badge instead of buried in a legal PDF. See `lib/studio/backends/types.ts`.
 */
export type SafetyTier =
	| "indemnified-equivalent" // trained on licensed/owned data — safest for brand work
	| "partner" // third-party model, standard provider terms
	| "experimental"; // preview / unstable

/**
 * Where a take came from, carried through export (generation-provenance is one
 * of our wedges). Additive/optional — pre-existing takes simply lack it.
 */
export interface Provenance {
	/** Registry id of the backend that generated this take. */
	backendId: string;
	vendor: string;
	/** Concrete provider model id used. */
	model: string;
	safetyTier: SafetyTier;
	/** Whether the router auto-selected the backend or the user pinned it. */
	routedBy?: "auto" | "manual";
	/** Slot intent the router resolved (for auditing routing decisions). */
	intent?: string;
	/** Identity preserved by seed (true) or by reference-conditioning fallback. */
	seedLocked?: boolean;
	generatedAt: number;
}

/** Normalized cost of a take — the honest, per-model number Firefly won't show. */
export interface TakeCost {
	/** Byorn credits (single normalized unit across all backends). */
	credits: number;
	usd?: number;
	/** Plain-language derivation for the cost tooltip. */
	basis?: string;
	/** True while this is a pre-generation estimate, false once actualized. */
	estimated?: boolean;
}

/** One generated variant of a clip. Alternates are never destroyed on selection. */
export interface Take {
	id: string;
	status: TakeStatus;
	/** Bound once the generated result is imported as a project MediaAsset. */
	mediaId?: string;
	thumbnailUrl?: string;
	seed?: number;
	/** Exact recipe that produced this take. */
	spec: GenerationSpec;
	/** Provider job id, for polling while the take is generating. */
	jobId?: string;
	/** Which backend produced this take + its safety tier (survives export). */
	provenance?: Provenance;
	/** Normalized cost (estimate before generation, actual after). */
	cost?: TakeCost;
	createdAt: number;
	error?: string;
}

/** Mixed into Video/Image elements (and audio elements, for TTS voiceover
 *  slots — see `BaseAudioElement`) to make them AI-native generative slots. */
export interface GenerativeFields {
	/** Present ⇒ this clip is a generative slot. */
	generation?: GenerationSpec;
	/** Generated variants; the active one's media is mirrored to `mediaId`. */
	takes?: Take[];
	activeTakeId?: string;
}

export interface VideoElement extends BaseTimelineElement, GenerativeFields {
	type: "video";
	mediaId: string;
	muted?: boolean;
	hidden?: boolean;
	playbackRate?: number;
	/** Play the trimmed source span backwards. */
	reversed?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	transitionOut?: TransitionData;
	crop?: CropRect;
	mask?: MaskShape;
}

export interface ImageElement extends BaseTimelineElement, GenerativeFields {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	transitionOut?: TransitionData;
	crop?: CropRect;
	mask?: MaskShape;
}

export interface TextBackground {
	enabled: boolean;
	color: string;
	cornerRadius?: number;
	paddingX?: number;
	paddingY?: number;
	offsetX?: number;
	offsetY?: number;
}

export interface TextWordTiming {
	word: string;
	/** Start time relative to the element's own start (local time) */
	start: number;
	/** End time relative to the element's own start (local time) */
	end: number;
}

export interface TextElement extends BaseTimelineElement {
	type: "text";
	content: string;
	fontSize: number;
	fontFamily: string;
	color: string;
	/** Color applied to words once they have been spoken (karaoke progressive fill) */
	highlightColor?: string;
	/** Color of the word currently being spoken. Falls back to highlightColor when unset. */
	wordActiveColor?: string;
	/** Rounded background box drawn behind the currently-spoken word (highlight-box style). */
	wordActiveBackground?: string;
	/** Word-level timing for karaoke-style highlighting */
	wordTimings?: TextWordTiming[];
	/** Scale multiplier for the currently-spoken word (pop effect). 1.0 = no pop, 1.3 = 30% larger. */
	wordPopScale?: number;
	/** Outline/stroke color drawn around glyphs (CapCut-style caption outline). */
	strokeColor?: string;
	/** Outline width as a ratio of font size (0 = none, ~0.08 = a bold outline). */
	strokeWidth?: number;
	background: TextBackground;
	textAlign: "left" | "center" | "right";
	fontWeight: "normal" | "bold";
	fontStyle: "normal" | "italic";
	textDecoration: "none" | "underline" | "line-through";
	letterSpacing?: number;
	lineHeight?: number;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	transitionOut?: TransitionData;
	crop?: CropRect;
	mask?: MaskShape;
}

export interface StickerElement extends BaseTimelineElement {
	type: "sticker";
	stickerId: string;
	hidden?: boolean;
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	transitionOut?: TransitionData;
	crop?: CropRect;
	mask?: MaskShape;
}

export interface EffectElement extends BaseTimelineElement {
	type: "effect";
	effectType: string;
	params: EffectParamValues;
}

export type VisualElement =
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement;

export type ElementUpdatePatch =
	| { transform: Transform }
	| { opacity: number }
	| { volume: number };

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement
	| EffectElement;

export type ElementType = TimelineElement["type"];

export type CreateUploadAudioElement = Omit<UploadAudioElement, "id">;
export type CreateLibraryAudioElement = Omit<LibraryAudioElement, "id">;
export type CreateAudioElement =
	| CreateUploadAudioElement
	| CreateLibraryAudioElement;
export type CreateVideoElement = Omit<VideoElement, "id">;
export type CreateImageElement = Omit<ImageElement, "id">;
export type CreateTextElement = Omit<TextElement, "id">;
export type CreateStickerElement = Omit<StickerElement, "id">;
export type CreateEffectElement = Omit<EffectElement, "id">;
export type CreateTimelineElement =
	| CreateAudioElement
	| CreateVideoElement
	| CreateImageElement
	| CreateTextElement
	| CreateStickerElement
	| CreateEffectElement;

export interface ElementDragState {
	isDragging: boolean;
	elementId: string | null;
	trackId: string | null;
	startMouseX: number;
	startMouseY: number;
	startElementTime: number;
	clickOffsetTime: number;
	currentTime: number;
	currentMouseY: number;
}

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: number;
	targetElement: { elementId: string; trackId: string } | null;
}

export interface ComputeDropTargetParams {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: TimelineTrack[];
	playheadTime: number;
	isExternalDrop: boolean;
	elementDuration: number;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: number;
	excludeElementId?: string;
	targetElementTypes?: string[];
}

export interface ClipboardItem {
	trackId: string;
	trackType: TrackType;
	element: CreateTimelineElement;
}
