"use client";

import { SubTabView } from "./sub-tab-view";
import { SoundsView } from "./sounds";
import { VoiceoverView } from "./voiceover";
import { PodcastClipsView } from "./podcast-clips";
import { AudioEnhanceView } from "./audio-enhance";
import { AudioRecordingPanel } from "./audio-recording";
import { BeatDetectionPanel } from "./beat-detection";

// Music generation moved to the Generate panel's Audio tab (Music mode,
// real ElevenLabs Music via /api/studio/audio) — the old `music-gen.tsx`
// panel here was a broken TTS-abuse hack (its "music" prompt would be
// SPOKEN by cloud TTS) that was already hidden behind a retired-feature
// gate and has been deleted outright, not just unmounted.
export function AudioCombinedView() {
	return (
		<SubTabView
			tabs={[
				{ key: "sounds", label: "Sounds", content: <SoundsView /> },
				{ key: "voiceover", label: "Voiceover", content: <VoiceoverView /> },
				{ key: "podcast", label: "Podcast", content: <PodcastClipsView /> },
				{ key: "enhance", label: "Enhance", content: <AudioEnhanceView /> },
				{ key: "record", label: "Record", content: <AudioRecordingPanel /> },
				{ key: "beats", label: "Beats", content: <BeatDetectionPanel /> },
			]}
		/>
	);
}
