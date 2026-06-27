import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
	VideoResolution,
	VideoOrientation,
	VideoMode,
} from "@/lib/studio/provider-adapter";
import type { ImageSize, ImageQuality } from "@/lib/studio/image-generator";

/**
 * Sticky Studio settings. Whatever the user last picked becomes the default
 * next time, until they change it again — persisted to localStorage so it
 * survives reloads and route changes.
 */
interface StudioSettingsState {
	// Video generation
	mode: VideoMode;
	orientation: VideoOrientation;
	resolution: VideoResolution;
	duration: number;
	cameraPreset: string | null;
	seedLocked: boolean;
	// Persona consistency: "high" renders a per-shot reference still via
	// gpt-image-2 edits (best identity match, +1 image call); "fast" uses the
	// persona's anchor image directly as the reference (cheaper, quicker).
	consistencyMode: "high" | "fast";
	// GPT Image
	imageSize: ImageSize;
	imageQuality: ImageQuality;

	set: (patch: Partial<Omit<StudioSettingsState, "set">>) => void;
}

export const useStudioSettingsStore = create<StudioSettingsState>()(
	persist(
		(set) => ({
			mode: "text-to-video",
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
