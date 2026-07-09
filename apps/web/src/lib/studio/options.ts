/**
 * Shared studio option sets — the single source of truth for the
 * resolution / orientation choices the generation UIs offer and the
 * reference-still aspect each orientation maps to. Keep these here rather than
 * re-listing them per panel so the form, the clip-properties editor, and the
 * generate route can't drift out of sync.
 */
import type {
	VideoResolution,
	VideoOrientation,
} from "@/lib/studio/provider-adapter";
import type { ImageSize } from "@/lib/studio/image-generator";

export const RESOLUTIONS: {
	value: VideoResolution;
	label: string;
	hint: string;
}[] = [
	{ value: "480p", label: "480p", hint: "~$0.03–0.05/sec · fastest drafting" },
	{ value: "720p", label: "720p", hint: "~$0.07–0.10/sec · normal drafting" },
	{
		value: "1080p",
		label: "1080p",
		hint: "~$0.23–0.37/sec · locked-seed finals only",
	},
];

export const ORIENTATIONS: {
	value: VideoOrientation;
	label: string;
	ratio: string;
}[] = [
	{ value: "portrait", label: "Portrait", ratio: "9:16" },
	{ value: "landscape", label: "Landscape", ratio: "16:9" },
	{ value: "square", label: "Square", ratio: "1:1" },
];

/** Reference-still aspect to match the video orientation (High consistency). */
export const STILL_SIZE_BY_ORIENTATION: Record<VideoOrientation, ImageSize> = {
	portrait: "1024x1536",
	landscape: "1536x1024",
	square: "1024x1024",
};
