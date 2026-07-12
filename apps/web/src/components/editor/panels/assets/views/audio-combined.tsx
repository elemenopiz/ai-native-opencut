"use client";

import { isFeatureAvailable } from "@/lib/local-ai/retired-features";
import { SubTabView } from "./sub-tab-view";
import { SoundsView } from "./sounds";
import { VoiceoverView } from "./voiceover";
import { PodcastClipsView } from "./podcast-clips";
import { AudioEnhanceView } from "./audio-enhance";
import { AudioRecordingPanel } from "./audio-recording";
import { MusicGenPanel } from "./music-gen";
import { BeatDetectionPanel } from "./beat-detection";

export function AudioCombinedView() {
	return (
		<SubTabView
			tabs={[
				{ key: "sounds", label: "Sounds", content: <SoundsView /> },
				{ key: "voiceover", label: "Voiceover", content: <VoiceoverView /> },
				{ key: "podcast", label: "Podcast", content: <PodcastClipsView /> },
				{ key: "enhance", label: "Enhance", content: <AudioEnhanceView /> },
				{ key: "record", label: "Record", content: <AudioRecordingPanel /> },
				// Music gen is retired with the Python stack (its prompt would be
				// SPOKEN by cloud TTS) — hide the tab until it has a new home.
				...(isFeatureAvailable("musicGen")
					? [{ key: "music", label: "Music", content: <MusicGenPanel /> }]
					: []),
				{ key: "beats", label: "Beats", content: <BeatDetectionPanel /> },
			]}
		/>
	);
}
