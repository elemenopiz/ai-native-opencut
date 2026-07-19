import type { ExportOptions } from "@/types/export";

export const DEFAULT_EXPORT_OPTIONS = {
	format: "mp4",
	quality: "high",
	includeAudio: true,
} satisfies ExportOptions;

export const EXPORT_MIME_TYPES = {
	webm: "video/webm",
	mp4: "video/mp4",
	gif: "image/gif",
} as const;

// ---------------------------------------------------------------------------
// Smart Export Presets — platform-optimized export configurations
// ---------------------------------------------------------------------------

export interface ExportPreset {
	id: string;
	name: string;
	description: string;
	options: ExportOptions;
	tip?: string;
	/**
	 * Output pixel dimensions this preset targets. Omitted for presets that
	 * should render at whatever size the project already is (Custom,
	 * Podcast — audio-only, dimensions are moot).
	 */
	canvasSize?: { width: number; height: number };
}

export const EXPORT_PRESETS: ExportPreset[] = [
	{
		id: "youtube",
		name: "YouTube",
		description: "16:9 · 1920x1080 · MP4",
		options: { format: "mp4", quality: "high", includeAudio: true },
		tip: "YouTube re-encodes everything, so high quality gives the best result after processing.",
		canvasSize: { width: 1920, height: 1080 },
	},
	{
		id: "youtube-4k",
		name: "YouTube 4K",
		description: "16:9 · 3840x2160 · MP4",
		options: { format: "mp4", quality: "very_high", includeAudio: true },
		tip: "Upload at the highest quality your source allows. YouTube will create lower-res versions automatically.",
		canvasSize: { width: 3840, height: 2160 },
	},
	{
		id: "tiktok",
		name: "TikTok / Reels",
		description: "9:16 · 1080x1920 · MP4",
		options: { format: "mp4", quality: "high", includeAudio: true },
		tip: "Keep under 60s for best reach. TikTok compresses heavily, so export at high quality.",
		canvasSize: { width: 1080, height: 1920 },
	},
	{
		id: "instagram-square",
		name: "Instagram Square",
		description: "1:1 · 1080x1080 · MP4",
		options: { format: "mp4", quality: "high", includeAudio: true },
		tip: "Square works best for feed posts viewed on both mobile and desktop.",
		canvasSize: { width: 1080, height: 1080 },
	},
	{
		id: "instagram",
		name: "Instagram Portrait",
		description: "4:5 · 1080x1350 · MP4",
		options: { format: "mp4", quality: "high", includeAudio: true },
		tip: "4:5 fills more of the feed than 1:1 without cropping to a full story.",
		canvasSize: { width: 1080, height: 1350 },
	},
	{
		id: "twitter",
		name: "Twitter / X",
		description: "16:9 · 1280x720 · MP4, 2 min 20s limit on free tier",
		options: { format: "mp4", quality: "medium", includeAudio: true },
		tip: "Twitter has a 512MB limit. Medium quality keeps file size manageable.",
		canvasSize: { width: 1280, height: 720 },
	},
	{
		id: "web",
		name: "Web / email",
		description: "16:9 · 1280x720 · WebM, smaller file size",
		options: { format: "webm", quality: "medium", includeAudio: true },
		tip: "WebM gives smaller files for embedding in websites. Not all email clients support video.",
		canvasSize: { width: 1280, height: 720 },
	},
	{
		id: "podcast",
		name: "Podcast (audio only)",
		description: "No video track, just audio",
		options: {
			format: "mp4",
			quality: "medium",
			includeAudio: true,
			audioOnly: true,
		},
		tip: "The video track is dropped entirely, even if the project has a cover image or waveform visual.",
	},
	{
		id: "custom",
		name: "Custom",
		description: "Choose your own format and quality",
		options: { format: "mp4", quality: "high", includeAudio: true },
	},
];
