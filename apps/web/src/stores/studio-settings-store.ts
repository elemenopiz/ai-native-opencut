import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";

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
	seedLocked: boolean;
	// Persona consistency tier: "high" (Balanced) renders a per-shot reference
	// still via gpt-image-2 edits (best identity match, +1 image call); "fast"
	// uses the persona's anchor image directly (cheaper, quicker, loosest
	// likeness); "durable" renders the still locally via PhotoMaker v1 on the
	// image service (best durable likeness, $0 API cost, needs the service up).
	consistencyMode: "high" | "fast" | "durable";
	// GPT Image
	imageSize: ImageSize;
	imageQuality: ImageQuality;

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
			seedLocked: false,
			consistencyMode: "high",
			imageSize: "1024x1536",
			imageQuality: "high",
			set: (patch) => set(patch),
		}),
		{ name: "studio-settings" },
	),
);
