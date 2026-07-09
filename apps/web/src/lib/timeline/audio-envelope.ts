/**
 * Client-side audio energy-envelope extraction via Web Audio.
 *
 * Used by multicam audio sync so cross-correlation alignment works entirely
 * in the browser — no Python backend required. The pure math (RMS windows,
 * cross-correlation) lives in `audio-sync-utils.ts`; this file only owns the
 * browser-dependent decode step.
 */

import { computeRmsEnvelope } from "@/lib/timeline/audio-sync-utils";

/** Coarse enough to stay fast, fine enough for frame-accurate-ish sync. */
export const ENVELOPE_RESOLUTION_HZ = 20;

export interface AudioEnvelope {
	/** RMS energy per frame, `resolutionHz` frames per second of source time. */
	envelope: number[];
	resolutionHz: number;
	/** Decoded source duration in seconds. */
	duration: number;
}

/**
 * Decode a media file's audio track and reduce it to a mono RMS envelope.
 * Throws when the file has no decodable audio (e.g. image assets).
 */
export async function extractEnvelopeFromFile({
	file,
	resolutionHz = ENVELOPE_RESOLUTION_HZ,
}: {
	file: File;
	resolutionHz?: number;
}): Promise<AudioEnvelope> {
	const arrayBuffer = await file.arrayBuffer();

	// OfflineAudioContext cannot decode without a length up front, so use a
	// throwaway realtime context purely for decodeAudioData.
	const AudioContextCtor =
		window.AudioContext ??
		(window as Window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;
	if (!AudioContextCtor) {
		throw new Error("Web Audio is not available in this browser");
	}
	const audioContext = new AudioContextCtor();
	try {
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		const samples = downmixToMono(audioBuffer);
		const envelope = computeRmsEnvelope({
			samples,
			sampleRate: audioBuffer.sampleRate,
			resolutionHz,
		});
		return {
			envelope,
			resolutionHz,
			duration: audioBuffer.duration,
		};
	} finally {
		void audioContext.close();
	}
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
	if (buffer.numberOfChannels === 1) {
		return buffer.getChannelData(0);
	}
	const length = buffer.length;
	const mono = new Float32Array(length);
	for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i += 1) {
			mono[i] += data[i];
		}
	}
	const scale = 1 / buffer.numberOfChannels;
	for (let i = 0; i < length; i += 1) {
		mono[i] *= scale;
	}
	return mono;
}
