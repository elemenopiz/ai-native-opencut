// Adapted from palmier-io/sixsevenstudio (MIT). See THIRD_PARTY_NOTICES.
/**
 * Model capability catalog — mirrors the SHAPE of sixsevenstudio's
 * `RESOLUTIONS_BY_MODEL`/`DURATIONS`/`LLM_MODEL_LABELS` tables
 * (`src/types/constants.ts`: capabilities keyed by model id) but describes OUR
 * providers.
 *
 * `provider-adapter.ts` is deliberately "one function, one backend (BytePlus
 * ModelArk)" today, and `options.ts` is the single source of truth for the
 * CURRENT UI's resolution/orientation choices — this file does NOT replace
 * either. It exists because the adapter's own comment says a second backend
 * "could slot in later," and when that happens (a second video model, a
 * cheaper/faster tier, a non-BytePlus provider) something needs to answer
 * "what does THIS model support" per model id rather than assuming every
 * model supports every `VideoResolution`/`VideoOrientation`/`VideoMode`. Treat
 * this as scaffolding: exactly one entry exists per catalog today (the model
 * we actually call), values copied from the real call sites
 * (`provider-adapter.ts`, `generation-form.tsx`, `image-generator.ts`), not
 * invented.
 *
 * WIRING TODO: nothing reads this catalog yet. A future multi-model picker
 * (analogous to sixsevenstudio's `LLM_MODEL_LABELS` dropdown) would read
 * `VIDEO_MODEL_CAPABILITIES`/`IMAGE_MODEL_CAPABILITIES` to constrain
 * `generation-form.tsx`'s resolution/duration/mode controls per selected
 * model instead of the current single flat option set from `options.ts`.
 */

import type {
	VideoMode,
	VideoOrientation,
	VideoResolution,
} from "@/lib/studio/provider-adapter";
import type { ImageQuality, ImageSize } from "@/lib/studio/image-generator";

export const VIDEO_MODEL_IDS = ["seedance-2.0"] as const;
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];

export const IMAGE_MODEL_IDS = ["gpt-image-2"] as const;
export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

export interface VideoModelCapabilities {
	id: VideoModelId;
	label: string;
	/** `webEnv` var whose value overrides the concrete endpoint id (see `provider-adapter.ts`'s `byteplusSubmit`). */
	endpointIdEnvVar: string;
	resolutions: VideoResolution[];
	orientations: VideoOrientation[];
	/** Continuous duration range in seconds (not discrete tiers — see `generation-form.tsx`'s duration `Slider`). */
	durationRangeSec: { min: number; max: number };
	modes: VideoMode[];
	/** Accepts `seed` on submit but never returns it (why we pin it client-side) — see `GenerationSpec.seedLocked`. */
	supportsSeedLock: boolean;
	/** Omni-reference: `referenceImages`/`referenceVideos` conditioning, independent of any fixed frame. */
	supportsOmniReference: boolean;
	/** First-&-last-frame mode (`lastFrameUrl` / flf2v). */
	supportsLastFrame: boolean;
}

export const VIDEO_MODEL_CAPABILITIES: Record<VideoModelId, VideoModelCapabilities> = {
	"seedance-2.0": {
		id: "seedance-2.0",
		label: "Seedance 2.0 (BytePlus ModelArk)",
		endpointIdEnvVar: "BYTEPLUS_SEEDANCE_ENDPOINT_ID",
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["portrait", "landscape", "square"],
		durationRangeSec: { min: 4, max: 15 },
		modes: ["text-to-video", "image-to-video"],
		supportsSeedLock: true,
		supportsOmniReference: true,
		supportsLastFrame: true,
	},
};

export interface ImageModelCapabilities {
	id: ImageModelId;
	label: string;
	/** `webEnv` var whose value overrides the model id (see `image-generator.ts` / `persona-still.ts`). */
	modelEnvVar: string;
	sizes: ImageSize[];
	qualities: ImageQuality[];
	/** `/images/edits` reference-conditioned stills (see `persona-still.ts`'s `renderPersonaStill`). */
	supportsEdits: boolean;
}

export const IMAGE_MODEL_CAPABILITIES: Record<ImageModelId, ImageModelCapabilities> = {
	"gpt-image-2": {
		id: "gpt-image-2",
		label: "GPT Image 2",
		modelEnvVar: "OPENAI_IMAGE_MODEL",
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		supportsEdits: true,
	},
};

export function getVideoModelCapabilities(
	id: VideoModelId = "seedance-2.0",
): VideoModelCapabilities {
	return VIDEO_MODEL_CAPABILITIES[id];
}

export function getImageModelCapabilities(
	id: ImageModelId = "gpt-image-2",
): ImageModelCapabilities {
	return IMAGE_MODEL_CAPABILITIES[id];
}
