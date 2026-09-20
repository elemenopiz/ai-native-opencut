import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";
import { DEFAULT_APPROVAL_THRESHOLD_CREDITS } from "@/lib/studio/cost";

/**
 * How attached media is interpreted:
 *  - "omni": references condition the shot (r2v); none is a fixed frame. @mention them.
 *  - "first-last": a first frame (i2v) and optional last frame (flf2v) to move between.
 *  - "multiframe": N keyframes → N-1 flf2v segments stitched onto the timeline. Built
 *    client-side on the verified flf2v mode (Seedance itself caps at 2 frames/call).
 */
export type GenMode = "omni" | "first-last" | "multiframe";

/**
 * Sticky Studio settings. Whatever the user last picked becomes the default
 * next time, until they change it again — persisted to localStorage so it
 * survives reloads and route changes.
 */
interface StudioSettingsState {
	// Video generation
	mode: VideoMode;
	/** Reference-handling mode (Omni / First & last frame / Multiframe). */
	genMode: GenMode;
	orientation: VideoOrientation;
	resolution: VideoResolution;
	duration: number;
	cameraPreset: string | null;
	// Persona consistency tier: "high" (Balanced) renders a per-shot reference
	// still via a routed image provider (GPT Image / Gemini / …), feeding the
	// persona's anchor + uploaded photos as references (best identity match, +1
	// image call); "fast" uses the anchor image directly (cheaper, quicker,
	// loosest likeness).
	consistencyMode: "high" | "fast";
	// GPT Image
	imageSize: ImageSize;
	imageQuality: ImageQuality;
	// "Keep face & pose" — when a ready image reference is attached, appends
	// an identity-lock instruction (see lib/studio/identity-lock.ts) so the
	// generated image keeps the reference person's exact face/pose while
	// everything else (clothes, background, setting) still follows the
	// prompt. Sticky like the other image settings above.
	imageKeepFacePose: boolean;
	// Cost-preview approval gate: generations whose estimated cost meets or
	// exceeds this CREDITS threshold ask for explicit approval before spending
	// (see `lib/studio/cost.ts`). Trivial single re-rolls fall under it.
	approvalThresholdCredits: number;
	// Vision self-review: when on, the Director automatically reviews each
	// generated slot's frames against its prompt and self-corrects (reroll/remix)
	// up to a bounded number of attempts, still gated by the approval threshold
	// above (see `lib/director/vision-critic.ts`). Off ⇒ review only when the
	// user's message asks for quality, or when the model calls `reviewTake` itself.
	autoReviewEnabled: boolean;
	// Generation kill switch — the Director spends real money with an external
	// provider only when it calls generate/reroll/remix/compareTake (see
	// GENERATION_VERB_NAMES in lib/director/agent.ts); everything else (trims,
	// captions, effects, reads) is free. Off ⇒ those verbs are removed from the
	// per-run tool array handed to the brain (see runDirectorAgent's
	// `generationEnabled` param) so the Director can edit but never spend.
	// Default true so a user who never touches the toggle sees no behavior
	// change from before this setting existed.
	generationEnabled: boolean;

	set: (patch: Partial<Omit<StudioSettingsState, "set">>) => void;
}

export const useStudioSettingsStore = create<StudioSettingsState>()(
	persist(
		(set) => ({
			mode: "text-to-video",
			genMode: "omni",
			orientation: "portrait",
			resolution: "720p",
			duration: 5,
			cameraPreset: null,
			consistencyMode: "high",
			imageSize: "1024x1536",
			imageQuality: "high",
			imageKeepFacePose: false,
			approvalThresholdCredits: DEFAULT_APPROVAL_THRESHOLD_CREDITS,
			autoReviewEnabled: false,
			generationEnabled: true,
			set: (patch) => set(patch),
		}),
		{
			name: "studio-settings",
			version: 1,
			// v0 → v1: `approvalThresholdUsd` (USD) renamed to
			// `approvalThresholdCredits` (1 credit = $0.01) — the whole cost-preview
			// pipeline moved from USD to credits display. Old persisted USD values
			// convert ×100 so a returning user's threshold means the same real spend.
			migrate: (persisted, version) => {
				const state = persisted as Partial<StudioSettingsState> & {
					approvalThresholdUsd?: number;
				};
				if (version < 1 && typeof state.approvalThresholdUsd === "number") {
					const { approvalThresholdUsd, ...rest } = state;
					return {
						...rest,
						approvalThresholdCredits: approvalThresholdUsd * 100,
					};
				}
				return state;
			},
		},
	),
);
