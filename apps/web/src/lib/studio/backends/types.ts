/**
 * GenerationBackend — the routed adapter contract.
 *
 * Byorn's spine is a single unified generator; this is the layer BEHIND that
 * front door. Every gen provider (video or image) implements `GenerationBackend`
 * and self-registers in the `registry`. The `router` picks one per slot by
 * intent; `seed-lock` normalizes identity across whichever backend is chosen.
 *
 * This is the inverse of Firefly's "manual dropdown catalog with no routing":
 * many interchangeable backends, one front door, auto-routed, with seed-lock as
 * a cross-backend identity normalizer so switching models never drops a persona.
 *
 * Adapters are SERVER modules — they read `webEnv` keys and must never ship keys
 * to the browser. An adapter with no key is `isAvailable() === false`: real,
 * complete code that stays inert until its provider is configured.
 */

import type {
	VideoMode,
	VideoOrientation,
	VideoResolution,
} from "@/lib/studio/provider-adapter";
import type { ImageQuality, ImageSize } from "@/lib/studio/image-generator";
import type { SafetyTier } from "@/types/timeline";

export type { SafetyTier };

export type GenerationModality = "video" | "image" | "audio";

/**
 * What a timeline slot is asking for — the router's primary signal. Inferred
 * from the `GenerationSpec` (persona present, modality, prompt shape) unless a
 * caller sets it explicitly.
 */
export type SlotIntent =
	| "character-video" // identity-critical motion → needs a seed-lock-capable video model
	| "broll-video" // generic motion, no identity lock required
	| "character-still" // persona reference frame / identity-critical still
	| "broll-still" // generic still / texture / background plate
	| "text-in-image" // typography-heavy still → route to a strong text-render model
	| "upscale" // enhance / upscale pass
	| "video-score" // video-conditioned ambience/foley (MMAudio-class)
	| "text-music"; // text/lyrics-to-music (ElevenLabs Music-class)

export type BackendId = string;

/** Per-backend capability surface. Lives on the adapter (not a parallel table)
 *  so the router and UI introspect a single source of truth. */
export interface BackendCapabilities {
	// Video-oriented
	resolutions?: VideoResolution[];
	orientations?: VideoOrientation[];
	durationRangeSec?: { min: number; max: number };
	// Image-oriented
	sizes?: ImageSize[];
	qualities?: ImageQuality[];
	// Identity / conditioning
	/** Accepts a `seed` and reproduces from it (why we can pin identity by seed). */
	supportsSeedLock: boolean;
	/** Omni-reference conditioning (subject/style/scene refs, not a fixed frame). */
	supportsOmniReference: boolean;
	/** First-&-last-frame (flf2v) mode. */
	supportsLastFrame: boolean;
	/** Reference-conditioned edits (image→image identity carry when no seed). */
	supportsReferenceEdits: boolean;
	/** True when this backend accepts `generateAudio: false` to render a
	 *  silent clip (e.g. Seedance's `generate_audio` flag). Backends with
	 *  native, inseparable audio (e.g. Veo) omit this — there's no way to turn
	 *  it off, so the UI shouldn't offer a toggle it can't honor. */
	supportsAudioToggle?: boolean;
	// Audio-oriented
	/** True when this backend needs a source video (video-to-audio "score"
	 *  generation, e.g. MMAudio) rather than working from text alone. */
	requiresVideoRef?: boolean;
	/** Slot intents this backend is a good fit for — the router's fitness filter. */
	intents: SlotIntent[];
}

/** Normalized cost of one generation. Internal credits are the single Byorn
 *  unit; `usd` is best-effort for the tooltip. This is the honest,
 *  before-you-generate number Firefly refuses to publish per model. */
export interface CostEstimate {
	/** Normalized internal credits (one Byorn credit unit across all backends). */
	credits: number;
	/** Best-effort USD, when derivable from a published provider rate. */
	usd?: number;
	/** Plain-language derivation, shown in the slot's cost tooltip. */
	basis: string;
}

/** The modality-agnostic superset a backend receives. Adapters read only the
 *  fields their modality/capabilities support and ignore the rest. */
export interface BackendRequest {
	modality: GenerationModality;
	prompt: string;
	mode?: VideoMode;
	referenceImageUrl?: string;
	referenceImages?: string[];
	referenceVideos?: string[];
	lastFrameUrl?: string;
	seed?: number;
	/** When `false`, request a silent render (no model-generated audio).
	 *  Video backends that support it map this to their provider flag (e.g.
	 *  Seedance `generate_audio`); others ignore it. Omitted ⇒ provider default. */
	generateAudio?: boolean;
	resolution?: VideoResolution;
	orientation?: VideoOrientation;
	duration?: number;
	size?: ImageSize;
	quality?: ImageQuality;
	// ── Audio (score / music) ──────────────────────────────────────────────
	/** Text-to-music only: force an instrumental take (no vocals). */
	instrumental?: boolean;
	/** Text-to-music only: optional lyric lines to guide vocal generation. */
	lyrics?: string;
	// NOTE: video-to-audio "score" generation (MMAudio-class) reuses
	// `referenceVideos[0]` as the source video URL rather than adding a new
	// field — it is already the modality-agnostic "reference video" slot.
}

export type JobStatus = "pending" | "processing" | "completed" | "failed";

/** Submit outcome. Async backends return a `jobId` to poll; sync backends
 *  (most image models) return `status: "completed"` with `mediaUrl` inline. */
export interface SubmitResult {
	jobId: string;
	status: JobStatus;
	/** Video or image URL — filled inline by sync backends, via `poll` otherwise. */
	mediaUrl?: string;
	seed?: number;
	error?: string;
}

export interface PollResult {
	jobId: string;
	status: JobStatus;
	mediaUrl?: string;
	seed?: number;
	error?: string;
}

/**
 * One interchangeable generation backend behind the unified generator.
 * Implement this + call `registerBackend()` and the router/registry/UI pick it
 * up with zero other wiring.
 */
export interface GenerationBackend {
	id: BackendId;
	label: string;
	vendor: string;
	modality: GenerationModality;
	safetyTier: SafetyTier;
	capabilities: BackendCapabilities;
	/** Env vars whose presence enables this backend (diagnostics + UI badge). */
	requiredEnv: string[];
	/** True only when every `requiredEnv` key is set. Inert-but-real otherwise. */
	isAvailable(): boolean;
	/** Honest pre-generation cost, normalized to Byorn credits. */
	estimateCost(req: BackendRequest): CostEstimate;
	/**
	 * The exact clip length (whole seconds) this backend will submit for `req`,
	 * for backends that SNAP the requested duration to a discrete provider
	 * value (e.g. Kling's 5|10s, Luma's 5|9s, Veo's 4|6|8s). The server billing
	 * path reads this — `costFor(id, "video", { seconds })` — so the credits
	 * charged always equal the seconds actually generated, and it resolves from
	 * the SAME helper `submit`/`estimateCost` use so the three can't drift. Omit
	 * on backends that render the requested duration verbatim (e.g. Seedance);
	 * the caller then bills the requested duration unchanged.
	 */
	resolveDurationSec?(req: BackendRequest): number;
	/** Kick off generation. Never throws for provider errors — returns
	 *  `{ status: "failed", error }` so the router/caller can fall back. */
	submit(req: BackendRequest): Promise<SubmitResult>;
	/** Poll an async job to a terminal state. No-op for sync backends. */
	poll(jobId: string): Promise<PollResult>;
}
