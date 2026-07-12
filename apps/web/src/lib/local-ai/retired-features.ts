/**
 * Features whose only implementation was the retired Python AI stack
 * (services/*). Each is hidden — not broken — until it gets a new home.
 * Flip to true only when a browser/cloud implementation lands.
 * (Beta freeze note: the Python stack itself is still in-repo per ADR-004;
 * these gates make the app honest for users who never ran it.)
 */
export const RETIRED_FEATURES = {
	dubbing: false, // use-ai-dubbing (pyannote + TTS chain)
	musicGen: false, // use-music-gen (would speak its prompt via cloud TTS!)
	scriptToVideo: false, // use-script-to-video
	denoise: false, // use-noise-reduction (audio-properties panel)
	speakerLabels: false, // podcast-clips diarization labels
	youtubeImport: false, // youtube panels (yt-dlp) — owner default: hide for beta
	voiceClone: false, // XTTS speaker_wav path (Task 8 already removed the UI)
	// Not in the original plan list, but same stack, same treatment:
	factCheck: false, // quick-actions fact check (local Ollama /api/factcheck)
	localBackendSetup: false, // docker setup guide, "AI features are not available" banner, header backend-status pill, settings optimization section
} as const;

export type RetiredFeature = keyof typeof RETIRED_FEATURES;

/**
 * Preferred call-site check. Deliberately widened to `boolean`: with the
 * literal `false` types from `as const`, gate branches would type-narrow to
 * dead code and trip unreachable/unused lint at every call site.
 */
export function isFeatureAvailable(feature: RetiredFeature): boolean {
	return RETIRED_FEATURES[feature];
}

/**
 * Toast copy for the defensive early-returns inside gated hooks. The UI
 * entry points are hidden too, so users normally never hit these — they
 * exist so any stray caller (editor action, MCP verb, stale component)
 * fails with honest copy instead of a localhost:8420 network error.
 */
export function retiredFeatureMessage(feature: RetiredFeature): string {
	switch (feature) {
		case "dubbing":
			return "AI dubbing is not available in this beta.";
		case "musicGen":
			return "Music generation is not available in this beta.";
		case "scriptToVideo":
			return "Script-to-video is not available in this beta.";
		case "denoise":
			return "Noise reduction is not available in this beta.";
		case "speakerLabels":
			return "Speaker detection is not available in this beta.";
		case "youtubeImport":
			return "YouTube import is not available in this beta.";
		case "voiceClone":
			return "Voice cloning is not available in this beta.";
		case "factCheck":
			return "Fact checking is not available in this beta.";
		case "localBackendSetup":
			return "The local AI engine is not available in this beta.";
	}
}
