"use client";

import { useEffect, useState } from "react";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
import { FEATURE_SOUND_EFFECTS, FEATURE_VOICEOVER } from "@/lib/feature-flags";
import { SubTabView } from "./sub-tab-view";
import { ComingSoon } from "./coming-soon";
import { SoundsView } from "./sounds";
import { VoiceoverView } from "./voiceover";
import { PodcastClipsView } from "./podcast-clips";
import { AudioEnhanceView } from "./audio-enhance";
import { AudioRecordingPanel } from "./audio-recording";
import { BeatDetectionPanel } from "./beat-detection";

// Text-to-music generation (ElevenLabs Music / fal MMAudio) had a Generate-panel
// Audio tab; it's gone along with those backends — neither has a funded key for
// this beta and there's no Google/Seedance audio-gen equivalent. The old
// `music-gen.tsx` panel here was a separate, broken TTS-abuse hack that was
// already deleted outright before that.
export function AudioCombinedView() {
	const pending = useAssetsPanelStore((s) => s.pendingAudioSubTab);
	const clearPending = useAssetsPanelStore((s) => s.clearPendingAudioSubTab);

	// Deep-link target for SubTabView's sub-tab (see `openAudioSubTab`).
	// Captured into local state rather than read from the store directly, so consuming the request
	// (`clearPending`) doesn't unmount/reset SubTabView a second time. The
	// `key` only changes when a NEW request arrives, forcing SubTabView to
	// remount and honor `defaultTab` even if the Audio tab (and this
	// component) was already mounted.
	const [applied, setApplied] = useState(pending);
	useEffect(() => {
		if (!pending) return;
		setApplied(pending);
		clearPending();
	}, [pending, clearPending]);

	return (
		<SubTabView
			key={applied?.token ?? "default"}
			defaultTab={applied?.subTab}
			tabs={[
				// Sounds (Freesound) and Voiceover (OpenAI TTS) are gated OFF for
				// this beta — see feature-flags.ts. Kept in the tab list (rather
				// than removed) so they're findable, with a "Coming soon"
				// placeholder standing in for the real panel.
				{
					key: "sounds",
					label: "Sounds",
					content: FEATURE_SOUND_EFFECTS ? (
						<SoundsView />
					) : (
						<ComingSoon
							title="Sounds"
							description="Sound-effects search isn't available in this beta."
						/>
					),
				},
				{
					key: "voiceover",
					label: "Voiceover",
					content: FEATURE_VOICEOVER ? (
						<VoiceoverView />
					) : (
						<ComingSoon
							title="Voiceover"
							description="AI voiceover isn't available in this beta."
						/>
					),
				},
				{ key: "podcast", label: "Podcast", content: <PodcastClipsView /> },
				{ key: "enhance", label: "Enhance", content: <AudioEnhanceView /> },
				{ key: "record", label: "Record", content: <AudioRecordingPanel /> },
				{ key: "beats", label: "Beats", content: <BeatDetectionPanel /> },
			]}
		/>
	);
}
