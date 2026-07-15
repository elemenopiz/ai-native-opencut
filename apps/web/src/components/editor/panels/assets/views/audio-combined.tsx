"use client";

import { useEffect, useState } from "react";
import { useAssetsPanelStore } from "@/stores/assets-panel-store";
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
	const pending = useAssetsPanelStore((s) => s.pendingAudioSubTab);
	const clearPending = useAssetsPanelStore((s) => s.clearPendingAudioSubTab);

	// Deep-link target for SubTabView's sub-tab (e.g. "Open Voiceover" from the
	// Generate panel's Audio tab — see `openAudioSubTab`). Captured into local
	// state rather than read from the store directly, so consuming the request
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
