import { useCallback, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useBackgroundTasksStore } from "@/stores/background-tasks-store";
import type {
	BeatDetectionResult,
	BeatMarker,
	BeatGridConfig,
} from "@/lib/audio/beat-detection-types";
import { DEFAULT_BEAT_GRID } from "@/lib/audio/beat-detection-types";
import { toast } from "sonner";

/**
 * Legacy energy-peak detector. Kept as a fallback for when
 * web-audio-beat-detector throws (it can on very short or quiet audio).
 */
function detectBeatsFromBuffer(audioBuffer: AudioBuffer): BeatDetectionResult {
	const channelData = audioBuffer.getChannelData(0);
	const sampleRate = audioBuffer.sampleRate;

	const windowSize = Math.round(sampleRate * 0.01);
	const hopSize = Math.round(windowSize / 2);

	const energy: number[] = [];
	for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
		let sum = 0;
		for (let j = i; j < i + windowSize; j++) {
			sum += channelData[j] * channelData[j];
		}
		energy.push(sum / windowSize);
	}

	const threshold = energy.reduce((a, b) => a + b, 0) / energy.length;
	const peaks: number[] = [];
	for (let i = 1; i < energy.length - 1; i++) {
		if (
			energy[i] > energy[i - 1] &&
			energy[i] > energy[i + 1] &&
			energy[i] > threshold * 1.5
		) {
			peaks.push(i);
		}
	}

	const minBeatInterval = Math.round((sampleRate * 0.25) / hopSize);
	const beats: BeatMarker[] = [];
	let lastPeakIndex = -Infinity;

	for (const peak of peaks) {
		if (peak - lastPeakIndex >= minBeatInterval) {
			beats.push({
				time: (peak * hopSize) / sampleRate,
				strength: energy[peak] / (threshold * 3),
				index: beats.length,
			});
			lastPeakIndex = peak;
		}
	}

	let bpm = 120;
	if (beats.length >= 2) {
		const intervals: number[] = [];
		for (let i = 1; i < Math.min(beats.length, 50); i++) {
			intervals.push(beats[i].time - beats[i - 1].time);
		}
		const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
		bpm = Math.round(60 / avgInterval);
		if (bpm > 200) bpm = Math.round(bpm / 2);
		if (bpm < 60) bpm = Math.round(bpm * 2);
	}

	return {
		bpm,
		beats,
		confidence: Math.min(beats.length / 20, 1),
	};
}

/**
 * Compute a normalized local RMS energy for each beat time so the UI's
 * beat-strength visualization stays meaningful with a grid-derived beat list.
 */
function computeBeatStrengths(
	audioBuffer: AudioBuffer,
	beatTimes: number[],
): number[] {
	const channelData = audioBuffer.getChannelData(0);
	const sampleRate = audioBuffer.sampleRate;
	const halfWindow = Math.round(sampleRate * 0.025);

	const energies = beatTimes.map((time) => {
		const center = Math.round(time * sampleRate);
		const start = Math.max(0, center - halfWindow);
		const end = Math.min(channelData.length, center + halfWindow);
		if (end <= start) return 0;
		let sum = 0;
		for (let i = start; i < end; i++) {
			sum += channelData[i] * channelData[i];
		}
		return Math.sqrt(sum / (end - start));
	});

	const maxEnergy = Math.max(...energies, 1e-6);
	return energies.map((e) => e / maxEnergy);
}

/**
 * Primary detector: web-audio-beat-detector's `guess` returns BPM + offset
 * of the first beat; we derive the beat grid from that tempo instead of raw
 * energy peaks. Throws on very short/quiet audio — caller falls back to the
 * legacy energy detector.
 */
async function detectBeatsWithLibrary(
	audioBuffer: AudioBuffer,
): Promise<BeatDetectionResult> {
	const { guess } = await import("web-audio-beat-detector");
	const { bpm, offset } = await guess(audioBuffer);

	if (!Number.isFinite(bpm) || bpm <= 0) {
		throw new Error("Beat detector returned an invalid tempo");
	}

	const interval = 60 / bpm;
	const duration = audioBuffer.duration;
	// Normalize the offset into [0, interval) so the grid starts at the
	// first beat within the clip.
	let firstBeat = offset % interval;
	if (firstBeat < 0) firstBeat += interval;

	const beatTimes: number[] = [];
	for (let t = firstBeat; t < duration; t += interval) {
		beatTimes.push(t);
	}
	if (beatTimes.length === 0) {
		throw new Error("Audio too short for tempo-derived beat grid");
	}

	const strengths = computeBeatStrengths(audioBuffer, beatTimes);
	const beats: BeatMarker[] = beatTimes.map((time, index) => ({
		time,
		strength: strengths[index],
		index,
	}));

	// Confidence: how well the tempo grid lines up with actual signal
	// energy — the mean normalized energy at beat positions.
	const meanStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;
	const confidence = Math.min(0.5 + meanStrength * 0.5, 1);

	return { bpm: Math.round(bpm), beats, confidence };
}

async function detectBeats(
	audioBuffer: AudioBuffer,
): Promise<BeatDetectionResult> {
	try {
		return await detectBeatsWithLibrary(audioBuffer);
	} catch {
		// Library can throw on very short or quiet audio — fall back to the
		// legacy energy-peak detector so detection still returns something.
		return detectBeatsFromBuffer(audioBuffer);
	}
}

export function useBeatDetection() {
	const editor = useEditor();
	const bgTasks = useBackgroundTasksStore();
	const [result, setResult] = useState<BeatDetectionResult | null>(null);
	const [gridConfig, setGridConfig] =
		useState<BeatGridConfig>(DEFAULT_BEAT_GRID);

	const detect = useCallback(
		async (mediaId?: string) => {
			const taskId = `beat-${Date.now()}`;
			bgTasks.addTask({
				id: taskId,
				type: "smart-cut",
				label: "Detecting Beats",
				progress: "Analyzing audio rhythm...",
			});

			try {
				const tracks = editor.timeline.getTracks();
				let audioBuffer: AudioBuffer | null = null;
				const audioContext = new AudioContext({ sampleRate: 44100 });

				for (const track of tracks) {
					if (track.type !== "audio" && track.type !== "video") continue;
					for (const el of track.elements) {
						const mediaEl = el as any;
						if (!mediaEl.mediaId) continue;
						if (mediaId && mediaEl.mediaId !== mediaId) continue;
						const asset = editor.media.getAssetById(mediaEl.mediaId);
						if (!asset?.file) continue;

						try {
							const ab = await asset.file.arrayBuffer();
							audioBuffer = await audioContext.decodeAudioData(ab);
							break;
						} catch {
							continue;
						}
					}
					if (audioBuffer) break;
				}

				audioContext.close();

				if (!audioBuffer) {
					throw new Error("No audio found in timeline");
				}

				const detection = await detectBeats(audioBuffer);
				setResult(detection);

				bgTasks.updateTask(taskId, {
					status: "completed",
					progress: `Detected ${detection.bpm} BPM, ${detection.beats.length} beats`,
					completedAt: Date.now(),
				});

				toast.success(
					`Beat detection: ${detection.bpm} BPM, ${detection.beats.length} beats`,
				);
			} catch (err) {
				bgTasks.updateTask(taskId, {
					status: "error",
					error: err instanceof Error ? err.message : "Detection failed",
					completedAt: Date.now(),
				});
			}
		},
		[editor, bgTasks],
	);

	const getNearestBeat = useCallback(
		(time: number): number | null => {
			if (!result) return null;
			let nearest = result.beats[0];
			let minDist = Infinity;
			for (const beat of result.beats) {
				const dist = Math.abs(beat.time - time);
				if (dist < minDist) {
					minDist = dist;
					nearest = beat;
				}
			}
			return nearest.time;
		},
		[result],
	);

	return { detect, result, gridConfig, setGridConfig, getNearestBeat };
}
